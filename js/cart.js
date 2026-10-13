// «Корзина» in the header: what the buyer has picked and not yet ordered.
//
// The storage itself lives in data.js (the account's own record when signed in, this browser
// otherwise). This file is the button, its live count, and the one place that builds a cart entry
// from a configurator choice - so the cart page, the checkout and the button never disagree about
// what an entry contains.
import { icon } from "./icons.js";
import { authReady, isRealUser, db } from "./firebase-init.js";
import {
  getCartItems, adoptLocalCart, getLot, getPartner, getAnimalsByIds,
  primaryAnimalType, isSellingPartner,
} from "./data.js";
import { formatsOf, quote } from "./carcass.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

// The listener of the mount that owns the button on screen; a second mount replaces it.
let stopListening = null;

/**
 * What one line of the cart holds: the carcass, the choice made about it, and a preview of the
 * price. The amounts are recomputed by createOrder when the order is placed - here they only let
 * the buyer see what they picked.
 */
export function cartEntry({ lot, partner, choice, quote }) {
  return {
    lotId: lot.id,
    lotTitle: lot.name || "",
    imageUrl: lot.imageUrl || null,
    partnerId: lot.partnerId,
    partnerName: partner?.displayName || "",
    format: choice.format,
    cuttingId: choice.cuttingId || null,
    cuttingName: quote?.cut?.name || null,
    deliveryId: choice.deliveryId || null,
    deliveryCity: quote?.del?.city || null,
    deliveryMode: choice.deliveryId === "pickup" ? "pickup" : choice.deliveryId ? "city" : "agree",
    weightKg: quote?.weight ?? null,
    amount: quote?.total ?? 0,
  };
}

/**
 * The cart read back against the world as it is now: every entry with its lot, its farm, a fresh
 * price - and what is wrong with it, if anything. A half someone else booked meanwhile, a farm
 * that went off sale or a changed cutting shows here and on the checkout, in the same words,
 * because both read it through this one function.
 */
export async function loadCartLines(uid) {
  // Someone who filled a cart before signing in has just signed in: bring it across before
  // reading, or the page they came here for would look empty. A no-op when there is nothing.
  if (uid) await adoptLocalCart(uid).catch((e) => console.error(e));
  const items = await getCartItems(uid);
  if (!items.length) return [];

  const lots = await Promise.all(items.map((i) => getLot(i.lotId).catch(() => null)));
  const partners = new Map();
  await Promise.all([...new Set(items.map((i) => i.partnerId))].map(async (id) => {
    partners.set(id, await getPartner(id).catch(() => null));
  }));
  const animals = await getAnimalsByIds(lots.flatMap((l) => l?.animalIds || []));
  const animalsById = new Map(animals.map((a) => [a.id, a]));

  return items.map((item, i) => {
    const lot = lots[i];
    const partner = partners.get(item.partnerId);
    let problem = null;
    let q = null;
    if (!lot) problem = "Туша снята с продажи";
    else if (!isSellingPartner(partner)) problem = "Хозяйство сейчас не продаёт";
    else if (!formatsOf(lot)[item.format]?.available) problem = "Эту часть туши уже забронировали";
    else {
      try {
        q = quote(lot, partner.storefront || {}, item);
      } catch (e) {
        problem = "Условия хозяйства изменились — выберите заново";
      }
    }
    return { item, lot, partner, problem, quote: q, type: lot ? primaryAnimalType(lot, animalsById) : "cattle" };
  });
}

export function mountCartButton() {
  const slot = document.getElementById("cart-slot");
  if (!slot) return;

  const paint = (n) => {
    const badge = n ? `<span class="notif-dot">${n > 9 ? "9+" : n}</span>` : "";
    slot.innerHTML = `
      <a class="icon-btn notif-btn" href="/cart" aria-label="Корзина${n ? `, товаров: ${n}` : ", пусто"}" title="Корзина">
        ${icon("shopping-cart", { size: 18 })}${badge}
      </a>`;
  };
  paint(0);

  authReady.then(async (user) => {
    const uid = isRealUser(user) ? user.uid : null;
    if (stopListening) stopListening();

    if (!uid) {
      // No account yet: the cart is this browser's, and the page tells us when it changes.
      const refresh = async () => paint((await getCartItems(null)).length);
      refresh();
      const onChange = () => refresh();
      window.addEventListener("et-cart-changed", onChange);
      window.addEventListener("storage", onChange);
      stopListening = () => {
        window.removeEventListener("et-cart-changed", onChange);
        window.removeEventListener("storage", onChange);
      };
      return;
    }

    // Signing in brings whatever this browser collected along with it.
    try {
      await adoptLocalCart(uid);
    } catch (e) {
      console.error(e);
    }
    stopListening = onSnapshot(collection(db, "clients", uid, "cart"),
      (snap) => paint(snap.size),
      (e) => console.error(e));
  });
}
