// Leadership's window 1.5 - the buyer's view of one order: its steps as they happen, with what the
// farm filmed and weighed and the documents it attached; «Сделка завершена» once the meat is in
// hand (or the deal completes by itself 3 hours after handover); a dispute at delivery, which holds
// the farm's last payout; cancelling while the animal is still alive.
import { icon } from "./icons.js";
import {
  getOrder, getPartner, orderAction, uploadDisputeFile, getMyOrderDisputes, formatTenge, escapeHtml,
  getOrderReview, submitReview, pluralRu, startPayment,
} from "./data.js";
import { orderSummary, orderDetails } from "./carcass.js";
import {
  stageOf, statusText, statusTone, reached, canCancel, canConfirm, COMPLETED_BY, whenLabel, overdue,
} from "./order-status.js";
import { mediaHtml, docLinksHtml } from "./media.js";

const OUTCOME_FOR_BUYER = {
  buyer: "В вашу пользу",
  partner: "В пользу хозяйства",
  partial: "Частично в вашу пользу",
  withdrawn: "Претензия отозвана",
};

const kgText = (w) => String(Math.round(Number(w) * 10) / 10).replace(".", ",");

function weighingForBuyer(order) {
  const w = order.weighing;
  if (!w) return "";
  const diff = Number(w.difference) || 0;
  const money = w.meat == null ? ""
    : ` Итог заказа — <strong>${formatTenge(w.total)}</strong>${diff > 0 ? `, доплата ${formatTenge(diff)}` : diff < 0 ? `, возврат вам ${formatTenge(-diff)}` : ", без перерасчёта"}.`;
  return `<p style="font-size:14px; margin:10px 0 0;">${icon("scale", { size: 16 })} Контрольное взвешивание: <strong>${kgText(w.weightKg)} кг</strong>${order.estimatedWeightKg ? ` (ожидалось ~${kgText(order.estimatedWeightKg)} кг)` : ""}.${money}</p>
    ${w.scalePhoto ? mediaHtml([w.scalePhoto]) : ""}`;
}

function timelineHtml(order) {
  const pickup = order.delivery?.mode === "pickup";
  const meat = order.steps?.meat;
  const steps = [
    { stage: "created", title: "Заказ оформлен", when: order.createdAt, body: escapeHtml(orderDetails(order).join(" · ")) },
    { stage: "accepted", title: "Хозяйство приняло заказ", when: order.acceptedAt },
    { stage: "animal_selected", title: "Животное выбрано", when: order.steps?.identify?.at, body: mediaHtml(order.steps?.identify?.files) },
    {
      stage: "meat_ready", title: "Мясо готово", when: meat?.at,
      body: meat ? `${mediaHtml(meat.files)}${weighingForBuyer(order)}
        ${docLinksHtml([...(meat.certificates || []), ...(meat.documents || []).map((d) => ({ ...d, label: d.name || "Документ" }))])}` : "",
    },
    { stage: "shipped", title: pickup ? "Готов к выдаче" : "Заказ в пути", when: order.steps?.shipped?.at },
    { stage: "delivered", title: "Передан вам", when: order.steps?.handover?.at },
    {
      stage: "completed", title: "Сделка завершена", when: order.completedAt,
      body: stageOf(order.status) === "completed" ? escapeHtml(COMPLETED_BY[order.completedBy] || "") : "",
    },
  ];
  const cancelled = stageOf(order.status) === "cancelled";
  let currentFound = false;
  return `<div class="timeline">${steps.map((s) => {
    const done = reached(order, s.stage);
    let state = done ? "completed" : "pending";
    if (!done && !currentFound && !cancelled) { state = "current"; currentFound = true; }
    return `
      <div class="timeline-step ${state}">
        <div class="timeline-dot">${state === "completed" ? icon("check", { size: 14, stroke: 2.5 }) : state === "current" ? "●" : ""}</div>
        <div class="timeline-card">
          <div class="row-top"><h4>${escapeHtml(s.title)}</h4>${done && s.when ? `<time>${escapeHtml(whenLabel(s.when))}</time>` : ""}</div>
          ${done && s.body ? `<div style="font-size:13px; margin-top:6px;">${s.body}</div>` : ""}
        </div>
      </div>`;
  }).join("")}</div>`;
}

// A joint purchase is one order with 2-5 people behind it. Everyone follows it; the one who
// gathered them is the one who confirms, disputes or cancels - an order cannot take two answers.
function groupHtml(order, isBuyer) {
  const g = order.group;
  if (!g) return "";
  const members = (g.members || []).map((m) =>
    `<div class="money-row"><span>${escapeHtml(m.name || "Участник")}${m.uid === order.buyerUid ? " · организатор" : ""}</span><span>${formatTenge(m.amount)}</span></div>`).join("");
  return `
    <div class="panel" style="margin-top:16px;">
      <h4 class="eyebrow" style="margin-bottom:10px;">${icon("users", { size: 16 })} Совместная покупка</h4>
      <p style="font-size:14px; margin:0 0 10px;">${g.size} ${pluralRu(g.size, "участник", "участника", "участников")} делят эту тушу.
        ${isBuyer
          ? "Вы организатор: оплачиваете всю сумму и подтверждаете получение. Ниже — сколько вам должен каждый."
          : "Организатор оплачивает всю сумму и подтверждает получение. Свою долю переведите ему."}</p>
      ${members}
    </div>`;
}

// The review opens only after the deal is completed, and only for the buyer of that deal - the
// server checks the same thing. Nothing appears on the farm's page until a moderator reads it.
function reviewHtml(order, review, isBuyer) {
  if (stageOf(order.status) !== "completed" || !isBuyer) return "";
  const head = '<h4 class="eyebrow" style="margin-bottom:10px;">Отзыв о хозяйстве</h4>';
  if (review) {
    const state = review.status === "published" ? "Опубликован на странице хозяйства."
      : review.status === "rejected" ? `Не опубликован. ${escapeHtml(review.moderationNote || "")}`
        : "Отправлен на проверку — появится на странице хозяйства после модерации.";
    return `<div class="panel" style="margin-top:16px;">${head}
      <p style="font-size:14px; margin:0;">${"★".repeat(review.rating)}${"☆".repeat(5 - review.rating)} — ${state}</p>
      ${review.text ? `<p class="claim-text" style="font-size:13px; margin-top:8px;">${escapeHtml(review.text)}</p>` : ""}</div>`;
  }
  return `
    <div class="panel" style="margin-top:16px;">${head}
      <p style="font-size:14px; margin:0 0 10px;">Как прошла сделка? Оценку увидят другие покупатели — после проверки модератором.</p>
      <div class="star-pick" id="rv-stars">
        ${[1, 2, 3, 4, 5].map((i) => `<button type="button" data-star="${i}" aria-label="${i} из 5">★</button>`).join("")}
      </div>
      <div class="field" style="margin-top:12px;"><label for="rv-text">Что стоит знать другим</label>
        <textarea id="rv-text" maxlength="1500" placeholder="Мясо, упаковка, связь с фермером, доставка"></textarea></div>
      <p id="rv-error" style="color:var(--danger); font-size:14px;" hidden></p>
      <button class="btn-pill btn-primary btn-block" id="rv-send" disabled>Отправить отзыв</button>
    </div>`;
}

function actionsHtml(order, disputes, isBuyer) {
  const s = stageOf(order.status);
  const latest = disputes[0];
  if (!isBuyer) {
    return `<p style="font-size:14px; margin:0;">Вы участник совместной покупки. Шаги хозяйства видны здесь,
      а получение подтверждает организатор заказа.</p>`;
  }
  if (s === "cancelled") {
    return `<p style="font-size:14px; margin:0;">Заказ отменён${order.cancelledBy === "partner" ? " хозяйством" : ""}.</p>`;
  }
  if (s === "disputed") {
    const state = latest?.status === "in_review" ? "на рассмотрении у администратора" : "отправлена, ждёт рассмотрения";
    return `<div class="notice-box notice-icon">${icon("clock", { size: 18 })}<span><strong>Претензия ${state}.</strong>
      Администратор свяжется с вами по номеру из заказа.</span></div>
      ${latest ? `<p style="font-size:13px; margin-top:10px;" class="claim-text">${escapeHtml(latest.description || "")}</p>` : ""}`;
  }
  if (s === "completed") {
    const decided = latest?.resolution ? `<div class="notice-box notice-icon" style="margin-top:10px;">${icon("check", { size: 18 })}<span>
      <strong>${escapeHtml(OUTCOME_FOR_BUYER[latest.resolution.outcome] || "Претензия рассмотрена")}.</strong>
      <span class="claim-text">${escapeHtml(latest.resolution.note || "")}</span></span></div>` : "";
    return `<p style="font-size:14px; margin:0;">Сделка завершена — ${escapeHtml(COMPLETED_BY[order.completedBy] || "")}.</p>${decided}`;
  }
  const confirm = canConfirm(order) ? `
    <button class="btn-pill btn-primary btn-block" data-track="complete">${icon("check", { size: 16 })} Сделка завершена</button>
    <p class="cfg-hint" style="margin:6px 0 12px;">Нажмите, когда мясо у вас и всё в порядке.</p>
    <button class="btn-pill btn-rust btn-block" data-track="dispute">${icon("triangle-alert", { size: 16 })} Оспорить качество</button>
    <p class="cfg-hint" style="margin:6px 0 0;">Запах, температура, не те куски — спор остановит последнюю выплату хозяйству до решения платформы.</p>
    ${s === "delivered" && order.autoCompleteAt ? `<p class="notice-box" style="margin-top:12px; font-size:13px;">Если ничего не нажать, сделка завершится
      автоматически ${escapeHtml(whenLabel(order.autoCompleteAt))} — через 3 часа после передачи.</p>` : ""}` : "";
  const cancel = canCancel(order) ? `
    <button class="btn-pill btn-ghost btn-block" data-track="cancel" style="margin-top:10px;">Отменить заказ</button>
    <p class="cfg-hint" style="margin:6px 0 0;">Отменить можно до забоя.</p>` : "";
  if (!confirm && !cancel) return '<p style="font-size:14px; margin:0;">Хозяйство готовит заказ — здесь появятся фото и видео каждого этапа.</p>';
  return confirm + cancel;
}

// Платёжная ось заказа словами покупателя. `not_required` — пилот без онлайн-оплаты: расчёт
// напрямую с хозяйством, и говорить про оплату на странице тогда нечего.
const PAYMENT_TEXT = {
  awaiting: ["Ждёт оплаты", "Заказ забронирован. Хозяйство начнёт работу после оплаты."],
  authorized: ["Оплачено", "Сумма заблокирована на карте и спишется, когда хозяйство примет заказ."],
  captured_partial: ["Оплачено", "Деньги у платформы."],
  captured_full: ["Оплачено", "Деньги у платформы."],
  cancelled: ["Оплата отменена", "Блокировка снята, деньги остались на карте."],
  failed: ["Оплата не прошла", "Деньги не списаны. Можно попробовать ещё раз."],
  expired: ["Счёт истёк", "Ссылка на оплату больше не действует. Создайте новую."],
  refund_pending: ["Оформляется возврат", "Деньги вернутся на ту же карту."],
  refunded: ["Возвращено", "Деньги вернулись на карту, которой была оплата."],
};

function paymentHtml(order, checking, isBuyer) {
  const status = order.payment?.status;
  if (!status || status === "not_required") {
    return `<p class="cfg-hint">Онлайн-оплата подключается отдельным этапом. Сейчас расчёт —
      и доплату или возврат после взвешивания — вы согласуете с хозяйством напрямую.</p>`;
  }
  // Человек вернулся со страницы оплаты быстрее, чем их сервер достучался до нас. Говорим об
  // этом прямо, вместо того чтобы показывать «ждёт оплаты» тому, кто только что заплатил.
  if (checking) {
    return `<div class="money-row"><span>Оплата<small>Проверяем у платёжного сервиса…</small></span>
      <span><strong>Проверяем</strong></span></div>`;
  }
  const [title, note] = PAYMENT_TEXT[status] || ["Оплата", ""];
  // Кнопка только там, где оплата действительно возможна: заказ ещё ждёт денег, ещё не ушёл
  // дальше по работе хозяйства — и смотрит тот, кто платит. Складчину оплачивает организатор
  // одной суммой за всех; участнику сервер откажет, а кнопка, которая всегда падает, хуже, чем
  // её отсутствие.
  const awaitsMoney = ["awaiting", "failed", "expired"].includes(status);
  const canPay = awaitsMoney && stageOf(order.status) === "created" && isBuyer;
  return `
    <div class="money-row"><span>Оплата<small>${escapeHtml(note)}</small></span><span><strong>${escapeHtml(title)}</strong></span></div>
    ${canPay ? `<button class="btn-pill btn-primary btn-block" id="btn-pay" style="margin-top:12px;">
      ${icon("credit-card", { size: 16 })} Оплатить ${formatTenge(order.weighing?.total ?? order.amount)}</button>
      <p id="pay-error" style="color:var(--danger); font-size:14px; margin-top:8px;" hidden></p>` : ""}
    ${!isBuyer && order.group && awaitsMoney
      ? `<p class="cfg-hint" style="margin-top:8px;">Оплачивает организатор — одной суммой за всех.
          Свою долю переведите ему.</p>` : ""}
    ${receiptHtml("чек", order.fiscal)}
    ${receiptHtml("чек возврата", order.fiscalReturn)}`;
}

// Чек выбивает касса ХОЗЯЙСТВА, под его БИН: продавец мяса — оно, а не площадка. Печатать нам
// нечего, зато по ссылке открывается тот же документ, что ушёл в налоговую.
//
// Пока контур re:Kassa тестовый, чек так и подписан — «Тестовый чек». Назвать его фискальным
// значило бы соврать: по ссылке откроется документ, которого налоговая не видела. Признак
// приходит с сервера вместе с чеком, страница его не угадывает.
function receiptHtml(what, fiscal) {
  const url = fiscal?.url;
  if (!url) return "";
  const number = fiscal.ticketNumber ? `№ ${escapeHtml(fiscal.ticketNumber)}` : "Открыть";
  const test = fiscal.test === true;
  const name = `${test ? "Тестовый" : "Фискальный"} ${what}`;
  const note = test ? `${number} · пробный, в налоговую не ушёл` : number;
  return `<div class="money-row"><span>${escapeHtml(name)}<small>${note}</small></span>
    <span><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Посмотреть</a></span></div>`;
}

function moneyHtml(order, checking, isBuyer) {
  const w = order.weighing;
  const diff = Number(w?.difference) || 0;
  return `
    <div class="money-row"><span>Сумма заказа<small>${escapeHtml(orderSummary(order))}</small></span><span>${formatTenge(order.amount)}</span></div>
    ${w && w.meat != null ? `<div class="money-row"><span>После взвешивания<small>${diff > 0 ? "доплата" : diff < 0 ? "возврат" : "без перерасчёта"}${diff ? " " + formatTenge(Math.abs(diff)) : ""}</small></span><span><strong>${formatTenge(w.total)}</strong></span></div>` : ""}
    ${paymentHtml(order, checking, isBuyer)}`;
}

function openDisputeModal(order, user, onDone) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-label="Оспорить качество">
      <div class="row-top"><h3 style="margin:0;">Оспорить качество</h3><button class="modal-close" aria-label="Закрыть">×</button></div>
      <p style="font-size:14px;">Опишите проблему: запах, температура, несоответствие кусков. Претензия уходит администратору
        платформы, а последняя выплата хозяйству останавливается до решения.</p>
      <div class="field"><label for="dsp-text">Что не так</label><textarea id="dsp-text" maxlength="2000"></textarea></div>
      <div class="field"><label for="dsp-file">Фото или видео</label><input type="file" id="dsp-file" accept="image/*,video/*" capture="environment"></div>
      <p id="dsp-error" style="color:var(--danger); font-size:14px;" hidden></p>
      <button class="btn-pill btn-rust btn-block" id="dsp-send">Отправить в арбитраж платформы</button>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".modal-close").addEventListener("click", close);
  overlay.querySelector("#dsp-send").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const err = overlay.querySelector("#dsp-error");
    const description = overlay.querySelector("#dsp-text").value.trim();
    const file = overlay.querySelector("#dsp-file").files[0];
    err.hidden = true;
    if (description.length < 5) { err.textContent = "Опишите проблему."; err.hidden = false; return; }
    btn.disabled = true;
    btn.textContent = "Отправка…";
    try {
      const mediaUrl = file ? await uploadDisputeFile(user.uid, order.id, file) : null;
      await orderAction(order.id, "dispute", { description, mediaUrl });
      close();
      onDone();
    } catch (e2) {
      console.error(e2);
      err.textContent = e2?.message || "Не удалось отправить. Попробуйте ещё раз.";
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "Отправить в арбитраж платформы";
    }
  });
}

export async function initOrderTracking(contentEl, orderId, user) {
  let order = null;
  let partner = null;
  let review = null;
  // Возврат со страницы оплаты: пока перепроверяем статус, панель денег говорит «проверяем».
  let checkingPayment = false;
  let stars = 0;
  // The buyer of the order - for a joint purchase, the one who gathered it. Everyone else in the
  // group follows the same page without its decisions.
  const isBuyer = () => order?.buyerUid === user.uid;

  const load = async () => {
    order = await getOrder(orderId);
    // Only a party to the order may close an overdue one; a participant of a joint purchase is
    // not one, and would just be refused.
    if (order && overdue(order) && order.buyerUid === user.uid) {
      try {
        await orderAction(order.id, "autocomplete");
        order = await getOrder(orderId);
      } catch (e) {
        console.error(e);
      }
    }
  };

  const render = async () => {
    const disputes = order.disputeId ? await getMyOrderDisputes(user.uid, order.id).catch(() => []) : [];
    const wa = String(partner?.phone || "").replace(/[^\d]/g, "");
    if (stageOf(order.status) === "completed" && isBuyer() && review === null) {
      review = await getOrderReview(order.id).catch(() => null);
    }
    contentEl.innerHTML = `
      <span class="eyebrow">Отслеживание</span>
      <h1 style="margin-top:6px;">${escapeHtml(order.lotTitle || "Заказ")}</h1>
      <p>${escapeHtml(orderSummary(order))} · ${formatTenge(order.amount)}
        <span class="status-chip ${statusTone(order)}" style="margin-left:6px;">${escapeHtml(statusText(order, "buyer"))}</span></p>
      <div class="order-layout" style="margin-top:20px;">
        <div class="panel">${timelineHtml(order)}</div>
        <div>
          <div class="panel">${actionsHtml(order, disputes, isBuyer())}<p id="track-error" style="color:var(--danger); font-size:14px;" hidden></p></div>
          ${reviewHtml(order, review, isBuyer())}
          ${groupHtml(order, isBuyer())}
          <div class="panel" style="margin-top:16px;"><h4 class="eyebrow" style="margin-bottom:10px;">Деньги</h4>${moneyHtml(order, checkingPayment, isBuyer())}</div>
          <div class="panel" style="margin-top:16px;">
            <h4 class="eyebrow" style="margin-bottom:10px;">Связь с хозяйством</h4>
            ${wa ? `<a class="btn-pill btn-secondary btn-block" href="https://wa.me/${escapeHtml(wa)}" target="_blank" rel="noopener">${icon("message-circle", { size: 16 })} ${escapeHtml(partner?.displayName || "Хозяйство")} в WhatsApp</a>`
              : '<p style="font-size:14px; margin:0;">Контакт хозяйства пока не указан.</p>'}
          </div>
        </div>
      </div>`;
  };

  const act = async (btn, action, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    const err = contentEl.querySelector("#track-error");
    btn.disabled = true;
    try {
      await orderAction(order.id, action);
      await load();
      await render();
    } catch (e) {
      console.error(e);
      err.textContent = e?.message || "Не удалось выполнить действие.";
      err.hidden = false;
      btn.disabled = false;
    }
  };

  /** Уводит на страницу оплаты Freedom Pay. Ссылку выдаёт сервер, не браузер. */
  const pay = async (btn) => {
    const err = contentEl.querySelector("#pay-error");
    if (err) err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Открываем оплату…";
    try {
      const { redirectUrl } = await startPayment(order.id);
      if (!redirectUrl) throw new Error("Платёжный сервис не дал ссылку.");
      window.location.href = redirectUrl;
    } catch (e) {
      console.error(e);
      if (err) {
        err.textContent = e?.message || "Не удалось начать оплату. Попробуйте ещё раз.";
        err.hidden = false;
      }
      btn.disabled = false;
      await render();
    }
  };

  const sendReview = async (btn) => {
    const err = contentEl.querySelector("#rv-error");
    const text = contentEl.querySelector("#rv-text").value.trim();
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Отправляем…";
    try {
      await submitReview({ orderId: order.id, rating: stars, text });
      review = await getOrderReview(order.id).catch(() => ({ rating: stars, text, status: "pending" }));
      await render();
    } catch (e) {
      console.error(e);
      err.textContent = e?.message || "Не удалось отправить отзыв.";
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "Отправить отзыв";
    }
  };

  contentEl.addEventListener("click", (e) => {
    const star = e.target.closest("[data-star]");
    if (star) {
      stars = Number(star.dataset.star);
      contentEl.querySelectorAll("[data-star]").forEach((b) => {
        b.classList.toggle("on", Number(b.dataset.star) <= stars);
      });
      contentEl.querySelector("#rv-send").disabled = false;
      return;
    }
    if (e.target.closest("#rv-send")) return sendReview(e.target.closest("#rv-send"));
    if (e.target.closest("#btn-pay")) return pay(e.target.closest("#btn-pay"));
    const btn = e.target.closest("[data-track]");
    if (!btn) return;
    const what = btn.dataset.track;
    if (what === "complete") act(btn, "complete", "Подтвердите: мясо у вас и всё в порядке? После этого сделка закроется.");
    if (what === "cancel") act(btn, "cancel", "Отменить заказ? Хозяйство ещё не приступило к забою.");
    if (what === "dispute") openDisputeModal(order, user, async () => { await load(); await render(); });
  });

  try {
    await load();
    // Both the buyer and, for a joint purchase, everyone in the group may follow the order.
    const mine = order && (order.buyerUid === user.uid || (order.memberUids || []).includes(user.uid));
    if (!mine) {
      contentEl.innerHTML = '<div class="empty-state">Заказ не найден среди ваших.</div>';
      return;
    }
    partner = await getPartner(order.partnerId).catch(() => null);
    document.title = (order.lotTitle || "Заказ") + " — ET";
    await render();

    // Возврат со страницы оплаты. Параметру ?paid НЕ верим: правду о деньгах пишет вебхук, а он
    // мог ещё не дойти — человек возвращается в браузер быстрее, чем их сервер стучится к нам.
    // Поэтому несколько раз перечитываем заказ и перерисовываем, когда статус изменится. Если
    // не дождались — страница просто покажет то, что есть, и кнопку «Оплатить».
    const returned = new URLSearchParams(window.location.search).has("paid");
    if (returned) {
      // Убираем параметр из адреса, чтобы обновление страницы не запускало проверку заново.
      history.replaceState(null, "", `/order?id=${encodeURIComponent(order.id)}`);
      if (order.payment?.status === "awaiting") {
        checkingPayment = true;
        await render();
        for (let i = 0; i < 7 && order.payment?.status === "awaiting"; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          await load();
        }
        checkingPayment = false;
        await render();
      }
    }
  } catch (e) {
    console.error(e);
    contentEl.innerHTML = `<div class="empty-state">${e?.code === "permission-denied" ? "Заказ не найден среди ваших." : "Не удалось загрузить заказ."}</div>`;
  }
}
