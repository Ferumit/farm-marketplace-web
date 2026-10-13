import { icon } from "./icons.js";
import { escapeHtml } from "./data.js";

/**
 * A step's files as a gallery: photos open full size, videos play in place, documents are links.
 * `removable` adds a remove button on each (the farm's files before the step is sent).
 */
export function mediaHtml(files, { removable = false } = {}) {
  if (!files || !files.length) return "";
  return `<div class="media-grid">${files.map((f, i) => {
    const url = escapeHtml(f.url);
    const remove = removable
      ? `<button type="button" class="media-remove" data-remove-index="${i}" aria-label="Убрать файл">×</button>` : "";
    if (f.kind === "video") {
      return `<div class="media-item"><video src="${url}" controls playsinline preload="metadata"></video>${remove}</div>`;
    }
    if (f.kind === "doc") {
      return `<div class="media-item media-item--doc"><a href="${url}" target="_blank" rel="noopener">${icon("file-text", { size: 22 })}
        <span>${escapeHtml(f.name || f.label || "Документ")}</span></a>${remove}</div>`;
    }
    return `<div class="media-item"><a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${escapeHtml(f.name || "Фото")}" loading="lazy"></a>${remove}</div>`;
  }).join("")}</div>`;
}

/** Certificates and documents as a simple list of links with their review state. */
export function docLinksHtml(docs) {
  if (!docs || !docs.length) return "";
  const state = { approved: "подтверждён платформой", pending: "на проверке" };
  return `<ul class="doc-links">${docs.map((d) => `
    <li><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener">${icon("file-text", { size: 16 })} ${escapeHtml(d.label || d.name || "Документ")}</a>
      ${state[d.status] ? `<span class="doc-links__state">${state[d.status]}</span>` : ""}</li>`).join("")}</ul>`;
}
