import {
  collection, doc, getDoc, getDocs, query, where, orderBy,
  documentId, setDoc, updateDoc, deleteDoc, serverTimestamp, writeBatch, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { ref as storageRef, uploadBytes, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { db, storage, authReady } from "./firebase-init.js";

// Statuses the buyer-facing UI (mobile app Market screen) treats as "for sale".
const VISIBLE_LOT_STATUSES = ["open", "fully_booked"];
const VISIBLE_PARTNER_STATUSES = ["verified", "active"];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function withId(snap) {
  return { id: snap.id, ...snap.data() };
}

// Firestore text fields (displayName, lot name/description, breed, ...) are user-writable and
// firestore.rules doesn't validate their content, so anything rendered via innerHTML must be
// escaped here first - otherwise a malicious profile/lot name is a stored-XSS payload.
// Reads an identifier that may arrive either as a path segment (/lots/{id}, the clean URL) or
// as a query parameter (/lot.html?id=..., what the legacy 301s and any old link resolve to).
// A server-side rewrite does not populate location.search, so the path has to come first.
export function routeId(prefix, param) {
  const m = window.location.pathname.match(new RegExp("^/" + prefix + "/([^/]+)"));
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(window.location.search).get(param);
}

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Whether buyers may see and order from this farm. Only a farm the platform has checked sells:
 * the homepage promises "только проверенные хозяйства", and createOrder refuses the rest on the
 * server - this is the same rule, applied to what the site displays.
 */
export function isSellingPartner(partner) {
  return !!partner && VISIBLE_PARTNER_STATUSES.includes(partner.status);
}

// One read per page load: the storefront needs the farm list both to show farms and to decide
// which lots to show. A failed read is not cached, so a retry can succeed.
let sellingPartners = null;

export function getPartners() {
  if (!sellingPartners) {
    sellingPartners = (async () => {
      await authReady;
      const q = query(collection(db, "partners"), where("status", "in", VISIBLE_PARTNER_STATUSES));
      const snap = await getDocs(q);
      return snap.docs.map(withId);
    })();
    sellingPartners.catch(() => { sellingPartners = null; });
  }
  // A copy, so a caller sorting or filtering its list cannot reorder another caller's.
  return sellingPartners.then((list) => list.slice());
}

// A farm that is not checked is readable only by itself and staff (firestore.rules), so for
// everyone else the read is refused rather than empty. That is an answer, not a failure: the farm
// exists and does not sell - which is exactly what the pages already know how to say.
export async function getPartner(id) {
  await authReady;
  try {
    const snap = await getDoc(doc(db, "partners", id));
    return snap.exists() ? withId(snap) : null;
  } catch (e) {
    if (e?.code === "permission-denied") return { id, status: "unavailable" };
    throw e;
  }
}

// Lots of checked farms only. A farm still on review can already prepare and publish lots - they
// appear here the moment it is approved, with nothing to republish.
export async function getOpenLots() {
  await authReady;
  const q = query(collection(db, "lots"), where("status", "in", VISIBLE_LOT_STATUSES));
  const [snap, partners] = await Promise.all([getDocs(q), getPartners()]);
  const checked = new Set(partners.map((p) => p.id));
  return snap.docs.map(withId).filter((lot) => checked.has(lot.partnerId));
}

export async function getLotsByPartner(partnerId) {
  await authReady;
  const q = query(
    collection(db, "lots"),
    where("partnerId", "==", partnerId),
    where("status", "in", VISIBLE_LOT_STATUSES)
  );
  const snap = await getDocs(q);
  return snap.docs.map(withId);
}

export async function getLot(id) {
  await authReady;
  const snap = await getDoc(doc(db, "lots", id));
  return snap.exists() ? withId(snap) : null;
}

// Firestore `in` queries cap at 10 values — chunk for correctness beyond the demo dataset size.
export async function getAnimalsByIds(ids) {
  await authReady;
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return [];
  const groups = chunk(uniqueIds, 10);
  const results = await Promise.all(
    groups.map(async (group) => {
      const q = query(collection(db, "animals"), where(documentId(), "in", group));
      const snap = await getDocs(q);
      return snap.docs.map(withId);
    })
  );
  return results.flat();
}

export async function getDeliverySteps(lotId) {
  await authReady;
  const q = query(collection(db, "lots", lotId, "deliveries"), orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map(withId);
}

export async function getMyPurchases(uid) {
  await authReady;
  const snap = await getDocs(collection(db, "clients", uid, "purchases"));
  return snap.docs.map(withId);
}

// Purchase doc id === lotId (see ET_side_client firestore_service.dart buyShare()).
export async function getMyPurchaseForLot(uid, lotId) {
  await authReady;
  const snap = await getDoc(doc(db, "clients", uid, "purchases", lotId));
  return snap.exists() ? withId(snap) : null;
}

// Placing an order goes through the Cloud Function, never straight to Firestore: it has to check
// the lot is open, move bookedShares, flip the lot to fully_booked and write the order as one
// atomic unit, and none of that can be trusted to a browser.
// The key is generated by the CALLER, once per order attempt, and reused across retries of that
// same attempt - see lot.js. That is the whole point: if the response is lost on the way back,
// retrying with the same key returns the order that was already created instead of booking the
// shares a second time. A key generated here, per call, would be useless.
export function newIdempotencyKey() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  // Older Safari has crypto.getRandomValues but not randomUUID.
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Places an order through createOrder. A carcass order is { lotId, format, cuttingId, deliveryId,
 * deliveryAddress, deliveryDate, deliverySlot, contactPhone }; the older { lotId, shares, ... } still
 * works. Only choices are sent - the server works out every amount itself.
 */
export async function placeOrder(order) {
  await authReady;
  const { functions } = await import("./firebase-init.js");
  const { httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js");
  const call = httpsCallable(functions, "createOrder");
  const res = await call({ ...order, idempotencyKey: order.idempotencyKey || newIdempotencyKey() });
  return res.data;
}

/**
 * Просит ссылку на оплату заказа. Возвращает { redirectUrl, paymentId } либо бросает.
 *
 * Сумму здесь не передаём и передать не можем: сервер берёт её из заказа. Карту вводят на
 * странице Freedom Pay — у нас она не появляется ни на мгновение.
 *
 * Пока онлайн-оплата не включена, сервер отвечает failed-precondition — это не поломка, а
 * состояние, и звать эту функцию можно безопасно: см. payButtonHtml в order-track.js.
 */
export async function startPayment(orderId) {
  await authReady;
  const { functions } = await import("./firebase-init.js");
  const { httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js");
  const call = httpsCallable(functions, "startPayment");
  const res = await call({ orderId });
  return res.data;
}

// ---- a farm's private records: partners/{uid}/private/{identity|location|review} ----------------
// Readable by the farm itself and by staff only (firestore.rules) - which is why these are not
// fields on the public profile.

/** One of the farm's private documents, or null when it does not exist yet. */
export async function getFarmPrivate(uid, docId) {
  await authReady;
  const snap = await getDoc(doc(db, "partners", uid, "private", docId));
  return snap.exists() ? snap.data() : null;
}

// ---- the farm's storefront (cabinet → Витрина) -----------------------------------------------------

/**
 * Saves the storefront onto the farm's public profile in one write: description, video, paid
 * cutting options and delivery tariffs. Buyers read it there; firestore.rules caps its size.
 */
export async function saveStorefront(uid, storefront) {
  await authReady;
  await updateDoc(doc(db, "partners", uid), { storefront, storefrontUpdatedAt: serverTimestamp() });
}

/** Legal form, registered name and address - private, and part of what review checks. */
export async function saveFarmLegal(uid, { form, legalName, address }) {
  await authReady;
  await setDoc(doc(db, "partners", uid, "private", "legal"), { form, legalName, address, updatedAt: serverTimestamp() });
}

/** Счёт, на который платформа перечислит долю хозяйства. Меняется в любой момент. */
export async function saveFarmBank(uid, { iban, bic, bankName, kbe }) {
  await authReady;
  await setDoc(doc(db, "partners", uid, "private", "bank"),
    { iban, bic, bankName, kbe, updatedAt: serverTimestamp() });
}

/**
 * Доступ к онлайн-кассе хозяйства — им сервер выбивает фискальные чеки от его имени.
 *
 * Две записи, и это не прихоть. Пароль и ПИН ложатся в `kassa`, которую по правилам не читает
 * никто из клиентов: это действующие ключи, которыми выбиваются налоговые документы под чужим
 * БИН. Заводской номер и дата — в `kassaInfo`, её читать можно, и по ней кабинет понимает, что
 * касса подключена, не трогая секретов.
 */
export async function saveFarmKassa(uid, { znm, password, pin }) {
  await authReady;
  const base = ["partners", uid, "private"];
  await setDoc(doc(db, ...base, "kassa"), { znm, password, pin, updatedAt: serverTimestamp() });
  await setDoc(doc(db, ...base, "kassaInfo"), { znm, connectedAt: serverTimestamp() });
}

export const FARM_DOC_KINDS = [
  { id: "ses", label: "Санитарно-эпидемиологическое заключение (СЭС)" },
  { id: "vet_control", label: "Ветеринарный контроль (ветеринарно-санитарное заключение)" },
  { id: "other", label: "Другой документ хозяйства" },
];

export async function getFarmDocuments(uid) {
  await authReady;
  const snap = await getDocs(collection(db, "partners", uid, "documents"));
  return snap.docs.map(withId).sort((a, b) => (b.uploadedAt?.seconds || 0) - (a.uploadedAt?.seconds || 0));
}

/** Files one of the farm's own certificates for review - the same path as the paperwork on animals. */
export async function addFarmDocument(uid, { kind, file }) {
  await authReady;
  const problem = describeDocFile(file);
  if (problem) throw new Error(problem);
  const docRef = doc(collection(db, "partners", uid, "documents"));
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
  const storagePath = `documents/${uid}/farm/${docRef.id}.${ext}`;
  const fileUrl = await uploadFile(storagePath, file);
  await setDoc(docRef, {
    kind,
    label: (FARM_DOC_KINDS.find((k) => k.id === kind) || FARM_DOC_KINDS[2]).label,
    fileUrl,
    storagePath,
    fileName: file.name,
    contentType: file.type || guessMimeFromName(file.name),
    size: file.size,
    status: "pending",
    partnerId: uid,
    uploadedAt: serverTimestamp(),
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
  });
  return docRef.id;
}

/** Withdraws a certificate nobody has reviewed yet - file first, record second, as for animals. */
export async function deleteFarmDocument(uid, docId) {
  await authReady;
  const docRef = doc(db, "partners", uid, "documents", docId);
  const snap = await getDoc(docRef);
  if (snap.exists()) {
    const target = snap.data().storagePath || snap.data().fileUrl;
    if (target) {
      try {
        await deleteObject(storageRef(storage, target));
      } catch (e) {
        if (e?.code !== "storage/object-not-found") throw e;
      }
    }
  }
  await deleteDoc(docRef);
}

/**
 * Uploads a large file (the slaughterhouse video) with progress. `onProgress` gets 0..1; the
 * upload resumes by itself over a flaky connection, which matters from a village.
 */
export function uploadWithProgress(path, file, onProgress, contentType) {
  return new Promise((resolve, reject) => {
    authReady.then(() => {
      // Some Android browsers hand over an empty type for a file picked from Downloads; the rules
      // decide by type, so the caller can say what the file is.
      const task = uploadBytesResumable(storageRef(storage, path), file, { contentType: contentType || file.type || undefined });
      task.on("state_changed",
        (s) => onProgress?.(s.totalBytes ? s.bytesTransferred / s.totalBytes : 0),
        reject,
        () => getDownloadURL(task.snapshot.ref).then(resolve, reject));
    }, reject);
  });
}

/** Removes a file the farm replaced (an old video or cover); a file already gone is fine. */
export async function deleteStoredFile(urlOrPath) {
  if (!urlOrPath) return;
  await authReady;
  try {
    await deleteObject(storageRef(storage, urlOrPath));
  } catch (e) {
    if (e?.code !== "storage/object-not-found") throw e;
  }
}

/** The farm's email for notifications, kept off the public profile. "" clears it. */
export async function saveFarmContact(uid, email) {
  await authReady;
  await setDoc(doc(db, "partners", uid, "private", "contact"), { email: email || null, updatedAt: serverTimestamp() });
}

/**
 * Places (or, with null, removes) the caller's own hub point. The server keeps the exact point
 * private and publishes a point rounded to ~5 km; that public point is what comes back.
 */
export async function saveHubLocation(point) {
  await authReady;
  const { functions } = await import("./firebase-init.js");
  const { httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js");
  const res = await httpsCallable(functions, "setHubLocation")(
    point ? { lat: point.lat, lng: point.lng } : { clear: true });
  return res.data?.publicLocation || null;
}

// Status moves go through the server too: cancelling has to return the reserved shares to the
// lot and fix up the legacy purchase doc in the same transaction.
export async function changeOrderStatus(orderId, action) {
  return orderAction(orderId, action);
}

/**
 * One step of an order's lifecycle (functions/index.js updateOrderStatus): accept, identify,
 * meat_ready, ship, handover, complete, autocomplete, dispute, cancel. `payload` carries what the
 * step needs - its files, the weighing, the dispute's description.
 */
export async function orderAction(orderId, action, payload = {}) {
  await authReady;
  const { functions } = await import("./firebase-init.js");
  const { httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js");
  const res = await httpsCallable(functions, "updateOrderStatus")({ ...payload, orderId, action });
  return res.data;
}

/** One order, for either of its two parties (the rules let only them - and staff - read it). */
export async function getOrder(orderId) {
  await authReady;
  const snap = await getDoc(doc(db, "orders", orderId));
  return snap.exists() ? withId(snap) : null;
}

// What an order's step may carry - the same limits storage.rules puts on orders/{farm}/{order}/.
const ORDER_FILE_LIMITS = { video: 150, photo: 15, doc: 20 };

/** "photo" | "video" | "doc" for a file a step may take, or null. */
export function orderFileKind(file) {
  const type = file?.type || guessMimeFromName(file?.name || "");
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("image/")) return "photo";
  if (type === "application/pdf") return "doc";
  return null;
}

/**
 * Uploads a file for one of the order's steps into the farm's own folder, with progress. Returns
 * { url, kind, name, path } - what updateOrderStatus accepts on the step.
 */
export async function uploadOrderFile(partnerId, orderId, file, onProgress) {
  const kind = orderFileKind(file);
  if (!kind) throw new Error("Подойдёт фото, видео или PDF.");
  const limit = ORDER_FILE_LIMITS[kind];
  if (file.size > limit * 1024 * 1024) throw new Error(`Файл больше ${limit} МБ.`);
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  const path = `orders/${partnerId}/${orderId}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const type = file.type || (kind === "doc" ? "application/pdf" : kind === "video" ? "video/mp4" : "image/jpeg");
  const url = await uploadWithProgress(path, file, onProgress, type);
  return { url, kind, name: file.name.slice(0, 120), path };
}

/** The buyer's evidence for a dispute - photo or video, into their own dispute folder. */
export async function uploadDisputeFile(uid, orderId, file) {
  const kind = orderFileKind(file);
  if (kind !== "photo" && kind !== "video") throw new Error("Подойдёт фото или видео.");
  if (file.size > 50 * 1024 * 1024) throw new Error("Файл больше 50 МБ.");
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "bin";
  const type = file.type || (kind === "video" ? "video/mp4" : "image/jpeg");
  return uploadWithProgress(`disputes/${uid}/${orderId}_${Date.now()}.${ext}`, file, null, type);
}

export async function getMyOrdersAsBuyer(uid) {
  await authReady;
  const q = query(collection(db, "orders"), where("buyerUid", "==", uid), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(withId);
}

export async function getOrdersForPartner(partnerId) {
  await authReady;
  const q = query(collection(db, "orders"), where("partnerId", "==", partnerId), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(withId);
}

// ---- «Корзина»: picked, not yet ordered -------------------------------------------------------
//
// A signed-in buyer keeps their cart in their own record (clients/{uid}/cart), so it follows them
// to another device and survives a cleared browser. Someone who has not signed in yet keeps it in
// this browser and it moves across on the way in - ordering needs an account anyway, and losing a
// basket at the door is the surest way to lose the order with it.
//
// Every amount stored here is a PREVIEW. createOrder recomputes the price from the lot and the
// farm's storefront when the order is actually placed, so a stale or edited cart cannot set a price.

const CART_KEY = "et-cart";
const MAX_CART_ITEMS = 20;

/** One entry per carcass and format: picking the same half twice updates it instead of doubling. */
export const cartItemId = (item) => `${item.lotId}__${item.format}`;

function readLocalCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return []; // private mode, or something else wrote nonsense there
  }
}

function writeLocalCart(items) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(items.slice(0, MAX_CART_ITEMS)));
  } catch (e) {
    console.error(e);
  }
  // The header badge listens for this; a cart that changes silently reads as a broken button.
  window.dispatchEvent(new CustomEvent("et-cart-changed"));
}

export async function getCartItems(uid) {
  if (!uid) return readLocalCart();
  await authReady;
  const snap = await getDocs(collection(db, "clients", uid, "cart"));
  return snap.docs.map(withId).sort((a, b) => (b.addedAt?.seconds || 0) - (a.addedAt?.seconds || 0));
}

export async function addCartItem(uid, item) {
  const id = cartItemId(item);
  if (!uid) {
    const items = readLocalCart().filter((x) => x.id !== id);
    writeLocalCart([{ ...item, id, addedAt: { seconds: Math.floor(Date.now() / 1000) } }, ...items]);
    return id;
  }
  await authReady;
  await setDoc(doc(db, "clients", uid, "cart", id), { ...item, addedAt: serverTimestamp() });
  return id;
}

export async function removeCartItem(uid, itemId) {
  if (!uid) {
    writeLocalCart(readLocalCart().filter((x) => x.id !== itemId));
    return;
  }
  await authReady;
  await deleteDoc(doc(db, "clients", uid, "cart", itemId));
}

/** Empties the cart, or just the entries that turned into orders. */
export async function clearCartItems(uid, ids = null) {
  if (!uid) {
    writeLocalCart(ids ? readLocalCart().filter((x) => !ids.includes(x.id)) : []);
    return;
  }
  await authReady;
  const list = ids || (await getCartItems(uid)).map((i) => i.id);
  const batch = writeBatch(db);
  list.forEach((id) => batch.delete(doc(db, "clients", uid, "cart", id)));
  await batch.commit();
}

/** Moves what this browser collected before signing in into the account, then empties it. */
export async function adoptLocalCart(uid) {
  const local = readLocalCart();
  if (!uid || !local.length) return;
  await authReady;
  const batch = writeBatch(db);
  local.forEach((item) => {
    const { id, addedAt, ...rest } = item;
    batch.set(doc(db, "clients", uid, "cart", id || cartItemId(item)), { ...rest, addedAt: serverTimestamp() });
  });
  await batch.commit();
  writeLocalCart([]);
}

// ---- reviews ------------------------------------------------------------------------------
// A review belongs to a completed ORDER (reviews/{orderId}) and is published only after
// moderation; the farm's rating is recomputed on the server from the published ones.

/** One call for anything the functions expose - the import is dynamic so pages that never call
 *  a function don't pay for the SDK. */
async function callFunction(name, payload) {
  await authReady;
  const { functions } = await import("./firebase-init.js");
  const { httpsCallable } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js");
  const res = await httpsCallable(functions, name)(payload);
  return res.data;
}

export async function submitReview({ orderId, rating, text }) {
  return callFunction("submitReview", { orderId, rating, text });
}

/** This buyer's review of one order, whatever its moderation status - or null. */
export async function getOrderReview(orderId) {
  await authReady;
  try {
    const snap = await getDoc(doc(db, "reviews", orderId));
    return snap.exists() ? withId(snap) : null;
  } catch (e) {
    // Someone else's review of someone else's order: not ours to see, and not an error here.
    if (e?.code === "permission-denied") return null;
    throw e;
  }
}

/** A farm's published reviews, newest first. */
export async function getPartnerReviews(partnerId) {
  await authReady;
  const q = query(
    collection(db, "reviews"),
    where("partnerId", "==", partnerId),
    where("status", "==", "published"),
    orderBy("createdAt", "desc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map(withId);
}

// ---- joint purchase (совместная покупка) -----------------------------------------------------
// 2-5 people split one carcass or half. The farm sees nothing until the last place is filled: the
// join that fills it places the order for everyone (functions/index.js).

export async function createGroupBuy(payload) {
  return callFunction("createGroupBuy", payload);
}

export async function joinGroupBuy(groupId) {
  return callFunction("joinGroupBuy", { groupId });
}

export async function leaveGroupBuy(groupId) {
  return callFunction("leaveGroupBuy", { groupId });
}

export async function getGroupBuy(groupId) {
  await authReady;
  const snap = await getDoc(doc(db, "groupBuys", groupId));
  return snap.exists() ? withId(snap) : null;
}

/** The delivery address and the organiser's phone - readable by the people in the group only. */
export async function getGroupContact(groupId) {
  await authReady;
  try {
    const snap = await getDoc(doc(db, "groupBuys", groupId, "private", "contact"));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    if (e?.code === "permission-denied") return null;
    throw e;
  }
}

/** Every joint purchase this person is in, newest first. */
export async function getMyGroupBuys(uid) {
  await authReady;
  const q = query(
    collection(db, "groupBuys"),
    where("memberUids", "array-contains", uid),
    orderBy("createdAt", "desc"),
  );
  const snap = await getDocs(q);
  return snap.docs.map(withId);
}

/** This buyer's disputes about one order, newest first. */
export async function getMyOrderDisputes(uid, orderId) {
  await authReady;
  const q = query(collection(db, "disputes"), where("uid", "==", uid), where("orderId", "==", orderId));
  const snap = await getDocs(q);
  return snap.docs.map(withId).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

/** This buyer's disputes about one lot, newest first. The rules let a buyer read only their own. */
export async function getMyDisputes(uid, lotId) {
  await authReady;
  const q = query(collection(db, "disputes"), where("uid", "==", uid), where("lotId", "==", lotId));
  const snap = await getDocs(q);
  return snap.docs.map(withId).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

export async function createDispute({ uid, lotId, description, mediaUrl }) {
  await authReady;
  const ref = doc(collection(db, "disputes"));
  await setDoc(ref, {
    uid,
    lotId,
    description,
    mediaUrl: mediaUrl || null,
    status: "new",
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

// Newer lots carry their own meatType (set once at creation in lot_constructor_screen.dart).
// Older lots don't have it, so fall back to joining through the first linked animal.
export function primaryAnimalType(lot, animalsById) {
  if (lot.meatType) return lot.meatType;
  const firstId = (lot.animalIds || [])[0];
  const animal = firstId ? animalsById.get(firstId) : null;
  return animal ? animal.type : null;
}

// Newer purchases store the actual amount paid (immune to the lot's price changing later);
// older purchase docs don't have it, so fall back to shares × the lot's current price.
export function purchaseAmount(purchase, lot) {
  if (typeof purchase.amountPaid === "number") return purchase.amountPaid;
  return purchase.shares * (lot?.pricePerShare || 0);
}

/* ─── Partner cabinet ─────────────────────────────────────────────────────────
   Everything below writes as the signed-in partner. firestore.rules already allows a partner
   to create/update their own lots, animals and delivery steps, so no rule changes are needed -
   but every write must carry partnerId === own uid or the rule rejects it. */

// Same 6 steps ET_partners seeds via DeliveryStep.defaultChain() (delivery_step.dart:100-161).
// Titles must match exactly: the buyer's tracker and the app render whatever is stored here.
export const DELIVERY_CHAIN = [
  { id: "step_1_selection", order: 1, title: "Отбор", subtitle: "Выбор животных", icon: "agriculture" },
  { id: "step_2_preparation", order: 2, title: "Подготовка", subtitle: "Предпродажная подготовка", icon: "task_alt" },
  { id: "step_3_processing", order: 3, title: "Обработка", subtitle: "Убойный цех", icon: "factory" },
  { id: "step_4_packaging", order: 4, title: "Упаковка", subtitle: "Фасовка и маркировка", icon: "scale" },
  { id: "step_5_dispatch", order: 5, title: "Отправка", subtitle: "Погрузка и транспорт", icon: "local_shipping" },
  { id: "step_6_delivery", order: 6, title: "Доставка", subtitle: "Передача клиенту", icon: "content_cut" },
];

// Unlike getLotsByPartner (buyer-facing, only open/fully_booked), the cabinet needs drafts too.
export async function getMyLots(partnerId) {
  await authReady;
  const q = query(collection(db, "lots"), where("partnerId", "==", partnerId));
  const snap = await getDocs(q);
  return snap.docs.map(withId).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

export async function getMyAnimals(partnerId) {
  await authReady;
  const q = query(collection(db, "animals"), where("partnerId", "==", partnerId));
  const snap = await getDocs(q);
  return snap.docs.map(withId).sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

export async function uploadImage(path, file) {
  await authReady;
  const fileRef = storageRef(storage, path);
  await uploadBytes(fileRef, file);
  return getDownloadURL(fileRef);
}

// ---------------------------------------------------------------------------------------------
// Veterinary documents
//
// They hang off the ANIMAL, not the lot: a certificate is issued for one head of livestock, while
// a lot is a bundle that the same animal can leave and re-enter. A lot shows the union of its
// animals' paperwork.
//
// They live in a SUBCOLLECTION rather than an array field on the animal, and that is the whole
// design. The farmer legitimately owns the animal document and must be able to edit breed and
// weight - so if the paperwork sat in an array on that same document, the farmer could set their
// own document to 'approved' and Firestore rules could not realistically stop them element by
// element. As a subcollection the rule is exact: the owner may create only with status 'pending',
// and only a reviewer may ever change that status. Same lesson as bookedShares - whoever the
// decision is about must not be able to write the field that carries it.
// ---------------------------------------------------------------------------------------------
export const DOC_KINDS = [
  { id: "vet_certificate", label: "Ветеринарная справка (форма №1)" },
  { id: "vet_passport", label: "Ветеринарный паспорт" },
  { id: "lab_report", label: "Заключение лаборатории" },
  { id: "other", label: "Другой документ" },
];

export const DOC_STATUS_LABEL = {
  pending: "На проверке",
  approved: "Подтверждён",
  rejected: "Отклонён",
};

export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const ALLOWED_DOC_MIME = [
  "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

/** Human-readable reason a file cannot be attached, or null when it is fine. */
export function describeDocFile(file) {
  if (!file) return "Выберите файл.";
  if (file.size > MAX_DOC_BYTES) {
    return `Файл больше 20 МБ (${Math.round(file.size / 1024 / 1024)} МБ). Сожмите или отсканируйте в меньшем качестве.`;
  }
  // Some Android browsers hand over an empty type for files picked from Downloads; fall back to
  // the extension rather than rejecting a perfectly good PDF.
  const type = file.type || guessMimeFromName(file.name);
  if (!ALLOWED_DOC_MIME.includes(type)) {
    return "Подойдёт фото, PDF или документ Word. Другие форматы не принимаются.";
  }
  return null;
}

function guessMimeFromName(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
    heic: "image/heic", heif: "image/heif", pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  }[ext] || "";
}

/** Uploads any allowed file, preserving its real content type (uploadImage assumes an image). */
export async function uploadFile(path, file) {
  await authReady;
  const fileRef = storageRef(storage, path);
  const contentType = file.type || guessMimeFromName(file.name) || "application/octet-stream";
  await uploadBytes(fileRef, file, { contentType });
  return getDownloadURL(fileRef);
}

export async function addAnimalDocument(partnerId, animalId, { kind, file }) {
  await authReady;
  const problem = describeDocFile(file);
  if (problem) throw new Error(problem);

  const docRef = doc(collection(db, "animals", animalId, "documents"));
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 8);
  // Path sits under documents/{partnerId}/ so the existing Storage rule scopes it to the owner;
  // the reviewer is allowed in by the admin claim.
  const storagePath = `documents/${partnerId}/${animalId}/${docRef.id}.${ext}`;
  const fileUrl = await uploadFile(storagePath, file);

  await setDoc(docRef, {
    kind,
    label: (DOC_KINDS.find((k) => k.id === kind) || DOC_KINDS[3]).label,
    fileUrl,
    storagePath,
    fileName: file.name,
    contentType: file.type || guessMimeFromName(file.name),
    size: file.size,
    // 'pending' is written by the client but ENFORCED by the rules - a farmer cannot upload an
    // already-approved document, and cannot approve one afterwards either.
    status: "pending",
    partnerId,
    animalId,
    uploadedAt: serverTimestamp(),
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
  });
  return docRef.id;
}

export async function getAnimalDocuments(animalId) {
  await authReady;
  const snap = await getDocs(collection(db, "animals", animalId, "documents"));
  return snap.docs.map(withId);
}

/** Documents for several animals at once, as a Map(animalId -> docs[]). */
export async function getDocumentsForAnimals(animalIds) {
  await authReady;
  const ids = [...new Set(animalIds.filter(Boolean))];
  // Per-animal catch on purpose: paperwork is an ADDITION to the livestock list, and a failure
  // to read it must never take the list down with it. One rejected promise in a Promise.all
  // blanked the whole cabinet page the first time this ran against undeployed rules.
  const pairs = await Promise.all(ids.map(async (id) => {
    try {
      return [id, await getAnimalDocuments(id)];
    } catch (e) {
      console.error("documents unavailable for animal " + id, e);
      return [id, []];
    }
  }));
  return new Map(pairs);
}

/** Withdraw a document nobody has reviewed yet - a wrong scan should not need an admin. */
//
// Removes the FILE as well as the record. Deleting only the record left every withdrawn
// certificate sitting in Storage for good - and still openable, because a download URL carries
// its own access token and is never checked against the rules. For a document the farmer
// explicitly took back, that is a privacy problem, not just wasted space.
//
// File first, record second: if the record delete then fails, the farmer still sees the entry
// and can retry, whereas the reverse order fails silently into an orphan nobody can find.
export async function deleteAnimalDocument(animalId, docId) {
  await authReady;
  const docRef = doc(db, "animals", animalId, "documents", docId);
  const snap = await getDoc(docRef);
  if (snap.exists()) {
    const { storagePath, fileUrl } = snap.data();
    // storagePath is written by addAnimalDocument; older records only have the download URL,
    // which storageRef() also accepts.
    const target = storagePath || fileUrl;
    if (target) {
      try {
        await deleteObject(storageRef(storage, target));
      } catch (e) {
        // Already gone is fine - that is the state we want. Anything else stops the withdrawal,
        // so we never drop the record while the file survives.
        if (e?.code !== "storage/object-not-found") throw e;
      }
    }
  }
  await deleteDoc(docRef);
}

/** The worst status across an animal's paperwork, which is what the farmer needs to see. */
export function documentsSummary(docs) {
  if (!docs || !docs.length) return { state: "none", label: "Нет документов" };
  if (docs.some((d) => d.status === "rejected")) return { state: "rejected", label: "Есть отклонённый" };
  if (docs.some((d) => d.status === "pending")) return { state: "pending", label: "На проверке" };
  return { state: "approved", label: "Документы подтверждены" };
}

export async function createAnimal(partnerId, data) {
  await authReady;
  const ref = doc(collection(db, "animals"));
  await setDoc(ref, {
    partnerId,
    breed: data.breed,
    subBreed: "",
    status: "active",
    weight: data.weight,
    ageCategory: data.ageCategory,
    gender: data.gender,
    type: data.type,
    imageUrl: data.imageUrl || null,
    notes: null,
    vetDocuments: [],
    price: data.price,
    region: data.region,
    regionCode: data.regionCode || null,
    createdAt: serverTimestamp(),
  });
  // Returned so the caller can open the paperwork panel for the animal it just created -
  // documents can only be attached once the animal exists.
  return ref.id;
}

// Creates the lot as a draft and seeds its delivery chain in the same batch, exactly like
// FirestoreService.createLot() + initializeLotTraceability() do in ET_partners.
export async function createLot(partnerId, data) {
  await authReady;
  const lotRef = doc(collection(db, "lots"));
  const batch = writeBatch(db);

  batch.set(lotRef, {
    partnerId,
    name: data.name,
    description: data.description || "",
    animalIds: data.animalIds || [],
    totalWeight: data.totalWeight,
    // The price per kilogram of carcass is what orders are computed from (createOrder); the price
    // per share is kept alongside for both apps, which still sell by share.
    pricePerKg: data.pricePerKg || null,
    pricePerShare: data.pricePerShare,
    status: "draft",
    totalShares: data.totalShares,
    bookedShares: 0,
    imageUrl: data.imageUrl || null,
    // regionCode is what the site filters and maps by; location stays the human-readable name,
    // because that is the field both apps display.
    location: data.location,
    regionCode: data.regionCode || null,
    meatType: data.meatType || null,
    vetDocuments: [],
    createdAt: serverTimestamp(),
  });

  DELIVERY_CHAIN.forEach((step) => {
    batch.set(doc(db, "lots", lotRef.id, "deliveries", step.id), {
      id: step.id,
      lotId: lotRef.id,
      title: step.title,
      subtitle: step.subtitle,
      description: step.subtitle,
      location: data.location,
      status: step.order === 1 ? "current" : "pending",
      order: step.order,
      icon: step.icon,
      completedAt: null,
      gpsCoords: null,
      mediaUrl: null,
    });
  });

  await batch.commit();
  return lotRef.id;
}

// Firestore rules freeze a lot status once bookedShares > 0, so a lot people have booked into
// cannot be pulled from sale or deleted - from here, from the app, or from anywhere else. The
// UI hides the button in that case, so a denial here means something raced us (someone ordered
// the last share while this page was open); say so instead of surfacing permission-denied.
export async function setLotStatus(lotId, status) {
  await authReady;
  try {
    await updateDoc(doc(db, "lots", lotId), { status });
  } catch (e) {
    if (e?.code === "permission-denied") {
      throw new Error("У туши уже есть заказы — снять её с продажи нельзя.");
    }
    throw e;
  }
}

export async function setDeliveryStepMedia(lotId, stepId, mediaUrl) {
  await authReady;
  await updateDoc(doc(db, "lots", lotId, "deliveries", stepId), { mediaUrl });
}

// Marks a step done and promotes the next one to 'current', mirroring _completeStep() in
// traceability_screen.dart. completedAt is a real Timestamp because the apps cast it strictly.
export async function completeDeliveryStep(lotId, step, allSteps) {
  await authReady;
  const batch = writeBatch(db);
  batch.update(doc(db, "lots", lotId, "deliveries", step.id), {
    status: "completed",
    completedAt: Timestamp.now(),
  });
  const next = allSteps.find((s) => s.order === step.order + 1);
  if (next) {
    batch.update(doc(db, "lots", lotId, "deliveries", next.id), { status: "current" });
  }
  await batch.commit();
}

export function bookingPercent(lot) {
  const total = lot.totalShares || 0;
  const booked = lot.bookedShares || 0;
  if (total <= 0) return 0;
  return Math.round((booked / total) * 100);
}

export function formatTenge(amount) {
  const n = Math.round(Number(amount) || 0);
  return n.toLocaleString("ru-RU") + " ₸";
}

// Russian noun pluralization (1 доля / 2 доли / 5 долей) — a simple 1-vs-other check is wrong
// for any count ending in 2-4 (e.g. "22 доли") or landing in the 5-20 exception range.
export function pluralRu(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
