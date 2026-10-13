// Leadership's window 2.1 - the farm's desk: orders as cards, coloured by status, each saying what
// the farm has to do next. A card opens the order (cabinet/order.html), where the steps are taken.
import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requirePartner } from "./auth.js";
import { mountCabinetNav, renderStatusNote } from "./partner-nav.js";
import { getOrdersForPartner, formatTenge, escapeHtml } from "./data.js";
import { orderSummary, orderDetails } from "./carcass.js";
import { statusText, statusTone, isFinished, stageOf, whenLabel } from "./order-status.js";

mountLayout();
mountCabinetNav("/cabinet/orders");

const listEl = document.getElementById("orders-list");

// What the farm does next, per stage.
const NEXT = {
  created: "Примите заказ",
  accepted: "Шаг 1: снимите животное",
  animal_selected: "Шаг 2: мясо, документы, взвешивание",
  meat_ready: "Шаг 3: отправьте заказ",
  shipped: "Шаг 4: отметьте передачу",
  delivered: "Ждём подтверждения покупателя",
  disputed: "Спор у администратора",
};

function cardHtml(order) {
  const details = orderDetails(order);
  const where = order.delivery?.mode === "pickup" ? "Самовывоз из хаба" : (order.deliveryAddress || "Адрес не указан");
  const next = NEXT[stageOf(order.status)];
  return `
    <a class="data-row order-card" href="/cabinet/order?id=${encodeURIComponent(order.id)}">
      <div class="grow">
        <h4>${escapeHtml(order.lotTitle || "Лот")}</h4>
        <p>${escapeHtml(orderSummary(order))} · ${formatTenge(order.amount)}${order.createdAt ? " · " + escapeHtml(whenLabel(order.createdAt)) : ""}</p>
        ${details.length ? `<p>${escapeHtml(details.join(" · "))}</p>` : ""}
        <p style="margin-top:8px;">${icon("map-pin", { size: 14 })} ${escapeHtml(where)}</p>
      </div>
      <div class="order-card__side">
        <span class="status-chip ${statusTone(order)}">${escapeHtml(statusText(order, "farm"))}</span>
        ${next ? `<span class="order-card__next">${escapeHtml(next)} →</span>` : '<span class="order-card__next">Открыть →</span>'}
      </div>
    </a>`;
}

async function render(uid) {
  const orders = await getOrdersForPartner(uid);
  if (!orders.length) {
    listEl.innerHTML = `<div class="empty-state">Заказов пока нет. Они появятся здесь, как только покупатель
      оформит заказ на одну из ваших опубликованных туш.</div>`;
    return;
  }
  const active = orders.filter((o) => !isFinished(o));
  const finished = orders.filter(isFinished);
  listEl.innerHTML = `
    <h3 style="margin:0 0 10px;">В работе <span class="progress-caption" style="margin:0;">${active.length}</span></h3>
    ${active.length ? active.map(cardHtml).join("") : '<div class="empty-state">Активных заказов нет.</div>'}
    ${finished.length ? `<h3 style="margin:26px 0 10px;">Завершённые и отменённые</h3>${finished.map(cardHtml).join("")}` : ""}`;
}

async function init() {
  const session = await requirePartner();
  if (!session) return;
  renderStatusNote(session.profile, session.user.uid);
  try {
    await render(session.user.uid);
  } catch (e) {
    console.error(e);
    // A missing composite index surfaces as failed-precondition with a console link to create it.
    listEl.innerHTML = '<div class="empty-state">Не удалось загрузить заказы.</div>';
  }
}

init();
