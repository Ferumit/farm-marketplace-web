// Leadership's window 2.2 - the farm's card for one order. Accept it, then four steps, each opened
// by the one before: the live animal on camera, the ready meat with documents and the control
// weighing, sending the order, handing it over. Beside them, the money each step releases.
// Every move goes through updateOrderStatus; this page only uploads the step's files and asks.
import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requirePartner } from "./auth.js";
import { mountCabinetNav } from "./partner-nav.js";
import { getOrder, orderAction, uploadOrderFile, orderFileKind, deleteStoredFile, formatTenge, escapeHtml, pluralRu } from "./data.js";
import { orderSummary, SLOT_LABEL } from "./carcass.js";
import {
  stageOf, statusText, statusTone, reached, canCancel, PAYOUT_PARTS, PAYOUT_STATE, COMPLETED_BY, whenLabel, overdue,
} from "./order-status.js";
import { mediaHtml, docLinksHtml } from "./media.js";

mountLayout();
mountCabinetNav("/cabinet/orders");

const el = document.getElementById("po-content");
const orderId = new URLSearchParams(window.location.search).get("id");
let session = null;
let order = null;
let busy = false;
// Files uploaded for a step that has not been sent yet.
const pending = { identify: [], meat: [], documents: [], scale: [] };
const ALLOWED = { identify: ["photo", "video"], meat: ["photo", "video"], documents: ["photo", "doc"], scale: ["photo"] };

const kgText = (w) => String(Math.round(Number(w) * 10) / 10).replace(".", ",");

function showError(text) {
  const p = el.querySelector("#po-error");
  if (!p) return;
  p.textContent = text;
  p.hidden = !text;
  if (text) p.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---- pieces -------------------------------------------------------------------------------------

function panel({ state, title, when = "", hint = "", body = "" }) {
  const badge = state === "done"
    ? `<span class="status-chip open">готово${when ? " · " + escapeHtml(when) : ""}</span>`
    : state === "locked" ? '<span class="status-chip draft">после предыдущего шага</span>' : "";
  return `
    <div class="step-panel${state === "done" ? " is-done" : state === "locked" ? " is-locked" : ""}">
      <h3>${title} ${badge}</h3>
      ${hint ? `<p class="step-hint">${hint}</p>` : ""}
      ${body}
    </div>`;
}

function uploader(key, { accept, capture, label, iconName, multiple = true }) {
  return `
    <label class="btn-pill btn-secondary btn-sm" style="cursor:pointer;">${icon(iconName, { size: 16 })} ${label}
      <input type="file" accept="${accept}"${capture ? ' capture="environment"' : ""}${multiple ? " multiple" : ""} hidden data-upload="${key}"></label>
    <div data-pending="${key}">${mediaHtml(pending[key], { removable: true })}</div>
    <div class="upload-progress" data-progress="${key}" hidden style="margin-top:10px;">
      <div class="progress-track"><div class="progress-fill" style="width:0%"></div></div>
      <div class="progress-caption"></div>
    </div>`;
}

function weighingHtml(w) {
  if (!w) return "";
  const diff = Number(w.difference) || 0;
  const diffText = diff > 0 ? `доплата покупателя ${formatTenge(diff)}`
    : diff < 0 ? `возврат покупателю ${formatTenge(-diff)}` : "без перерасчёта";
  return `
    <p style="font-size:14px; margin:12px 0 0;">${icon("scale", { size: 16 })} Взвешивание: <strong>${kgText(w.weightKg)} кг</strong>${w.meat != null
      ? ` → мясо ${formatTenge(w.meat)}, итог ${formatTenge(w.total)} — ${diffText}` : ""}</p>
    ${w.scalePhoto ? mediaHtml([w.scalePhoto]) : ""}`;
}

// ---- the page: contact, acceptance, the four steps, the outcome, the money ------------------------

function headerHtml() {
  return `
    <span class="eyebrow" style="display:block; margin-top:16px;">Заказ</span>
    <h1 style="margin:6px 0 0;">${escapeHtml(order.lotTitle || "Лот")}</h1>
    <p style="margin:6px 0 0;">${escapeHtml(orderSummary(order))} · ${formatTenge(order.amount)}
      <span class="status-chip ${statusTone(order)}" style="margin-left:6px;">${escapeHtml(statusText(order, "farm"))}</span></p>`;
}

function contactHtml() {
  const phone = order.contactPhone || order.buyerPhone || "";
  const wa = phone.replace(/[^\d]/g, "");
  const mode = order.delivery?.mode;
  const delivery = mode === "pickup" ? "самовывоз из хаба" : mode === "city" ? `доставка: ${order.delivery.city}` : "по договорённости";
  const date = order.deliveryDate
    ? order.deliveryDate.split("-").reverse().join(".") + (order.deliverySlot && order.deliverySlot !== "any" ? ", " + (SLOT_LABEL[order.deliverySlot] || "").toLowerCase() : "")
    : "не указана";
  return `
    <div class="step-panel po-contact">
      <h3>${icon("phone", { size: 18 })} Покупатель и доставка</h3>
      <dl>
        <dt>Телефон</dt><dd>${escapeHtml(phone || "—")}${wa ? ` · <a href="https://wa.me/${escapeHtml(wa)}" target="_blank" rel="noopener" style="color:var(--green); font-weight:600;">WhatsApp</a>` : ""}</dd>
        <dt>Доставка</dt><dd>${escapeHtml(delivery)}</dd>
        ${mode !== "pickup" ? `<dt>Адрес</dt><dd>${escapeHtml(order.deliveryAddress || "—")}</dd>` : ""}
        <dt>Желаемая дата</dt><dd>${escapeHtml(date)}</dd>
        <dt>Разделка</dt><dd>${escapeHtml(order.cutting?.name || "стандартная")}</dd>
        ${order.group ? `<dt>Совместная покупка</dt><dd>${order.group.size} ${pluralRu(order.group.size, "участник", "участника", "участников")} делят тушу.
          Заказ ведёт ${escapeHtml((order.group.members || [])[0]?.name || "организатор")} — телефон выше.</dd>` : ""}
      </dl>
    </div>`;
}

function acceptHtml() {
  const s = stageOf(order.status);
  if (s === "cancelled") {
    return panel({ state: "done", title: "Заказ отменён", when: whenLabel(order.updatedAt),
      hint: order.cancelledBy === "buyer" ? "Покупатель отменил заказ, туша вернулась в продажу." : "Заказ отменён хозяйством, туша вернулась в продажу." });
  }
  if (s !== "created") return panel({ state: "done", title: "Заказ принят", when: whenLabel(order.acceptedAt) });
  return panel({
    state: "current", title: "Принять заказ",
    hint: "Проверьте формат, разделку, доставку и дату. Приняв заказ, вы открываете аванс — 50 % вашей доли.",
    body: `<div class="step-actions">
      <button class="btn-pill btn-primary" data-act="accept">Принять заказ</button>
      <button class="btn-pill btn-ghost" data-act="cancel">Отклонить</button></div>`,
  });
}

function identifyHtml() {
  const title = "Шаг 1. Снять на камеру";
  const s = stageOf(order.status);
  if (order.steps?.identify) {
    return panel({ state: "done", title, when: whenLabel(order.steps.identify.at), body: mediaHtml(order.steps.identify.files) });
  }
  if (s === "cancelled" || !reached(order, "accepted")) return panel({ state: "locked", title });
  if (s !== "accepted") return panel({ state: "done", title, hint: "Пройден в прежней версии кабинета, без съёмки." });
  return panel({
    state: "current", title,
    hint: "Снимите животное, которое пойдёт на этот заказ, — видео или фото. На телефоне кнопка сразу откроет камеру; покупатель увидит съёмку в своём заказе.",
    body: `${uploader("identify", { accept: "image/*,video/*", capture: true, label: "Снять на камеру", iconName: "camera" })}
      <div class="step-actions"><button class="btn-pill btn-primary" data-send="identify"${pending.identify.length ? "" : " disabled"}>Отправить шаг 1</button></div>`,
  });
}

function meatHtml() {
  const title = "Шаг 2. Готовое мясо и документы";
  const s = stageOf(order.status);
  if (order.steps?.meat) {
    const m = order.steps.meat;
    return panel({
      state: "done", title, when: whenLabel(m.at),
      body: `${mediaHtml(m.files)}${weighingHtml(order.weighing)}
        ${docLinksHtml([...(m.certificates || []), ...(m.documents || []).map((d) => ({ ...d, label: d.name || "Документ" }))])}`,
    });
  }
  if (s === "cancelled" || !reached(order, "animal_selected")) return panel({ state: "locked", title });
  if (s !== "animal_selected") return panel({ state: "done", title, hint: "Пройден в прежней версии кабинета, без фото." });
  const expected = order.estimatedWeightKg ? `Ожидалось ~${kgText(order.estimatedWeightKg)} кг.` : "";
  return panel({
    state: "current", title,
    hint: "Покажите мясо после разделки, приложите документы и взвесьте. Ветдокументы животного из реестра приложатся к заказу сами. После этого шага заказ уже нельзя отменить.",
    body: `
      <h4 class="eyebrow" style="margin:0 0 8px;">Готовое мясо</h4>
      ${uploader("meat", { accept: "image/*,video/*", capture: true, label: "Снять мясо", iconName: "camera" })}
      <h4 class="eyebrow" style="margin:18px 0 8px;">Документы</h4>
      ${uploader("documents", { accept: "image/*,application/pdf", capture: false, label: "Прикрепить документ", iconName: "file-text" })}
      <p class="upload-note">Фото документа или PDF: ветсправка, заключение лаборатории, накладная.</p>
      <h4 class="eyebrow" style="margin:18px 0 8px;">Контрольное взвешивание</h4>
      <div class="weigh-row">
        <div class="field" style="margin:0;"><label for="po-weight">Вес, кг</label>
          <input type="text" id="po-weight" inputmode="decimal" placeholder="${escapeHtml(order.estimatedWeightKg ? kgText(order.estimatedWeightKg) : "60")}"></div>
        <p class="weigh-preview" id="po-weigh-preview">${expected}</p>
      </div>
      <div style="margin-top:10px;">${uploader("scale", { accept: "image/*", capture: true, label: "Снять весы", iconName: "scale", multiple: false })}</div>
      <div class="step-actions"><button class="btn-pill btn-primary" data-send="meat">Отправить шаг 2</button></div>`,
  });
}

function shipHtml() {
  const title = "Шаг 3. Отправить заказ";
  const s = stageOf(order.status);
  if (order.steps?.shipped || (reached(order, "shipped") && s !== "cancelled")) {
    return panel({ state: "done", title, when: whenLabel(order.steps?.shipped?.at) });
  }
  if (s !== "meat_ready") return panel({ state: "locked", title });
  return panel({
    state: "current", title,
    hint: order.delivery?.mode === "pickup"
      ? "Когда заказ готов к выдаче, отметьте это — покупатель увидит, что можно забирать."
      : "Когда заказ погружен и выехал к покупателю, отметьте отправку — покупатель увидит это в заказе.",
    body: `<div class="step-actions"><button class="btn-pill btn-primary" data-act="ship">${icon("truck", { size: 16 })} Отправить заказ</button></div>`,
  });
}

function handoverHtml() {
  const title = "Шаг 4. Передача покупателю";
  const s = stageOf(order.status);
  if (order.steps?.handover) {
    const body = s === "delivered"
      ? `<p class="step-hint" style="margin:8px 0 0;">Ждём подтверждения покупателя. Если он не подтвердит и не откроет спор,
          сделка завершится автоматически ${escapeHtml(whenLabel(order.autoCompleteAt))}.</p>` : "";
    return panel({ state: "done", title, when: whenLabel(order.steps.handover.at), body });
  }
  if (s === "delivered") return panel({ state: "done", title });
  if (s !== "shipped") return panel({ state: "locked", title });
  return panel({
    state: "current", title,
    hint: "Отметьте, когда покупатель получил заказ. После этого у него 3 часа, чтобы подтвердить получение или открыть спор; иначе сделка завершится сама.",
    body: '<div class="step-actions"><button class="btn-pill btn-primary" data-act="handover">Передан покупателю</button></div>',
  });
}

function outcomeHtml() {
  const s = stageOf(order.status);
  if (s === "completed") {
    return `<div class="notice-box notice-icon" style="margin-top:12px;">${icon("check", { size: 18 })}<span>
      <strong>Сделка завершена</strong> — ${escapeHtml(COMPLETED_BY[order.completedBy] || "")}${order.completedAt ? ", " + escapeHtml(whenLabel(order.completedAt)) : ""}.</span></div>`;
  }
  if (s === "disputed") {
    return `<div class="notice-box notice-icon notice-danger" style="margin-top:12px;">${icon("triangle-alert", { size: 18 })}<span>
      <strong>Покупатель открыл спор.</strong> Последняя часть выплаты заблокирована до решения администратора платформы — он свяжется с вами.</span></div>`;
  }
  return "";
}

// Заплатил покупатель картой или рассчитается с хозяйством напрямую — это решается при создании
// заказа и записано на нём самом. Хозяйству важно не «как устроена платформа», а один вопрос:
// можно ли брать заказ в работу. Поэтому здесь не статус платежа как термин, а ответ на него.
const FARM_PAYMENT_NOTE = {
  awaiting: ["Заказ ещё не оплачен", "Принять его можно будет сразу после оплаты — она придёт сама."],
  authorized: ["Покупатель оплатил", "Сумма заблокирована на его карте и уйдёт платформе, когда вы примете заказ."],
  captured_partial: ["Деньги у платформы", "Ваша доля выплачивается по шагам, как в списке выше."],
  captured_full: ["Деньги у платформы", "Ваша доля выплачивается по шагам, как в списке выше."],
  cancelled: ["Оплата отменена", "Блокировка с карты покупателя снята."],
  failed: ["Оплата не прошла", "Покупатель может попробовать ещё раз."],
  expired: ["Счёт истёк", "Покупателю нужно создать оплату заново."],
  refund_pending: ["Оформляется возврат", "Деньги возвращаются покупателю."],
  refunded: ["Деньги возвращены покупателю", "По этому заказу расчётов больше не будет."],
};

function paymentNote() {
  const status = order.payment?.status;
  if (!status || status === "not_required") {
    return `<p class="upload-note">Расчёт по этому заказу идёт напрямую с покупателем — платформа
      деньги не держит. Выше видно, как считается ваша доля.</p>`;
  }
  const [title, note] = FARM_PAYMENT_NOTE[status] || ["Оплата", ""];
  return `<div class="notice-box notice-icon" style="margin-top:12px;">
    ${icon("credit-card", { size: 18 })}<span><strong>${escapeHtml(title)}</strong> — ${escapeHtml(note)}</span></div>`;
}

function moneyHtml() {
  const amount = Number(order.amount) || 0;
  const total = order.weighing?.total ?? amount;
  const pct = Number(order.commission?.totalPct ?? 10);
  const net = order.payouts?.net ?? Math.round((total * (100 - pct)) / 100);
  const advance = order.payouts?.advance?.amount ?? Math.round(net / 2);
  const meatPart = order.payouts?.meat?.amount ?? Math.round((net - advance) / 2);
  const finalPart = order.payouts?.final?.amount ?? (net - advance - meatPart);
  const parts = { advance, meat: meatPart, final: finalPart };
  const diff = Number(order.weighing?.difference) || 0;
  const rows = PAYOUT_PARTS.map((p) => {
    const st = order.payouts?.[p.key]?.status || (stageOf(order.status) === "cancelled" ? "cancelled" : "locked");
    return `<div class="money-row"><span>${p.label}<small>${p.when} · ${PAYOUT_STATE[st] || st}</small></span><span>${formatTenge(parts[p.key])}</span></div>`;
  }).join("");
  return `
    <div class="panel">
      <h4 class="eyebrow" style="margin:0 0 10px;">Деньги по заказу</h4>
      <div class="money-row"><span>Сумма заказа</span><span>${formatTenge(amount)}</span></div>
      ${diff ? `<div class="money-row"><span>После взвешивания<small>${diff > 0 ? "доплата" : "возврат"} ${formatTenge(Math.abs(diff))}</small></span><span>${formatTenge(total)}</span></div>` : ""}
      <div class="money-row"><span>Ваша доля<small>за вычетом комиссии платформы ${pct} %</small></span><span><strong>${formatTenge(net)}</strong></span></div>
      ${rows}
      ${paymentNote()}
      ${canCancel(order) && stageOf(order.status) !== "created" ? `
        <button class="btn-pill btn-ghost btn-block" data-act="cancel" style="margin-top:12px;">Отменить заказ</button>
        <p class="upload-note">Отменить можно до забоя — пока не отправлен шаг 2.</p>` : ""}
    </div>`;
}

function render() {
  el.innerHTML = `
    ${headerHtml()}
    <div class="po-layout">
      <div>
        ${contactHtml()}
        ${acceptHtml()}
        ${identifyHtml()}
        ${meatHtml()}
        ${shipHtml()}
        ${handoverHtml()}
        ${outcomeHtml()}
        <p id="po-error" style="color:var(--danger); font-size:14px; margin-top:12px;" hidden></p>
      </div>
      <aside class="po-aside">${moneyHtml()}</aside>
    </div>`;
  wireWeight();
}

// ---- actions --------------------------------------------------------------------------------------

function paintPending(key) {
  const box = el.querySelector(`[data-pending="${key}"]`);
  if (box) box.innerHTML = mediaHtml(pending[key], { removable: true });
  const send = el.querySelector('[data-send="identify"]');
  if (send) send.disabled = !pending.identify.length;
}

async function uploadOne(key, file) {
  const kind = orderFileKind(file);
  if (!ALLOWED[key].includes(kind)) {
    showError(key === "documents" ? "Документ — это фото или PDF." : key === "scale" ? "Снимите весы на фото." : "Нужно фото или видео.");
    return;
  }
  const box = el.querySelector(`[data-progress="${key}"]`);
  const fill = box.querySelector(".progress-fill");
  const caption = box.querySelector(".progress-caption");
  box.hidden = false;
  try {
    const uploaded = await uploadOrderFile(order.partnerId, order.id, file, (p) => {
      fill.style.width = Math.round(p * 100) + "%";
      caption.textContent = `Загружаем «${file.name}» — ${Math.round(p * 100)}%`;
    });
    if (key === "scale") {
      pending.scale.forEach((f) => deleteStoredFile(f.path).catch(console.error));
      pending.scale = [uploaded];
    } else {
      pending[key].push(uploaded);
    }
    paintPending(key);
  } catch (e) {
    console.error(e);
    showError(e?.code === "storage/unauthorized" ? "Хранилище отклонило файл: фото до 15 МБ, видео до 150 МБ или PDF до 20 МБ." : (e?.message || "Не удалось загрузить файл."));
  } finally {
    box.hidden = true;
  }
}

const strip = (list) => list.map(({ url, kind, name }) => ({ url, kind, name }));

async function run(btn, action, payload, onDone) {
  if (busy) return;
  busy = true;
  showError("");
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await orderAction(order.id, action, payload);
    onDone?.();
    await reload();
  } catch (e) {
    console.error(e);
    showError(e?.message || "Не удалось выполнить действие.");
    btn.disabled = false;
    btn.innerHTML = label;
  } finally {
    busy = false;
  }
}

const CONFIRM = {
  cancel: "Отменить заказ? Туша вернётся в продажу.",
  ship: "Отметить, что заказ отправлен покупателю?",
  handover: "Покупатель получил заказ? После этого у него 3 часа, чтобы подтвердить получение или открыть спор.",
};

async function sendStep(step, btn) {
  if (step === "identify") {
    await run(btn, "identify", { files: strip(pending.identify) }, () => { pending.identify = []; });
    return;
  }
  const weightKg = parseFloat(String(el.querySelector("#po-weight")?.value || "").replace(",", "."));
  if (!pending.meat.length) return showError("Снимите готовое мясо — нужно хотя бы одно фото или видео.");
  if (Number(order.pricePerKg) > 0 && !(weightKg > 0)) return showError("Укажите вес по контрольному взвешиванию.");
  await run(btn, "meat_ready", {
    files: strip(pending.meat),
    documents: strip(pending.documents),
    scalePhoto: pending.scale.length ? strip(pending.scale)[0] : null,
    weightKg: weightKg > 0 ? weightKg : null,
  }, () => { pending.meat = []; pending.documents = []; pending.scale = []; });
}

function wireWeight() {
  const input = el.querySelector("#po-weight");
  const out = el.querySelector("#po-weigh-preview");
  if (!input || !out) return;
  input.addEventListener("input", () => {
    const w = parseFloat(input.value.replace(",", "."));
    const perKg = Number(order.pricePerKg) || 0;
    if (!(w > 0) || !perKg) {
      out.textContent = order.estimatedWeightKg ? `Ожидалось ~${kgText(order.estimatedWeightKg)} кг.` : "";
      return;
    }
    const meat = Math.round(perKg * w);
    const total = meat + (Number(order.pricing?.cutting) || 0) + (Number(order.pricing?.delivery) || 0);
    const diff = total - (Number(order.amount) || 0);
    out.textContent = `${kgText(w)} кг × ${formatTenge(perKg)} = ${formatTenge(meat)}. `
      + (diff > 0 ? `Доплата покупателя ${formatTenge(diff)}.` : diff < 0 ? `Возврат покупателю ${formatTenge(-diff)}.` : "Без перерасчёта.");
  });
}

el.addEventListener("change", async (e) => {
  const input = e.target.closest("[data-upload]");
  if (!input) return;
  const files = [...input.files];
  input.value = "";
  for (const file of files) await uploadOne(input.dataset.upload, file);
});

el.addEventListener("click", (e) => {
  const remove = e.target.closest("[data-remove-index]");
  if (remove) {
    const key = remove.closest("[data-pending]").dataset.pending;
    const [gone] = pending[key].splice(Number(remove.dataset.removeIndex), 1);
    if (gone?.path) deleteStoredFile(gone.path).catch(console.error);
    paintPending(key);
    return;
  }
  const act = e.target.closest("[data-act]");
  if (act) {
    if (CONFIRM[act.dataset.act] && !window.confirm(CONFIRM[act.dataset.act])) return;
    run(act, act.dataset.act, {});
    return;
  }
  const send = e.target.closest("[data-send]");
  if (send) sendStep(send.dataset.send, send);
});

async function reload() {
  order = await getOrder(orderId);
  // A buyer who let the 3 hours pass: the deal completes the moment anyone looks at it.
  if (overdue(order)) {
    try {
      await orderAction(order.id, "autocomplete");
      order = await getOrder(orderId);
    } catch (e) {
      console.error(e);
    }
  }
  render();
}

async function init() {
  session = await requirePartner();
  if (!session) return;
  if (!orderId) {
    el.innerHTML = '<div class="empty-state" style="margin-top:18px;">Заказ не указан.</div>';
    return;
  }
  try {
    order = await getOrder(orderId);
    if (!order || order.partnerId !== session.user.uid) {
      el.innerHTML = '<div class="empty-state" style="margin-top:18px;">Такой заказ не найден среди ваших.</div>';
      return;
    }
    document.title = `Заказ — ${order.lotTitle || "лот"} — ET Partners`;
    await reload();
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="empty-state" style="margin-top:18px;">${e?.code === "permission-denied" ? "Такой заказ не найден среди ваших." : "Не удалось загрузить заказ."}</div>`;
  }
}

init();
