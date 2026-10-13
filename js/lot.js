import { icon } from "./icons.js";
import { meatTile } from "./tiles.js";
import { mountLayout } from "./layout.js";
import { getLot, getPartner, getAnimalsByIds, bookingPercent, formatTenge, primaryAnimalType, escapeHtml, routeId, isSellingPartner } from "./data.js";
import { lotPlaceLabel } from "./regions.js";
import { ageLabel } from "./livestock.js";
import { availabilityLabel, weightLabel } from "./carcass.js";
import { mountConfigurator } from "./configurator.js";

mountLayout();

const contentEl = document.getElementById("lot-content");
const params = new URLSearchParams(window.location.search);
const lotId = routeId("lots", "id");
// /lots/{id}/split is the clean form; ?mode=split is what the old link still carries.
const splitMode = /\/split\/?$/.test(window.location.pathname) || params.get("mode") === "split";

const MEAT_LABEL = { cattle: "Говядина", horse: "Конина" };

// A lot's share count is written by its farm, so it is capped here: one cell per share of a lot
// claiming millions of them would freeze the visitor's tab building the grid.
const MAX_SHARE_CELLS = 100;

function shareGridHtml(lot) {
  const total = Number(lot.totalShares) || 0;
  const booked = Number(lot.bookedShares) || 0;
  const shown = Math.min(total, MAX_SHARE_CELLS);
  // Two cells read as halves; older lots keep their numbered shares.
  const label = (i) => (total === 2 ? `${i + 1}-я половина` : String(i + 1));
  let cells = "";
  for (let i = 0; i < shown; i++) {
    const filled = i < booked;
    cells += `<div class="share-slot ${filled ? "filled" : "empty"}${total === 2 ? " share-slot--half" : ""}">${filled ? icon("check", { size: 16, stroke: 2.5 }) + (total === 2 ? " занята" : "") : label(i)}</div>`;
  }
  if (total > shown) cells += `<div class="share-slot empty">+${total - shown}</div>`;
  return `<div class="share-grid${total === 2 ? " share-grid--halves" : ""}">${cells}</div>`;
}

// Why this lot cannot be ordered, when it cannot. The server refuses in every one of these cases
// anyway; this only spares the buyer a form that could not succeed.
function blockedReason(lot, partner) {
  if (!isSellingPartner(partner)) return "Хозяйство ещё не прошло проверку";
  if (lot.status === "fully_booked") return "Туша полностью забронирована";
  if (lot.status !== "open") return "Лот снят с продажи";
  return null;
}

function renderHtml(lot, partner, animalsById) {
  const pct = bookingPercent(lot);
  const type = primaryAnimalType(lot, animalsById);
  const animal = (lot.animalIds || []).map((id) => animalsById.get(id)).find(Boolean);
  const name = escapeHtml(lot.name);
  const photo = lot.imageUrl
    ? `<img src="${escapeHtml(lot.imageUrl)}" alt="${name}">`
    : meatTile(type);
  const perKg = Math.round(Number(lot.pricePerKg) || 0);
  const blocked = blockedReason(lot, partner);

  const shareBlock = splitMode ? `
      <div class="panel" style="margin-top:20px;">
        <h4 class="eyebrow" style="margin-bottom:4px;">${icon("users", { size: 15 })} Совместная покупка</h4>
        <p style="font-size:14px;">Одна туша на 2–5 человек. Выберите формат и доставку справа, нажмите
          «Собрать совместную покупку» — появится страница сбора со ссылкой, которую можно отправить друзьям.
          Стоимость делится поровну, а заказ уходит хозяйству, когда соберутся все. Пока идёт сбор,
          туша не бронируется — успеть нужно, пока её не купили.</p>
        ${shareGridHtml(lot)}
      </div>` : "";

  return `
    <div class="lot-layout">
      <div>
        <div class="lot-photo">${photo}</div>
        <div style="margin-top:20px;">
          <span class="eyebrow">${isSellingPartner(partner) ? `<a href="/farmers/${encodeURIComponent(partner.id)}" style="color:var(--green)">${escapeHtml(partner.displayName)}</a> · ` : ""}${escapeHtml(lotPlaceLabel(lot) || "Казахстан")}</span>
          <h1 style="margin-top:8px;">${name}</h1>
          <p>${escapeHtml(lot.description || "")}</p>
          <div class="chip-row" style="margin-top:12px;">
            <span class="chip-filter">${MEAT_LABEL[type] || "Мясо"}</span>
            ${animal?.breed ? `<span class="chip-filter">${escapeHtml(animal.breed)}</span>` : ""}
            ${animal?.ageCategory ? `<span class="chip-filter">${escapeHtml(ageLabel(animal.ageCategory, animal.type || type))}</span>` : ""}
            ${lot.totalWeight ? `<span class="chip-filter">Туша ${escapeHtml(weightLabel(Number(lot.totalWeight)))}</span>` : ""}
          </div>
        </div>
        ${shareBlock}
      </div>

      <div class="panel">
        <div class="progress-row">
          <div class="progress-labels"><span>${escapeHtml(availabilityLabel(lot))}</span><span class="value">${pct}%</span></div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        ${perKg ? `<p style="margin:14px 0 18px; font-size:14px;">Цена — <strong>${formatTenge(perKg)} за кг</strong> туши</p>` : '<div style="height:16px;"></div>'}
        ${blocked
          ? `<button class="btn-pill btn-primary btn-block" disabled>${blocked}</button>`
          : '<div id="configurator"></div>'}
        <div class="notice-box notice-icon" style="margin-top:18px;">
          ${icon("shield-check", { size: 18 })}<span>Заказ бронирует тушу за вами. Как и когда платить —
          будет написано на странице заказа сразу после оформления.</span>
        </div>
      </div>
    </div>`;
}

async function init() {
  if (!lotId) {
    contentEl.innerHTML = '<div class="empty-state">Лот не указан.</div>';
    return;
  }
  try {
    const lot = await getLot(lotId);
    if (!lot) {
      contentEl.innerHTML = '<div class="empty-state">Такой лот не найден — возможно, он уже продан или снят с продажи.</div>';
      return;
    }
    document.title = lot.name + " — ET";
    const [partner, animals] = await Promise.all([
      getPartner(lot.partnerId),
      getAnimalsByIds(lot.animalIds || []),
    ]);
    const animalsById = new Map(animals.map((a) => [a.id, a]));
    contentEl.innerHTML = renderHtml(lot, partner, animalsById);
    const mount = document.getElementById("configurator");
    if (mount) mountConfigurator(mount, { lot, partner });
  } catch (e) {
    console.error(e);
    contentEl.innerHTML = '<div class="empty-state">Не удалось загрузить лот.</div>';
  }
}

init();
