// Leadership's window 1.4 - checkout: one delivery address, the date and time wanted, and the order
// summary. Until online payment is switched on, confirming books the carcass and the buyer settles
// with the farm directly; then this button becomes «Оплатить 100 %». The amounts shown here are a
// preview - createOrder works them out again from the lot and the farm's storefront.
import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requireRealLogin, getMyProfile } from "./auth.js";
import { authReady, isRealUser } from "./firebase-init.js";
import {
  getLot, getPartner, placeOrder, createGroupBuy, newIdempotencyKey, clearCartItems,
  formatTenge, escapeHtml, isSellingPartner, pluralRu, startPayment,
} from "./data.js";
import { loadCartLines } from "./cart.js";
import { partnerPlaceLabel } from "./regions.js";
import { FORMAT_LABEL, SLOT_LABEL, formatsOf, quote, deliveryOptions, weightLabel } from "./carcass.js";

mountLayout();

const el = document.getElementById("checkout-content");
const params = new URLSearchParams(window.location.search);
// The same page gathers a joint purchase: same carcass, same delivery, but the cost is split
// between 2-5 people and the order waits until they are all in.
const groupMode = params.get("group") === "1";
// ...and it also places everything in the cart at once, one order per carcass.
const cartMode = params.get("cart") === "1";
let cartUid = null;
const choice = {
  lotId: params.get("lot") || "",
  format: params.get("format") || "",
  cuttingId: params.get("cut") || "",
  deliveryId: params.get("del") || "",
  size: 2,
};

/** Even shares, the odd tenge on the organiser - the same split the server makes. */
function splitAmount(total, size) {
  const each = Math.floor(total / size);
  return { mine: total - each * (size - 1), each };
}
// One key for this page: a retry after a lost answer returns the order already made instead of
// booking the carcass twice.
const idempotencyKey = newIdempotencyKey();

const pad = (n) => String(n).padStart(2, "0");
function dayFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function message(html) {
  el.innerHTML = `<div class="empty-state" style="margin-top:20px;">${html}</div>`;
}

function summaryHtml(lot, partner, q, options) {
  const deliveryLabel = !options.length ? "по договорённости с хозяйством"
    : choice.deliveryId === "pickup" ? "самовывоз из хаба"
    : escapeHtml(q.del?.city || "");
  return `
    <h3>${escapeHtml(lot.name)}</h3>
    <p class="muted">${escapeHtml(partner.displayName || "")} · ${escapeHtml(partnerPlaceLabel(partner) || "")}</p>
    <div class="co-line"><span>${FORMAT_LABEL[choice.format]}<small>${escapeHtml(weightLabel(q.weight))}${lot.pricePerKg ? ` × ${formatTenge(lot.pricePerKg)}/кг` : ""}</small></span><span>${formatTenge(q.meat)}</span></div>
    <div class="co-line"><span>Разделка<small>${q.cut ? escapeHtml(q.cut.name) : "стандартная"}</small></span><span>${q.cutting ? formatTenge(q.cutting) : "в цене"}</span></div>
    <div class="co-line"><span>Доставка<small>${deliveryLabel}</small></span><span>${options.length ? (q.delivery ? formatTenge(q.delivery) : "бесплатно") : "—"}</span></div>
    <div class="co-total"><span>Итого</span><strong>${formatTenge(q.total)}</strong></div>
    ${groupMode ? (() => {
      const s = splitAmount(q.total, choice.size);
      return `<div class="co-line" style="border-top:1px solid var(--line); padding-top:10px;">
        <span>Ваша доля<small>из ${choice.size} ${pluralRu(choice.size, "участника", "участников", "участников")}${s.mine !== s.each ? `, остальные по ${formatTenge(s.each)}` : ""}</small></span>
        <span><strong>${formatTenge(s.mine)}</strong></span></div>`;
    })() : ""}
    ${lot.pricePerKg ? '<p class="cfg-hint">Итог за мясо уточнится после контрольного взвешивания: при перевесе — доплата, при недовесе — возврат разницы.</p>' : ""}
    <a class="btn-pill btn-ghost btn-sm" href="/lots/${encodeURIComponent(lot.id)}" style="margin-top:14px;">← Изменить выбор</a>`;
}

// Address, date and phone - the same fields whichever way the buyer got here, one carcass or a
// whole cart.
function contactFieldsHtml(profile, user) {
  const slots = Object.entries(SLOT_LABEL).map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  return `
    <div class="field" id="co-address-field">
      <label for="co-address">Адрес доставки</label>
      <textarea id="co-address" placeholder="Город, улица, дом, квартира" maxlength="300"></textarea>
    </div>
    <div class="co-row2">
      <div class="field"><label for="co-date">Желаемая дата</label>
        <input type="date" id="co-date" min="${dayFromNow(2)}" max="${dayFromNow(90)}" value="${dayFromNow(4)}"></div>
      <div class="field"><label for="co-slot">Время</label><select id="co-slot">${slots}</select></div>
    </div>
    <p class="field-hint" style="margin-top:-6px;">Забой и разделка занимают несколько дней — фермер подтвердит дату или предложит другую.</p>
    <div class="field"><label for="co-phone">Контактный телефон</label>
      <input type="tel" id="co-phone" value="${escapeHtml(profile?.phone || user.phoneNumber || "")}" placeholder="+7 700 000 00 00"></div>`;
}

/**
 * The whole cart at once. Every line becomes its own order - an order is one carcass from one
 * farm, and each farm prepares and delivers its own - so this page collects the address once and
 * then places them one by one, keeping in the cart anything that could not be ordered.
 */
function renderCart(lines, profile, user) {
  const ready = lines.filter((l) => !l.problem);
  const needsAddress = ready.some((l) => l.item.deliveryMode !== "pickup");
  const farms = new Set(ready.map((l) => l.item.partnerId)).size;
  const total = ready.reduce((sum, l) => sum + (l.quote?.total ?? l.item.amount ?? 0), 0);

  el.innerHTML = `
    <div class="checkout-layout">
      <div class="panel">
        <h3 style="margin-top:0;">${icon("shopping-cart", { size: 18 })} Заказ из корзины</h3>
        <p style="font-size:14px;">${ready.length} ${pluralRu(ready.length, "туша", "туши", "туш")}
          ${farms > 1 ? `из ${farms} ${pluralRu(farms, "хозяйства", "хозяйств", "хозяйств")} — каждое станет отдельным заказом со своими этапами.`
            : "— заказ уйдёт хозяйству сразу после подтверждения."}</p>
        ${contactFieldsHtml(profile, user)}
        ${needsAddress ? "" : '<p class="notice-box">Все туши в корзине — самовывоз из хаба. Точный адрес фермер сообщит, когда подтвердит заказ.</p>'}
        <p id="co-error" style="color:var(--danger); font-size:14px;" hidden></p>
        <button class="btn-pill btn-primary btn-block" id="co-submit">Забронировать ${ready.length} ${pluralRu(ready.length, "заказ", "заказа", "заказов")}</button>
        ${isRealUser(user) ? "" : '<p class="cfg-hint" style="margin-top:8px;">Перед бронированием попросим подтвердить номер телефона — кодом из SMS.</p>'}
        <div class="notice-box notice-icon" style="margin-top:14px;">${icon("shield-check", { size: 18 })}<span>Бронь закрепляет тушу
          за вами. Что и когда платить — будет написано на странице заказа сразу после бронирования.</span></div>
      </div>
      <aside class="panel co-summary">
        <h3>Корзина</h3>
        ${lines.map((l) => `
          <div class="co-line"><span>${escapeHtml(l.item.lotTitle || "Туша")}<small>${escapeHtml(l.item.partnerName || "")} ·
            ${FORMAT_LABEL[l.item.format] || ""}${l.problem ? ` · ${l.problem}` : ""}</small></span>
            <span>${l.problem ? "—" : formatTenge(l.quote?.total ?? l.item.amount)}</span></div>`).join("")}
        <div class="co-total"><span>Итого</span><strong>${formatTenge(total)}</strong></div>
        <p class="cfg-hint">Итог за мясо уточнится после контрольного взвешивания каждой туши.</p>
        <a class="btn-pill btn-ghost btn-sm" href="/cart" style="margin-top:14px;">← Вернуться в корзину</a>
      </aside>
    </div>`;

  document.getElementById("co-address-field").hidden = !needsAddress;

  document.getElementById("co-submit").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const err = document.getElementById("co-error");
    const fail = (text) => { err.textContent = text; err.hidden = false; btn.disabled = false; };
    err.hidden = true;
    // Здесь и только здесь: заказ создаёт человек с подтверждённым номером.
    if (!(await requireRealLogin())) return;
    const deliveryAddress = needsAddress ? document.getElementById("co-address").value.trim() : "";
    const contactPhone = document.getElementById("co-phone").value.trim();
    if (needsAddress && deliveryAddress.length < 5) return fail("Укажите адрес доставки.");
    if (contactPhone.replace(/\D/g, "").length < 10) return fail("Укажите телефон для связи.");

    btn.disabled = true;
    const deliveryDate = document.getElementById("co-date").value || null;
    const deliverySlot = document.getElementById("co-slot").value;
    const placed = [];
    const failed = [];

    // One at a time: each order books shares in its own lot, and a half that goes while we are
    // ordering must fail only its own line.
    for (let i = 0; i < ready.length; i++) {
      const { item } = ready[i];
      btn.textContent = `Оформляем ${i + 1} из ${ready.length}…`;
      try {
        const res = await placeOrder({
          lotId: item.lotId,
          format: item.format,
          cuttingId: item.cuttingId || null,
          deliveryId: item.deliveryId || null,
          deliveryAddress,
          deliveryDate,
          deliverySlot,
          contactPhone,
          // Per line, and stable for this page: a retry re-sends the same key and gets the order
          // that was already made instead of booking the carcass twice.
          idempotencyKey: `${idempotencyKey}-${item.id}`,
        });
        placed.push({ item, orderId: res?.orderId });
      } catch (e2) {
        console.error(e2);
        failed.push({ item, message: e2?.message || "Не удалось оформить." });
      }
    }

    // Only what actually became an order leaves the cart; the rest stays, with its reason.
    if (placed.length) await clearCartItems(cartUid, placed.map((p) => p.item.id)).catch(console.error);

    el.innerHTML = `
      <div class="panel" style="margin-top:20px; max-width:680px;">
        <h3 style="margin-top:0;">${icon("check", { size: 20 })} ${placed.length ? `Оформлено ${placed.length} ${pluralRu(placed.length, "заказ", "заказа", "заказов")}` : "Заказы не оформлены"}</h3>
        ${placed.map((p) => `<div class="money-row"><span>${escapeHtml(p.item.lotTitle || "Туша")}<small>${escapeHtml(p.item.partnerName || "")}</small></span>
          <span><a href="/order?id=${encodeURIComponent(p.orderId)}" style="color:var(--green); font-weight:700;">Открыть →</a></span></div>`).join("")}
        ${failed.length ? `<div class="notice-box notice-icon notice-danger" style="margin-top:14px;">${icon("triangle-alert", { size: 18 })}<span>
          Осталось в корзине: ${failed.map((f) => `${escapeHtml(f.item.lotTitle || "туша")} — ${escapeHtml(f.message)}`).join("; ")}</span></div>` : ""}
        <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:16px;">
          <a class="btn-pill btn-primary" href="/orders">Мои заказы →</a>
          ${failed.length ? '<a class="btn-pill btn-ghost" href="/cart">Вернуться в корзину</a>' : ""}
        </div>
      </div>`;
  });
}

function render(lot, partner, profile, user) {
  const sf = partner.storefront || {};
  const options = deliveryOptions(sf);
  el.innerHTML = `
    <div class="checkout-layout">
      <div class="panel">
        ${groupMode ? `
          <h3 style="margin-top:0;">${icon("users", { size: 18 })} Совместная покупка</h3>
          <p style="font-size:14px;">Вы организатор: выбираете тушу, разделку и доставку, а стоимость делится поровну.
            Заказ уйдёт хозяйству, когда соберутся все участники — до этого хозяйство его не видит и ничего не бронируется.</p>
          <div class="field"><label for="co-size">Сколько человек делят тушу</label>
            <select id="co-size">${[2, 3, 4, 5].map((n) => `<option value="${n}">${n} ${pluralRu(n, "человек", "человека", "человек")}</option>`).join("")}</select></div>
          <hr style="border:0; border-top:1px solid var(--line); margin:18px 0;">` : ""}
        <h3 style="margin-top:0;">Доставка</h3>
        ${options.length ? `
          <div class="field"><label for="co-del">Способ</label>
            <select id="co-del">${options.map((o) => `<option value="${escapeHtml(o.id)}"${o.id === choice.deliveryId ? " selected" : ""}>${escapeHtml(o.label)} — ${o.price ? formatTenge(o.price) : "бесплатно"}</option>`).join("")}</select></div>`
          : '<p style="font-size:14px;">Хозяйство ещё не указало тарифы доставки — способ и стоимость вы согласуете с ним после заказа.</p>'}
        ${contactFieldsHtml(profile, user)}
        <p class="notice-box" id="co-pickup-note" hidden>Самовывоз из хаба: ${escapeHtml(partnerPlaceLabel(partner) || "адрес хозяйства")}.
          Точный адрес фермер сообщит, когда подтвердит заказ.</p>
        <p id="co-error" style="color:var(--danger); font-size:14px;" hidden></p>
        <button class="btn-pill btn-primary btn-block" id="co-submit">${groupMode ? "Создать совместную покупку" : "Забронировать заказ"}</button>
        ${isRealUser(user) ? "" : '<p class="cfg-hint" style="margin-top:8px;">Перед бронированием попросим подтвердить номер телефона — кодом из SMS.</p>'}
        <div class="notice-box notice-icon" style="margin-top:14px;">${icon("shield-check", { size: 18 })}<span>Бронь закрепляет тушу
          за вами. Что и когда платить — будет написано на странице заказа сразу после бронирования.</span></div>
      </div>
      <aside class="panel co-summary" id="co-summary"></aside>
    </div>`;

  const delSelect = document.getElementById("co-del");
  const sizeSelect = document.getElementById("co-size");
  const paint = () => {
    if (delSelect) choice.deliveryId = delSelect.value;
    if (sizeSelect) choice.size = Number(sizeSelect.value) || 2;
    const pickup = choice.deliveryId === "pickup";
    document.getElementById("co-address-field").hidden = pickup;
    document.getElementById("co-pickup-note").hidden = !pickup;
    document.getElementById("co-summary").innerHTML = summaryHtml(lot, partner, quote(lot, sf, choice), options);
  };
  delSelect?.addEventListener("change", paint);
  sizeSelect?.addEventListener("change", paint);
  paint();

  document.getElementById("co-submit").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const err = document.getElementById("co-error");
    const fail = (text) => { err.textContent = text; err.hidden = false; };
    err.hidden = true;
    if (!(await requireRealLogin())) return;
    const pickup = choice.deliveryId === "pickup";
    const deliveryAddress = pickup ? "" : document.getElementById("co-address").value.trim();
    const contactPhone = document.getElementById("co-phone").value.trim();
    if (!pickup && deliveryAddress.length < 5) return fail("Укажите адрес доставки.");
    if (contactPhone.replace(/\D/g, "").length < 10) return fail("Укажите телефон для связи.");

    btn.disabled = true;
    btn.textContent = "Оформляем…";
    const common = {
      lotId: lot.id,
      format: choice.format,
      cuttingId: choice.cuttingId || null,
      deliveryId: choice.deliveryId || null,
      deliveryAddress,
      deliveryDate: document.getElementById("co-date").value || null,
      deliverySlot: document.getElementById("co-slot").value,
      contactPhone,
    };
    try {
      if (groupMode) {
        const group = await createGroupBuy({ ...common, size: choice.size });
        window.location.href = `/group?id=${encodeURIComponent(group.groupId)}`;
        return;
      }
      const placed = await placeOrder({ ...common, idempotencyKey });

      // Заказ создан — сразу уводим на оплату. Пока онлайн-оплата не включена, сервер отвечает
      // failed-precondition, и это не ошибка, а состояние: показываем тот же экран, что и раньше,
      // где расчёт согласуется с хозяйством напрямую.
      let payFailed = false;
      if (placed?.orderId) {
        try {
          const { redirectUrl } = await startPayment(placed.orderId);
          if (redirectUrl) {
            window.location.href = redirectUrl;
            return;
          }
        } catch (e3) {
          payFailed = !String(e3?.code || "").includes("failed-precondition");
          if (payFailed) console.error(e3);
        }
      }

      el.innerHTML = `
        <div class="panel" style="margin-top:20px; max-width:620px;">
          <h3 style="margin-top:0;">${icon("check", { size: 20 })} Заказ оформлен</h3>
          <p>${payFailed
            ? `${FORMAT_LABEL[choice.format]} «${escapeHtml(lot.name)}» забронирована за вами, но открыть оплату
               не получилось. Заказ никуда не денется — откройте его и попробуйте оплатить ещё раз.`
            : `${FORMAT_LABEL[choice.format]} «${escapeHtml(lot.name)}» забронирована за вами. Фермер подтвердит заказ
               и свяжется, чтобы согласовать расчёт и передачу. Каждый шаг — съёмку животного, готовое мясо и
               взвешивание — вы увидите в заказе.`}</p>
          <a class="btn-pill btn-primary" href="${placed?.orderId ? `/order?id=${encodeURIComponent(placed.orderId)}` : "/orders"}">Открыть заказ →</a>
        </div>`;
    } catch (e2) {
      console.error(e2);
      // The server's own refusals come with a Russian explanation worth showing as is; an internal
      // failure does not, and the buyer did nothing wrong.
      const code = String(e2?.code || "");
      fail(code.includes("internal")
        ? "Не получилось оформить заказ из-за ошибки на сервере. Попробуйте чуть позже."
        : (e2?.message || "Не удалось оформить заказ."));
      btn.disabled = false;
      btn.textContent = groupMode ? "Создать совместную покупку" : "Забронировать заказ";
    }
  });
}

async function init() {
  // Страницу показываем всем. Раньше аноним улетал на /login первой же строкой и не видел ни
  // формы, ни суммы — человек бросал заказ, не узнав цены, а проверяющий эквайера записывал,
  // что оформление заказа не настроено. Теперь номер спрашиваем по кнопке, а не на пороге.
  const user = await authReady;
  if (!user) return message("Не удалось начать сессию. Обновите страницу.");

  // The cart route: everything picked, in one go. Signing in just now brought this browser's
  // cart into the account (js/cart.js), so read it after the login has settled.
  if (cartMode) {
    cartUid = user.uid;
    try {
      const profile = await getMyProfile(user.uid).catch(() => null);
      const lines = await loadCartLines(cartUid);
      if (!lines.some((l) => !l.problem)) {
        return message('В корзине нет туш, которые можно заказать. <a href="/cart" style="color:var(--green)">Открыть корзину →</a>');
      }
      document.title = "Оформление корзины — ET";
      renderCart(lines, profile, user);
    } catch (e) {
      console.error(e);
      message("Не удалось загрузить корзину. Обновите страницу.");
    }
    return;
  }

  if (!choice.lotId || !["half", "whole"].includes(choice.format)) {
    return message('Заказ не выбран. <a href="/farmers" style="color:var(--green)">Выберите хозяйство →</a>');
  }
  try {
    const lot = await getLot(choice.lotId);
    if (!lot) return message("Такая туша не найдена — возможно, её уже сняли с продажи.");
    const partner = await getPartner(lot.partnerId);
    if (!isSellingPartner(partner)) return message("Это хозяйство ещё не прошло проверку платформы.");
    const f = formatsOf(lot)[choice.format];
    if (!f.available) {
      return message(`${FORMAT_LABEL[choice.format]} этой туши уже недоступна. <a href="/lots/${encodeURIComponent(lot.id)}" style="color:var(--green)">Вернуться к туше →</a>`);
    }
    // A link can be old: a cutting or a city the farm has since removed falls back to the defaults.
    const sf = partner.storefront || {};
    const options = deliveryOptions(sf);
    if (choice.cuttingId && !(sf.cutting || []).some((c) => c.id === choice.cuttingId)) choice.cuttingId = "";
    if (!options.some((o) => o.id === choice.deliveryId)) choice.deliveryId = options[0]?.id || "";
    document.title = `Оформление — ${lot.name} — ET`;
    const profile = await getMyProfile(user.uid).catch(() => null);
    render(lot, partner, profile, user);
  } catch (e) {
    console.error(e);
    message("Не удалось загрузить заказ. Обновите страницу.");
  }
}

init();
