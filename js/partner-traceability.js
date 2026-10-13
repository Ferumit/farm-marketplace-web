import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requirePartner } from "./auth.js";
import { mountCabinetNav } from "./partner-nav.js";
import {
  getMyLots, getDeliverySteps, setDeliveryStepMedia, completeDeliveryStep,
  uploadImage, escapeHtml,
} from "./data.js";

mountLayout();
mountCabinetNav("/cabinet/delivery");

const tabsEl = document.getElementById("lot-tabs");
const stepsEl = document.getElementById("steps-list");
let session = null;
let lots = [];
let currentLotId = null;
let steps = [];

function stepStateClass(status) {
  if (status === "completed") return "completed";
  if (status === "current" || status === "in_progress") return "current";
  return "pending";
}

function renderTabs() {
  tabsEl.innerHTML = lots.map((l) =>
    `<button class="lot-tab${l.id === currentLotId ? " selected" : ""}" type="button" data-lot="${l.id}">${escapeHtml(l.name)}</button>`
  ).join("");
  tabsEl.querySelectorAll("[data-lot]").forEach((btn) => {
    btn.addEventListener("click", () => selectLot(btn.dataset.lot));
  });
}

function stepHtml(step) {
  const state = stepStateClass(step.status);
  const isActive = state === "current";
  const date = step.completedAt
    ? `<time>${new Date(step.completedAt.seconds * 1000).toLocaleDateString("ru-RU")}</time>` : "";

  const media = step.mediaUrl
    ? `<img class="step-media" src="${escapeHtml(step.mediaUrl)}" alt="Фото этапа">` : "";

  const actions = isActive ? `
    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-top:14px;">
      <label class="btn-pill btn-secondary btn-sm" style="cursor:pointer;">
        ${step.mediaUrl ? "Заменить фото" : "Приложить фото"}
        <input type="file" accept="image/*" data-photo="${escapeHtml(step.id)}" hidden>
      </label>
      <button class="btn-pill btn-primary btn-sm" data-complete="${escapeHtml(step.id)}" ${step.mediaUrl ? "" : "disabled"}>
        Завершить этап
      </button>
      ${step.mediaUrl ? "" : '<span class="progress-caption" style="align-self:center;">Фото обязательно</span>'}
    </div>` : "";

  return `
    <div class="timeline-step ${state}" style="padding-bottom:22px;">
      <div class="timeline-dot">${state === "completed" ? icon("check", { size: 14, stroke: 2.5 }) : state === "current" ? "●" : ""}</div>
      <div class="timeline-card">
        <div class="row-top">
          <h4>${escapeHtml(step.title)}</h4>
          ${date}
        </div>
        <p>${escapeHtml(step.subtitle || "")}</p>
        ${media}
        ${actions}
      </div>
    </div>`;
}

function renderSteps() {
  if (!steps.length) {
    stepsEl.innerHTML = '<div class="empty-state">У этого лота нет этапов доставки.</div>';
    return;
  }
  stepsEl.innerHTML = `<div class="timeline">${steps.map(stepHtml).join("")}</div>`;

  stepsEl.querySelectorAll("[data-photo]").forEach((input) => {
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      const label = input.closest("label");
      label.textContent = "Загружаем…";
      try {
        // The farm's own folder: Storage rules let a farm write only under lots/{its uid}/.
        const url = await uploadImage(
          `lots/${session.user.uid}/steps/${currentLotId}_${input.dataset.photo}_${Date.now()}.jpg`, file);
        await setDeliveryStepMedia(currentLotId, input.dataset.photo, url);
        await loadSteps();
      } catch (e) {
        console.error(e);
        alert("Не удалось загрузить фото.");
        await loadSteps();
      }
    });
  });

  stepsEl.querySelectorAll("[data-complete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const step = steps.find((s) => s.id === btn.dataset.complete);
      btn.disabled = true;
      btn.textContent = "…";
      try {
        await completeDeliveryStep(currentLotId, step, steps);
        await loadSteps();
      } catch (e) {
        console.error(e);
        alert("Не удалось завершить этап.");
        await loadSteps();
      }
    });
  });
}

async function loadSteps() {
  steps = await getDeliverySteps(currentLotId);
  renderSteps();
}

async function selectLot(lotId) {
  currentLotId = lotId;
  renderTabs();
  stepsEl.innerHTML = '<div class="timeline-card skeleton" style="height:120px;"></div>';
  try {
    await loadSteps();
  } catch (e) {
    console.error(e);
    stepsEl.innerHTML = '<div class="empty-state">Не удалось загрузить этапы.</div>';
  }
}

async function init() {
  session = await requirePartner();
  if (!session) return;
  // The steps now live on each order (cabinet/order.html), where they carry the evidence and the
  // money of that order. This lot-wide view stays for the mobile apps' old lots.
  document.getElementById("cabinet-nav")?.insertAdjacentHTML("afterend", `
    <div class="notice-box notice-icon" style="margin-bottom:18px;">${icon("clipboard-check", { size: 18 })}<span>
      Этапы теперь ведутся в карточке каждого заказа — со съёмкой, взвешиванием и документами.
      <a href="/cabinet/orders" style="color:var(--green); font-weight:700;">Перейти к заказам →</a></span></div>`);
  try {
    lots = await getMyLots(session.user.uid);
    if (!lots.length) {
      tabsEl.innerHTML = "";
      stepsEl.innerHTML = `<div class="empty-state">Сначала создайте лот —
        <a href="/cabinet/lots/new" style="color:var(--green)">конструктор лота →</a></div>`;
      return;
    }
    await selectLot(lots[0].id);
  } catch (e) {
    console.error(e);
    stepsEl.innerHTML = '<div class="empty-state">Не удалось загрузить лоты.</div>';
  }
}

init();
