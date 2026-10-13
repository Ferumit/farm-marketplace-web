import { lotCardHtml, MEAT_LABEL } from "./lot-card.js";
import { lotRegion, regionName, lotPlaceLabel } from "./regions.js";
import { mountLayout } from "./layout.js";
import {
  getOpenLots, getPartners, getAnimalsByIds, primaryAnimalType, escapeHtml,
} from "./data.js";
import { formatsOf } from "./carcass.js";

mountLayout();

const grid = document.getElementById("lots-grid");
const resultsCount = document.getElementById("results-count");
const searchInput = document.getElementById("f-search");
const regionSelect = document.getElementById("f-region");
const priceSelect = document.getElementById("f-price");
const availableCheck = document.getElementById("f-available");
const meatChecks = () => Array.from(document.querySelectorAll(".f-meat"));

let lots = [];
let partnersById = new Map();
let animalsById = new Map();

function applyFilters() {
  const search = searchInput.value.trim().toLowerCase();
  const activeMeats = meatChecks().filter((c) => c.checked).map((c) => c.value);
  const region = regionSelect.value;
  // "half:250000" - a half carcass still free at that price or less; "whole:..." likewise.
  const [budgetFormat, budgetMax] = (priceSelect.value || ":").split(":");
  const onlyAvailable = availableCheck.checked;

  const filtered = lots.filter((lot) => {
    const type = primaryAnimalType(lot, animalsById);
    const breed = (lot.animalIds || []).map((id) => animalsById.get(id)?.breed).find(Boolean) || "";
    const partnerName = partnersById.get(lot.partnerId)?.displayName || "";

    if (search) {
      // Meat type and region belong in here too: "конина" is the most obvious thing a buyer
      // types, and it appears in none of the stored text fields - only as a derived label.
      const haystack = [
        lot.name, lot.description, breed, partnerName, lot.location, lotPlaceLabel(lot), MEAT_LABEL[type],
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    if (activeMeats.length && !activeMeats.includes(type)) return false;
    if (region && lotRegion(lot) !== region) return false;
    const formats = formatsOf(lot);
    if (budgetFormat) {
      const f = formats[budgetFormat];
      if (!f || !f.available || f.meat > Number(budgetMax)) return false;
    }
    if (onlyAvailable && !formats.half.available && !formats.whole.available) return false;
    return true;
  });

  resultsCount.textContent = `Найдено лотов: ${filtered.length}`;
  paintFiltersToggle();
  grid.innerHTML = filtered.length
    ? filtered.map((lot) => lotCardHtml(lot, { animalsById, partner: partnersById.get(lot.partnerId) })).join("")
    : '<div class="empty-state" style="grid-column:1/-1;">По этим фильтрам лотов не найдено.</div>';
}

function renderRegionFilter() {
  // Only regions that actually have lots, named in Russian, one entry per region however many
  // spellings its lots use.
  const codes = [...new Set(lots.map(lotRegion).filter(Boolean))]
    .sort((a, b) => regionName(a).localeCompare(regionName(b), "ru"));
  regionSelect.innerHTML = '<option value="">Все регионы</option>' +
    codes.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(regionName(c))}</option>`).join("");
}

async function init() {
  // Lets the header search box - and the homepage's meat choice - deep-link into a filtered list.
  const params = new URLSearchParams(window.location.search);
  const q = params.get("q");
  if (q) searchInput.value = q;
  const meat = params.get("meat");
  meatChecks().forEach((c) => { if (c.value === meat) c.checked = true; });

  try {
    const [openLots, partners] = await Promise.all([getOpenLots(), getPartners()]);
    lots = openLots;
    partnersById = new Map(partners.map((p) => [p.id, p]));

    const animals = await getAnimalsByIds(lots.flatMap((l) => l.animalIds || []));
    animalsById = new Map(animals.map((a) => [a.id, a]));

    renderRegionFilter();
    applyFilters();
  } catch (e) {
    console.error(e);
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">Не удалось загрузить лоты.</div>';
  }
}


// On a phone the filter panel is a whole screen of controls standing between the visitor and the
// first lot, so it starts collapsed there. The button carries the active-filter count because a
// collapsed panel otherwise hides the fact that the list is being narrowed at all.
const filtersToggle = document.getElementById("filters-toggle");
const filtersPanel = document.getElementById("filters-panel");
const isPhone = window.matchMedia("(max-width: 899px)");

function activeFilterCount() {
  return (searchInput.value.trim() ? 1 : 0)
    + meatChecks().filter((c) => c.checked).length
    + (regionSelect.value ? 1 : 0)
    + (priceSelect.value ? 1 : 0)
    + (availableCheck.checked ? 1 : 0);
}

function paintFiltersToggle() {
  const n = activeFilterCount();
  filtersToggle.textContent = n ? `Фильтры · ${n}` : "Фильтры";
}

function setFiltersOpen(open) {
  filtersPanel.hidden = !open;
  filtersToggle.setAttribute("aria-expanded", String(open));
}

function syncFiltersToViewport() {
  // A leftover `hidden` would survive into the desktop layout, where the toggle is display:none -
  // the panel would vanish with nothing left to bring it back.
  setFiltersOpen(!isPhone.matches);
}

filtersToggle.addEventListener("click", () => setFiltersOpen(filtersPanel.hidden));
isPhone.addEventListener("change", syncFiltersToViewport);
syncFiltersToViewport();

searchInput.addEventListener("input", applyFilters);
regionSelect.addEventListener("change", applyFilters);
priceSelect.addEventListener("change", applyFilters);
availableCheck.addEventListener("change", applyFilters);
meatChecks().forEach((c) => c.addEventListener("change", applyFilters));

init();
