// Совместная покупка (leadership's «складчина»): 2-5 people split one carcass.
//
// The organiser sets everything up at the checkout and shares this page's link; the rest join
// here. The farm sees nothing until the last place is taken - the join that fills it places the
// order for everyone, and from then on this page only points at that order. Nothing is reserved
// while the group fills (see functions/index.js), so the page says plainly what that means.
import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requireRealLogin } from "./auth.js";
import { authReady, isRealUser } from "./firebase-init.js";
import {
  getGroupBuy, getGroupContact, joinGroupBuy, leaveGroupBuy, getLot,
  formatTenge, escapeHtml, pluralRu,
} from "./data.js";
import { FORMAT_LABEL, SLOT_LABEL, weightLabel, availabilityLabel } from "./carcass.js";

mountLayout();

const contentEl = document.getElementById("group-content");
const groupId = new URLSearchParams(window.location.search).get("id") || "";

const STATUS_NOTE = {
  placed: "Все собрались — заказ ушёл хозяйству.",
  failed: "Совместная покупка не состоялась.",
  cancelled: "Организатор отменил сбор.",
};

function seatsHtml(group) {
  const members = group.members || [];
  const rows = [];
  for (let i = 0; i < group.size; i++) {
    const m = members[i];
    const amount = (group.perMember || [])[i];
    rows.push(`
      <div class="seat-row${m ? "" : " free"}">
        <span class="seat-num">${m ? icon("check", { size: 15, stroke: 2.5 }) : i + 1}</span>
        <span class="grow">
          <strong>${m ? escapeHtml(m.name || "Участник") : "Свободное место"}</strong>
          <small>${i === 0 ? "организатор · " : ""}${formatTenge(amount)}</small>
        </span>
      </div>`);
  }
  return rows.join("");
}

function detailsHtml(group, contact) {
  const rows = [
    ["Хозяйство", escapeHtml(group.partnerName || "")],
    ["Формат", `${FORMAT_LABEL[group.format] || ""}${group.estimatedWeightKg ? " · " + weightLabel(group.estimatedWeightKg) : ""}`],
    ["Разделка", group.cutting ? `${escapeHtml(group.cutting.name)} · ${formatTenge(group.cutting.amount)}` : "стандартная, в цене"],
    ["Доставка", group.delivery?.mode === "pickup"
      ? "самовывоз из хаба"
      : `${escapeHtml(group.delivery?.city || "по договорённости")}${group.delivery?.amount ? " · " + formatTenge(group.delivery.amount) : ""}`],
    ...(group.deliveryDate ? [["Дата", `${escapeHtml(group.deliveryDate.split("-").reverse().join("."))}${group.deliverySlot ? " · " + (SLOT_LABEL[group.deliverySlot] || "") : ""}`]] : []),
    ...(contact?.deliveryAddress ? [["Адрес", escapeHtml(contact.deliveryAddress)]] : []),
  ];
  return rows.map(([k, v]) => `<div class="money-row"><span>${k}</span><span>${v}</span></div>`).join("");
}

function actionsHtml(group, uid, lot) {
  const joined = (group.members || []).length;
  const isMember = (group.memberUids || []).includes(uid);
  const isCreator = group.creatorUid === uid;

  if (group.status === "placed") {
    return `<a class="btn-pill btn-primary btn-block" href="/order?id=${encodeURIComponent(group.orderId)}">Открыть заказ →</a>
      <p class="cfg-hint" style="margin-top:8px;">Шаги хозяйства, взвешивание и документы — в заказе. Получение подтверждает организатор.</p>`;
  }
  if (group.status === "failed" || group.status === "cancelled") {
    return `<div class="notice-box notice-icon">${icon("triangle-alert", { size: 18 })}<span>${escapeHtml(STATUS_NOTE[group.status])}
      ${escapeHtml(group.failedReason || "")} Деньги никто не вносил.</span></div>
      <a class="btn-pill btn-secondary btn-block" style="margin-top:12px;" href="/lots/${encodeURIComponent(group.lotId)}">Посмотреть тушу →</a>`;
  }

  // Still filling. The carcass is not held, so say so before someone counts on it.
  const gone = lot && lot.status !== "open";
  const left = group.size - joined;
  return `
    ${gone ? `<div class="notice-box notice-icon notice-danger" style="margin-bottom:12px;">${icon("triangle-alert", { size: 18 })}<span>
      Эту тушу уже забронировали. Сбор можно закрыть — заказ не получится оформить.</span></div>` : ""}
    ${isMember
      ? `<p style="font-size:14px; margin:0 0 12px;">Вы в этой покупке. Осталось найти ${left} ${pluralRu(left, "человека", "человек", "человек")} —
         поделитесь ссылкой.</p>`
      : `<button class="btn-pill btn-primary btn-block" data-group="join">Участвовать · ${formatTenge((group.perMember || [])[joined] || 0)}</button>
         <p class="cfg-hint" style="margin:6px 0 12px;">Место закрепится за вами. Заказ уйдёт хозяйству, когда соберутся все ${group.size}.</p>`}
    <button class="btn-pill btn-secondary btn-block" data-group="copy">${icon("link", { size: 16 })} Скопировать ссылку</button>
    ${isMember ? `<button class="btn-pill btn-ghost btn-block" data-group="leave" style="margin-top:10px;">
      ${isCreator ? "Отменить сбор" : "Выйти из покупки"}</button>` : ""}`;
}

function render(group, uid, contact, lot) {
  const joined = (group.members || []).length;
  const pct = Math.round((joined / group.size) * 100);
  contentEl.innerHTML = `
    <span class="eyebrow">${icon("users", { size: 15 })} Совместная покупка</span>
    <h1 style="margin-top:6px;">${escapeHtml(group.lotTitle || "Туша")}</h1>
    <p>${escapeHtml(group.partnerName || "")} · ${FORMAT_LABEL[group.format] || ""} · ${formatTenge(group.amount)} на всех</p>
    <div class="group-layout" style="margin-top:20px;">
      <div class="panel">
        <div class="progress-row">
          <div class="progress-labels"><span>Собрано ${joined} из ${group.size}</span><span class="value">${pct}%</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        <div style="margin-top:14px;">${seatsHtml(group)}</div>
      </div>
      <div>
        <div class="panel">${actionsHtml(group, uid, lot)}
          <p id="group-error" style="color:var(--danger); font-size:14px; margin-top:10px;" hidden></p></div>
        <div class="panel" style="margin-top:16px;">
          <h4 class="eyebrow" style="margin-bottom:10px;">Что заказываем</h4>
          ${detailsHtml(group, contact)}
          <div class="money-row"><span><strong>Итого на всех</strong></span><span><strong>${formatTenge(group.amount)}</strong></span></div>
          ${group.pricePerKg ? '<p class="cfg-hint">Итог за мясо уточнится после контрольного взвешивания — доплату или возврат делите так же.</p>' : ""}
        </div>
        ${lot ? `<p class="cfg-hint" style="margin-top:12px;">Туша сейчас: ${escapeHtml(availabilityLabel(lot).toLowerCase())}. Пока идёт сбор, она не забронирована.</p>` : ""}
      </div>
    </div>`;
}

async function init() {
  if (!groupId) {
    contentEl.innerHTML = '<div class="empty-state">Совместная покупка не указана.</div>';
    return;
  }
  const user = await authReady;
  const uid = isRealUser(user) ? user.uid : null;

  const load = async () => {
    const group = await getGroupBuy(groupId);
    if (!group) {
      contentEl.innerHTML = '<div class="empty-state">Такой совместной покупки нет — возможно, ссылка устарела.</div>';
      return null;
    }
    document.title = `Совместная покупка — ${group.lotTitle || "туша"} — ET`;
    // The address is readable by the people in the group only; the lot tells whether the carcass
    // is still free while the group fills.
    const [contact, lot] = await Promise.all([
      getGroupContact(groupId).catch(() => null),
      getLot(group.lotId).catch(() => null),
    ]);
    render(group, uid, contact, lot);
    return group;
  };

  contentEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-group]");
    if (!btn) return;
    const what = btn.dataset.group;

    if (what === "copy") {
      try {
        await navigator.clipboard.writeText(window.location.href);
        btn.innerHTML = icon("check", { size: 16 }) + " Ссылка скопирована";
        setTimeout(() => { btn.innerHTML = icon("link", { size: 16 }) + " Скопировать ссылку"; }, 2000);
      } catch (e2) {
        console.error(e2);
      }
      return;
    }
    // Joining is the first thing that needs a real account - anonymous visitors read the page
    // and are sent to log in only here, coming back to this same link.
    if (!(await requireRealLogin())) return;
    const err = contentEl.querySelector("#group-error");
    err.hidden = true;
    btn.disabled = true;
    try {
      if (what === "join") {
        const res = await joinGroupBuy(groupId);
        // The last place places the order: go straight to it.
        if (res?.orderId) {
          window.location.href = `/order?id=${encodeURIComponent(res.orderId)}`;
          return;
        }
      }
      if (what === "leave") {
        const isCreator = btn.textContent.includes("Отменить");
        const ask = isCreator
          ? "Отменить сбор? Остальные участники получат уведомление."
          : "Выйти из совместной покупки?";
        if (!window.confirm(ask)) { btn.disabled = false; return; }
        await leaveGroupBuy(groupId);
      }
      await load();
    } catch (e2) {
      console.error(e2);
      err.textContent = e2?.message || "Не удалось выполнить действие.";
      err.hidden = false;
      btn.disabled = false;
    }
  });

  try {
    await load();
  } catch (e) {
    console.error(e);
    contentEl.innerHTML = '<div class="empty-state">Не удалось загрузить совместную покупку.</div>';
  }
}

init();
