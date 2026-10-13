import { escapeHtml } from "./data.js";

/**
 * Plays a farm's slaughterhouse video over the page. Only on request: a catalogue autoplaying a
 * dozen videos would spend a buyer's mobile data before they chose anything.
 */
export function openVideo(url, title) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-box modal-box--video" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="row-top">
        <h3 style="margin:0;">${escapeHtml(title)}</h3>
        <button class="modal-close" aria-label="Закрыть">×</button>
      </div>
      <video src="${escapeHtml(url)}" controls autoplay playsinline></video>
    </div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector("video");
  const close = () => {
    video.pause();
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".modal-close").addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  overlay.querySelector(".modal-close").focus();
}
