import { icon } from "./icons.js";
import { initialOf } from "./tiles.js";
import { lotCardHtml } from "./lot-card.js";
import { partnerPlaceLabel } from "./regions.js";
import { ageLabel } from "./livestock.js";
import { mountConfigurator } from "./configurator.js";
import { mountLayout } from "./layout.js";
import {
  getPartner, getLotsByPartner, getAnimalsByIds, getPartnerReviews,
  pluralRu, escapeHtml, routeId, isSellingPartner, formatTenge,
} from "./data.js";

mountLayout();

const heroEl = document.getElementById("farmer-hero");
const gridEl = document.getElementById("lot-grid");
const reviewsEl = document.getElementById("farmer-reviews");
const partnerId = routeId("farmers", "id");

function heroHtml(p) {
  const name = escapeHtml(p.displayName || "Фермер");
  const avatar = p.avatarUrl
    ? `<img class="avatar" src="${escapeHtml(p.avatarUrl)}" alt="${name}">`
    : `<div class="avatar avatar-initial">${escapeHtml(initialOf(p.displayName))}</div>`;
  const verified = (p.status === "verified" || p.status === "active")
    ? `<span class="badge-pill badge-verified with-icon">${icon("badge-check", { size: 15 })}Проверенный хаб</span>` : "";
  const certified = p.certified
    ? `<span class="badge-pill badge-verified with-icon">${icon("shield-check", { size: 15 })}Сертификаты</span>` : "";
  const waNumber = (p.phone || "").replace(/[^\d]/g, "");
  const dealsWord = pluralRu(p.totalDeals || 0, "сделка", "сделки", "сделок");
  // Checked certificates say more than any chat can - the WhatsApp fallback is for farms without them.
  const docChip = p.certified
    ? `<span class="doc-chip doc-chip--ok">${icon("shield-check", { size: 16 })} СЭС и ветконтроль подтверждены платформой</span>`
    : waNumber
      ? `<a class="doc-chip" href="https://wa.me/${escapeHtml(waNumber)}" target="_blank" rel="noopener">${icon("file-text", { size: 16 })} Ветеринарные документы — уточнить в WhatsApp</a>`
      : `<span class="doc-chip">${icon("file-text", { size: 16 })} Ветеринарные документы — уточняйте у фермера напрямую</span>`;
  return `
    <div class="farmer-hero">
      ${avatar}
      <div>
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <h1 style="margin:0;">${name}</h1>
          ${verified}${certified}
        </div>
        <p style="margin:6px 0 0;">${icon("map-pin", { size: 16 })} ${escapeHtml(partnerPlaceLabel(p) || "Регион не указан")} · ${icon("star", { size: 16 })} ${(Number(p.rating) || 0).toFixed(1)} рейтинг · ${Number(p.totalDeals) || 0} ${dealsWord}</p>
      </div>
    </div>
    <div class="chip-row" style="margin-top:18px;">
      ${docChip}
    </div>
    ${storefrontHtml(p.storefront || {})}`;
}

// What the farm set up in its cabinet → Витрина: who it is, its slaughterhouse on video, and the
// terms a buyer needs before choosing a carcass - which cuts cost extra and where it delivers.
function storefrontHtml(sf) {
  const desc = sf.description ? `<p class="farm-desc">${escapeHtml(sf.description)}</p>` : "";
  const video = sf.videoUrl ? `
    <figure class="farm-video">
      <video src="${escapeHtml(sf.videoUrl)}"${sf.posterUrl ? ` poster="${escapeHtml(sf.posterUrl)}"` : ""} controls playsinline preload="metadata"></video>
      <figcaption>Убойный цех хозяйства</figcaption>
    </figure>` : "";
  const cutting = [
    "<li><strong>Стандартная</strong> — включена в цену</li>",
    ...(sf.cutting || []).map((c) => `<li><strong>${escapeHtml(c.name)}</strong> — ${formatTenge(c.price)} за половину туши${c.note ? `<br><span class="muted">${escapeHtml(c.note)}</span>` : ""}</li>`),
  ];
  const delivery = [
    ...(sf.pickup ? ["<li><strong>Самовывоз</strong> из хаба — бесплатно</li>"] : []),
    ...(sf.delivery || []).map((d) => `<li><strong>${escapeHtml(d.city)}</strong> — ${formatTenge(d.price)}</li>`),
  ];
  if (!desc && !video && !(sf.cutting || []).length && !delivery.length) return "";
  return `
    <div class="farm-about">
      <div>${desc}${video}</div>
      <div class="farm-terms">
        <div class="panel"><h4 class="eyebrow">Разделка</h4><ul>${cutting.join("")}</ul></div>
        ${delivery.length ? `<div class="panel"><h4 class="eyebrow">Доставка</h4><ul>${delivery.join("")}</ul></div>` : ""}
      </div>
    </div>`;
}

// What buyers said about the farm. Only reviews a moderator published are here, and each one
// belongs to a deal that actually completed - which is also what the rating above is counted from.
function reviewsHtml(partner, reviews) {
  const stars = (n) => `<span class="review-card__stars">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>`;
  const count = reviews.length;
  const head = `<h2>Отзывы покупателей</h2>`;
  if (!count) {
    return `${head}<p style="max-width:640px; margin-top:-6px;">Пока отзывов нет.
      Первый появится после того, как покупатель завершит сделку с этим хозяйством.</p>`;
  }
  const average = (Number(partner.rating) || reviews.reduce((a, r) => a + r.rating, 0) / count).toFixed(1);
  return `
    ${head}
    <p style="max-width:640px; margin-top:-6px;">${icon("star", { size: 16 })} ${average} из 5 ·
      ${count} ${pluralRu(count, "отзыв", "отзыва", "отзывов")} от покупателей завершённых сделок.</p>
    <div class="panel" style="margin-top:14px;">
      ${reviews.map((r) => `
        <div class="review-card">
          <div class="review-card__head">
            <strong>${escapeHtml(r.buyerName || "Покупатель")} ${stars(r.rating)}</strong>
            <time>${r.createdAt?.seconds ? new Date(r.createdAt.seconds * 1000).toLocaleDateString("ru-RU") : ""}</time>
          </div>
          ${r.text ? `<p>${escapeHtml(r.text)}</p>` : '<p class="muted">Без комментария.</p>'}
          ${r.lotTitle ? `<p class="muted" style="font-size:13px;">${escapeHtml(r.lotTitle)}</p>` : ""}
        </div>`).join("")}
    </div>`;
}

function openConfigurator(lot, partner, animalsById) {
  const animal = (lot.animalIds || []).map((id) => animalsById.get(id)).find(Boolean);
  const meta = [animal?.breed, animal?.ageCategory ? ageLabel(animal.ageCategory, animal.type) : ""]
    .filter(Boolean).map(escapeHtml).join(" · ");
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box modal-box--cfg" role="dialog" aria-modal="true" aria-label="Настройка заказа">
      <div class="row-top">
        <div><h3 style="margin:0;">${escapeHtml(lot.name)}</h3>${meta ? `<p class="cfg-hint" style="margin-top:4px;">${meta}</p>` : ""}</div>
        <button class="modal-close" aria-label="Закрыть">×</button>
      </div>
      <div data-cfg-mount style="margin-top:14px;"></div>
    </div>`;
  document.body.appendChild(overlay);
  mountConfigurator(overlay.querySelector("[data-cfg-mount]"), { lot, partner });
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".modal-close").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  overlay.querySelector(".modal-close").focus();
}

async function init() {
  if (!partnerId) {
    heroEl.innerHTML = '<div class="empty-state">Фермер не указан.</div>';
    return;
  }
  try {
    const partner = await getPartner(partnerId);
    if (!partner) {
      heroEl.innerHTML = '<div class="empty-state">Такой фермер не найден.</div>';
      gridEl.innerHTML = "";
      return;
    }
    // Nothing of an unchecked farm is shown - not even its contacts: the WhatsApp link below would
    // send a buyer to deal around the very check that makes the platform worth trusting.
    if (!isSellingPartner(partner)) {
      heroEl.innerHTML = '<div class="empty-state">Это хозяйство ещё не прошло проверку платформы. Его страница и лоты откроются после подтверждения.</div>';
      gridEl.innerHTML = "";
      return;
    }
    document.title = (partner.displayName || "Фермер") + " — ET";
    heroEl.innerHTML = heroHtml(partner);

    const lots = await getLotsByPartner(partnerId);
    const animals = await getAnimalsByIds(lots.flatMap((l) => l.animalIds || []));
    const animalsById = new Map(animals.map((a) => [a.id, a]));

    gridEl.innerHTML = lots.length
      ? lots.map((l) => lotCardHtml(l, { animalsById, configure: true })).join("")
      : '<div class="empty-state" style="grid-column:1/-1;">У этого хозяйства пока нет туш в продаже.</div>';
    // Leadership's window 1.3: the order is set up right on the farm's page.
    gridEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-configure]");
      const lot = btn && lots.find((l) => l.id === btn.dataset.configure);
      if (lot) openConfigurator(lot, partner, animalsById);
    });

    // The reviews come last and on their own: a farm with none must still show its lots.
    try {
      reviewsEl.innerHTML = reviewsHtml(partner, await getPartnerReviews(partnerId));
    } catch (e) {
      console.error(e);
      reviewsEl.innerHTML = "";
    }
  } catch (e) {
    console.error(e);
    heroEl.innerHTML = '<div class="empty-state">Не удалось загрузить профиль фермера.</div>';
  }
}

init();
