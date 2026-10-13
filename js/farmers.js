import { icon } from "./icons.js";
import { meatTile } from "./tiles.js";
import { mountLayout } from "./layout.js";
import { getPartners, getOpenLots, getAnimalsByIds, primaryAnimalType, escapeHtml, pluralRu, formatTenge } from "./data.js";
import { partnerRegion, regionName, partnerPlaceLabel, ZONES, zoneOf } from "./regions.js";
import { BREEDS, AGES, ageKey, nameKey } from "./livestock.js";
import { openVideo } from "./video-modal.js";

mountLayout();

const grid = document.getElementById("farmer-grid");
const resultsCount = document.getElementById("results-count");
const resetBtn = document.getElementById("f-reset");
const meatButtons = [...document.querySelectorAll("#meat-switch [data-meat]")];
const f = {
  zone: document.getElementById("f-zone"),
  region: document.getElementById("f-region"),
  breed: document.getElementById("f-breed"),
  age: document.getElementById("f-age"),
  budget: document.getElementById("f-budget"),
  rating: document.getElementById("f-rating"),
  search: document.getElementById("f-search"),
};

const MEAT_LABEL = { cattle: "Говядина", horse: "Конина" };
let meat = "";          // "", "cattle" or "horse" - the switch above the filters
let farmers = [];
let offersByFarm = new Map(); // partnerId -> offers[]
let dataBreeds = new Map();   // species -> Map(nameKey -> the spelling farms use)

// ---- offers: what a buyer can actually buy from a farm right now ---------------------------------
//
// One per open lot, priced for the formats that are still free: a whole carcass needs every share
// free, a half needs half of them. The lot-level filters (meat, breed, age, budget) are checked
// against ONE offer at a time - a farm with cheap beef and dear horse meat must not turn up for
// "конина до 250 000 ₸" because of the beef.
function offerOf(lot, animalsById) {
  const total = Number(lot.totalShares) || 0;
  const free = total - (Number(lot.bookedShares) || 0);
  const whole = (Number(lot.pricePerShare) || 0) * total;
  const animals = (lot.animalIds || []).map((id) => animalsById.get(id)).filter(Boolean);
  const type = primaryAnimalType(lot, animalsById);
  return {
    type,
    breeds: new Set(animals.map((a) => nameKey(a.breed)).filter(Boolean)),
    ages: new Set(animals.map((a) => ageKey(a.ageCategory, a.type || type)).filter(Boolean)),
    whole: total > 0 && free === total && whole > 0 ? whole : null,
    half: total > 0 && total % 2 === 0 && free >= total / 2 && whole > 0 ? whole / 2 : null,
    breedNames: animals.map((a) => a.breed).filter(Boolean),
  };
}

function lotFilters() {
  const [format, max] = (f.budget.value || ":").split(":");
  return { meat, breed: f.breed.value, age: f.age.value, format, max: Number(max) || 0 };
}

function offerMatches(o, q) {
  if (q.meat && o.type !== q.meat) return false;
  if (q.breed && !o.breeds.has(q.breed)) return false;
  if (q.age && !o.ages.has(q.age)) return false;
  if (q.format) {
    const price = o[q.format];
    if (price == null || price > q.max) return false;
  }
  return true;
}

// ---- filter options ----------------------------------------------------------------------------

function fillSelect(select, firstLabel, options, keep = true) {
  const current = select.value;
  select.innerHTML = `<option value="">${firstLabel}</option>` + options;
  if (keep && [...select.options].some((o) => o.value === current)) select.value = current;
}

function paintZones() {
  const present = new Set(farmers.map((p) => zoneOf(partnerRegion(p))).filter(Boolean));
  fillSelect(f.zone, "Все зоны", ZONES.filter((z) => present.has(z.id))
    .map((z) => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join(""));
}

// Only regions that have a farm, and inside the chosen zone.
function paintRegions() {
  const zone = ZONES.find((z) => z.id === f.zone.value);
  const codes = [...new Set(farmers.map(partnerRegion).filter(Boolean))]
    .filter((c) => !zone || zone.codes.includes(c))
    .sort((a, b) => regionName(a).localeCompare(regionName(b), "ru"));
  fillSelect(f.region, "Все области", codes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(regionName(c))}</option>`).join(""));
}

// The dictionary for the chosen meat, plus any breed farms have actually entered that it lacks -
// a filter must never hide a farm because of how its breed was spelled.
function paintBreeds() {
  const species = meat ? [meat] : ["cattle", "horse"];
  const byKey = new Map();
  species.forEach((s) => {
    BREEDS[s].forEach((b) => byKey.set(nameKey(b), b));
    (dataBreeds.get(s) || new Map()).forEach((name, key) => { if (!byKey.has(key)) byKey.set(key, name); });
  });
  const options = [...byKey.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"))
    .map(([key, name]) => `<option value="${escapeHtml(key)}">${escapeHtml(name)}</option>`).join("");
  fillSelect(f.breed, "Любая", options);
}

// Age names are the horse's and the cow's own; without a chosen meat they would mix, so the
// filter waits for the switch above.
function paintAges() {
  if (!meat) {
    f.age.innerHTML = '<option value="">Сначала выберите вид мяса</option>';
    f.age.disabled = true;
    return;
  }
  f.age.disabled = false;
  fillSelect(f.age, "Любой", AGES[meat].map((a) => `<option value="${a.value}">${a.value} · ${a.hint}</option>`).join(""));
}

// ---- cards -------------------------------------------------------------------------------------

function badges(p) {
  const out = [];
  if (p.status === "verified" || p.status === "active") {
    out.push(`<span class="badge-pill badge-verified with-icon">${icon("badge-check", { size: 14 })}Проверен</span>`);
  }
  // Set by the platform alone, once СЭС and ветконтроль are both approved.
  if (p.certified) {
    out.push(`<span class="badge-pill badge-verified with-icon" title="СЭС и ветконтроль подтверждены платформой">${icon("shield-check", { size: 14 })}Сертификаты</span>`);
  }
  return out.length ? `<span class="badge-row">${out.join("")}</span>` : "";
}

function farmerCardHtml(p, offers, q) {
  const types = new Set(offers.map((o) => o.type).filter(Boolean));
  const meatLabels = [...types].map((t) => escapeHtml(MEAT_LABEL[t] || t)).join(" · ");
  const tileType = types.has("horse") && !types.has("cattle") ? "horse"
    : types.has("cattle") && !types.has("horse") ? "cattle"
    : types.size ? "mixed" : "farm";
  const name = escapeHtml(p.displayName || "Фермер");
  const sf = p.storefront || {};
  // A farm with a slaughterhouse video shows its still, and a button that plays it right here.
  const photo = sf.videoUrl && sf.posterUrl ? `<img src="${escapeHtml(sf.posterUrl)}" alt="Цех хозяйства ${name}" loading="lazy">`
    : p.avatarUrl ? `<img src="${escapeHtml(p.avatarUrl)}" alt="${name}" loading="lazy">`
    : meatTile(tileType);
  const play = sf.videoUrl
    ? `<button type="button" class="video-play" data-video="${escapeHtml(sf.videoUrl)}" data-title="${name}">${icon("play", { size: 14 })} Видео цеха</button>`
    : "";

  // The cheapest way in among what fits the current filters: a half if there is one.
  const fitting = offers.filter((o) => offerMatches(o, { ...q, format: "", max: 0 }));
  const cheapest = (key) => {
    const prices = fitting.map((o) => o[key]).filter((v) => v != null);
    return prices.length ? Math.min(...prices) : null;
  };
  const half = cheapest("half");
  const whole = cheapest("whole");
  const price = half != null ? `<p class="price-from">Половина от <strong>${formatTenge(half)}</strong></p>`
    : whole != null ? `<p class="price-from">Целая туша от <strong>${formatTenge(whole)}</strong></p>` : "";

  return `
    <article class="card-photo card-stretch">
      <div class="photo-wrap">
        ${photo}
        <span class="badge-pill on-photo">${icon("map-pin", { size: 14 })} ${escapeHtml(partnerPlaceLabel(p) || "Регион не указан")}</span>
        ${play}
      </div>
      <div class="content">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
          <h3><a class="stretched-link" href="/farmers/${encodeURIComponent(p.id)}">${name}</a></h3>
          ${badges(p)}
        </div>
        <p class="desc">${meatLabels || "Ассортимент уточняется"}${offers.length ? ` · ${offers.length} ${pluralRu(offers.length, "лот", "лота", "лотов")}` : ""}</p>
        ${price}
        <div class="cta-row">
          <span class="stat-inline"><span class="stat"><span class="num">${(Number(p.rating) || 0).toFixed(1)}</span><span class="lbl with-icon">${icon("star", { size: 13 })}рейтинг</span></span></span>
          <span class="btn-pill btn-primary btn-sm" aria-hidden="true">Перейти к мясу →</span>
        </div>
      </div>
    </article>`;
}

// ---- filtering ---------------------------------------------------------------------------------

function applyFilters() {
  const q = lotFilters();
  const lotLevel = q.meat || q.breed || q.age || q.format;
  const search = nameKey(f.search.value);
  const minRating = Number(f.rating.value) || 0;

  const shown = farmers.filter((p) => {
    const code = partnerRegion(p);
    if (f.zone.value && zoneOf(code) !== f.zone.value) return false;
    if (f.region.value && code !== f.region.value) return false;
    if ((Number(p.rating) || 0) < minRating) return false;
    if (search && !nameKey(p.displayName).includes(search)) return false;
    if (lotLevel && !(offersByFarm.get(p.id) || []).some((o) => offerMatches(o, q))) return false;
    return true;
  });

  resultsCount.textContent = `Найдено ${shown.length} ${pluralRu(shown.length, "хаб", "хаба", "хабов")}`;
  resetBtn.hidden = !activeFilterCount();
  paintFiltersToggle();
  grid.innerHTML = shown.length
    ? shown.map((p) => farmerCardHtml(p, offersByFarm.get(p.id) || [], q)).join("")
    : '<div class="empty-state" style="grid-column:1/-1;">По этим фильтрам хабов не найдено.</div>';
  writeUrl();
}

function activeFilterCount() {
  return [meat, f.zone.value, f.region.value, f.breed.value, f.age.value, f.budget.value,
    Number(f.rating.value) ? "1" : "", f.search.value.trim()].filter(Boolean).length;
}

// ---- the address bar: a filtered catalogue is a link that can be sent to someone ----------------

const URL_KEYS = { zone: "zone", region: "region", breed: "breed", age: "age", budget: "budget", rating: "rating", search: "q" };

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  meat = ["cattle", "horse"].includes(params.get("meat")) ? params.get("meat") : "";
  return params;
}

function writeUrl() {
  const params = new URLSearchParams();
  if (meat) params.set("meat", meat);
  Object.entries(URL_KEYS).forEach(([k, name]) => {
    const v = f[k].value.trim();
    if (v && !(k === "rating" && !Number(v))) params.set(name, v);
  });
  const qs = params.toString();
  history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
}

function restoreFromUrl(params) {
  Object.entries(URL_KEYS).forEach(([k, name]) => {
    const v = params.get(name);
    if (v != null && (f[k].tagName === "INPUT" || [...f[k].options].some((o) => o.value === v))) f[k].value = v;
  });
}

function paintMeatSwitch() {
  meatButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.meat === meat)));
}

// ---- phones: the bar collapses behind a button that says how many filters are on --------------

const filtersToggle = document.getElementById("filters-toggle");
const filterBar = document.getElementById("filter-bar");
const isPhone = window.matchMedia("(max-width: 899px)");
function paintFiltersToggle() {
  const n = activeFilterCount() - (meat ? 1 : 0); // the meat switch stays visible on its own
  filtersToggle.textContent = n ? `Фильтры · ${n}` : "Фильтры";
}
function setFiltersOpen(open) {
  filterBar.hidden = !open;
  filtersToggle.setAttribute("aria-expanded", String(open));
}
filtersToggle.addEventListener("click", () => setFiltersOpen(filterBar.hidden));
isPhone.addEventListener("change", () => setFiltersOpen(!isPhone.matches));

// ---- wiring --------------------------------------------------------------------------------------

meatButtons.forEach((b) => b.addEventListener("click", () => {
  meat = b.dataset.meat;
  paintMeatSwitch();
  paintBreeds();
  paintAges();
  applyFilters();
}));
f.zone.addEventListener("change", () => { paintRegions(); applyFilters(); });
["region", "breed", "age", "budget", "rating"].forEach((k) => f[k].addEventListener("change", applyFilters));
f.search.addEventListener("input", applyFilters);
grid.addEventListener("click", (e) => {
  const play = e.target.closest("[data-video]");
  if (play) openVideo(play.dataset.video, play.dataset.title);
});
resetBtn.addEventListener("click", () => {
  meat = "";
  Object.values(f).forEach((el) => { el.value = el.id === "f-rating" ? "0" : ""; });
  paintMeatSwitch();
  paintRegions();
  paintBreeds();
  paintAges();
  applyFilters();
});

async function init() {
  const params = readUrl();
  paintMeatSwitch();
  // A link with filters in it opens them; otherwise phones start collapsed, as on /lots.
  const hasBarFilters = Object.values(URL_KEYS).some((name) => params.get(name));
  setFiltersOpen(!isPhone.matches || hasBarFilters);
  try {
    const [partnersRes, lots] = await Promise.all([getPartners(), getOpenLots()]);
    farmers = partnersRes;
    const animals = await getAnimalsByIds(lots.flatMap((l) => l.animalIds || []));
    const animalsById = new Map(animals.map((a) => [a.id, a]));

    offersByFarm = new Map(farmers.map((p) => [p.id, []]));
    dataBreeds = new Map([["cattle", new Map()], ["horse", new Map()]]);
    lots.forEach((lot) => {
      const offers = offersByFarm.get(lot.partnerId);
      if (!offers) return;
      const offer = offerOf(lot, animalsById);
      offers.push(offer);
      if (offer.type && dataBreeds.has(offer.type)) {
        offer.breedNames.forEach((n) => dataBreeds.get(offer.type).set(nameKey(n), n));
      }
    });

    paintZones();
    restoreFromUrl(params);   // zone first: the region list depends on it
    paintRegions();
    paintBreeds();
    paintAges();
    restoreFromUrl(params);   // then the lists that were just built
    applyFilters();
  } catch (e) {
    console.error(e);
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">Не удалось загрузить каталог. Попробуйте обновить страницу.</div>';
  }
}

init();
