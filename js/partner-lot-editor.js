import { icon } from "./icons.js";
import { meatMonogram } from "./tiles.js";
import { mountLayout } from "./layout.js";
import { requirePartner } from "./auth.js";
import { mountCabinetNav } from "./partner-nav.js";
import { regionOptionsHtml, regionName, partnerRegion } from "./regions.js";
import { ageLabel } from "./livestock.js";
import {
  getMyAnimals, createLot, uploadImage, formatTenge, escapeHtml,
  getDocumentsForAnimals, documentsSummary,
} from "./data.js";

mountLayout();
mountCabinetNav("/cabinet/lots");

// A carcass is usually a little over half of the live weight; this only pre-fills the field.
const CARCASS_YIELD = 0.55;
const TYPE_WORD = { cattle: "говядина", horse: "конина" };
const DOC_CHIP = { none: "draft", pending: "booked", approved: "open", rejected: "danger" };

const errorEl = document.getElementById("form-error");
const pickerEl = document.getElementById("animals-picker");
const nameInput = document.getElementById("f-name");
const weightInput = document.getElementById("f-weight");
const priceInput = document.getElementById("f-price");
const halvesInput = document.getElementById("f-halves");
let session = null;
let animals = [];
let docsByAnimal = new Map();
let selectedId = null;
let nameTouched = false;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}

const num = (el) => parseFloat(String(el.value).replace(/\s/g, "").replace(",", "."));

function suggestedName(a) {
  const age = a.ageCategory ? ageLabel(a.ageCategory, a.type).split(" · ")[0] : "";
  return [a.breed, age, TYPE_WORD[a.type]].filter(Boolean).join(", ");
}

function renderAnimals() {
  if (!animals.length) {
    pickerEl.innerHTML = `<div class="notice-box">Сначала добавьте скот —
      <a href="/cabinet/animals" style="color:var(--green)">раздел «Скот»</a>.</div>`;
    return;
  }
  pickerEl.innerHTML = animals.map((a) => {
    const picked = selectedId === a.id;
    const mini = a.imageUrl
      ? `<img class="mini" src="${escapeHtml(a.imageUrl)}" alt="">`
      : `<div class="mini">${meatMonogram(a.type)}</div>`;
    const summary = documentsSummary(docsByAnimal.get(a.id));
    return `
      <div class="animal-pick${picked ? " selected" : ""}" data-animal="${escapeHtml(a.id)}" role="radio" aria-checked="${picked}" tabindex="0">
        ${mini}
        <div class="grow" style="flex:1;">
          <strong style="font-size:14px;">${escapeHtml(a.breed || "Без породы")}</strong>
          <div class="progress-caption">${[a.ageCategory ? escapeHtml(ageLabel(a.ageCategory, a.type)) : "", a.weight ? `${escapeHtml(a.weight)} кг живого веса` : ""].filter(Boolean).join(" · ")}</div>
        </div>
        <span class="status-chip ${DOC_CHIP[summary.state]}" style="font-size:11px;">${summary.label}</span>
        <span>${picked ? icon("check", { size: 18, stroke: 2.5 }) : ""}</span>
      </div>`;
  }).join("");
}

function pick(id) {
  selectedId = id;
  const a = animals.find((x) => x.id === id);
  if (a) {
    // Pre-fill what the animal already says; anything the farmer has typed stays theirs.
    if (!nameTouched) nameInput.value = suggestedName(a);
    if (!weightInput.value && Number(a.weight) > 0) weightInput.value = String(Math.round(Number(a.weight) * CARCASS_YIELD));
    if (!priceInput.value && Number(a.price) > 0) priceInput.value = String(Math.round(Number(a.price)));
    document.getElementById("weight-hint").textContent = Number(a.weight) > 0
      ? `Живой вес — ${a.weight} кг; туша обычно около ${Math.round(CARCASS_YIELD * 100)} % от него. Точный вес определит контрольное взвешивание.`
      : "Точный вес определит контрольное взвешивание после забоя.";
  }
  renderAnimals();
  recalc();
}

function recalc() {
  const weight = num(weightInput) || 0;
  const price = num(priceInput) || 0;
  const whole = weight * price;
  const halves = halvesInput.checked;
  document.getElementById("calc-half-row").style.display = halves ? "" : "none";
  const kg = (w) => String(Math.round(w * 10) / 10).replace(".", ",");
  document.getElementById("calc-half-label").textContent = weight ? `Половина, ~${kg(weight / 2)} кг` : "Половина";
  document.getElementById("calc-whole-label").textContent = weight ? `Целая туша, ~${kg(weight)} кг` : "Целая туша";
  document.getElementById("calc-half").textContent = whole > 0 ? formatTenge(whole / 2) : "—";
  document.getElementById("calc-whole").textContent = whole > 0 ? formatTenge(whole) : "—";
}

pickerEl.addEventListener("click", (e) => {
  const row = e.target.closest("[data-animal]");
  if (row) pick(row.dataset.animal);
});
pickerEl.addEventListener("keydown", (e) => {
  const row = e.target.closest("[data-animal]");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(row.dataset.animal); }
});
nameInput.addEventListener("input", () => { nameTouched = true; });
[weightInput, priceInput].forEach((el) => el.addEventListener("input", recalc));
halvesInput.addEventListener("change", recalc);

document.getElementById("btn-create").addEventListener("click", async () => {
  errorEl.style.display = "none";
  const animal = animals.find((a) => a.id === selectedId);
  const name = nameInput.value.trim();
  const weight = num(weightInput);
  const pricePerKg = Math.round(num(priceInput));
  const regionCode = document.getElementById("f-region").value;
  const file = document.getElementById("f-photo").files[0];

  if (!animal) return showError("Выберите животное — лот это одна туша.");
  if (!name) return showError("Введите название.");
  if (!weight || weight <= 0 || weight > 2000) return showError("Укажите примерный вес туши в кг.");
  if (!pricePerKg || pricePerKg <= 0) return showError("Введите цену за 1 кг туши.");
  if (!regionCode) return showError("Выберите регион.");

  // Paperwork is the point of the whole mechanic, so a lot cannot be assembled from livestock that
  // has none. Supplying the documents is the farmer's part and is enforced; approval is the
  // reviewer's, and waiting for it would block the farmer on somebody else's queue.
  if (!(docsByAnimal.get(animal.id) || []).length) {
    return showError("У этого животного нет ветеринарных документов. Прикрепите их в разделе «Скот» — без бумаг лот не примут на проверку.");
  }

  const btn = document.getElementById("btn-create");
  btn.disabled = true;
  btn.textContent = "Создаём…";
  try {
    let imageUrl = null;
    if (file) imageUrl = await uploadImage(`lots/${session.user.uid}/${Date.now()}.jpg`, file);
    const totalShares = halvesInput.checked ? 2 : 1;
    await createLot(session.user.uid, {
      name,
      description: document.getElementById("f-desc").value.trim(),
      animalIds: [animal.id],
      totalWeight: Math.round(weight * 10) / 10,
      pricePerKg,
      totalShares,
      // Kept for both apps, which still price by share.
      pricePerShare: Math.round((weight * pricePerKg) / totalShares),
      // The code for filtering and the map; the name because it is what both apps display.
      regionCode,
      location: regionName(regionCode),
      meatType: animal.type || null,
      imageUrl,
    });
    window.location.href = "/cabinet/lots";
  } catch (e) {
    console.error(e);
    showError("Не удалось создать лот. Попробуйте ещё раз.");
    btn.disabled = false;
    btn.textContent = "Создать лот";
  }
});

async function init() {
  session = await requirePartner();
  if (!session) return;
  // A lot usually comes from the hub's own region, so that is the starting choice.
  document.getElementById("f-region").insertAdjacentHTML("beforeend", regionOptionsHtml(partnerRegion(session.profile) || ""));
  recalc();
  try {
    animals = (await getMyAnimals(session.user.uid)).filter((a) => a.status !== "sold");
    docsByAnimal = await getDocumentsForAnimals(animals.map((a) => a.id));
    renderAnimals();
  } catch (e) {
    console.error(e);
    pickerEl.innerHTML = '<div class="empty-state">Не удалось загрузить скот.</div>';
  }
}

init();
