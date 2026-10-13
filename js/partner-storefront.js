// Cabinet → Витрина (leadership's window 2.0): what buyers see of the farm - description,
// slaughterhouse video, paid cutting and delivery - and what the platform checks: legal details and
// the farm's own certificates.
import { mountLayout } from "./layout.js";
import { requirePartner } from "./auth.js";
import { mountCabinetNav, renderStatusNote } from "./partner-nav.js";
import {
  escapeHtml, getFarmPrivate, saveStorefront, saveFarmLegal, saveFarmKassa, saveFarmBank,
  FARM_DOC_KINDS, DOC_STATUS_LABEL, getFarmDocuments, addFarmDocument, deleteFarmDocument,
  describeDocFile, uploadWithProgress, deleteStoredFile,
} from "./data.js";

mountLayout();
mountCabinetNav("/cabinet/storefront");

const contentEl = document.getElementById("sf-content");
const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 180;
const MAX_CUTTING = 20;
const MAX_DELIVERY = 60;
const LEGAL_FORMS = [
  ["kh", "Крестьянское хозяйство (КХ)"],
  ["fh", "Фермерское хозяйство (ФХ)"],
  ["ip", "Индивидуальный предприниматель (ИП)"],
  ["too", "Товарищество (ТОО)"],
];
const DOC_CHIP = { pending: "booked", approved: "open", rejected: "danger" };

let session = null;
let uid = null;
let saved = {};          // the storefront exactly as stored - the video saves itself on top of it
let legal = null;
let identity = null;
let hubPoint = null;
// Только отметка о подключении кассы: заводской номер и дата. Сами ключи клиенту не отдаются
// правилами — и правильно, ими выбиваются налоговые документы от имени хозяйства.
let kassaInfo = null;
let bank = null;
let farmDocs = [];

const newId = () => Math.random().toString(36).slice(2, 10);
const $ = (sel) => contentEl.querySelector(sel);

function parsePrice(raw) {
  const s = String(raw ?? "").replace(/[\s ₸]/g, "").replace(",", ".");
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : NaN;
}

function setMsg(el, text, ok) {
  el.textContent = text;
  el.style.color = ok ? "var(--ok)" : "var(--danger)";
  el.hidden = !text;
}

// ---- checklist: what stands between the farm and a full check ------------------------------------

function checklistHtml() {
  const approved = new Set(farmDocs.filter((d) => d.status === "approved").map((d) => d.kind));
  const filed = new Set(farmDocs.filter((d) => d.status !== "rejected").map((d) => d.kind));
  const certState = session.profile.certified ? "done"
    : ["ses", "vet_control"].every((k) => filed.has(k)) ? "wait" : "todo";
  const rows = [
    ["done", "Анкета хозяйства", ""],
    [identity ? "done" : "todo", "ИИН / БИН", identity ? "" : "указывается при регистрации"],
    [legal ? "done" : "todo", "Реквизиты", legal ? "" : "заполните ниже"],
    [certState, "Сертификаты СЭС и ветконтроля",
      certState === "done" ? "подтверждены" : certState === "wait" ? "на проверке у администратора" : "загрузите ниже"],
    [hubPoint ? "done" : "todo", "Точка хаба на карте", hubPoint ? "" : "отмечается в профиле"],
    [kassaInfo ? "done" : "todo", "Онлайн-касса",
      kassaInfo ? "чеки выбиваются" : "без неё покупатель не получит чек"],
  ];
  const mark = { done: "✓", wait: "…", todo: "○" };
  return rows.map(([state, label, hint]) => `
    <li class="${state}"><span class="mark" aria-hidden="true">${mark[state]}</span>
      <span>${escapeHtml(label)}${hint ? ` <span class="hint">— ${escapeHtml(hint)}</span>` : ""}</span></li>`).join("");
}

// ---- rows of the two editable lists --------------------------------------------------------------

function cuttingRowHtml(o = {}) {
  return `
    <div class="opt-row" data-cut="${escapeHtml(o.id || newId())}">
      <div><label>Название</label>
        <input type="text" data-f="name" maxlength="60" value="${escapeHtml(o.name || "")}" placeholder="Традиционная Мүшелеу"></div>
      <div><label>Цена за половину туши, ₸</label>
        <input type="text" data-f="price" inputmode="numeric" value="${escapeHtml(o.price ?? "")}" placeholder="15000"></div>
      <div><label>Что входит</label>
        <input type="text" data-f="note" maxlength="300" value="${escapeHtml(o.note || "")}" placeholder="12 жілік, казы, бас-сирақ…"></div>
      <button type="button" class="btn-pill btn-ghost btn-sm" data-remove>Убрать</button>
    </div>`;
}

function deliveryRowHtml(o = {}) {
  return `
    <div class="opt-row opt-row--delivery" data-del="${escapeHtml(o.id || newId())}">
      <div><label>Город или населённый пункт</label>
        <input type="text" data-f="city" maxlength="60" value="${escapeHtml(o.city || "")}" placeholder="Караганда"></div>
      <div><label>Стоимость, ₸</label>
        <input type="text" data-f="price" inputmode="numeric" value="${escapeHtml(o.price ?? "")}" placeholder="10000"></div>
      <button type="button" class="btn-pill btn-ghost btn-sm" data-remove>Убрать</button>
    </div>`;
}

// ---- video ---------------------------------------------------------------------------------------

function videoBoxHtml() {
  if (!saved.videoUrl) {
    return '<p class="sf-lede" style="margin:0;">Видео ещё не загружено.</p>';
  }
  const poster = saved.posterUrl ? ` poster="${escapeHtml(saved.posterUrl)}"` : "";
  return `<video src="${escapeHtml(saved.videoUrl)}"${poster} controls playsinline preload="metadata"></video>`;
}

/** Reads the length and grabs a still for the cover, entirely in the browser. Never throws. */
function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    let finished = false;
    let duration = null;
    const done = (posterBlob = null) => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      resolve({ duration, posterBlob });
    };
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => {
      duration = Number.isFinite(v.duration) ? v.duration : null;
      v.currentTime = Math.min(1, (duration || 3) / 3);
    };
    v.onseeked = () => {
      try {
        const w = Math.min(960, v.videoWidth || 960);
        const h = Math.round(w * (v.videoHeight || 540) / (v.videoWidth || 960));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(v, 0, 0, w, h);
        canvas.toBlob((blob) => done(blob), "image/jpeg", 0.82);
      } catch (e) {
        done(null);
      }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 10000);
    v.src = url;
  });
}

async function onVideoChosen(file) {
  const msg = $("#video-msg");
  setMsg(msg, "", true);
  if (!file) return;
  if (!String(file.type).startsWith("video/")) return setMsg(msg, "Это не видеофайл.", false);
  if (file.size > MAX_VIDEO_BYTES) {
    return setMsg(msg, `Видео ${Math.round(file.size / 1048576)} МБ — больше 150 МБ. Снимите покороче или сожмите.`, false);
  }
  const probe = await probeVideo(file);
  if (probe.duration && probe.duration > MAX_VIDEO_SECONDS) {
    return setMsg(msg, `Видео длится ${Math.round(probe.duration / 60)} мин — оставьте до 3 минут: покупатель смотрит его с телефона.`, false);
  }

  const bar = $("#video-progress");
  const fill = $("#video-progress-fill");
  const label = $("#video-progress-text");
  const pick = $("#video-pick");
  bar.hidden = false;
  pick.classList.add("is-disabled");
  try {
    const ts = Date.now();
    const ext = (file.name.split(".").pop() || "mp4").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "mp4";
    const videoPath = `farms/${uid}/video/${ts}.${ext}`;
    const videoUrl = await uploadWithProgress(videoPath, file, (p) => {
      fill.style.width = Math.round(p * 100) + "%";
      label.textContent = `Загружено ${Math.round(p * 100)}%`;
    });
    let posterUrl = null;
    let posterPath = null;
    if (probe.posterBlob) {
      posterPath = `farms/${uid}/poster/${ts}.jpg`;
      posterUrl = await uploadWithProgress(posterPath, new File([probe.posterBlob], "poster.jpg", { type: "image/jpeg" }))
        .catch(() => { posterPath = null; return null; });
    }
    const previous = [saved.videoPath, saved.posterPath];
    saved = { ...saved, videoUrl, videoPath, posterUrl, posterPath };
    await saveStorefront(uid, saved);
    // The replaced files would otherwise stay in the bucket, still openable by their old links.
    previous.filter(Boolean).forEach((p) => deleteStoredFile(p).catch(console.error));
    $("#video-box").innerHTML = videoBoxHtml();
    $("#video-remove").hidden = false;
    setMsg(msg, "Видео сохранено — покупатели увидят его в каталоге и на странице хозяйства.", true);
  } catch (e) {
    console.error(e);
    setMsg(msg, e?.code === "storage/unauthorized"
      ? "Хранилище отклонило файл: нужен видеофайл до 150 МБ."
      : "Не удалось загрузить видео. Проверьте связь и попробуйте ещё раз.", false);
  } finally {
    bar.hidden = true;
    pick.classList.remove("is-disabled");
    $("#f-video").value = "";
  }
}

async function removeVideo() {
  if (!window.confirm("Убрать видео с витрины?")) return;
  const msg = $("#video-msg");
  const previous = [saved.videoPath, saved.posterPath];
  try {
    saved = { ...saved, videoUrl: null, videoPath: null, posterUrl: null, posterPath: null };
    await saveStorefront(uid, saved);
    previous.filter(Boolean).forEach((p) => deleteStoredFile(p).catch(console.error));
    $("#video-box").innerHTML = videoBoxHtml();
    $("#video-remove").hidden = true;
    setMsg(msg, "Видео убрано.", true);
  } catch (e) {
    console.error(e);
    setMsg(msg, "Не удалось убрать видео.", false);
  }
}

// ---- saving the storefront -----------------------------------------------------------------------

function readRows(selector, fields) {
  return [...contentEl.querySelectorAll(selector)].map((row) => {
    const o = { id: row.dataset.cut || row.dataset.del };
    fields.forEach((f) => { o[f] = row.querySelector(`[data-f="${f}"]`).value.trim(); });
    return o;
  }).filter((o) => fields.some((f) => o[f])); // a row left completely empty is not an error
}

async function saveAll() {
  const msg = $("#save-msg");
  setMsg(msg, "", true);
  const description = $("#f-desc").value.trim();
  const cutting = readRows("[data-cut]", ["name", "price", "note"]);
  const delivery = readRows("[data-del]", ["city", "price"]);

  for (const c of cutting) {
    if (!c.name) return setMsg(msg, "У платной разделки нужно название.", false);
    c.price = parsePrice(c.price);
    if (!Number.isFinite(c.price) || c.price > 10000000) return setMsg(msg, `Проверьте цену разделки «${c.name}».`, false);
  }
  for (const d of delivery) {
    if (!d.city) return setMsg(msg, "У строки доставки нужен город.", false);
    d.price = parsePrice(d.price);
    if (!Number.isFinite(d.price) || d.price > 1000000) return setMsg(msg, `Проверьте стоимость доставки в «${d.city}».`, false);
  }
  const pickup = $("#f-pickup").checked;
  if (!delivery.length && !pickup) {
    return setMsg(msg, "Укажите хотя бы один город доставки или самовывоз — иначе покупатель не сможет оформить заказ.", false);
  }

  const btn = $("#btn-save");
  btn.disabled = true;
  btn.textContent = "Сохраняем…";
  try {
    const storefront = { ...saved, description, cutting, delivery, pickup };
    await saveStorefront(uid, storefront);
    saved = storefront;
    setMsg(msg, "Витрина сохранена.", true);
  } catch (e) {
    console.error(e);
    setMsg(msg, "Не удалось сохранить витрину. Попробуйте ещё раз.", false);
  } finally {
    btn.disabled = false;
    btn.textContent = "Сохранить витрину";
  }
}

// ---- legal details ------------------------------------------------------------------------------

// Part of what review checks: once the farm is approved, the rules let it fill them in if it never
// did, but a change goes through support.
function legalLocked() {
  const status = session.profile.status;
  return !!legal && (status === "verified" || status === "active");
}

function legalPanelHtml() {
  const l = legal || {};
  const locked = legalLocked();
  const dis = locked ? " disabled" : "";
  return `
    <h3>Реквизиты</h3>
    <p class="sf-lede">Видят только вы и администрация платформы — для проверки хозяйства и будущих выплат.</p>
    <div class="field"><label for="f-form">Организационная форма</label>
      <select id="f-form"${dis}>${LEGAL_FORMS.map(([v, t]) => `<option value="${v}"${l.form === v ? " selected" : ""}>${t}</option>`).join("")}</select></div>
    <div class="field"><label for="f-legal-name">Название по документам</label>
      <input type="text" id="f-legal-name" maxlength="200" value="${escapeHtml(l.legalName || "")}" placeholder="КХ «Степной»"${dis}></div>
    <div class="field"><label for="f-address">Юридический адрес</label>
      <input type="text" id="f-address" maxlength="300" value="${escapeHtml(l.address || "")}" placeholder="Область, район, село, улица"${dis}></div>
    ${locked
      ? '<p class="field-hint">Хозяйство уже проверено — чтобы изменить реквизиты, напишите в поддержку.</p>'
      : '<button class="btn-pill btn-secondary" id="btn-legal">Сохранить реквизиты</button>'}
    <p id="legal-msg" hidden style="font-size:13px;"></p>`;
}

/**
 * Счёт для выплат. Раньше здесь стояла заглушка про «карту, которая появится вместе с
 * онлайн-оплатой»: оплата давно подключена, а выплаты идут на счёт, не на карту.
 *
 * Заполнять нужно целиком: по половине реквизитов перевод не уйдёт, а выглядеть счёт будет
 * заполненным — это хуже пустого поля.
 */
function bankPanelHtml() {
  const b = bank || {};
  return `
    <h3>Счёт для выплат</h3>
    <p class="sf-lede">Сюда платформа перечислит вашу долю: половина при подтверждении заказа,
      четверть при отгрузке, четверть после получения покупателем. Счёт должен быть открыт на то
      же лицо, что указано в реквизитах.</p>
    <div class="field"><label for="f-iban">IBAN</label>
      <input type="text" id="f-iban" maxlength="20" value="${escapeHtml(b.iban || "")}" placeholder="KZ00000000000000000"></div>
    <div class="field"><label for="f-bank-name">Банк</label>
      <input type="text" id="f-bank-name" maxlength="200" value="${escapeHtml(b.bankName || "")}" placeholder="Halyk Bank"></div>
    <div class="field"><label for="f-bic">БИК</label>
      <input type="text" id="f-bic" maxlength="8" value="${escapeHtml(b.bic || "")}" placeholder="HSBKKZKX"></div>
    <div class="field"><label for="f-kbe">КБе</label>
      <input type="text" id="f-kbe" maxlength="2" inputmode="numeric" value="${escapeHtml(b.kbe || "")}" placeholder="17"></div>
    <button class="btn-pill btn-secondary" id="btn-bank">Сохранить счёт</button>
    <p id="bank-msg" hidden style="font-size:13px;"></p>`;
}

async function saveBank() {
  const msg = $("#bank-msg");
  const iban = $("#f-iban").value.replace(/\s/g, "").toUpperCase();
  const bankName = $("#f-bank-name").value.trim();
  const bic = $("#f-bic").value.trim().toUpperCase();
  const kbe = $("#f-kbe").value.trim();
  if (!/^KZ[0-9A-Z]{18}$/.test(iban)) return setMsg(msg, "IBAN в Казахстане — KZ и ещё 18 знаков.", false);
  if (!bankName) return setMsg(msg, "Укажите банк.", false);
  if (!/^[A-Z0-9]{8}$/.test(bic)) return setMsg(msg, "БИК банка — 8 знаков.", false);
  if (!/^[0-9]{2}$/.test(kbe)) return setMsg(msg, "КБе — две цифры.", false);
  try {
    await saveFarmBank(uid, { iban, bic, bankName, kbe });
    bank = { iban, bic, bankName, kbe };
    setMsg(msg, "Счёт сохранён.", true);
  } catch (e) {
    console.error(e);
    setMsg(msg, "Не удалось сохранить счёт.", false);
  }
}

/**
 * Подключение онлайн-кассы. Продавец мяса — хозяйство, значит и чек его: платформа лишь
 * выбивает его кассой, под его БИН.
 *
 * Поля пустые даже после подключения: пароль и ПИН обратно не показываются никому. Экран знает
 * только заводской номер — этого хватает, чтобы сказать «подключена».
 */
function kassaPanelHtml() {
  const znm = kassaInfo?.znm;
  return `
    <h3>Онлайн-касса</h3>
    <p class="sf-lede">${znm
      ? `Касса ${escapeHtml(znm)} подключена. Чеки по вашим заказам выбиваются автоматически и выходят под вашим БИН.`
      : "Подключите свою кассу в re:Kassa — и платформа будет выбивать чеки от вашего имени, сама, в момент оплаты. Без кассы покупатель не получит чек, а выдавать его при расчёте обязывает закон."}</p>
    <ol class="sf-steps" style="margin:10px 0 14px; padding-left:20px; line-height:1.7;">
      <li>Зарегистрируйте кассу в приложении re:Kassa — понадобится ваша ЭЦП. Касса остаётся вашей.</li>
      <li>Настройки → «Подключить приложение» → выберите «ТОО Компания» → «Получить пароль».</li>
      <li>Пароль показывается один раз. Перенесите его сюда вместе с заводским номером и ПИН-кодом.</li>
    </ol>
    <div class="field"><label for="f-znm">Заводской номер кассы (ЗНМ)</label>
      <input type="text" id="f-znm" maxlength="40" placeholder="TESTZNM-000"></div>
    <div class="field"><label for="f-kassa-password">Пароль для приложения</label>
      <input type="text" id="f-kassa-password" maxlength="300" placeholder="Тот, что показали один раз"></div>
    <div class="field"><label for="f-kassa-pin">ПИН-код кассы</label>
      <input type="text" id="f-kassa-pin" maxlength="6" inputmode="numeric" placeholder="Им закрывается смена"></div>
    <button class="btn-pill btn-secondary" id="btn-kassa">${znm ? "Заменить доступ" : "Подключить кассу"}</button>
    <p class="field-hint">Пароль и ПИН мы не покажем обратно — ни вам, ни администратору.</p>
    <p id="kassa-msg" hidden style="font-size:13px;"></p>`;
}

async function saveKassa() {
  const msg = $("#kassa-msg");
  const znm = $("#f-znm").value.trim().toUpperCase();
  const password = $("#f-kassa-password").value.trim();
  const pin = $("#f-kassa-pin").value.trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(znm)) return setMsg(msg, "Заводской номер — буквы, цифры и дефис.", false);
  if (!password) return setMsg(msg, "Вставьте пароль, который выдала re:Kassa.", false);
  if (!/^[0-9]{4,6}$/.test(pin)) return setMsg(msg, "ПИН кассы — от четырёх до шести цифр.", false);
  try {
    await saveFarmKassa(uid, { znm, password, pin });
    kassaInfo = { znm };
    $("#checklist").innerHTML = checklistHtml();
    // Поля чистим сразу: держать пароль в форме незачем.
    $("#f-kassa-password").value = "";
    $("#f-kassa-pin").value = "";
    setMsg(msg, "Касса подключена. Чеки будут выбиваться автоматически.", true);
  } catch (e) {
    console.error(e);
    setMsg(msg, "Не удалось сохранить доступ к кассе.", false);
  }
}

async function saveLegal() {
  const msg = $("#legal-msg");
  const form = $("#f-form").value;
  const legalName = $("#f-legal-name").value.trim();
  const address = $("#f-address").value.trim();
  if (legalName.length < 3) return setMsg(msg, "Укажите название по документам.", false);
  if (address.length < 5) return setMsg(msg, "Укажите юридический адрес.", false);
  try {
    await saveFarmLegal(uid, { form, legalName, address });
    legal = { form, legalName, address };
    $("#checklist").innerHTML = checklistHtml();
    setMsg(msg, "Реквизиты сохранены.", true);
  } catch (e) {
    console.error(e);
    setMsg(msg, e?.code === "permission-denied"
      ? "Хозяйство уже проверено — изменить реквизиты можно через поддержку."
      : "Не удалось сохранить реквизиты.", false);
  }
}

// ---- the farm's certificates -----------------------------------------------------------------------

function docsListHtml() {
  if (!farmDocs.length) return '<p class="sf-lede" style="margin:0 0 12px;">Документов пока нет.</p>';
  return `<div class="doc-list">${farmDocs.map((d) => `
    <div class="doc-item">
      <div class="grow"><strong>${escapeHtml(d.label || "Документ")}</strong><br>
        <span style="color:var(--ink-faint); font-size:13px;">${escapeHtml(d.fileName || "")}</span>
        ${d.status === "rejected" && d.reviewNote ? `<br><span style="color:var(--danger); font-size:13px;">Причина: ${escapeHtml(d.reviewNote)}</span>` : ""}</div>
      <span class="status-chip ${DOC_CHIP[d.status] || "draft"}">${escapeHtml(DOC_STATUS_LABEL[d.status] || d.status)}</span>
      <a class="btn-pill btn-ghost btn-sm" href="${escapeHtml(d.fileUrl)}" target="_blank" rel="noopener">Открыть</a>
      ${d.status === "pending" ? `<button type="button" class="btn-pill btn-ghost btn-sm" data-withdraw="${escapeHtml(d.id)}">Убрать</button>` : ""}
    </div>`).join("")}</div>`;
}

async function reloadDocs() {
  farmDocs = await getFarmDocuments(uid);
  $("#docs-list").innerHTML = docsListHtml();
  $("#checklist").innerHTML = checklistHtml();
}

async function uploadDoc() {
  const msg = $("#docs-msg");
  const file = $("#doc-file").files[0];
  const problem = describeDocFile(file);
  if (problem) return setMsg(msg, problem, false);
  const btn = $("#btn-doc");
  btn.disabled = true;
  btn.textContent = "Загружаем…";
  try {
    await addFarmDocument(uid, { kind: $("#doc-kind").value, file });
    $("#doc-file").value = "";
    await reloadDocs();
    setMsg(msg, "Документ отправлен на проверку.", true);
  } catch (e) {
    console.error(e);
    setMsg(msg, e?.code === "storage/unauthorized" ? "Хранилище отклонило файл: нужен PDF, фото или Word до 20 МБ." : (e?.message || "Не удалось загрузить документ."), false);
  } finally {
    btn.disabled = false;
    btn.textContent = "Отправить на проверку";
  }
}

// ---- page ----------------------------------------------------------------------------------------

function render() {
  const sf = saved;
  contentEl.innerHTML = `
    <div class="panel">
      <h3>Проверка хозяйства</h3>
      <p class="sf-lede">Покупатели видят только проверенные хозяйства. Бейдж «Сертификаты» появляется,
        когда администратор подтвердит СЭС и ветконтроль.</p>
      <ul class="checklist" id="checklist">${checklistHtml()}</ul>
    </div>

    <div class="panel">
      <h3>О хозяйстве</h3>
      <div class="field" style="margin:10px 0 0;">
        <label for="f-desc">Описание для покупателей</label>
        <textarea id="f-desc" maxlength="3000" rows="6" placeholder="Порода и откорм, условия содержания, убойный выход, как организован цех…">${escapeHtml(sf.description || "")}</textarea>
        <p class="field-hint"><span id="desc-count">${(sf.description || "").length}</span> / 3000</p>
      </div>
    </div>

    <div class="panel">
      <h3>Видео убойного цеха</h3>
      <p class="sf-lede">Покажите цех, охлаждение и порядок — до 3 минут и 150 МБ. Видео появится в каталоге и
        на странице хозяйства и сохраняется сразу после загрузки.</p>
      <div class="video-box" id="video-box">${videoBoxHtml()}</div>
      <div class="video-actions">
        <label class="btn-pill btn-secondary btn-sm" id="video-pick" style="cursor:pointer;">Выбрать видео
          <input type="file" id="f-video" accept="video/*" hidden></label>
        <button type="button" class="btn-pill btn-ghost btn-sm" id="video-remove"${sf.videoUrl ? "" : " hidden"}>Убрать видео</button>
      </div>
      <div class="upload-progress" id="video-progress" hidden>
        <div class="progress-track"><div class="progress-fill" id="video-progress-fill" style="width:0%"></div></div>
        <div class="progress-caption" id="video-progress-text"></div>
      </div>
      <p id="video-msg" hidden style="font-size:13px; margin-top:10px;"></p>
    </div>

    <div class="panel">
      <h3>Разделка</h3>
      <p class="sf-lede">Стандартная разделка входит в цену. Платные варианты вы называете и оцениваете сами —
        цена указывается за половину туши, за целую покупатель платит вдвое больше.</p>
      <div class="opt-fixed"><strong>Стандартная</strong><span>включена в цену</span></div>
      <div id="cutting-list">${(sf.cutting || []).map(cuttingRowHtml).join("")}</div>
      <button type="button" class="btn-pill btn-ghost btn-sm" id="add-cutting">+ Платная разделка</button>
    </div>

    <div class="panel">
      <h3>Доставка</h3>
      <p class="sf-lede">Доставляет хозяйство. Покупатель выбирает город из этого списка — стоимость
        добавится к заказу. Можно предложить самовывоз из хаба.</p>
      <label class="check-row"><input type="checkbox" id="f-pickup"${sf.pickup ? " checked" : ""}> Самовывоз из хаба — бесплатно</label>
      <div id="delivery-list">${(sf.delivery || []).map(deliveryRowHtml).join("")}</div>
      <button type="button" class="btn-pill btn-ghost btn-sm" id="add-delivery">+ Город доставки</button>
    </div>

    <div class="sf-save">
      <button class="btn-pill btn-primary" id="btn-save">Сохранить витрину</button>
      <p id="save-msg" hidden style="font-size:14px; margin:0;"></p>
    </div>

    <div class="panel" id="legal-panel">${legalPanelHtml()}</div>

    <div class="panel" id="kassa-panel">${kassaPanelHtml()}</div>

    <div class="panel">
      <h3>Сертификаты хозяйства</h3>
      <p class="sf-lede">Санитарно-эпидемиологическое заключение и ветеринарный контроль цеха. Фото, PDF или Word
        до 20 МБ; документ уходит на проверку администратору.</p>
      <div id="docs-list">${docsListHtml()}</div>
      <div class="doc-upload">
        <select id="doc-kind">${FARM_DOC_KINDS.map((k) => `<option value="${k.id}">${escapeHtml(k.label)}</option>`).join("")}</select>
        <input type="file" id="doc-file" accept="image/*,application/pdf,.doc,.docx">
        <button type="button" class="btn-pill btn-secondary btn-sm" id="btn-doc">Отправить на проверку</button>
      </div>
      <p id="docs-msg" hidden style="font-size:13px; margin-top:10px;"></p>
    </div>

    <div class="panel" id="bank-panel">${bankPanelHtml()}</div>`;
  wire();
}

function wire() {
  const desc = $("#f-desc");
  desc.addEventListener("input", () => { $("#desc-count").textContent = desc.value.length; });

  $("#f-video").addEventListener("change", (e) => onVideoChosen(e.target.files[0]));
  $("#video-remove").addEventListener("click", removeVideo);

  $("#add-cutting").addEventListener("click", () => {
    if (contentEl.querySelectorAll("[data-cut]").length >= MAX_CUTTING) return;
    $("#cutting-list").insertAdjacentHTML("beforeend", cuttingRowHtml());
    $("#cutting-list").lastElementChild.querySelector("input").focus();
  });
  $("#add-delivery").addEventListener("click", () => {
    if (contentEl.querySelectorAll("[data-del]").length >= MAX_DELIVERY) return;
    $("#delivery-list").insertAdjacentHTML("beforeend", deliveryRowHtml());
    $("#delivery-list").lastElementChild.querySelector("input").focus();
  });
  contentEl.addEventListener("click", async (e) => {
    const remove = e.target.closest("[data-remove]");
    if (remove) { remove.closest(".opt-row").remove(); return; }
    const withdraw = e.target.closest("[data-withdraw]");
    if (withdraw) {
      if (!window.confirm("Убрать документ? Его можно будет загрузить заново.")) return;
      withdraw.disabled = true;
      try {
        await deleteFarmDocument(uid, withdraw.dataset.withdraw);
        await reloadDocs();
      } catch (err) {
        console.error(err);
        setMsg($("#docs-msg"), "Не удалось убрать документ.", false);
        withdraw.disabled = false;
      }
    }
  });

  $("#btn-save").addEventListener("click", saveAll);
  $("#btn-legal")?.addEventListener("click", saveLegal);
  $("#btn-kassa")?.addEventListener("click", saveKassa);
  $("#btn-bank")?.addEventListener("click", saveBank);
  $("#btn-doc").addEventListener("click", uploadDoc);
}

async function init() {
  session = await requirePartner();
  if (!session) return;
  uid = session.user.uid;
  renderStatusNote(session.profile, uid);
  saved = session.profile.storefront || {};
  try {
    // Private records are extras here: one failing to load must not take the storefront down.
    [legal, identity, hubPoint, kassaInfo, bank, farmDocs] = await Promise.all([
      getFarmPrivate(uid, "legal").catch(() => null),
      getFarmPrivate(uid, "identity").catch(() => null),
      getFarmPrivate(uid, "location").catch(() => null),
      getFarmPrivate(uid, "kassaInfo").catch(() => null),
      getFarmPrivate(uid, "bank").catch(() => null),
      getFarmDocuments(uid).catch((e) => { console.error(e); return []; }),
    ]);
    render();
  } catch (e) {
    console.error(e);
    contentEl.innerHTML = '<div class="empty-state">Не удалось загрузить витрину.</div>';
  }
}

init();
