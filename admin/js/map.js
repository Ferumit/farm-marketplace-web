// A small map in a farm's review card: where the farm says its hub is.
//
// Same Leaflet build as the public site, vendored again under admin/vendor/leaflet because this
// origin cannot load the site's copy. Staff see the EXACT point (from the farm's private record)
// and, as a dashed circle, the ~5 km area buyers are shown - so a reviewer can check both the
// place itself and what the platform publishes about it.

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

let leaflet = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leaflet) {
    leaflet = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "vendor/leaflet/leaflet.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = "vendor/leaflet/leaflet.js";
      js.onload = () => resolve(window.L);
      js.onerror = () => { leaflet = null; reject(new Error("Leaflet did not load")); };
      document.head.appendChild(js);
    });
  }
  return leaflet;
}

/**
 * Draws into `el`. `exact` and `publicPoint` are {lat, lng} or null; `regionCenter` is [lat, lng]
 * for a farm that named only its region.
 */
export async function miniMap(el, { exact = null, publicPoint = null, regionCenter = null }) {
  const L = await loadLeaflet();
  const map = L.map(el, { scrollWheelZoom: false, dragging: !L.Browser.mobile, zoomSnap: 0.5 });
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  // The panel sends no Referer (no-referrer, set in nginx), and OSM refuses tile requests
  // without one - so the tiles alone send the panel's origin.
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, referrerPolicy: "strict-origin-when-cross-origin", className: "map-tiles" }).addTo(map);
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());

  const dot = (kind, size) => L.divIcon({ className: `map-marker map-marker--${kind}`, html: "<span></span>", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
  if (publicPoint) {
    L.circle([publicPoint.lat, publicPoint.lng], { radius: 3500, color: "#17805B", weight: 2, dashArray: "6 6", fillOpacity: 0.06, interactive: false }).addTo(map);
  }
  if (exact) {
    L.marker([exact.lat, exact.lng], { icon: dot("exact", 18), title: "Точная точка" }).addTo(map);
    map.setView([exact.lat, exact.lng], 11, { animate: false });
  } else if (regionCenter) {
    L.marker(regionCenter, { icon: dot("region", 22), title: "Центр региона" }).addTo(map);
    map.setView(regionCenter, 6, { animate: false });
  } else {
    map.fitBounds([[40.3, 46.2], [55.7, 87.6]], { animate: false });
  }
  return map;
}
