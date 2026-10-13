import { mountLayout } from "./layout.js";
import { sendOtp, confirmOtp, describeAuthError, safeNext, landingFor } from "./auth.js";

mountLayout();

const phoneInput = document.getElementById("phone-input");
const codeInput = document.getElementById("code-input");
const stepPhone = document.getElementById("step-phone");
const stepCode = document.getElementById("step-code");
const errorEl = document.getElementById("auth-error");
const params = new URLSearchParams(window.location.search);
// Only a path on this site. Without one, the account's role decides where to land.
const nextUrl = safeNext(params.get("next"));

// Someone sent here from an order button who has no account yet registers instead - and should
// come back to the same page afterwards, not start over from the homepage.
const registerLink = document.getElementById("register-link");
if (registerLink && nextUrl) registerLink.href = "/register?next=" + encodeURIComponent(nextUrl);

let confirmationResult = null;

function showError(message) {
  errorEl.textContent = message;
  errorEl.style.display = "block";
}

function clearError() {
  errorEl.style.display = "none";
}

function normalizePhone(raw) {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("8")) return "+7" + digits.slice(1);
  if (digits.startsWith("7")) return "+" + digits;
  return "+7" + digits;
}

document.getElementById("btn-send-code").addEventListener("click", async () => {
  clearError();
  const phone = normalizePhone(phoneInput.value.trim());
  if (phone.length < 11) {
    showError("Введите корректный номер телефона.");
    return;
  }
  try {
    confirmationResult = await sendOtp(phone, "recaptcha-container");
    stepPhone.style.display = "none";
    stepCode.style.display = "block";
  } catch (e) {
    console.error(e);
    showError(describeAuthError(e));
  }
});

document.getElementById("btn-confirm-code").addEventListener("click", async () => {
  clearError();
  const code = codeInput.value.trim();
  if (!confirmationResult || code.length < 4) {
    showError("Введите код из SMS.");
    return;
  }
  try {
    const cred = await confirmOtp(confirmationResult, code);
    let target = nextUrl;
    if (!target) {
      // A failed profile lookup is not a failed login - the profile page sorts it out.
      target = await landingFor(cred.user.uid).catch(() => "/profile");
    }
    window.location.href = target;
  } catch (e) {
    console.error(e);
    showError(describeAuthError(e));
  }
});

document.getElementById("btn-change-phone").addEventListener("click", () => {
  stepCode.style.display = "none";
  stepPhone.style.display = "block";
  clearError();
});
