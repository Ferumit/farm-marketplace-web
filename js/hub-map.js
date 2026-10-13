// The homepage map of checked hubs.
//
// A hub is placed by the best thing known about it, and the marker says which:
//   publicLocation - the ~5 km point the server derived from the farm's own pin (a filled dot);
//   region only    - the centre of the region the farm named, drawn as a ring, never as a dot,
//                    so it cannot pass for a real position.
// Hubs landing on the same spot share one marker with a count.
import { getPartners, pluralRu } from "./data.js";
import { regionByCode, partnerRegion, partnerPlaceLabel } from "./regions.js";
import { loadLeaflet, whenNearViewport, createMap, markerIcon, el } from "./map.js";

function placeOf(p) {
  const pl = p.publicLocation;
  if (pl && Number.isFinite(pl.lat) && Number.isFinite(pl.lng)) return { lat: pl.lat, lng: pl.lng, kind: "public" };
  const region = regionByCode(partnerRegion(p));
  if (region) return { lat: region.center[0], lng: region.center[1], kind: "region" };
  return null;
}

function popupFor(farms, kind) {
  const box = el("div", null, "map-popup");
  for (const p of farms) {
    const item = el("div", null, "map-popup__farm");
    const link = el("a", p.displayName || "Хозяйство");
    link.href = "/farmers/" + encodeURIComponent(p.id);
    item.append(link, el("div", partnerPlaceLabel(p) || "Регион не указан", "map-popup__where"));
    box.append(item);
  }
  box.append(el("p", kind === "region"
    ? "Точное место не указано — показан центр региона."
    : "Место показано с точностью около 5 км.", "map-popup__note"));
  return box;
}

export function mountHubMap(container, noteEl) {
  // Once per container: a second start would wipe the live map and then fail on Leaflet's own
  // "already initialized" guard, leaving an empty box.
  if (container.dataset.mapMounted) return;
  container.dataset.mapMounted = "1";
  whenNearViewport(container, async () => {
    let partners;
    try {
      [partners] = await Promise.all([getPartners(), loadLeaflet()]);
    } catch (e) {
      console.error(e);
      container.innerHTML = '<div class="empty-state">Не удалось загрузить карту хабов.</div>';
      return;
    }
    const L = window.L;

    const groups = new Map();
    let unplaced = 0;
    for (const p of partners) {
      const at = placeOf(p);
      if (!at) { unplaced++; continue; }
      const key = `${at.kind}:${at.lat.toFixed(4)},${at.lng.toFixed(4)}`;
      if (!groups.has(key)) groups.set(key, { at, farms: [] });
      groups.get(key).farms.push(p);
    }

    container.replaceChildren();
    // Street level means nothing for a point that is only good to 5 km, so the map stops before it.
    const map = createMap(container, { maxZoom: 11 });
    const points = [];
    for (const { at, farms } of groups.values()) {
      const icon = farms.length > 1 ? markerIcon("group", farms.length) : markerIcon(at.kind);
      L.marker([at.lat, at.lng], { icon, title: farms.map((f) => f.displayName || "Хозяйство").join(", ") })
        .bindPopup(popupFor(farms, at.kind), { maxWidth: 260 })
        .addTo(map);
      points.push([at.lat, at.lng]);
    }
    if (points.length) map.fitBounds(points, { padding: [48, 48], maxZoom: 6, animate: false });

    if (noteEl) {
      const parts = [];
      if (!partners.length) parts.push("Хабы появятся на карте после проверки платформой.");
      else parts.push("Точка — хаб с точностью около 5 км, кольцо — известен только регион.");
      if (unplaced) parts.push(`Ещё ${unplaced} ${pluralRu(unplaced, "хозяйство не указало", "хозяйства не указали", "хозяйств не указали")} регион.`);
      noteEl.textContent = parts.join(" ");
    }
  });
}
