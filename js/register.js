import { mountLayout } from "./layout.js";
import { sendOtp, confirmOtp, getProfiles, describeAuthError, safeNext, cleanEmail } from "./auth.js";
import { db, auth, authReady, isRealUser } from "./firebase-init.js";
import { doc, serverTimestamp, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { regionOptionsHtml } from "./regions.js";

mountLayout();
document.getElementById("f-region").insertAdjacentHTML("beforeend", regionOptionsHtml());

// Where to go once registered: back to the page that sent the person here (an invitation to a
// joint purchase, a lot they wanted to order) - or, with nowhere to return to, the natural start.
const nextUrl = safeNext(new URLSearchParams(window.location.search).get("next"));
const loginLink = document.getElementById("login-link");
if (loginLink && nextUrl) loginLink.href = "/login?next=" + encodeURIComponent(nextUrl);
const destination = (role) => nextUrl || (role === "partner" ? "/profile" : "/#choose");

const els = {
  title: document.getElementById("step-title"),
  sub: document.getElementById("step-sub"),
  role: document.getElementById("step-role"),
  phone: document.getElementById("step-phone"),
  code: document.getElementById("step-code"),
  form: document.getElementById("step-form"),
  error: document.getElementById("auth-error"),
  rail2: document.getElementById("rail-2"),
  rail3: document.getElementById("rail-3"),
};

let selectedRole = null;
let confirmationResult = null;

function showError(message) {
  els.error.textContent = message;
  els.error.style.display = "block";
}
function clearError() {
  els.error.style.display = "none";
}

function showStep(step) {
  els.role.hidden = step !== "role";
  els.phone.hidden = step !== "phone";
  els.code.hidden = step !== "code";
  els.form.hidden = step !== "form";
  clearError();
}

// Same normalisation the apps do (registration_screen.dart strips to digits and forces +7).
function normalizePhone(raw) {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("8")) return "+7" + digits.slice(1);
  if (digits.startsWith("7")) return "+" + digits;
  return "+7" + digits;
}

// The number is proven - by a code just now, or by a session that already exists. Either the
// account already has this role (then there is nothing to fill in) or it gets the form.
async function afterPhoneVerified(uid) {
  // Already registered in THIS role? Then don't show the form and never rewrite the existing
  // document - the apps' own createUserProfile() is a non-merging set() that wipes
  // status/balance/rating/createdAt on repeat registration, and that bug must not reach here.
  // Checked per-role on purpose: an existing buyer may legitimately also register as a farmer,
  // which just means adding a partners/{uid} doc alongside their clients/{uid} one.
  const { client, partner } = await getProfiles(uid);
  const alreadyInThisRole = selectedRole === "partner" ? partner : client;
  if (alreadyInThisRole) {
    window.location.href = destination(selectedRole);
    return;
  }

  els.rail2.classList.add("done");
  els.rail3.classList.add("done");
  els.title.textContent = selectedRole === "partner" ? "Данные хозяйства" : "Пара слов о вас";
  els.sub.textContent = selectedRole === "partner"
    ? "Название и регион увидят покупатели. ИИН/БИН и email — только администрация платформы."
    : "Имя и город видят фермеры, у которых вы покупаете.";
  document.getElementById("name-label").textContent =
    selectedRole === "partner" ? "Имя / название КХ" : "Имя";
  document.getElementById("f-name").placeholder =
    selectedRole === "partner" ? "КХ «Степной»" : "Как к вам обращаться";
  document.getElementById("iin-field").hidden = selectedRole !== "partner";
  document.getElementById("region-field").hidden = selectedRole !== "partner";
  document.getElementById("city-label").textContent = selectedRole === "partner" ? "Населённый пункт" : "Город";
  document.getElementById("f-city").placeholder = selectedRole === "partner" ? "Село или город, где хаб" : "Например, Астана";
  document.getElementById("partner-note").hidden = selectedRole !== "partner";
  showStep("form");
}

// ---- step 1: role ----
async function chooseRole(role) {
  document.querySelectorAll(".role-card")
    .forEach((c) => c.classList.toggle("selected", c.dataset.role === role));
  selectedRole = role;

  // Signed in already (a buyer adding a farm, or someone who logged in first): the number is
  // proven, so asking for another SMS code would only cost them time and us an SMS.
  const user = await authReady;
  if (isRealUser(user)) {
    try {
      await afterPhoneVerified(user.uid);
      return;
    } catch (e) {
      console.error(e);
      // Fall through to the normal phone step rather than leaving them stuck.
    }
  }

  els.rail2.classList.add("done");
  els.title.textContent = "Подтвердите номер";
  els.sub.textContent = selectedRole === "partner"
    ? "Регистрируем хозяйство. Номер станет логином в ET и ET Partners."
    : "Номер станет вашим логином — тем же, что и в приложении ET.";
  showStep("phone");
}

document.querySelectorAll(".role-card").forEach((card) => {
  card.addEventListener("click", () => chooseRole(card.dataset.role));
});

// Роль можно принести в адресе — и отдельной страницей, и параметром.
//
// Отдельная страница нужна для печати: /register/partner короче и понятнее на листовке, чем
// /register?role=partner, и его не испортит мессенджер, обрезающий строку запроса. Параметр
// остаётся: по нему приходят старые ссылки и те, что уже разошлись.
//
// Читаем ПУТЬ, а не только запрос: nginx подставляет файл перезаписью, и строка запроса до
// браузера не доходит — location.search на /register/partner пуст.
const ROLE_ALIASES = { partner: "partner", farmer: "partner", client: "client", buyer: "client" };
const fromPath = (window.location.pathname.match(/\/register\/([a-z]+)/i) || [])[1] || "";
const fromQuery = new URLSearchParams(window.location.search).get("role") || "";
const askedRole = ROLE_ALIASES[(fromPath || fromQuery).toLowerCase()];
if (askedRole) {
  // Страница заведена под одну роль — пусть и называется так. «Регистрация» вообще — это про
  // выбор, которого здесь уже не будет.
  const eyebrow = document.querySelector(".eyebrow");
  if (eyebrow) {
    eyebrow.textContent = askedRole === "partner" ? "Регистрация хозяйства" : "Регистрация покупателя";
  }
  chooseRole(askedRole);
}

// ---- step 2: phone + OTP ----
document.getElementById("btn-send-code").addEventListener("click", async () => {
  clearError();
  const phone = normalizePhone(document.getElementById("phone-input").value.trim());
  if (phone.length < 12) {
    showError("Введите полный номер телефона.");
    return;
  }
  const btn = document.getElementById("btn-send-code");
  btn.disabled = true;
  btn.textContent = "Отправляем…";
  try {
    confirmationResult = await sendOtp(phone, "recaptcha-container");
    showStep("code");
  } catch (e) {
    console.error(e);
    showError(describeAuthError(e));
  } finally {
    btn.disabled = false;
    btn.textContent = "Получить код →";
  }
});

document.getElementById("btn-change-phone").addEventListener("click", () => showStep("phone"));

document.getElementById("btn-confirm-code").addEventListener("click", async () => {
  clearError();
  const code = document.getElementById("code-input").value.trim();
  if (!confirmationResult || code.length < 4) {
    showError("Введите код из SMS.");
    return;
  }
  const btn = document.getElementById("btn-confirm-code");
  btn.disabled = true;
  btn.textContent = "Проверяем…";
  try {
    const cred = await confirmOtp(confirmationResult, code);
    await afterPhoneVerified(cred.user.uid);
  } catch (e) {
    console.error(e);
    showError(describeAuthError(e));
  } finally {
    btn.disabled = false;
    btn.textContent = "Подтвердить →";
  }
});

// ---- step 3: profile ----
document.getElementById("btn-finish").addEventListener("click", async () => {
  clearError();
  const user = auth.currentUser;
  if (!isRealUser(user)) {
    showError("Сессия истекла. Начните регистрацию заново.");
    return;
  }

  const name = document.getElementById("f-name").value.trim();
  const city = document.getElementById("f-city").value.trim();
  const iin = document.getElementById("f-iin").value.trim();
  const regionCode = document.getElementById("f-region").value;
  const email = cleanEmail(document.getElementById("f-email").value);
  const isPartner = selectedRole === "partner";

  if (!name) {
    showError(isPartner ? "Введите имя или название КХ." : "Введите имя.");
    return;
  }
  if (isPartner && !/^\d{12}$/.test(iin)) {
    showError("ИИН/БИН должен состоять ровно из 12 цифр.");
    return;
  }
  if (isPartner && !regionCode) {
    showError("Выберите область, где находится хозяйство.");
    return;
  }
  if (email === null) {
    showError("Проверьте email — похоже, в адресе ошибка. Или оставьте поле пустым.");
    return;
  }

  const btn = document.getElementById("btn-finish");
  btn.disabled = true;
  btn.textContent = "Сохраняем…";
  try {
    // Same 17 keys as the apps' UserProfile.toMap(), so both apps read this document
    // without surprises. Types matter: ET_side_client casts `createdAt as Timestamp?` and
    // `rating as num?` strictly and would throw on strings.
    //
    // Except the IIN: this document is public - every visitor, anonymous ones included, can read
    // it - and an IIN is personal data. The key stays (as null) for the apps' sake; the number
    // itself goes to partners/{uid}/private/identity in the same batch, readable by the farm and
    // staff only. A farm's email goes to private/contact for the same reason; a buyer's profile
    // is private already, so their email sits on it.
    const batch = writeBatch(db);
    batch.set(doc(db, isPartner ? "partners" : "clients", user.uid), {
      uid: user.uid,
      phone: user.phoneNumber || "",
      role: isPartner ? "partner" : "client",
      displayName: name,
      iin: null,
      iban: null,
      country: null,
      documentUrl: null,
      status: isPartner ? "pending_review" : "active",
      createdAt: serverTimestamp(),
      avatarUrl: null,
      city: city || null,
      rating: 0,
      totalDeals: 0,
      walletBalance: 0,
      pendingBalance: 0,
      achievements: [],
      ...(isPartner ? { regionCode } : { email: email || null }),
    }, { merge: true });
    if (isPartner) {
      batch.set(doc(db, "partners", user.uid, "private", "identity"), { iin, updatedAt: serverTimestamp() });
      if (email) {
        batch.set(doc(db, "partners", user.uid, "private", "contact"), { email, updatedAt: serverTimestamp() });
      }
    }
    await batch.commit();

    window.location.href = destination(selectedRole);
  } catch (e) {
    console.error(e);
    showError("Не удалось сохранить профиль. Попробуйте ещё раз.");
    btn.disabled = false;
    btn.textContent = "Завершить регистрацию";
  }
});
