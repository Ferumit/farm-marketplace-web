// «Корзина» - the carcasses this buyer has picked and not yet ordered.
//
// Each line is re-checked against the lot as it is now: a half someone else booked meanwhile, a
// farm that went off sale, a price the farm has changed - all of that shows here rather than at
// the checkout. The amounts are still only a preview; createOrder prices every order itself.
import { icon } from "./icons.js";
import { meatTile } from "./tiles.js";
import { mountLayout } from "./layout.js";
import { authReady, isRealUser } from "./firebase-init.js";
import { removeCartItem, formatTenge, escapeHtml, pluralRu } from "./data.js";
import { loadCartLines } from "./cart.js";
import { FORMAT_LABEL, weightLabel } from "./carcass.js";

mountLayout();

const contentEl = document.getElementById("cart-content");
let uid = null;
let lines = [];

function rowHtml({ item, lot, problem, quote: q, type }) {
  const photo = item.imageUrl || lot?.imageUrl
    ? `<img src="${escapeHtml(item.imageUrl || lot.imageUrl)}" alt="">`
    : meatTile(type);
  const delivery = item.deliveryMode === "pickup" ? "самовывоз из хаба"
    : item.deliveryCity ? `доставка: ${item.deliveryCity}`
      : "доставка по договорённости";
  const details = [
    FORMAT_LABEL[item.format] || "",
    q?.weight ? weightLabel(q.weight) : (item.weightKg ? weightLabel(item.weightKg) : ""),
    item.cuttingName ? `разделка «${item.cuttingName}»` : "стандартная разделка",
    delivery,
  ].filter(Boolean).join(" · ");

  return `
    <div class="cart-row">
      <span class="cart-row__photo">${photo}</span>
      <div class="grow">
        <h4><a href="/lots/${encodeURIComponent(item.lotId)}" style="color:var(--ink);">${escapeHtml(item.lotTitle || "Туша")}</a></h4>
        <p>${escapeHtml(item.partnerName || "")}</p>
        <p style="margin-top:4px;">${escapeHtml(details)}</p>
        ${problem ? `<p class="cart-gone" style="margin-top:6px;">${icon("triangle-alert", { size: 14 })} ${escapeHtml(problem)}</p>` : ""}
      </div>
      <div class="cart-row__side">
        <span class="cart-row__price">${problem ? "—" : formatTenge(q?.total ?? item.amount)}</span>
        <button class="link-btn" type="button" data-remove="${escapeHtml(item.id)}">Убрать</button>
      </div>
    </div>`;
}

function render() {
  if (!lines.length) {
    contentEl.innerHTML = `
      <div class="empty-state" style="margin-top:20px;">
        Корзина пуста. Выберите тушу — половину или целую — и добавьте её сюда.
        <div style="margin-top:14px;"><a class="btn-pill btn-primary" href="/lots">Все лоты →</a></div>
      </div>`;
    return;
  }

  const ready = lines.filter((l) => !l.problem);
  const total = ready.reduce((sum, l) => sum + (l.quote?.total ?? l.item.amount ?? 0), 0);
  const farms = new Set(ready.map((l) => l.item.partnerId)).size;

  contentEl.innerHTML = `
    <div class="cart-layout" style="margin-top:20px;">
      <div class="panel">${lines.map(rowHtml).join("")}</div>
      <aside class="panel">
        <h3 style="margin-top:0;">Итого</h3>
        <div class="money-row"><span>Готово к заказу</span><span>${ready.length} ${pluralRu(ready.length, "туша", "туши", "туш")}</span></div>
        ${farms > 1 ? `<div class="money-row"><span>Хозяйств</span><span>${farms}</span></div>` : ""}
        <div class="money-row"><span><strong>Сумма</strong></span><span><strong>${formatTenge(total)}</strong></span></div>
        <p class="cfg-hint">Итог за мясо уточнится после контрольного взвешивания каждой туши: при перевесе — доплата,
          при недовесе — возврат разницы.</p>
        <a class="btn-pill btn-primary btn-block" href="/checkout?cart=1"${ready.length ? "" : ' aria-disabled="true" style="pointer-events:none; opacity:.5;"'}>
          Оформить заказ →</a>
        ${farms > 1 ? `<p class="cfg-hint" style="margin-top:8px;">Туши из разных хозяйств станут отдельными заказами —
          каждое хозяйство готовит и везёт своё.</p>` : ""}
        <a class="btn-pill btn-ghost btn-block" href="/lots" style="margin-top:10px;">Добавить ещё</a>
      </aside>
    </div>`;

  contentEl.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await removeCartItem(uid, btn.dataset.remove);
        lines = await loadCartLines(uid);
        render();
      } catch (e) {
        console.error(e);
        btn.disabled = false;
      }
    });
  });
}

async function init() {
  const user = await authReady;
  uid = isRealUser(user) ? user.uid : null;
  try {
    lines = await loadCartLines(uid);
    render();
  } catch (e) {
    console.error(e);
    contentEl.innerHTML = '<div class="empty-state">Не удалось загрузить корзину.</div>';
  }
}

init();
