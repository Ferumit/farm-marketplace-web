import { icon } from "./icons.js";
import { meatMonogram } from "./tiles.js";
import { mountLayout } from "./layout.js";
import { requirePartner } from "./auth.js";
import { mountCabinetNav, renderStatusNote } from "./partner-nav.js";
import {
  getMyAnimals, createAnimal, uploadImage, formatTenge, escapeHtml,
  DOC_KINDS, DOC_STATUS_LABEL, getDocumentsForAnimals, addAnimalDocument,
  deleteAnimalDocument, documentsSummary, describeDocFile,
} from "./data.js";
import { breedOptionsHtml, ageOptionsHtml, ageLabel } from "./livestock.js";
import { regionOptionsHtml, regionName, partnerRegion } from "./regions.js";

mountLayout();
mountCabinetNav("/cabinet/animals");

// Breed and age come from the species' own lists: a filter can only find what was entered in a
// known shape, and horse age names mean nothing for cattle.
const typeSelect = document.getElementById("f-type");
const breedSelect = document.getElementById("f-breed");
const breedOther = document.getElementById("f-breed-other");
function paintSpeciesLists() {
  breedSelect.innerHTML = breedOptionsHtml(typeSelect.value);
  document.getElementById("f-age").innerHTML = ageOptionsHtml(typeSelect.value);
  breedOther.hidden = breedSelect.value !== "__other";
}
typeSelect.addEventListener("change", paintSpeciesLists);
breedSelect.addEventListener("change", () => {
  breedOther.hidden = breedSelect.value !== "__other";
  if (!breedOther.hidden) breedOther.focus();
});
paintSpeciesLists();

const listEl = document.getElementById("animals-list");
const formEl = document.getElementById("add-form");
const errorEl = document.getElementById("form-error");
let session = null;
let docsByAnimal = new Map();
// Which rows the farmer has opened, so a re-render after an upload does not collapse them.
const openDocPanels = new Set();

const TYPE_LABEL = { cattle: "КРС", horse: "Лошадь" };
const DOC_CHIP_CLASS = { none: "draft", pending: "booked", approved: "open", rejected: "danger" };

function fileGlyph(contentType) {
  if ((contentType || "").startsWith("image/")) return icon("image", { size: 22 });
  if (contentType === "application/pdf") return icon("file-text", { size: 22 });
  return icon("file", { size: 22 });
}

function documentRowHtml(animalId, d) {
  const withdrawable = d.status === "pending";
  return `
    <div class="doc-row">
      <span class="doc-glyph">${fileGlyph(d.contentType)}</span>
      <div class="grow">
        <strong>${escapeHtml(d.label || "Документ")}</strong>
        <p class="doc-file">${escapeHtml(d.fileName || "")}</p>
        ${d.status === "rejected" && d.reviewNote
          ? `<p class="doc-note">Причина: ${escapeHtml(d.reviewNote)}</p>` : ""}
      </div>
      <span class="status-chip ${DOC_CHIP_CLASS[d.status] || "draft"}">${DOC_STATUS_LABEL[d.status] || d.status}</span>
      <a class="btn-pill btn-ghost btn-sm" href="${escapeHtml(d.fileUrl)}" target="_blank" rel="noopener">Открыть</a>
      ${withdrawable
        ? `<button class="btn-pill btn-ghost btn-sm" data-withdraw="${escapeHtml(d.id)}" data-animal="${escapeHtml(animalId)}">Убрать</button>`
        : ""}
    </div>`;
}

function documentPanelHtml(animalId) {
  const docs = docsByAnimal.get(animalId) || [];
  const options = DOC_KINDS.map((k) => `<option value="${k.id}">${escapeHtml(k.label)}</option>`).join("");
  return `
    <div class="doc-panel" data-panel="${escapeHtml(animalId)}">
      ${docs.length
        ? docs.map((d) => documentRowHtml(animalId, d)).join("")
        : `<p class="doc-empty">Документов пока нет. Покупатель видит, проверены ли бумаги на животное,
             поэтому лот без них выглядит слабее — а администратор не сможет подтвердить хозяйство.</p>`}
      <div class="doc-upload">
        <select data-kind="${escapeHtml(animalId)}">${options}</select>
        <input type="file" data-file="${escapeHtml(animalId)}"
               accept="image/*,application/pdf,.doc,.docx">
        <button class="btn-pill btn-secondary btn-sm" data-upload="${escapeHtml(animalId)}">Прикрепить</button>
      </div>
      <p class="doc-hint">Фото, PDF или Word, до 20 МБ. После загрузки документ уходит на проверку
        администратору — подтвердить его самостоятельно нельзя.</p>
      <p class="doc-error" data-docerror="${escapeHtml(animalId)}" hidden></p>
    </div>`;
}

function animalRowHtml(a) {
  const thumb = a.imageUrl
    ? `<img class="thumb" src="${escapeHtml(a.imageUrl)}" alt="">`
    : `<div class="thumb">${meatMonogram(a.type)}</div>`;
  const parts = [
    escapeHtml(a.breed),
    TYPE_LABEL[a.type] || "",
    escapeHtml(ageLabel(a.ageCategory, a.type)),
    a.weight ? `${a.weight} кг` : "",
    a.price ? `${formatTenge(a.price)}/кг` : "",
    escapeHtml(a.region || ""),
  ].filter(Boolean);

  const summary = documentsSummary(docsByAnimal.get(a.id));
  const open = openDocPanels.has(a.id);

  return `
    <div class="data-row">
      ${thumb}
      <div class="grow">
        <h4>${escapeHtml(a.breed || "Без породы")}</h4>
        <p>${parts.slice(1).join(" · ")}</p>
      </div>
      <span class="status-chip ${DOC_CHIP_CLASS[summary.state]}">${summary.label}</span>
      <button class="btn-pill btn-ghost btn-sm" data-docs="${escapeHtml(a.id)}"
              aria-expanded="${open}">Документы${open ? " ▴" : " ▾"}</button>
    </div>
    ${open ? documentPanelHtml(a.id) : ""}`;
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.style.display = "block";
}

function showDocError(animalId, msg) {
  const el = listEl.querySelector(`[data-docerror="${CSS.escape(animalId)}"]`);
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

document.getElementById("btn-toggle-form").addEventListener("click", () => {
  formEl.hidden = !formEl.hidden;
  if (!formEl.hidden) formEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

document.getElementById("btn-save-animal").addEventListener("click", async () => {
  errorEl.style.display = "none";
  const breed = breedSelect.value === "__other" ? breedOther.value.trim() : breedSelect.value;
  const weight = parseFloat(document.getElementById("f-weight").value.replace(",", "."));
  const price = parseFloat(document.getElementById("f-price").value.replace(",", "."));
  const regionCode = document.getElementById("f-region").value;
  const file = document.getElementById("f-photo").files[0];

  if (!breed) return showError("Укажите породу.");
  if (!weight || weight <= 0) return showError("Укажите корректный вес в кг.");
  if (!price || price <= 0) return showError("Укажите корректную цену за кг.");
  if (!regionCode) return showError("Выберите область.");

  const btn = document.getElementById("btn-save-animal");
  btn.disabled = true;
  btn.textContent = "Сохраняем…";
  try {
    let imageUrl = null;
    if (file) {
      // Same Storage path the partner app writes to (animals/{partnerId}/...), which the
      // storage rules already scope to the owning partner.
      imageUrl = await uploadImage(`animals/${session.user.uid}/${Date.now()}.jpg`, file);
    }
    const animalId = await createAnimal(session.user.uid, {
      breed,
      weight,
      price,
      // The name is what both apps display; the code is what the site filters by.
      region: regionName(regionCode),
      regionCode,
      type: typeSelect.value,
      gender: document.getElementById("f-gender").value,
      ageCategory: document.getElementById("f-age").value,
      imageUrl,
    });
    ["f-weight", "f-price", "f-breed-other"].forEach((id) => { document.getElementById(id).value = ""; });
    paintSpeciesLists();
    document.getElementById("f-photo").value = "";
    formEl.hidden = true;
    // Paperwork can only be attached once the animal exists, so open its panel straight away
    // rather than leaving the farmer to find it.
    if (animalId) openDocPanels.add(animalId);
    await renderList();
  } catch (e) {
    console.error(e);
    showError("Не удалось сохранить. Проверьте подключение и попробуйте ещё раз.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Добавить в реестр";
  }
});

listEl.addEventListener("click", async (e) => {
  const toggle = e.target.closest("[data-docs]");
  if (toggle) {
    const id = toggle.dataset.docs;
    if (openDocPanels.has(id)) openDocPanels.delete(id); else openDocPanels.add(id);
    await renderList();
    return;
  }

  const upload = e.target.closest("[data-upload]");
  if (upload) {
    const animalId = upload.dataset.upload;
    showDocError(animalId, "");
    const input = listEl.querySelector(`[data-file="${CSS.escape(animalId)}"]`);
    const kind = listEl.querySelector(`[data-kind="${CSS.escape(animalId)}"]`).value;
    const file = input.files[0];
    const problem = describeDocFile(file);
    if (problem) return showDocError(animalId, problem);

    upload.disabled = true;
    upload.textContent = "Загружаем…";
    try {
      await addAnimalDocument(session.user.uid, animalId, { kind, file });
      await reloadDocs();
      await renderList();
    } catch (err) {
      console.error(err);
      showDocError(animalId, err?.code === "storage/unauthorized"
        ? "Загрузка отклонена сервером. Проверьте формат файла."
        : (err?.message || "Не удалось загрузить документ."));
    } finally {
      upload.disabled = false;
      upload.textContent = "Прикрепить";
    }
    return;
  }

  const withdraw = e.target.closest("[data-withdraw]");
  if (withdraw) {
    const { withdraw: docId, animal: animalId } = withdraw.dataset;
    if (!window.confirm("Убрать документ? Его можно будет загрузить заново.")) return;
    withdraw.disabled = true;
    try {
      await deleteAnimalDocument(animalId, docId);
      await reloadDocs();
      await renderList();
    } catch (err) {
      console.error(err);
      showDocError(animalId, "Не удалось убрать документ.");
      withdraw.disabled = false;
    }
  }
});

let animals = [];

async function reloadDocs() {
  docsByAnimal = await getDocumentsForAnimals(animals.map((a) => a.id));
}

async function renderList() {
  animals = await getMyAnimals(session.user.uid);
  if (!docsByAnimal.size || docsByAnimal.size !== animals.length) await reloadDocs();
  listEl.innerHTML = animals.length
    ? animals.map(animalRowHtml).join("")
    : '<div class="empty-state">Скот пока не добавлен. Он понадобится, чтобы собрать лот.</div>';
}

async function init() {
  session = await requirePartner();
  if (!session) return;
  renderStatusNote(session.profile, session.user.uid);
  // Livestock usually stands in the hub's own region, so that is the starting choice.
  document.getElementById("f-region").insertAdjacentHTML("beforeend", regionOptionsHtml(partnerRegion(session.profile) || ""));
  try {
    await renderList();
  } catch (e) {
    console.error(e);
    listEl.innerHTML = '<div class="empty-state">Не удалось загрузить список скота.</div>';
  }
}

init();
