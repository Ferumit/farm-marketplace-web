// Maps on the site: Leaflet (vendored in /vendor/leaflet, BSD-2) over OpenStreetMap tiles.
//
// Leaflet is loaded only when a map is about to be seen - ~150 KB that most visitors of most
// pages never need. Everything here draws in the site's own look: markers are HTML, not the
// default image pins, and dark mode is handled by CSS on the tile layer (components.css).
//
// OSM's tile servers are volunteer-run; their policy asks for attribution (kept), a Referer
// (the site sends its origin) and modest traffic. When traffic grows, a commercial tile provider
// is a one-line change to TILE_URL.

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

// Kazakhstan with a margin; the map is not allowed to wander off to other continents.
export const KZ_BOUNDS = [[40.3, 46.2], [55.7, 87.6]];

let leaflet = null;

/** Loads Leaflet once per page. A failed load is not cached, so a retry can succeed. */
export function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leaflet) {
    leaflet = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/vendor/leaflet/leaflet.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "/vendor/leaflet/leaflet.js";
      js.onload = () => resolve(window.L);
      js.onerror = () => { leaflet = null; reject(new Error("Leaflet did not load")); };
      document.head.appendChild(js);
    });
  }
  return leaflet;
}

/** Runs `start` once, when `el` is about to scroll into view (or at once without an observer). */
export function whenNearViewport(el, start) {
  if (!("IntersectionObserver" in window)) { start(); return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
  }, { rootMargin: "300px 0px" });
  io.observe(el);
}

/**
 * A map that does not fight the page it sits in:
 *  - the mouse wheel scrolls the PAGE until the map is clicked, then zooms the map until the
 *    pointer leaves it;
 *  - on a touch screen one finger scrolls the page and two fingers move and zoom the map, with a
 *    hint when someone tries one finger - otherwise a full-width map traps the thumb.
 */
export function createMap(el, { maxZoom = 18, bounds = KZ_BOUNDS } = {}) {
  const L = window.L;
  const touch = L.Browser.mobile;
  const map = L.map(el, {
    scrollWheelZoom: false,
    dragging: !touch,
    tapHold: false,
    minZoom: 4,
    maxZoom,
    maxBounds: L.latLngBounds(bounds).pad(0.3),
    maxBoundsViscosity: 0.8,
    zoomSnap: 0.5,
  });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.tileLayer(TILE_URL, {
    maxZoom: 19,
    attribution: ATTRIBUTION,
    // The staff panel sends no Referer at all, and OSM refuses tile requests without one.
    referrerPolicy: "strict-origin-when-cross-origin",
    className: "map-tiles",
  }).addTo(map);
  map.fitBounds(bounds, { animate: false });

  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());

  if (touch) {
    const hint = document.createElement("div");
    hint.className = "map-hint";
    hint.textContent = "Двумя пальцами — двигать карту";
    el.appendChild(hint);
    let timer = 0;
    el.addEventListener("touchmove", (e) => {
      if (e.touches.length !== 1) return;
      hint.classList.add("show");
      clearTimeout(timer);
      timer = setTimeout(() => hint.classList.remove("show"), 1400);
    }, { passive: true });
  }
  return map;
}

/**
 * A marker in the site's look. kind: "exact" (the farm's own point), "public" (a ~5 km point),
 * "region" (only the region is known: shown at its centre, drawn as a ring), "group" (several
 * farms on one spot, with a count).
 */
export function markerIcon(kind, count = 0) {
  const L = window.L;
  if (kind === "group") {
    return L.divIcon({ className: "map-marker map-marker--group", html: `<span>${Number(count)}</span>`, iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] });
  }
  const size = kind === "region" ? 24 : 18;
  return L.divIcon({ className: `map-marker map-marker--${kind}`, html: "<span></span>", iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
}

/** A DOM node from a tag and text - popups are built from text nodes only, never from HTML strings. */
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
