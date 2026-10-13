import {
  RecaptchaVerifier, signInWithPhoneNumber, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { auth, authReady, isRealUser } from "./firebase-init.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./firebase-init.js";

let recaptchaVerifier = null;

export function initRecaptcha(containerId) {
  if (recaptchaVerifier) return recaptchaVerifier;
  recaptchaVerifier = new RecaptchaVerifier(auth, containerId, { size: "invisible" });
  return recaptchaVerifier;
}

// A RecaptchaVerifier is single-use: once it has produced a token - or failed part-way through
// the challenge - reusing it fails with auth/invalid-app-credential whatever went wrong the first
// time. Cached in a module variable, that turned every retry into a second failure and made the
// real cause look permanent until the page was reloaded.
function resetRecaptcha() {
  try { recaptchaVerifier?.clear(); } catch (_) { /* widget already gone */ }
  recaptchaVerifier = null;
}

export async function sendOtp(phoneNumber, containerId) {
  const verifier = initRecaptcha(containerId);
  try {
    return await signInWithPhoneNumber(auth, phoneNumber, verifier);
  } catch (e) {
    resetRecaptcha();
    throw e;
  }
}

// Phone auth on the web fails for several very different reasons, and "проверьте номер" sends
// people chasing the wrong one. Most of these are configuration, not user error.
export function describeAuthError(error) {
  const code = error?.code || "";
  switch (code) {
    case "auth/invalid-phone-number":
      return "Неверный формат номера. Пример: +7 700 000 00 00.";
    case "auth/missing-phone-number":
      return "Введите номер телефона.";
    case "auth/unauthorized-domain":
    case "auth/invalid-app-credential":
    case "auth/captcha-check-failed":
      // All three mean the same thing in practice: Firebase refused to verify this page's origin.
      // Naming the host matters - the site answers on both example.kz and www.example.kz, and only
      // the one actually in the address bar is the one that has to be allow-listed.
      return `Вход по SMS не настроен для домена ${window.location.hostname}. `
        + "Добавьте его в Firebase Authentication → Settings → Authorized domains.";
    case "auth/operation-not-allowed":
      return "Вход по телефону отключён в Firebase Authentication.";
    case "auth/too-many-requests":
      return "Слишком много попыток с этого номера или адреса. Подождите и попробуйте снова.";
    case "auth/internal-error":
      // Общая отговорка Firebase: он так отвечает и когда reCAPTCHA не прошла, и когда защита
      // от перебора придержала номер. Разницы снаружи не видно, а человеку в обоих случаях
      // помогает одно и то же — подождать и повторить. Код оставлен для нас, в скобках.
      return "Сервис входа отклонил запрос. Обычно помогает подождать минуту и попробовать "
        + "снова — так он защищается от частых попыток. (auth/internal-error)";
    case "auth/quota-exceeded":
      return "Исчерпана квота на отправку SMS в проекте Firebase.";
    case "auth/invalid-verification-code":
      return "Неверный код из SMS.";
    case "auth/code-expired":
      return "Код истёк. Запросите новый.";
    case "auth/network-request-failed":
      return "Нет связи с сервером. Проверьте интернет.";
    default:
      // Neutral wording on purpose: login.js calls this from the confirm-code step too,
      // where "не удалось отправить код" would point at the wrong half of the flow.
      return `Не удалось продолжить вход (${code || "неизвестная ошибка"}).`;
  }
}

export async function confirmOtp(confirmationResult, code) {
  return confirmationResult.confirm(code);
}

export async function logOut() {
  await signOut(auth);
  window.location.href = "/";
}

// One phone number is one uid across all three apps, and that uid may legitimately hold BOTH a
// clients/{uid} and a partners/{uid} document - the seeded test account does. So anything that
// needs a specific role must ask for that collection instead of taking whichever doc turns up.
export async function getProfiles(uid) {
  const [clientSnap, partnerSnap] = await Promise.all([
    getDoc(doc(db, "clients", uid)),
    getDoc(doc(db, "partners", uid)),
  ]);
  return {
    client: clientSnap.exists() ? { role: "client", ...clientSnap.data() } : null,
    partner: partnerSnap.exists() ? { role: "partner", ...partnerSnap.data() } : null,
  };
}

export async function getPartnerProfile(uid) {
  const snap = await getDoc(doc(db, "partners", uid));
  return snap.exists() ? { role: "partner", ...snap.data() } : null;
}

// Convenience for places that just need "who is this" (header avatar, order contact). Prefers
// the partner profile because that's the role with a cabinet behind it.
export async function getMyProfile(uid) {
  const { client, partner } = await getProfiles(uid);
  return partner || client;
}

// role comes from getMyProfile() - it's just which collection the doc already lives in, not a
// user-chosen value, so this can't be used to write into the wrong collection.
export async function updateMyProfile(uid, role, fields) {
  const collectionName = role === "partner" ? "partners" : "clients";
  await setDoc(doc(db, collectionName, uid), fields, { merge: true });
}

// Where ?next= may send someone who just signed in: a path on this site and nothing else.
// "https://evil.example" or "//evil.example" there used to be followed as is, so a link to our
// own login page could hand a freshly verified user to any site that asked.
export function safeNext(raw) {
  const s = String(raw || "");
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : null;
}

// Where someone lands after signing in with nowhere particular to go: a farm to its orders, a
// buyer to the start of the catalogue, a number with no profile yet to registration.
export async function landingFor(uid) {
  const { client, partner } = await getProfiles(uid);
  if (partner) return "/cabinet/orders";
  if (client) return "/#choose";
  return "/register";
}

// An optional email: "" when left empty, the address when it looks like one, null when it does
// not. The same shape firestore.rules accepts for a farm's private contact.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export function cleanEmail(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.length <= 254 && EMAIL_RE.test(s) ? s : null;
}

// Partner-cabinet pages call this: real login AND a partners/{uid} document specifically.
// Reading partners directly matters - a user who is also a buyer has a clients doc too, and
// picking "whichever profile exists" would lock them out of their own cabinet.
export async function requirePartner() {
  const user = await requireRealLogin();
  if (!user) return null;
  const profile = await getPartnerProfile(user.uid);
  if (!profile) {
    window.location.href = "/profile";
    return null;
  }
  return { user, profile };
}

// Pages that need a real (phone-verified) login call this; anonymous visitors are sent to
// /login and returned to `next` afterwards.
export async function requireRealLogin(nextUrl) {
  const user = await authReady;
  if (isRealUser(user)) return user;
  // The whole path, not the last segment. With /cabinet/orders the old version sent the
  // visitor back to "orders" - the buyer page - after logging in, instead of the cabinet.
  const target = nextUrl || (window.location.pathname + window.location.search);
  window.location.href = "/login?next=" + encodeURIComponent(target);
  return null;
}
