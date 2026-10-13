// Leadership's window 1.3 - setting up an order for one carcass: format (half or whole, with the
// approximate weight), cutting (standard, or the farm's own paid options) and delivery (the farm's
// tariff for a city, or pickup), with the total as the buyer changes them. "Оформить заказ" goes on
// to the checkout page with the choice in the address; nothing is booked here.
import { icon } from "./icons.js";
import { escapeHtml, formatTenge, addCartItem } from "./data.js";
import { authReady, isRealUser } from "./firebase-init.js";
import { cartEntry } from "./cart.js";
import { FORMAT_LABEL, FORMAT_KZ, formatsOf, deliveryOptions, quote, weightLabel } from "./carcass.js";

let instance = 0;

export function mountConfigurator(el, { lot, partner, showSplit = true }) {
  const n = ++instance; // radio groups must not collide when two configurators share a page
  const sf = partner?.storefront || {};
  const formats = formatsOf(lot);
  const options = deliveryOptions(sf);
  const cuttings = (sf.cutting || []).filter((c) => c && c.id && c.name);
  const perKg = Math.round(Number(lot.pricePerKg) || 0);
  const firstFree = formats.half.available ? "half" : formats.whole.available ? "whole" : null;

  const formatHtml = ["half", "whole"].filter((f) => formats[f].sellable).map((f) => {
    const x = formats[f];
    return `
      <label class="cfg-option${x.available ? "" : " is-off"}">
        <input type="radio" name="cfg-format-${n}" value="${f}"${f === firstFree ? " checked" : ""}${x.available ? "" : " disabled"}>
        <span class="cfg-option__body">
          <span class="cfg-option__title">${FORMAT_LABEL[f]} <span class="cfg-kz">(${FORMAT_KZ[f]})</span></span>
          <span class="cfg-option__meta">${[weightLabel(x.weight), formatTenge(x.meat)].filter(Boolean).join(" · ")}</span>
          ${x.available ? "" : '<span class="cfg-option__note">уже забронирована</span>'}
        </span>
      </label>`;
  }).join("");

  const cuttingHtml = [
    `<label class="cfg-option"><input type="radio" name="cfg-cut-${n}" value="" checked>
      <span class="cfg-option__body"><span class="cfg-option__title">Стандартная</span>
      <span class="cfg-option__meta">включена в цену</span></span></label>`,
    ...cuttings.map((c) => `
      <label class="cfg-option"><input type="radio" name="cfg-cut-${n}" value="${escapeHtml(c.id)}">
        <span class="cfg-option__body">
          <span class="cfg-option__title">${escapeHtml(c.name)}</span>
          <span class="cfg-option__meta">+${formatTenge(c.price)} за половину туши</span>
          ${c.note ? `<span class="cfg-option__note">${escapeHtml(c.note)}</span>` : ""}
        </span>
      </label>`),
  ].join("");

  const deliveryHtml = options.length
    ? `<select class="cfg-select" data-cfg="delivery" aria-label="Доставка">
        ${options.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)} — ${o.price ? formatTenge(o.price) : "бесплатно"}</option>`).join("")}
      </select>`
    : '<p class="cfg-hint" style="margin:0;">Доставку и её стоимость вы согласуете с хозяйством после заказа.</p>';

  el.innerHTML = `
    <div class="cfg">
      <div class="cfg-step">
        <h4 class="eyebrow">Формат</h4>
        <div class="cfg-options">${formatHtml || '<p class="cfg-hint">Эту тушу сейчас нельзя заказать.</p>'}</div>
      </div>
      <div class="cfg-step">
        <h4 class="eyebrow">Разделка</h4>
        <div class="cfg-options">${cuttingHtml}</div>
      </div>
      <div class="cfg-step">
        <h4 class="eyebrow">Доставка</h4>
        ${deliveryHtml}
      </div>
      <div class="cfg-total" data-cfg="total"></div>
      <button type="button" class="btn-pill btn-primary btn-block" data-cfg="go"${firstFree ? "" : " disabled"}>
        ${firstFree ? "Оформить заказ →" : "Все части туши забронированы"}</button>
      ${firstFree ? `<button type="button" class="btn-pill btn-ghost btn-block" data-cfg="cart" style="margin-top:10px;">
        ${icon("shopping-cart", { size: 16 })} В корзину</button>` : ""}
      ${showSplit && firstFree ? `<button type="button" class="btn-pill btn-secondary btn-block" data-cfg="group" style="margin-top:10px;">${icon("users", { size: 16 })} Собрать совместную покупку</button>
      <p class="cfg-hint" style="margin:6px 0 0;">2–5 человек делят одну тушу: заказ уходит хозяйству, когда соберутся все.</p>` : ""}
    </div>`;

  const pick = (name) => el.querySelector(`input[name="${name}-${n}"]:checked`)?.value || "";
  const choice = () => ({
    format: pick("cfg-format"),
    cuttingId: pick("cfg-cut"),
    deliveryId: el.querySelector('[data-cfg="delivery"]')?.value || "",
  });

  const paint = () => {
    const c = choice();
    // A different format or delivery is a different cart entry, so the "already in the cart"
    // state must not survive the change that made it untrue.
    const cartBtn = el.querySelector("[data-cfg^='cart']");
    if (cartBtn?.dataset.cfg === "cart-open") {
      cartBtn.dataset.cfg = "cart";
      cartBtn.innerHTML = `${icon("shopping-cart", { size: 16 })} В корзину`;
    }
    if (!c.format) {
      el.querySelector('[data-cfg="total"]').innerHTML = "";
      return;
    }
    const q = quote(lot, sf, c);
    const meatLabel = perKg && q.weight ? `Мясо, ${weightLabel(q.weight)} × ${formatTenge(perKg)}/кг` : "Мясо";
    const rows = [
      [meatLabel, formatTenge(q.meat)],
      ...(q.cut ? [[`Разделка «${escapeHtml(q.cut.name)}»`, formatTenge(q.cutting)]] : []),
      ...(options.length ? [["Доставка", q.delivery ? formatTenge(q.delivery) : "бесплатно"]] : []),
    ];
    el.querySelector('[data-cfg="total"]').innerHTML = `
      ${rows.map(([k, v]) => `<div class="cfg-row"><span>${k}</span><span>${v}</span></div>`).join("")}
      <div class="cfg-row cfg-row--total"><span>Итого</span><strong>${formatTenge(q.total)}</strong></div>
      ${perKg ? '<p class="cfg-hint">Итог за мясо уточнится после контрольного взвешивания: при перевесе — доплата, при недовесе — возврат разницы.</p>' : ""}`;
  };

  // Both buttons go to the same checkout with the same choice; `group` is what turns it into
  // gathering 2-5 people instead of ordering alone.
  const goToCheckout = (group) => {
    const c = choice();
    if (!c.format) return;
    const q = new URLSearchParams({ lot: lot.id, format: c.format });
    if (c.cuttingId) q.set("cut", c.cuttingId);
    if (c.deliveryId) q.set("del", c.deliveryId);
    if (group) q.set("group", "1");
    window.location.href = "/checkout?" + q.toString();
  };

  // Adding to the cart does not need an account: what this browser collects moves into the
  // account on the way in (js/cart.js), and the order itself is where signing in is required.
  const addToCart = async (btn) => {
    const c = choice();
    if (!c.format) return;
    btn.disabled = true;
    btn.innerHTML = "Добавляем…";
    try {
      const user = await authReady;
      await addCartItem(isRealUser(user) ? user.uid : null,
        cartEntry({ lot, partner, choice: c, quote: quote(lot, sf, c) }));
      btn.innerHTML = `${icon("check", { size: 16 })} В корзине · <span style="text-decoration:underline;">открыть</span>`;
      btn.disabled = false;
      btn.dataset.cfg = "cart-open";
    } catch (e) {
      console.error(e);
      btn.innerHTML = "Не получилось добавить";
      btn.disabled = false;
    }
  };

  el.addEventListener("change", paint);
  el.querySelector('[data-cfg="go"]').addEventListener("click", () => goToCheckout(false));
  el.querySelector('[data-cfg="group"]')?.addEventListener("click", () => goToCheckout(true));
  el.querySelector('[data-cfg="cart"]')?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.cfg === "cart-open") {
      window.location.href = "/cart";
      return;
    }
    addToCart(btn);
  });
  paint();
}
