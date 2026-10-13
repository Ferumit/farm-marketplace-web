import { meatMonogram } from "./tiles.js";
import { mountLayout } from "./layout.js";
import { requirePartner } from "./auth.js";
import { mountCabinetNav, renderStatusNote } from "./partner-nav.js";
import { getMyLots, setLotStatus, formatTenge, bookingPercent, escapeHtml, pluralRu } from "./data.js";
import { availabilityLabel } from "./carcass.js";

mountLayout();
mountCabinetNav("/cabinet/lots");

const listEl = document.getElementById("lots-list");

const STATUS_LABEL = {
  draft: "Черновик",
  open: "Опубликован",
  fully_booked: "Туша забронирована",
  in_transit: "В пути",
  sold: "Продан",
};
const STATUS_CLASS = { draft: "draft", open: "open", fully_booked: "booked", in_transit: "booked", sold: "booked" };

function lotRowHtml(lot) {
  const pct = bookingPercent(lot);
  
  const thumb = lot.imageUrl
    ? `<img class="thumb" src="${escapeHtml(lot.imageUrl)}" alt="">`
    : `<div class="thumb">${meatMonogram(lot.meatType)}</div>`;
  const total = Number(lot.totalShares) || 0;
  const perKg = Number(lot.pricePerKg) || 0;
  // A carcass sells in halves or whole; older lots still carry their share count.
  const sale = total === 2 ? "половинами и целиком" : total === 1 ? "только целиком"
    : `${total} ${pluralRu(total, "доля", "доли", "долей")}`;
  const priceText = perKg ? `${formatTenge(perKg)}/кг` : `${formatTenge(lot.pricePerShare)} за долю`;
  const line = [sale, priceText, lot.totalWeight ? `туша ~${escapeHtml(String(lot.totalWeight).replace(".", ","))} кг` : "", availabilityLabel(lot).toLowerCase()]
    .filter(Boolean).join(" · ");

  // Unpublishing a lot people already paid into would make their purchase vanish from the
  // market - the app has no such guard, the site does.
  const hasBuyers = (lot.bookedShares || 0) > 0;
  let action = "";
  if (lot.status === "draft") {
    action = `<button class="btn-pill btn-primary btn-sm" data-publish="${lot.id}">Опубликовать</button>`;
  } else if (lot.status === "open") {
    action = hasBuyers
      ? `<span class="progress-caption">Есть заказы — снять с продажи нельзя</span>`
      : `<button class="btn-pill btn-secondary btn-sm" data-unpublish="${lot.id}">В черновик</button>`;
  }

  return `
    <div class="data-row">
      ${thumb}
      <div class="grow">
        <h4>${escapeHtml(lot.name)}</h4>
        <p>${line} · продано ${pct}%</p>
      </div>
      <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
        <span class="status-chip ${STATUS_CLASS[lot.status] || ""}">${STATUS_LABEL[lot.status] || lot.status}</span>
        ${action}
      </div>
    </div>`;
}

async function init() {
  const session = await requirePartner();
  if (!session) return;
  renderStatusNote(session.profile, session.user.uid);

  try {
    const lots = await getMyLots(session.user.uid);
    if (!lots.length) {
      listEl.innerHTML = `<div class="empty-state">Пока нет ни одного лота.
        <a href="/cabinet/lots/new" style="color:var(--green)">Создать первый →</a></div>`;
      return;
    }
    listEl.innerHTML = lots.map(lotRowHtml).join("");
    wireActions();
  } catch (e) {
    console.error(e);
    listEl.innerHTML = '<div class="empty-state">Не удалось загрузить лоты.</div>';
  }
}

function wireActions() {
  listEl.querySelectorAll("[data-publish]").forEach((btn) => {
    btn.addEventListener("click", () => changeStatus(btn, btn.dataset.publish, "open"));
  });
  listEl.querySelectorAll("[data-unpublish]").forEach((btn) => {
    btn.addEventListener("click", () => changeStatus(btn, btn.dataset.unpublish, "draft"));
  });
}

async function changeStatus(btn, lotId, status) {
  btn.disabled = true;
  btn.textContent = "…";
  try {
    await setLotStatus(lotId, status);
    init();
  } catch (e) {
    console.error(e);
    btn.disabled = false;
    btn.textContent = status === "open" ? "Опубликовать" : "В черновик";
    alert("Не удалось изменить статус лота.");
  }
}

init();
