// The site's notification centre: the bell in the header.
//
// Every notification is written by the server, inside the transaction of the event it announces
// (functions/index.js), so this file only reads them and marks them read - a browser cannot write
// one, which is why a buyer can trust "хозяйство приняло заказ". It listens rather than polls: an
// order accepted while the page is open shows up without a refresh, and a page left open all day
// costs one idle connection instead of a request every minute.
//
// Push notifications stay with the mobile apps (they have FCM); on the web this bell and, once
// the mail extension is installed, email are what reach a person who is not looking at the site.
import { icon } from "./icons.js";
import { escapeHtml, pluralRu } from "./data.js";
import { db, authReady, isRealUser } from "./firebase-init.js";
import {
  collection, query, where, orderBy, limit, onSnapshot, doc, updateDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// Enough to cover a day of an active order without turning the panel into a page of its own.
const SHOWN = 15;

// The live listener of the mount that owns the bell on screen. A second mount replaces it, so a
// page never keeps a connection feeding a panel that is no longer there.
let stopListening = null;

const KIND_ICON = {
  order_new: "shopping-cart",
  order_accepted: "handshake",
  order_step: "camera",
  order_handover: "truck",
  order_completed: "check",
  order_cancelled: "x",
  order_disputed: "triangle-alert",
  dispute_resolved: "shield-check",
  farm_review: "badge-check",
  document_review: "file-text",
  review_new: "star",
  review_moderated: "star",
  group_joined: "users",
  group_ready: "users",
};

function timeAgo(ts) {
  const seconds = ts?.seconds;
  if (!seconds) return "";
  const min = Math.floor((Date.now() - seconds * 1000) / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} ${pluralRu(days, "день", "дня", "дней")} назад`;
  return new Date(seconds * 1000).toLocaleDateString("ru-RU");
}

function itemHtml(n) {
  return `
    <a class="notif-item${n.read ? "" : " unread"}" href="${escapeHtml(n.link || "/")}" data-id="${escapeHtml(n.id)}">
      <span class="notif-item__icon">${icon(KIND_ICON[n.kind] || "bell", { size: 16 })}</span>
      <span class="notif-item__text">
        <strong>${escapeHtml(n.title || "")}</strong>
        ${n.body ? `<span>${escapeHtml(n.body)}</span>` : ""}
        <time>${escapeHtml(timeAgo(n.createdAt))}</time>
      </span>
    </a>`;
}

/** Marking read is a convenience, not an operation: a refused or offline write changes nothing. */
async function markRead(id) {
  try {
    await updateDoc(doc(db, "notifications", id), { read: true, readAt: serverTimestamp() });
  } catch (e) {
    console.error(e);
  }
}

export function mountNotifications() {
  if (!document.getElementById("notif-slot")) return;

  authReady.then((user) => {
    // Anonymous visitors - what the public catalogue browses with - have nothing addressed to them.
    if (!isRealUser(user)) return;
    // mountLayout runs twice on every page (the page script calls it, then DOMContentLoaded does),
    // and it rebuilds the header each time - so take the slot that is on screen NOW and drop any
    // panel a previous mount left behind, or the bell would open two stacked lists.
    const slot = document.getElementById("notif-slot");
    if (!slot) return;
    document.getElementById("notif-panel")?.remove();
    if (stopListening) stopListening();

    slot.innerHTML = `
      <button class="icon-btn notif-btn" type="button" id="notif-btn" aria-label="Уведомления" aria-expanded="false">
        ${icon("bell", { size: 18 })}<span class="notif-dot" id="notif-dot" hidden></span>
      </button>`;
    const panel = document.createElement("div");
    panel.className = "notif-panel";
    panel.id = "notif-panel";
    panel.hidden = true;
    document.querySelector(".site-header .container")?.appendChild(panel);

    const btn = document.getElementById("notif-btn");
    const dot = document.getElementById("notif-dot");
    let items = [];

    const paint = () => {
      const unread = items.filter((n) => !n.read);
      dot.hidden = unread.length === 0;
      dot.textContent = unread.length > 9 ? "9+" : String(unread.length);
      panel.innerHTML = `
        <div class="notif-panel__head">
          <strong>Уведомления</strong>
          ${unread.length ? '<button class="link-btn" type="button" id="notif-all">Прочитать все</button>' : ""}
        </div>
        ${items.length
          ? items.map(itemHtml).join("")
          : '<p class="notif-empty">Пока ничего нового. Здесь появятся заказы, шаги хозяйства и решения платформы.</p>'}`;

      panel.querySelectorAll(".notif-item").forEach((a) => {
        // The link is followed as usual; the read mark is sent on the way out.
        a.addEventListener("click", () => markRead(a.dataset.id));
      });
      document.getElementById("notif-all")?.addEventListener("click", () => {
        unread.forEach((n) => markRead(n.id));
      });
    };

    const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    btn.addEventListener("click", () => {
      const open = panel.hidden;
      panel.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (e) => {
      if (!panel.hidden && !panel.contains(e.target) && !btn.contains(e.target)) close();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

    const q = query(
      collection(db, "notifications"),
      where("uid", "==", user.uid),
      orderBy("createdAt", "desc"),
      limit(SHOWN),
    );
    stopListening = onSnapshot(q, (snap) => {
      items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      paint();
    }, (e) => {
      // A missing index or a refused read must not break the header around it.
      console.error(e);
    });
    paint();
  });
}
