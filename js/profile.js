import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requireRealLogin, getProfiles, updateMyProfile, logOut, cleanEmail } from "./auth.js";
import { escapeHtml, getFarmPrivate, saveHubLocation, saveFarmContact } from "./data.js";
import { regionOptionsHtml, partnerRegion } from "./regions.js";
import { pickerHtml, mountLocationPicker } from "./location-picker.js";

mountLayout();

const contentEl = document.getElementById("profile-content");

const ROLE_LABEL = { client: "Покупатель", partner: "Партнёр (фермер)" };

function sharedHeadHtml(profile) {
  const name = escapeHtml(profile.displayName || "Без имени");
  const initial = (profile.displayName || "?").trim().charAt(0).toUpperCase() || "?";
  return `
    <div class="profile-head">
      <div class="avatar-big">${escapeHtml(initial)}</div>
      <div>
        <h3 style="margin:0;">${name}</h3>
        <p style="margin:4px 0 0; font-size:13px;">${escapeHtml(profile.phone || "")} · ${ROLE_LABEL[profile.role] || profile.role}</p>
      </div>
    </div>`;
}

// Optional, private: for receipts and order notifications. A buyer's profile is private already;
// a farm's email lives in its private contact record, filled in after the page renders.
function emailFieldHtml(value = "") {
  return `
    <div class="field">
      <label for="f-email">Email <span style="color:var(--ink-faint); font-weight:400;">— необязательно</span></label>
      <input type="email" id="f-email" value="${escapeHtml(value)}" placeholder="name@example.kz" autocomplete="email" inputmode="email">
      <p class="field-hint">Для чеков и уведомлений о заказах. Видите только вы и администрация платформы.</p>
    </div>`;
}

function clientProfileHtml(profile) {
  return `
    ${sharedHeadHtml(profile)}
    <div class="field" style="margin-top:22px;">
      <label>Имя</label>
      <input type="text" id="f-name" value="${escapeHtml(profile.displayName || "")}" placeholder="Как к вам обращаться">
    </div>
    <div class="field">
      <label>Город</label>
      <input type="text" id="f-city" value="${escapeHtml(profile.city || "")}" placeholder="Например, Астана">
    </div>
    ${emailFieldHtml(profile.email || "")}
    <p id="save-msg" style="font-size:13px; display:none;"></p>
    <div class="profile-actions">
      <button class="btn-pill btn-primary btn-block" id="btn-save">Сохранить</button>
      <a class="btn-pill btn-secondary btn-block" href="/orders">Мои заказы →</a>
      <a class="btn-pill btn-ghost btn-block" href="https://example.kz/legal/delete-account-et" target="_blank" rel="noopener">Удалить аккаунт</a>
      <button class="btn-pill btn-rust btn-block" id="btn-logout">Выйти</button>
    </div>`;
}

function partnerProfileHtml(profile, alsoBuyer = false) {
  // A farm registered before regions had codes gets its region read from its city text, so it
  // only has to confirm the choice rather than find it in a list of twenty.
  const region = partnerRegion(profile) || "";
  return `
    ${sharedHeadHtml(profile)}
    <div class="field" style="margin-top:22px;">
      <label for="f-name">Имя / название КХ</label>
      <input type="text" id="f-name" value="${escapeHtml(profile.displayName || "")}" placeholder="КХ «Степной»">
    </div>
    <div class="field">
      <label for="f-region">Область</label>
      <select id="f-region"><option value="">Выберите область</option>${regionOptionsHtml(region)}</select>
    </div>
    <div class="field">
      <label for="f-city">Населённый пункт</label>
      <input type="text" id="f-city" value="${escapeHtml(profile.city || "")}" placeholder="Село или город, где хаб">
    </div>
    ${emailFieldHtml()}
    <div class="field">
      <label>Точка хаба на карте</label>
      <p class="field-hint" style="margin:0 0 10px;">Нажмите на карту там, где находится хаб, или определите по GPS.
        Точное место видите только вы и администрация платформы — покупателям хаб показан с точностью около 5 км.</p>
      ${pickerHtml()}
    </div>
    <p id="save-msg" style="font-size:13px; display:none;"></p>
    <div class="profile-actions">
      <button class="btn-pill btn-primary btn-block" id="btn-save">Сохранить</button>
      <a class="btn-pill btn-secondary btn-block" href="/cabinet/lots">Кабинет фермера →</a>
      ${alsoBuyer ? '<a class="btn-pill btn-secondary btn-block" href="/orders">Мои покупки →</a>' : ""}
      <a class="btn-pill btn-ghost btn-block" href="https://example.kz/legal/delete-account-et" target="_blank" rel="noopener">Удалить аккаунт</a>
      <button class="btn-pill btn-rust btn-block" id="btn-logout">Выйти</button>
    </div>`;
}

function wireActions(user, profile, picker = null, savedEmail = "") {
  document.getElementById("btn-logout")?.addEventListener("click", logOut);
  const regionSelect = document.getElementById("f-region");
  regionSelect?.addEventListener("change", () => picker?.recenter(regionSelect.value));

  const saveBtn = document.getElementById("btn-save");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", async () => {
    const msg = document.getElementById("save-msg");
    const fail = (text) => {
      msg.textContent = text;
      msg.style.color = "var(--danger)";
      msg.style.display = "block";
    };
    const displayName = document.getElementById("f-name").value.trim();
    const city = document.getElementById("f-city").value.trim();
    const email = cleanEmail(document.getElementById("f-email").value);
    if (email === null) return fail("Проверьте email — похоже, в адресе ошибка. Или оставьте поле пустым.");
    const fields = { displayName, city };
    if (profile.role === "partner") {
      if (!regionSelect.value) return fail("Выберите область, где находится хозяйство.");
      fields.regionCode = regionSelect.value;
    } else {
      fields.email = email || null;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "Сохранение…";
    try {
      await updateMyProfile(user.uid, profile.role, fields);
      // A farm's email is not on its public profile - it has a private record of its own.
      if (profile.role === "partner" && email !== savedEmail) {
        await saveFarmContact(user.uid, email);
        savedEmail = email;
      }
      // The point goes through the server, which keeps it private and publishes a rounded one.
      // Saved second, so a failure there still leaves the name and region saved - and says so.
      if (picker?.dirty) {
        try {
          picker.markSaved(await saveHubLocation(picker.point));
        } catch (e) {
          console.error(e);
          msg.textContent = "Профиль сохранён, но точку на карте сохранить не удалось. Попробуйте ещё раз.";
          msg.style.color = "var(--danger)";
          msg.style.display = "block";
          return;
        }
      }
      msg.innerHTML = icon("check", { size: 16 }) + " Сохранено";
      msg.style.color = "var(--ok)";
      msg.style.display = "block";
    } catch (e) {
      console.error(e);
      msg.textContent = "Не удалось сохранить. Попробуйте ещё раз.";
      msg.style.color = "var(--danger)";
      msg.style.display = "block";
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Сохранить";
    }
  });
}

async function init() {
  const user = await requireRealLogin("/profile");
  if (!user) return;
  try {
    const { client, partner } = await getProfiles(user.uid);
    if (!client && !partner) {
      contentEl.innerHTML = `<div class="empty-state">Профиль не найден.
        <a href="/register" style="color:var(--green)">Завершить регистрацию →</a></div>`;
      return;
    }
    // A uid can hold both roles. Show the partner view when there is one (it's the role with a
    // cabinet behind it) and keep the buyer's orders link if they also buy.
    const profile = partner || client;
    contentEl.innerHTML = partner
      ? partnerProfileHtml(partner, Boolean(client))
      : clientProfileHtml(client);
    let picker = null;
    let savedEmail = "";
    if (partner) {
      const contact = await getFarmPrivate(user.uid, "contact").catch(() => null);
      savedEmail = contact?.email || "";
      document.getElementById("f-email").value = savedEmail;
      // The exact point lives in the farm's private record; a failure to read it (or to load the
      // map) must not take the rest of the profile down with it.
      try {
        const exact = await getFarmPrivate(user.uid, "location").catch(() => null);
        picker = await mountLocationPicker({
          exact, publicPoint: partner.publicLocation || null, regionCode: document.getElementById("f-region").value,
        });
      } catch (e) {
        console.error(e);
        document.getElementById("loc-map").innerHTML = '<div class="empty-state">Не удалось загрузить карту.</div>';
      }
    }
    wireActions(user, profile, picker, savedEmail);
  } catch (e) {
    console.error(e);
    contentEl.innerHTML = '<div class="empty-state">Не удалось загрузить профиль.</div>';
  }
}

init();
