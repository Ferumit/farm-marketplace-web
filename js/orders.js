import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requireRealLogin } from "./auth.js";
import {
  getMyOrdersAsBuyer, getMyPurchases, getMyGroupBuys,
  formatTenge, getLot, pluralRu, escapeHtml, purchaseAmount,
} from "./data.js";
import { orderSummary, orderDetails } from "./carcass.js";
import { statusText, statusTone, stageOf, isFinished } from "./order-status.js";

mountLayout();

const listEl = document.getElementById("orders-list");
let uid = null;

// What the buyer can do about an order right now, if anything - the card says it before they open it.
const BUYER_NEXT = {
  shipped: "Подтвердите получение",
  delivered: "Подтвердите получение",
};

// A card opens the order's own tracker (/order?id=), where its steps, photos and weighing are,
// and where the deal is confirmed, disputed or cancelled.
function orderCardHtml(order) {
  const date = order.createdAt?.seconds
    ? new Date(order.createdAt.seconds * 1000).toLocaleDateString("ru-RU") : "";
  const details = orderDetails(order);
  const where = order.delivery?.mode === "pickup"
    ? "Самовывоз из хаба — адрес сообщит фермер"
    : (order.deliveryAddress || "Адрес не указан");
  const next = BUYER_NEXT[stageOf(order.status)];

  return `
    <a class="data-row order-card" href="/order?id=${encodeURIComponent(order.id)}">
      <div class="grow">
        <h4>${escapeHtml(order.lotTitle || "Лот")}</h4>
        <p>${escapeHtml(orderSummary(order))} · ${formatTenge(order.amount)}${date ? " · " + date : ""}</p>
        ${details.length ? `<p>${escapeHtml(details.join(" · "))}</p>` : ""}
        <p style="margin-top:8px;">${icon("map-pin", { size: 14 })} ${escapeHtml(where)}</p>
      </div>
      <div class="order-card__side">
        <span class="status-chip ${statusTone(order)}">${escapeHtml(statusText(order, "buyer"))}</span>
        <span class="order-card__next">${next ? escapeHtml(next) + " →" : "Отслеживание →"}</span>
      </div>
    </a>`;
}

// Orders placed from the mobile app don't create an `orders` document - they only write the
// legacy purchase doc. Show those too, clearly marked, so a buyer's history isn't split in half.
function legacyPurchaseHtml(purchase, lot) {
  const shareWord = pluralRu(purchase.shares, "доля", "доли", "долей");
  return `
    <a class="data-row order-card" href="/orders/${encodeURIComponent(purchase.id)}">
      <div class="grow">
        <h4>${escapeHtml(purchase.lotTitle || "Лот")}</h4>
        <p>${purchase.shares} ${shareWord} · ${formatTenge(purchaseAmount(purchase, lot))}</p>
        <p style="margin-top:8px;" class="progress-caption">Покупка из приложения — без адреса доставки</p>
      </div>
      <div class="order-card__side"><span class="order-card__next">Отслеживание →</span></div>
    </a>`;
}

// A joint purchase that is still filling has no order yet - it lives only on its own page, so it
// belongs at the top of this list or the person who started it would have nowhere to return to.
function groupCardHtml(group) {
  const joined = (group.members || []).length;
  const mine = (group.members || []).find((m) => m.uid === uid);
  return `
    <a class="data-row order-card" href="/group?id=${encodeURIComponent(group.id)}">
      <div class="grow">
        <h4>${icon("users", { size: 15 })} ${escapeHtml(group.lotTitle || "Туша")}</h4>
        <p>Совместная покупка · собрано ${joined} из ${group.size} · ваша доля ${formatTenge(mine?.amount || 0)}</p>
        <p style="margin-top:8px;">${escapeHtml(group.partnerName || "")}</p>
      </div>
      <div class="order-card__side">
        <span class="status-chip booked">Идёт сбор</span>
        <span class="order-card__next">${group.creatorUid === uid ? "Позвать ещё" : "Открыть"} →</span>
      </div>
    </a>`;
}

// A participant who did not gather the group is not the order's buyer, so the order is not in
// their own query - but it is their meat. Their group is what brings them to it.
function memberOrderCardHtml(group) {
  const mine = (group.members || []).find((m) => m.uid === uid);
  return `
    <a class="data-row order-card" href="/order?id=${encodeURIComponent(group.orderId)}">
      <div class="grow">
        <h4>${icon("users", { size: 15 })} ${escapeHtml(group.lotTitle || "Туша")}</h4>
        <p>Совместная покупка · ${group.size} ${pluralRu(group.size, "участник", "участника", "участников")} · ваша доля ${formatTenge(mine?.amount || 0)}</p>
        <p style="margin-top:8px;">${escapeHtml(group.partnerName || "")} · заказ ведёт ${escapeHtml((group.members || [])[0]?.name || "организатор")}</p>
      </div>
      <div class="order-card__side">
        <span class="status-chip open">Вы участник</span>
        <span class="order-card__next">Отслеживание →</span>
      </div>
    </a>`;
}

async function render() {
  const [orders, purchases, groups] = await Promise.all([
    getMyOrdersAsBuyer(uid), getMyPurchases(uid), getMyGroupBuys(uid).catch(() => []),
  ]);
  const openGroups = groups.filter((g) => g.status === "open");
  const memberOrders = groups.filter((g) => g.status === "placed" && g.orderId && g.creatorUid !== uid);

  // A web order writes both an order and a purchase doc for the same lot; don't list it twice.
  const lotIdsWithOrders = new Set(orders.map((o) => o.lotId));
  const legacyOnly = purchases.filter((p) => !lotIdsWithOrders.has(p.lotId));
  const legacyLots = await Promise.all(legacyOnly.map((p) => getLot(p.lotId)));

  const active = orders.filter((o) => !isFinished(o));
  const finished = orders.filter(isFinished);
  const legacy = legacyOnly.map((p, i) => legacyPurchaseHtml(p, legacyLots[i])).join("");

  if (!orders.length && !legacyOnly.length && !openGroups.length && !memberOrders.length) {
    listEl.innerHTML = `<div class="empty-state">У вас пока нет заказов.
      <a href="/#choose" style="color:var(--green)">Выбрать мясо →</a></div>`;
    return;
  }
  listEl.innerHTML = `
    ${openGroups.map(groupCardHtml).join("")}
    ${memberOrders.map(memberOrderCardHtml).join("")}
    ${active.map(orderCardHtml).join("")}
    ${finished.length ? `<h3 style="margin:26px 0 10px;">Завершённые и отменённые</h3>${finished.map(orderCardHtml).join("")}` : ""}
    ${legacy ? `<h3 style="margin:26px 0 10px;">Покупки из приложения</h3>${legacy}` : ""}`;
}

async function init() {
  const user = await requireRealLogin("/orders");
  if (!user) return;
  uid = user.uid;
  try {
    await render();
  } catch (e) {
    console.error(e);
    listEl.innerHTML = '<div class="empty-state">Не удалось загрузить заказы.</div>';
  }
}

init();
