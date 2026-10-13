import { icon } from "./icons.js";
import { meatTile } from "./tiles.js";
import { primaryAnimalType, bookingPercent, formatTenge, escapeHtml } from "./data.js";
import { lotPlaceLabel } from "./regions.js";
import { bestOffer, availabilityLabel, weightLabel } from "./carcass.js";

export const MEAT_LABEL = { cattle: "Говядина", horse: "Конина" };

/**
 * A lot - one carcass - as a catalogue card: the one shape shared by the homepage, /lots and a
 * farm's page, so the three can no longer drift apart. The price shown is the cheapest way in that
 * is still free: a half if there is one, otherwise the whole carcass.
 *
 * `partner` names the farm under the title (the farm's own page leaves it out). `configure` is for
 * the farm's page: the card keeps its link to the lot page, and gains a «Выбрать» button that sets
 * up the order right there - so the card becomes an <article> with a stretched link instead of one
 * big link, and the button is not nested inside a link.
 */
export function lotCardHtml(lot, { animalsById = new Map(), partner = null, configure = false } = {}) {
  const pct = bookingPercent(lot);
  const type = primaryAnimalType(lot, animalsById);
  const animal = (lot.animalIds || []).map((id) => animalsById.get(id)).find(Boolean);
  const name = escapeHtml(lot.name);
  const photo = lot.imageUrl
    ? `<img src="${escapeHtml(lot.imageUrl)}" alt="${name}" loading="lazy">`
    : meatTile(type);
  const meta = [
    escapeHtml(animal?.breed),
    MEAT_LABEL[type],
    lot.totalWeight ? `туша ${escapeHtml(weightLabel(Number(lot.totalWeight)))}` : null,
  ].filter(Boolean).join(" · ");

  const offer = bestOffer(lot);
  const price = offer
    ? `<span><span class="eyebrow" style="color:var(--ink-faint);">${offer.format === "half" ? "Половина" : "Целая туша"}${offer.weight ? " · " + escapeHtml(weightLabel(offer.weight)) : ""}</span><br>
        <strong style="font-family:var(--font-display); font-size:20px;">${formatTenge(offer.meat)}</strong></span>`
    : '<span class="eyebrow" style="color:var(--ink-faint);">Всё забронировано</span>';

  const href = `/lots/${encodeURIComponent(lot.id)}`;
  const title = configure ? `<h3><a class="stretched-link" href="${href}">${name}</a></h3>` : `<h3>${name}</h3>`;
  const cta = configure && offer
    ? `<button type="button" class="btn-pill btn-primary btn-sm card-action" data-configure="${escapeHtml(lot.id)}">Выбрать →</button>`
    : '<span class="btn-pill btn-primary btn-sm" aria-hidden="true">Подробнее →</span>';

  const body = `
      <div class="photo-wrap">
        ${photo}
        <span class="badge-pill on-photo">${icon("map-pin", { size: 14 })} ${escapeHtml(lotPlaceLabel(lot) || "Казахстан")}</span>
      </div>
      <div class="content">
        ${title}
        <p class="desc">${meta || "Подробности уточняются"}</p>
        ${partner ? `<p class="desc card-farm">${escapeHtml(partner.displayName || "Фермер")}</p>` : ""}
        <div class="progress-row">
          <div class="progress-labels">
            <span>${escapeHtml(availabilityLabel(lot))}</span><span class="value">${pct}%</span>
          </div>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="cta-row">
          ${price}
          ${cta}
        </div>
      </div>`;

  return configure
    ? `<article class="card-photo card-stretch">${body}</article>`
    : `<a class="card-photo" href="${href}">${body}</a>`;
}
