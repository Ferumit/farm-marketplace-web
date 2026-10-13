// A lot is one carcass, sold in halves or whole. This is the same arithmetic createOrder does on the
// server (functions/index.js priceOrder), so the price a buyer sees before ordering is the price
// the order will carry. The server recomputes everything regardless - this is only the preview.
//
// Formats are counted in shares: totalShares 2 is two halves (a half = 1 share, whole = 2),
// totalShares 1 is whole only. Older lots split into 4, 6, 8 or 12 shares sell as halves and whole
// too, as long as the count divides in two.

import { pluralRu } from "./data.js";

export const FORMAT_LABEL = { half: "Половина туши", whole: "Целая туша" };
export const FORMAT_KZ = { half: "жарты", whole: "тұтас" };
export const SLOT_LABEL = {
  any: "Любое время",
  morning: "Утро, 9:00–12:00",
  day: "День, 12:00–16:00",
  evening: "Вечер, 16:00–20:00",
};

export function sharesFor(lot, format) {
  const total = Number(lot.totalShares) || 0;
  if (format === "whole") return total;
  if (format === "half") return total >= 2 && total % 2 === 0 ? total / 2 : 0;
  return 0;
}

function meatOf(lot, shares) {
  const total = Number(lot.totalShares) || 0;
  if (!shares || !total) return { weight: null, meat: 0 };
  const fraction = shares / total;
  const perKg = Math.round(Number(lot.pricePerKg) || 0);
  const weight = Number(lot.totalWeight) || 0;
  const w = weight > 0 ? Math.round(weight * fraction * 10) / 10 : null;
  if (perKg > 0 && weight > 0) return { weight: w, meat: Math.round(perKg * weight * fraction) };
  return { weight: w, meat: Math.round(Number(lot.pricePerShare) || 0) * shares };
}

/**
 * Both formats of a carcass: whether it can be sold that way at all (`sellable`), whether it is
 * still free (`available`), and roughly what it weighs and what the meat costs.
 */
export function formatsOf(lot) {
  const total = Number(lot.totalShares) || 0;
  const booked = Number(lot.bookedShares) || 0;
  const open = lot.status === "open";
  const out = {};
  for (const format of ["half", "whole"]) {
    const shares = sharesFor(lot, format);
    const available = open && shares > 0 && (format === "whole" ? booked === 0 : total - booked >= shares);
    out[format] = { format, shares, sellable: shares > 0, available, ...meatOf(lot, shares) };
  }
  return out;
}

/** The cheapest way in that is still free: a half if there is one. */
export function bestOffer(lot) {
  const f = formatsOf(lot);
  return f.half.available ? f.half : f.whole.available ? f.whole : null;
}

/** Everything the farm offers for delivery: pickup first, then its cities. Empty = by agreement. */
export function deliveryOptions(storefront) {
  const out = [];
  if (storefront?.pickup) out.push({ id: "pickup", label: "Самовывоз из хаба", price: 0 });
  (storefront?.delivery || []).forEach((d) => out.push({ id: d.id, label: d.city, price: Math.round(Number(d.price) || 0) }));
  return out;
}

/** The amounts for one choice - the preview of what createOrder will charge. */
export function quote(lot, storefront, { format, cuttingId, deliveryId }) {
  const f = formatsOf(lot)[format] || { weight: null, meat: 0 };
  const halves = format === "whole" ? 2 : 1;
  const cut = cuttingId ? (storefront?.cutting || []).find((c) => c.id === cuttingId) || null : null;
  const del = deliveryId && deliveryId !== "pickup" ? (storefront?.delivery || []).find((d) => d.id === deliveryId) || null : null;
  const cutting = cut ? Math.round(Number(cut.price) || 0) * halves : 0;
  const delivery = del ? Math.round(Number(del.price) || 0) : 0;
  return { weight: f.weight, meat: f.meat, cutting, delivery, total: f.meat + cutting + delivery, cut, del };
}

export function weightLabel(w) {
  return w ? `~${String(w).replace(".", ",")} кг` : "";
}

/** What an order is for: "Половина туши · ~60 кг", or the share count of an older order. */
export function orderSummary(order) {
  if (order.format && FORMAT_LABEL[order.format]) {
    return FORMAT_LABEL[order.format] + (order.estimatedWeightKg ? " · " + weightLabel(order.estimatedWeightKg) : "");
  }
  const n = Number(order.shares) || 0;
  return `${n} ${pluralRu(n, "доля", "доли", "долей")}`;
}

/** The rest of what was chosen, as short phrases: cutting, delivery, the date and time wanted. */
export function orderDetails(order) {
  const out = [];
  if (order.cutting?.name) out.push(`разделка «${order.cutting.name}»`);
  if (order.delivery?.mode === "pickup") out.push("самовывоз");
  else if (order.delivery?.mode === "city" && order.delivery.city) out.push(`доставка: ${order.delivery.city}`);
  if (order.deliveryDate) {
    const [y, m, d] = String(order.deliveryDate).split("-");
    out.push(`к ${d}.${m}.${y}${order.deliverySlot && order.deliverySlot !== "any" ? ", " + SLOT_LABEL[order.deliverySlot].split(",")[0].toLowerCase() : ""}`);
  }
  return out;
}

/** "Свободны обе половины" - what is left of a carcass, in words. */
export function availabilityLabel(lot) {
  const total = Number(lot.totalShares) || 0;
  const free = Math.max(0, total - (Number(lot.bookedShares) || 0));
  if (lot.status === "draft") return "Не опубликована";
  if (lot.status !== "open" && lot.status !== "fully_booked") return "Снята с продажи";
  if (lot.status === "fully_booked" || free === 0) return "Туша забронирована";
  if (total === 1) return "Продаётся целиком";
  if (total === 2) return free === 2 ? "Свободны обе половины" : "Свободна одна половина";
  return free === total ? "Свободна вся туша" : free >= total / 2 ? "Свободна половина" : "Свободно меньше половины";
}
