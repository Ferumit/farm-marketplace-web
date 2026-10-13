import { icon } from "./icons.js";
import { escapeHtml, getFarmPrivate } from "./data.js";

const TABS = [
  { href: "/cabinet/orders", label: "Заказы" },
  { href: "/cabinet/lots", label: "Лоты" },
  { href: "/cabinet/animals", label: "Скот" },
  { href: "/cabinet/storefront", label: "Витрина" },
  { href: "/profile", label: "Профиль" },
];

export function mountCabinetNav(activeHref) {
  const mount = document.getElementById("cabinet-nav");
  if (!mount) return;
  mount.className = "cabinet-nav";
  mount.innerHTML = TABS.map((t) =>
    `<a href="${t.href}"${t.href === activeHref ? ' class="active"' : ""}>${t.label}</a>`
  ).join("");
}

// Information for the farm, not a gate - the gates are server-side. What review controls is
// selling: the storefront shows only checked farms and their lots, and createOrder refuses an
// order for anyone else. So a farm on review is told plainly that buyers cannot see it yet.
export async function renderStatusNote(profile, uid = profile?.uid) {
  const el = document.getElementById("status-note");
  if (!el || !profile) return;
  if (profile.status === "verified" || profile.status === "active") {
    el.innerHTML = "";
    return;
  }
  if (profile.status === "rejected") {
    // The reason is in the farm's private record (only the farm and staff can read it); farms
    // decided before that still carry it on the profile.
    let note = profile.reviewNote || "";
    try {
      const review = uid ? await getFarmPrivate(uid, "review") : null;
      if (review?.note) note = review.note;
    } catch (e) {
      console.error(e);
    }
    // A moderator's reason rarely ends in a full stop, and the next sentence must not run into it.
    const reason = note ? ` Причина: ${escapeHtml(note)}${/[.!?…]$/.test(note.trim()) ? "" : "."}` : "";
    el.innerHTML = `<div class="notice-box notice-icon notice-danger">${icon("triangle-alert", { size: 18 })}<span>
      Хозяйство не допущено к продажам.${reason} Лоты не показываются покупателям, новые заказы не принимаются.</span></div>`;
    return;
  }
  el.innerHTML = `<div class="notice-box notice-icon">${icon("clock", { size: 18 })}<span>
    Хозяйство на проверке у администратора. Скот, документы и лоты можно готовить уже сейчас —
    покупатели увидят лоты сразу после подтверждения.</span></div>`;
}
