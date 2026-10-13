// Firebase for the staff panel. Deliberately NOT the public site's firebase-init.js:
//   - no anonymous sign-in. The public site signs every visitor in anonymously so the catalogue
//     can be read; here an anonymous session would be a session that means nothing, so there is
//     none. You are either a verified phone or you see the login screen.
//   - emulator mode for testing, which the public site does not have.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getFunctions, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";

// Emulator mode exists so the privileged screens can be exercised end to end without handing
// admin rights to any real or test account. It is gated on the HOSTNAME, not just on the query
// string: on admin.example.kz no link can switch a real administrator onto a fake backend.
const onLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
export const EMULATOR = onLocalhost && new URLSearchParams(window.location.search).has("emulator");

const productionConfig = {
  apiKey: "AIzaSyDEMO_KEY_REPLACED_FOR_PUBLIC_REPO",
  authDomain: "farm-marketplace-demo.firebaseapp.com",
  projectId: "farm-marketplace-demo",
  storageBucket: "farm-marketplace-demo.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:77ee554b821dfa3f9d5ada",
};

// A "demo-" project keeps the emulators fully offline: anything not emulated fails instead of
// quietly reaching production.
const config = EMULATOR ? { ...productionConfig, projectId: "demo-et", apiKey: "demo-key" } : productionConfig;

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "europe-west3");

if (EMULATOR) {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8085);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  // The Auth emulator issues codes without SMS and without reCAPTCHA; this only exists there.
  auth.settings.appVerificationDisabledForTesting = true;
}
