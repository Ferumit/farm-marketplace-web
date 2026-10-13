// The hub-point picker on a farm's profile.
//
// The farm taps where the hub is (or asks the phone's GPS), and can drag the pin to adjust. Saving
// is the profile's own "Сохранить": the picker only holds the choice and says whether it changed.
// After a save it draws what buyers will see - a dashed circle around the ~5 km public point -
// so the farm knows exactly how much of its location is being shared.
import { icon } from "./icons.js";
import { regionByCode } from "./regions.js";
import { loadLeaflet, createMap, markerIcon, KZ_BOUNDS } from "./map.js";

const [[MIN_LAT, MIN_LNG], [MAX_LAT, MAX_LNG]] = KZ_BOUNDS;
const inKazakhstan = (p) => p.lat >= MIN_LAT && p.lat <= MAX_LAT && p.lng >= MIN_LNG && p.lng <= MAX_LNG;
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const same = (a, b) => (!a && !b) || (!!a && !!b && a.lat === b.lat && a.lng === b.lng);

export function pickerHtml() {
  return `
    <div class="loc-map" id="loc-map" role="application" aria-label="Карта: точка хаба"><div class="skeleton" style="height:100%;"></div></div>
    <div class="loc-actions">
      <button type="button" class="btn-pill btn-secondary btn-sm" id="loc-gps">${icon("map-pin", { size: 16 })} Моё местоположение</button>
      <button type="button" class="btn-pill btn-ghost btn-sm" id="loc-clear" hidden>Убрать точку</button>
    </div>
    <p class="field-hint" id="loc-status" aria-live="polite"></p>`;
}

/**
 * Mounts the picker into the markup from pickerHtml(). `exact` is the farm's saved point (from its
 * private record) or null; `publicPoint` is what buyers currently see; `regionCode` centres an
 * empty map on the farm's region.
 */
export async function mountLocationPicker({ exact = null, publicPoint = null, regionCode = "" }) {
  const mapEl = document.getElementById("loc-map");
  const gpsBtn = document.getElementById("loc-gps");
  const clearBtn = document.getElementById("loc-clear");
  const statusEl = document.getElementById("loc-status");
  const say = (text) => { statusEl.textContent = text; };

  const L = await loadLeaflet();
  mapEl.replaceChildren();
  const map = createMap(mapEl, { maxZoom: 18 });

  let saved = exact ? { lat: exact.lat, lng: exact.lng } : null;
  let point = saved;
  let marker = null;
  let publicCircle = null;

  function drawPublic(p) {
    if (publicCircle) { publicCircle.remove(); publicCircle = null; }
    if (!p) return;
    publicCircle = L.circle([p.lat, p.lng], {
      radius: 3500, color: "#17805B", weight: 2, dashArray: "6 6", fillOpacity: 0.06, interactive: false,
    }).addTo(map);
  }

  function place(p, { pan = false } = {}) {
    point = p ? { lat: round6(p.lat), lng: round6(p.lng) } : null;
    if (!point) {
      if (marker) { marker.remove(); marker = null; }
    } else if (marker) {
      marker.setLatLng([point.lat, point.lng]);
    } else {
      marker = L.marker([point.lat, point.lng], { icon: markerIcon("exact"), draggable: true, title: "Точка хаба", keyboard: false })
        .addTo(map)
        .on("dragend", () => {
          const ll = marker.getLatLng();
          if (!inKazakhstan({ lat: ll.lat, lng: ll.lng })) { place(point); say("Точка должна быть на территории Казахстана."); return; }
          place({ lat: ll.lat, lng: ll.lng });
        });
    }
    if (point && pan) map.setView([point.lat, point.lng], Math.max(map.getZoom(), 14));
    clearBtn.hidden = !point;
    if (!same(point, saved)) say(point ? "Точка выбрана — нажмите «Сохранить», чтобы применить." : "Точка будет убрана после сохранения.");
    else say(saved ? "Покупатели видят хаб в пунктирном круге — с точностью около 5 км." : "");
  }

  map.on("click", (e) => {
    const p = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (!inKazakhstan(p)) { say("Точка должна быть на территории Казахстана."); return; }
    place(p);
  });

  gpsBtn.addEventListener("click", () => {
    if (!("geolocation" in navigator)) { say("Этот браузер не умеет определять местоположение — отметьте точку на карте."); return; }
    gpsBtn.disabled = true;
    say("Определяем местоположение…");
    navigator.geolocation.getCurrentPosition((pos) => {
      gpsBtn.disabled = false;
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      if (!inKazakhstan(p)) { say("Вы сейчас не в Казахстане — отметьте точку хаба на карте вручную."); return; }
      place(p, { pan: true });
    }, (err) => {
      gpsBtn.disabled = false;
      say(err.code === err.PERMISSION_DENIED
        ? "Доступ к геопозиции запрещён в браузере — отметьте точку на карте вручную."
        : "Не удалось определить местоположение — отметьте точку на карте вручную.");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });

  clearBtn.addEventListener("click", () => place(null));

  // First view: the saved point up close, else the farm's region, else the whole country. Not
  // animated: a first view has nothing to animate from, and an animated zoom is finished by
  // animation frames, which a background tab does not get.
  const region = regionByCode(regionCode);
  if (saved) map.setView([saved.lat, saved.lng], 13, { animate: false });
  else if (region) map.setView(region.center, 7, { animate: false });
  place(saved);
  drawPublic(publicPoint);

  return {
    get point() { return point; },
    get dirty() { return !same(point, saved); },
    /** A new region was chosen: recentre on it, unless a point is already set. */
    recenter(code) {
      const r = regionByCode(code);
      if (r && !point) map.setView(r.center, 7);
    },
    /** After a successful save: the chosen point is now the saved one; show what buyers see. */
    markSaved(publicAfterSave) {
      saved = point;
      drawPublic(publicAfterSave);
      place(point);
    },
  };
}
