import { icon } from "./icons.js";
import { mountLayout } from "./layout.js";
import { requireRealLogin } from "./auth.js";
import {
  getMyPurchaseForLot, getLot, getPartner, getDeliverySteps, formatTenge, createDispute, getMyDisputes,
  pluralRu, escapeHtml, purchaseAmount, routeId,
} from "./data.js";
import { storage } from "./firebase-init.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

mountLayout();

const contentEl = document.getElementById("order-content");
const lotId = routeId("orders", "lotId");

// What the team decided, in the buyer's words. The note the team wrote comes after it.
const OUTCOME_FOR_BUYER = {
  buyer: "В вашу пользу",
  partner: "В пользу фермера",
  partial: "Частично в вашу пользу",
  withdrawn: "Претензия отозвана",
};

function stepClass(status) {
  if (status === "completed") return "completed";
  if (status === "current" || status === "in_progress") return "current";
  return "pending";
}

function stepIcon(status) {
  if (status === "completed") return icon("check", { size: 14, stroke: 2.5 });
  if (status === "current" || status === "in_progress") return "●";
  return "";
}

// The farmer cannot close a step without a photo of it, and that photo is the whole point of the
// tracker - it used to be stored and never shown to the buyer it was taken for.
function stepPhotoHtml(s) {
  if (!s.mediaUrl) return "";
  const url = escapeHtml(s.mediaUrl);
  return `<a class="step-photo" href="${url}" target="_blank" rel="noopener">
    <img src="${url}" alt="Фото этапа «${escapeHtml(s.title)}»" loading="lazy"></a>`;
}

function timelineHtml(steps) {
  return `<div class="timeline">${steps.map((s) => `
    <div class="timeline-step ${stepClass(s.status)}">
      <div class="timeline-dot">${stepIcon(s.status)}</div>
      <div class="timeline-card">
        <div class="row-top">
          <h4>${escapeHtml(s.title)}</h4>
          ${s.completedAt ? `<time>${new Date(s.completedAt.seconds * 1000).toLocaleDateString("ru-RU")}</time>` : ""}
        </div>
        <p>${escapeHtml(s.subtitle || s.description || "")}</p>
        ${stepPhotoHtml(s)}
      </div>
    </div>`).join("")}</div>`;
}

function renderHtml({ purchase, lot, partner, steps }) {
  const amount = formatTenge(purchaseAmount(purchase, lot));
  const amountNote = typeof purchase.amountPaid === "number" ? "" : " (по текущей цене лота)";
  const waNumber = (partner?.phone || "").replace(/[^\d]/g, "");
  const shareWord = pluralRu(purchase.shares, "доля", "доли", "долей");

  return `
    <span class="eyebrow">Отслеживание</span>
    <h1 style="margin-top:6px;">${escapeHtml(lot.name)}</h1>
    <p>${purchase.shares} ${shareWord} · ${amount}${amountNote}</p>

    <div class="order-layout" style="margin-top:20px;">
      <div>
        <div class="panel">
          <div class="progress-labels" style="margin-bottom:14px;">
            <span class="eyebrow" style="color:var(--ink-dim);">Статус</span>
          </div>
          ${steps.length ? timelineHtml(steps) : '<p style="font-size:14px;">Трекинг ещё не начат фермером.</p>'}
        </div>
      </div>

      <div>
        <div class="panel">
          <h4 class="eyebrow" style="margin-bottom:10px;">Escrow</h4>
          <p style="font-size:14px;">Здесь появится статус удержания средств и автоматическая
          доплата или возврат за перевес — после подключения платёжного провайдера. Пока оплата
          оформляется отдельно от сайта, вне Escrow.</p>
        </div>

        <div class="panel" style="margin-top:16px;">
          <h4 class="eyebrow" style="margin-bottom:10px;">Связь с фермером</h4>
          ${waNumber
            ? `<a class="btn-pill btn-primary btn-block" href="https://wa.me/${waNumber}" target="_blank" rel="noopener">${icon("message-circle", { size: 16 })} Написать в WhatsApp</a>`
            : `<p style="font-size:14px;">Контакт фермера пока не указан.</p>`}
        </div>

        <div class="panel" style="margin-top:16px;" id="dispute-slot"></div>
      </div>
    </div>`;
}

function disputeButtonHtml() {
  return `<button class="btn-pill btn-rust btn-block" id="btn-dispute">${icon("triangle-alert", { size: 16 })} Оспорить качество</button>`;
}

// The latest claim about this lot and what became of it. While one is open, a second is not
// offered - the team already has the case; after a decision the buyer can raise a new one.
async function renderDisputeSlot({ uid }) {
  const slot = document.getElementById("dispute-slot");
  if (!slot) return;
  let disputes = [];
  try {
    disputes = await getMyDisputes(uid, lotId);
  } catch (e) {
    // Not being able to show past claims must not take away the ability to file one.
    console.error(e);
  }
  const latest = disputes[0];
  const date = (ts) => (ts?.seconds ? new Date(ts.seconds * 1000).toLocaleDateString("ru-RU") : "");

  if (latest && latest.status !== "resolved") {
    const state = latest.status === "in_review" ? "На рассмотрении у администратора" : "Отправлена, ждёт рассмотрения";
    slot.innerHTML = `
      <h4 class="eyebrow" style="margin-bottom:10px;">Претензия</h4>
      <div class="notice-box notice-icon">${icon("clock", { size: 18 })}<span><strong>${state}.</strong>
        Администратор свяжется с вами по номеру из заказа.</span></div>
      <p style="font-size:13px; margin-top:10px;" class="claim-text">${date(latest.createdAt)} — ${escapeHtml(latest.description || "")}</p>`;
    return;
  }

  const decided = latest?.resolution ? `
    <h4 class="eyebrow" style="margin-bottom:10px;">Решение по претензии</h4>
    <div class="notice-box notice-icon" style="margin-bottom:14px;">${icon("check", { size: 18 })}<span>
      <strong>${escapeHtml(OUTCOME_FOR_BUYER[latest.resolution.outcome] || "Претензия рассмотрена")}.</strong>
      <span class="claim-text">${escapeHtml(latest.resolution.note || "")}</span>
      ${latest.resolution.decidedAt ? `<br><span style="font-size:12px; color:var(--ink-faint);">${date(latest.resolution.decidedAt)}</span>` : ""}
    </span></div>` : "";
  slot.innerHTML = decided + disputeButtonHtml();
  document.getElementById("btn-dispute").addEventListener("click", () =>
    openDisputeModal({ uid, lotId, onSent: () => renderDisputeSlot({ uid }) }));
}

function openDisputeModal({ uid, lotId, onSent }) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="row-top">
        <h3 style="margin:0;">Оспорить качество</h3>
        <button class="modal-close" aria-label="Закрыть">×</button>
      </div>
      <p style="font-size:14px;">Опишите проблему (запах, температура, несоответствие кусков).
      Обращение уходит администратору платформы для разбора и решения.</p>
      <div class="field">
        <label>Описание проблемы</label>
        <textarea id="dispute-text" placeholder="Опишите, что не так..."></textarea>
      </div>
      <div class="field">
        <label>Фото / видео доказательства</label>
        <input type="file" id="dispute-file" accept="image/*,video/*">
      </div>
      <p id="dispute-error" style="color:var(--danger); display:none;"></p>
      <button class="btn-pill btn-rust btn-block" id="btn-send-dispute">Отправить в арбитраж платформы</button>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".modal-close").addEventListener("click", close);

  overlay.querySelector("#btn-send-dispute").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const errorEl = overlay.querySelector("#dispute-error");
    const text = overlay.querySelector("#dispute-text").value.trim();
    const file = overlay.querySelector("#dispute-file").files[0];
    errorEl.style.display = "none";
    if (!text) {
      errorEl.textContent = "Опишите проблему.";
      errorEl.style.display = "block";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Отправка…";
    try {
      let mediaUrl = null;
      if (file) {
        const path = `disputes/${uid}/${lotId}_${Date.now()}_${file.name}`;
        const storageRef = ref(storage, path);
        await uploadBytes(storageRef, file);
        mediaUrl = await getDownloadURL(storageRef);
      }
      await createDispute({ uid, lotId, description: text, mediaUrl });
      overlay.querySelector(".modal-box").innerHTML = `
        <h3>Претензия отправлена</h3>
        <p style="font-size:14px;">Администратор рассмотрит обращение и свяжется с вами для
        решения по этому заказу. Статус претензии виден на этой странице.</p>
        <button class="btn-pill btn-primary btn-block" id="btn-close-ok">Понятно</button>`;
      overlay.querySelector("#btn-close-ok").addEventListener("click", close);
      onSent?.();
    } catch (err) {
      console.error(err);
      errorEl.textContent = "Не удалось отправить. Попробуйте ещё раз.";
      errorEl.style.display = "block";
      btn.disabled = false;
      btn.textContent = "Отправить в арбитраж платформы";
    }
  });
}

async function init() {
  // No argument: requireRealLogin() defaults to the current path, which is now the right answer.
  const user = await requireRealLogin();
  if (!user) return;
  // /order?id={order} follows one order through its steps; /orders/{lot} - below - is the older
  // view of a lot's production, kept for purchases made in the mobile app.
  const orderId = new URLSearchParams(window.location.search).get("id");
  if (orderId) {
    const { initOrderTracking } = await import("./order-track.js");
    await initOrderTracking(contentEl, orderId, user);
    return;
  }
  if (!lotId) {
    contentEl.innerHTML = '<div class="empty-state">Заказ не указан.</div>';
    return;
  }
  try {
    const purchase = await getMyPurchaseForLot(user.uid, lotId);
    if (!purchase) {
      contentEl.innerHTML = '<div class="empty-state">Заказ не найден среди ваших покупок.</div>';
      return;
    }
    const lot = await getLot(lotId);
    const [partner, steps] = await Promise.all([
      lot ? getPartner(lot.partnerId) : null,
      getDeliverySteps(lotId),
    ]);
    document.title = (lot?.name || "Заказ") + " — ET";
    contentEl.innerHTML = renderHtml({ purchase, lot, partner, steps });
    await renderDisputeSlot({ uid: user.uid });
  } catch (e) {
    console.error(e);
    contentEl.innerHTML = '<div class="empty-state">Не удалось загрузить заказ.</div>';
  }
}

init();
