import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, connectStorageEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { getFunctions, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

// Emulator mode, for exercising flows that WRITE - registration, the hub point, orders - without
// touching production data. Localhost only, gated on the hostname rather than just the query
// string, so no link can ever switch example.kz onto a fake backend. "?emulator" turns it on for the
// browser tab (it has to survive navigating /register -> /profile), "?production" turns it off.
// Uploads go to the Storage emulator, so start it too (--only auth,firestore,functions,storage).
const onLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
// Возвращает РЕЖИМ строкой, и пустая строка значит «боевой». Возврат false отсюда стоил сайту
// рабочего дня: `false !== ""` истинно, и каждый посетитель example.kz уходил в эмулятор на своём
// же компьютере — каталог пустой, вход не работает. Тип ответа здесь один, строка, без исключений.
function emulatorRequested() {
  if (!onLocalhost) return "";
  try {
    const q = new URLSearchParams(window.location.search);
    // "?emulator=app" — тот же стенд, что и у приложений. Приложения берут project id из
    // google-services.json и сменить его не могут, поэтому стенд для них поднимается под боевым
    // идентификатором. Чтобы сайт и приложение видели ОДНУ базу, сайту нужно пойти туда же.
    if (q.has("emulator")) sessionStorage.setItem("et-emulator", q.get("emulator") === "app" ? "app" : "1");
    if (q.has("production")) sessionStorage.removeItem("et-emulator");
    return sessionStorage.getItem("et-emulator") || "";
  } catch {
    return "";
  }
}
const emulatorMode = emulatorRequested();
export const EMULATOR = emulatorMode !== "";
// Проект эмулятора: свой «demo-» для сайта (всё, что не эмулируется, тогда падает, а не уходит
// в бой) или боевой идентификатор, когда стенд общий с приложениями.
const EMULATOR_PROJECT = emulatorMode === "app" ? null : "demo-et";

// Same Firebase project as the ET / ET Partners mobile apps (farm-marketplace-demo), under its
// own dedicated Web app registration ("ET Website (example.kz)") - not sharing an app identity
// with the unrelated delete-account-et.html utility page anymore.
const firebaseConfig = {
  apiKey: "AIzaSyDEMO_KEY_REPLACED_FOR_PUBLIC_REPO",
  authDomain: "farm-marketplace-demo.firebaseapp.com",
  projectId: "farm-marketplace-demo",
  storageBucket: "farm-marketplace-demo.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:77ee554b821dfa3f9d5ada",
};

// A "demo-" project keeps the emulators fully offline: anything not emulated fails instead of
// quietly reaching production.
export const app = initializeApp(EMULATOR && EMULATOR_PROJECT
  ? { ...firebaseConfig, projectId: EMULATOR_PROJECT, apiKey: "demo-key", storageBucket: EMULATOR_PROJECT + ".appspot.com" }
  : firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
// Must match the region the functions are deployed to (see functions/index.js setGlobalOptions),
// otherwise callable requests go to us-central1 and 404.
export const functions = getFunctions(app, "europe-west3");

if (EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8085);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  // The Auth emulator issues codes without SMS and without reCAPTCHA; this only exists there.
  auth.settings.appVerificationDisabledForTesting = true;
  const mark = () => {
    const badge = document.createElement("div");
    badge.textContent = "ЭМУЛЯТОР — не боевые данные";
    badge.style.cssText = "position:fixed;left:10px;bottom:10px;z-index:9999;pointer-events:none;"
      + "background:#B3392A;color:#fff;font:700 11px/1 system-ui,sans-serif;letter-spacing:.08em;"
      + "padding:7px 11px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.3)";
    document.body.appendChild(badge);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mark);
  else mark();
}

// Firestore rules are `allow read: if request.auth != null` for public catalog data
// (partners/animals/lots) — an anonymous session satisfies that with zero rule changes.
// Real visitors who log in with their phone (auth.js) replace this anonymous session.
let readyResolve;
export const authReady = new Promise((resolve) => { readyResolve = resolve; });

onAuthStateChanged(auth, (user) => {
  if (!user) {
    signInAnonymously(auth).catch((err) => {
      console.error("Anonymous sign-in failed", err);
      readyResolve(null);
    });
    return;
  }
  readyResolve(user);
});

export function currentUser() {
  return auth.currentUser;
}

export function isRealUser(user) {
  return !!user && !user.isAnonymous;
}
