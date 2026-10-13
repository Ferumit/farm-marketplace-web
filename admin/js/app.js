// ET staff panel.
//
// What protects this panel is NOT this file. Assume its source is public - it is served to anyone
// who gets past the nginx password, and that is a weak gate on purpose. Every read is authorised
// by the Firestore rules (isStaff: the role claim AND a live staff/{uid} record) and every write
// goes through a Cloud Function that re-checks both and writes an audit record. The role checks
// in here only decide which buttons to draw.
import { auth, db, functions, EMULATOR } from "./firebase.js";
import {
  onAuthStateChanged, RecaptchaVerifier, signInWithPhoneNumber, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  collection, collectionGroup, doc, getDoc, getDocs, query, where, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js";
import { regionByCode, regionName, partnerRegion } from "./regions.js";
import { miniMap } from "./map.js";

const root = document.getElementById("app");

// ============================================================================================
// Utilities
// ============================================================================================

// Everything that came out of the database goes through this before it becomes HTML. A farm
// name, a file name or a rejection note rendered raw here would turn a stored XSS into a hijacked
// administrator session - far worse than the one already fixed on the public site.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000);
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDate(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

function pluralRu(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

function ago(ts) {
  const d = toDate(ts);
  if (!d) return "—";
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "только что";
  if (mins < 60) return `${mins} ${pluralRu(mins, "минуту", "минуты", "минут")} назад`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} ${pluralRu(hours, "час", "часа", "часов")} назад`;
  const days = Math.floor(hours / 24);
  return `${days} ${pluralRu(days, "день", "дня", "дней")} назад`;
}

function ageDays(ts) {
  const d = toDate(ts);
  return d ? (Date.now() - d.getTime()) / 86400000 : 0;
}

function tenge(n) {
  return new Intl.NumberFormat("ru-RU").format(Math.round(Number(n) || 0)) + " ₸";
}

function normalisePhone(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("8") && digits.length === 11) return "+7" + digits.slice(1);
  if (digits.startsWith("7")) return "+" + digits;
  return digits ? "+7" + digits : "";
}

// Callable errors carry the server's own Russian message; Firestore errors carry English ones.
function describeError(e) {
  const code = String(e?.code || "");
  if (code.startsWith("functions/") && e?.message && code !== "functions/internal") return e.message;
  const bare = code.replace(/^(functions|auth)\//, "");
  return {
    "permission-denied": "Нет доступа.",
    "unauthenticated": "Сессия истекла — войдите снова.",
    "not-found": "Не найдено.",
    "failed-precondition": "Действие сейчас невозможно.",
    "unavailable": "Нет связи с сервером. Проверьте интернет.",
    "internal": "Ошибка на сервере. Попробуйте ещё раз.",
    "invalid-verification-code": "Неверный код.",
    "code-expired": "Код истёк — запросите новый.",
    "too-many-requests": "Слишком много попыток. Подождите немного.",
    "invalid-phone-number": "Неверный формат номера.",
  }[bare] || "Не удалось выполнить действие.";
}

const call = (name) => httpsCallable(functions, name);

// `bootstrap` only ever appears as the actor of the very first grant, before any admin existed.
const ROLE_LABEL = { admin: "Администратор", support: "Поддержка", bootstrap: "первичная настройка" };

// A MIRROR of STAFF_PERMISSIONS in functions/index.js, used only to decide what to draw. Nothing
// is enforced by it: a support account that forged its way to the moderation tab would still be
// refused by reviewPartner / reviewDocument on the server.
const PERMISSIONS = {
  admin: new Set(["staff.manage", "moderate", "orders.act", "view"]),
  support: new Set(["orders.act", "view"]),
};

// The lifecycle of functions/index.js updateOrderStatus; the old names of orders placed before it
// read as their new equivalents.
const ORDER_STATUS = {
  created: ["Ждёт фермера", "pending"],
  pending_payment: ["Ждёт фермера", "pending"],
  accepted: ["Принят", "ok"],
  confirmed: ["Принят", "ok"],
  animal_selected: ["Животное выбрано", "ok"],
  in_progress: ["Готовится", "ok"],
  meat_ready: ["Мясо готово", "ok"],
  shipped: ["В пути", "ok"],
  delivered: ["Передан покупателю", "pending"],
  completed: ["Завершён", "ok"],
  disputed: ["Спор", "bad"],
  cancelled: ["Отменён", "muted"],
};
const PAYOUT_STATE = {
  locked: "ждёт шага", unlocked: "открыт", blocked: "заблокирован спором", withheld: "удержан", cancelled: "отменён",
};
const COMPLETED_BY = { buyer: "покупатель подтвердил", auto: "автоматически", dispute: "по решению спора" };

const PARTNER_STATUS = {
  pending_review: ["На проверке", "pending"],
  verified: ["Одобрено", "ok"],
  active: ["Активно", "ok"],
  rejected: ["Отклонено", "bad"],
};

const DOC_STATUS = {
  pending: ["На проверке", "pending"],
  approved: ["Одобрен", "ok"],
  rejected: ["Отклонён", "bad"],
};

const DISPUTE_STATUS = {
  new: ["Новый", "pending"],
  in_review: ["В работе", "pending"],
  resolved: ["Закрыт", "ok"],
};
const OPEN_DISPUTES = ["new", "in_review"];

// What the team decided - a MIRROR of DISPUTE_OUTCOMES in functions/index.js. The buyer is shown
// the note written with it, not these words.
const DISPUTE_OUTCOME = {
  buyer: "В пользу покупателя",
  partner: "В пользу фермера",
  partial: "Частично в пользу покупателя",
  withdrawn: "Покупатель отозвал претензию",
};

const ACTION_LABEL = {
  "staff.bootstrap": "назначил себя первым администратором",
  "staff.grant": "выдал роль сотрудника",
  "staff.revoke": "отозвал роль сотрудника",
  "partner.approve": "одобрил хозяйство",
  "partner.reject": "отклонил хозяйство",
  "document.approve": "одобрил документ",
  "document.reject": "отклонил документ",
  "dispute.take": "взял спор в работу",
  "dispute.resolve": "закрыл спор",
  "review.approve": "опубликовал отзыв",
  "review.reject": "отклонил отзыв",
  "lot.delete": "удалил лот",
};

// What an order is for - a half or a whole carcass, or the share count of an older order. The
// public site's js/carcass.js says the same; this panel is a separate origin with its own copy.
const FORMAT_LABEL = { half: "Половина туши", whole: "Целая туша" };
const SLOT_LABEL = { any: "любое время", morning: "утро", day: "день", evening: "вечер" };
function orderWhat(o) {
  if (o.format && FORMAT_LABEL[o.format]) {
    return FORMAT_LABEL[o.format] + (o.estimatedWeightKg ? ` · ~${o.estimatedWeightKg} кг` : "");
  }
  const n = Number(o.shares) || 0;
  return `${n} ${pluralRu(n, "доля", "доли", "долей")}`;
}

function chip(map, value) {
  const [label, cls] = map[value] || [value || "—", "muted"];
  return `<span class="chip ${cls}">${esc(label)}</span>`;
}

// ============================================================================================
// Gate: who is looking at this page?
// ============================================================================================

let me = null; // { uid, phone, role }

onAuthStateChanged(auth, async (user) => {
  me = null;
  if (!user) return renderLogin();
  try {
    // Force a refresh: a role granted a moment ago is not in the cached token yet.
    const token = await user.getIdTokenResult(true);
    const role = token.claims.role;
    if (!PERMISSIONS[role]) return renderNoAccess(user);
    // The claim alone is not enough - the rules also require a live staff record, which
    // revocation deletes at once. Reading it both confirms access and catches a revoked account
    // whose token still carries the old claim.
    const staff = await getDoc(doc(db, "staff", user.uid));
    if (!staff.exists()) return renderNoAccess(user, "revoked");
    me = { uid: user.uid, phone: user.phoneNumber, role };
    renderShell();
    route();
  } catch (e) {
    console.error(e);
    renderNoAccess(user, e?.code === "permission-denied" ? "revoked" : "error");
  }
});

function can(permission) {
  return !!me && PERMISSIONS[me.role]?.has(permission);
}

// ---- login ------------------------------------------------------------------------------------

let verifier = null;

// A RecaptchaVerifier is single-use: after one attempt, successful or not, it has to be replaced.
function freshVerifier() {
  try { verifier?.clear(); } catch (_) { /* already gone */ }
  document.getElementById("recaptcha-container").innerHTML = "";
  verifier = new RecaptchaVerifier(auth, "recaptcha-container", { size: "invisible" });
  return verifier;
}

function emulatorBadge() {
  return EMULATOR ? '<span class="emulator-badge">Эмулятор — не боевые данные</span>' : "";
}

function renderLogin() {
  root.innerHTML = `
    <div class="gate"><div class="card">
      ${emulatorBadge()}
      <h1>Служебная панель ET</h1>
      <p>Вход по номеру телефона сотрудника.</p>
      <div id="step-phone">
        <div class="field">
          <label for="phone">Телефон</label>
          <input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 700 000 00 00">
        </div>
        <button class="btn primary block" id="send">Получить код</button>
      </div>
      <div id="step-code" hidden>
        <div class="field">
          <label for="code">Код из SMS</label>
          <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">
        </div>
        <button class="btn primary block" id="confirm">Войти</button>
        <div class="actions"><button class="btn block" id="back">Другой номер</button></div>
      </div>
      <p class="error" id="err" hidden></p>
    </div></div>`;

  let confirmation = null;
  const err = root.querySelector("#err");
  const showErr = (msg) => { err.textContent = msg; err.hidden = !msg; };

  root.querySelector("#send").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    showErr("");
    const phone = normalisePhone(root.querySelector("#phone").value);
    if (!/^\+\d{10,15}$/.test(phone)) return showErr("Введите номер полностью.");
    btn.disabled = true;
    try {
      confirmation = await signInWithPhoneNumber(auth, phone, freshVerifier());
      root.querySelector("#step-phone").hidden = true;
      root.querySelector("#step-code").hidden = false;
      root.querySelector("#code").focus();
    } catch (e) {
      console.error(e);
      showErr(describeError(e));
    } finally {
      btn.disabled = false;
    }
  });

  root.querySelector("#confirm").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    showErr("");
    const code = root.querySelector("#code").value.trim();
    if (code.length < 6) return showErr("Введите шесть цифр из SMS.");
    btn.disabled = true;
    try {
      await confirmation.confirm(code); // onAuthStateChanged takes it from here
    } catch (e) {
      console.error(e);
      showErr(describeError(e));
      btn.disabled = false;
    }
  });

  root.querySelector("#back").addEventListener("click", () => {
    root.querySelector("#step-code").hidden = true;
    root.querySelector("#step-phone").hidden = false;
    showErr("");
  });
}

// ---- no access --------------------------------------------------------------------------------

function renderNoAccess(user, reason) {
  const text = {
    revoked: "Права сотрудника у этого аккаунта отозваны.",
    error: "Не удалось проверить права. Обновите страницу.",
  }[reason] || "У этого аккаунта нет доступа к служебной панели.";

  root.innerHTML = `
    <div class="gate"><div class="card">
      ${emulatorBadge()}
      <h1>Нет доступа</h1>
      <p>${esc(text)}</p>
      <p class="meta">Вы вошли как <b>${esc(user.phoneNumber || "—")}</b>.</p>
      <div class="actions">
        <button class="btn" id="logout">Выйти</button>
        <button class="btn" id="claim">Я владелец платформы</button>
      </div>
      <p class="error" id="err" hidden></p>
    </div></div>`;

  root.querySelector("#logout").addEventListener("click", () => signOut(auth));

  // The first administrator. The server only lets a phone listed in BOOTSTRAP_ADMIN_PHONES make
  // itself admin; for everyone else this button just says no. Showing it to everybody gives
  // nothing away - the allowlist lives server-side and the phone is proven by the SMS code.
  root.querySelector("#claim").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const err = root.querySelector("#err");
    btn.disabled = true;
    err.hidden = true;
    try {
      await call("grantStaffRole")({ phone: user.phoneNumber, role: "admin" });
      await user.getIdToken(true);          // pick up the new claim
      window.location.reload();
    } catch (e) {
      console.error(e);
      err.textContent = describeError(e);
      err.hidden = false;
      btn.disabled = false;
    }
  });
}

// ============================================================================================
// Shell and navigation
// ============================================================================================

const TABS = [
  { id: "overview", label: "Сводка", perm: "view" },
  { id: "partners", label: "Хозяйства", perm: "moderate", badge: "partners" },
  { id: "documents", label: "Документы", perm: "moderate", badge: "documents" },
  { id: "orders", label: "Заказы", perm: "view" },
  { id: "disputes", label: "Споры", perm: "orders.act", badge: "disputes" },
  { id: "reviews", label: "Отзывы", perm: "moderate", badge: "reviews" },
  { id: "journal", label: "Журнал", perm: "view" },
  { id: "team", label: "Команда", perm: "staff.manage" },
];

const badges = { partners: 0, documents: 0, disputes: 0, reviews: 0 };

function renderShell() {
  root.innerHTML = `
    <header class="topbar">
      <div class="inner">
        <span class="brand">ET<small>служебная панель</small></span>
        ${EMULATOR ? '<span class="emulator-badge" style="margin:0">Эмулятор</span>' : ""}
        <span class="who">
          <span class="role">${esc(ROLE_LABEL[me.role] || me.role)}</span>
          <span>${esc(me.phone || "")}</span>
          <button class="btn" id="logout">Выйти</button>
        </span>
      </div>
      <nav class="tabs" id="tabs"></nav>
    </header>
    <main id="view"></main>`;
  root.querySelector("#logout").addEventListener("click", () => signOut(auth));
  refreshBadges();
}

function paintTabs(activeId) {
  const nav = document.getElementById("tabs");
  if (!nav) return;
  nav.innerHTML = TABS.filter((t) => can(t.perm)).map((t) => {
    const n = t.badge ? badges[t.badge] : 0;
    return `<a href="#${t.id}" class="${t.id === activeId ? "active" : ""}">
      ${esc(t.label)}${n ? `<span class="count">${n}</span>` : ""}</a>`;
  }).join("");
}

// The queues whose size is worth seeing from any tab - each only for a role that can act on it.
async function refreshBadges() {
  const jobs = [];
  if (can("moderate")) {
    jobs.push(getDocs(query(collection(db, "partners"), where("status", "==", "pending_review")))
      .then((s) => { badges.partners = s.size; }));
    jobs.push(getDocs(pendingDocumentsQuery()).then((s) => { badges.documents = s.size; }));
    jobs.push(getDocs(query(collection(db, "reviews"), where("status", "==", "pending")))
      .then((s) => { badges.reviews = s.size; }));
  }
  if (can("orders.act")) {
    jobs.push(getDocs(openDisputesQuery()).then((s) => { badges.disputes = s.size; }));
  }
  try {
    await Promise.all(jobs);
    paintTabs(currentTab());
  } catch (e) {
    console.error("badge refresh failed", e);
  }
}

// Status only - no orderBy - so it needs no composite index.
function openDisputesQuery() {
  return query(collection(db, "disputes"), where("status", "in", OPEN_DISPUTES));
}

// Exactly the shape of the COLLECTION_GROUP index in firestore.indexes.json. The emulator does
// not enforce indexes, so a query that drifted from it would pass every local test and then fail
// in production - keep the two in step.
function pendingDocumentsQuery() {
  return query(collectionGroup(db, "documents"), where("status", "==", "pending"), orderBy("uploadedAt", "asc"));
}

// Адрес вида #partner/<id> — карточка одного хозяйства. Это не отдельная вкладка: сверху
// по-прежнему подсвечены «Хозяйства», потому что человек не ушёл из раздела, а углубился в него.
// Хэш, а не состояние в памяти, чтобы ссылку на карточку можно было переслать коллеге и чтобы
// «назад» в браузере работало само.
function currentRoute() {
  const raw = window.location.hash.slice(1) || "overview";
  const deep = raw.match(/^partner\/(.+)$/);
  if (deep && can("moderate")) return { tab: "partners", partnerId: decodeURIComponent(deep[1]) };
  return { tab: (TABS.find((t) => t.id === raw && can(t.perm)) || TABS[0]).id, partnerId: null };
}

function currentTab() {
  return currentRoute().tab;
}

const VIEWS = {
  overview: viewOverview,
  partners: viewPartners,
  documents: viewDocuments,
  orders: viewOrders,
  disputes: viewDisputes,
  reviews: viewReviews,
  journal: viewJournal,
  team: viewTeam,
};

async function route() {
  if (!me) return;
  const { tab, partnerId } = currentRoute();
  paintTabs(tab);
  const view = document.getElementById("view");
  view.innerHTML = '<div class="empty">Загрузка…</div>';
  try {
    if (partnerId) await viewPartner(view, partnerId);
    else await VIEWS[tab](view);
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="notice">Не удалось загрузить раздел: ${esc(describeError(e))}</div>`;
  }
}

window.addEventListener("hashchange", route);

// Lookups shared by several views, fetched once per render.
async function partnersById() {
  const snap = await getDocs(collection(db, "partners"));
  return new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
}

// ============================================================================================
// Views
// ============================================================================================

// ---- overview: numbers, and more importantly, where things are stuck ---------------------------

async function viewOverview(view) {
  const [ordersSnap, partnersSnap, lotsSnap, docsSnap, disputesSnap] = await Promise.all([
    getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(500))),
    getDocs(collection(db, "partners")),
    getDocs(collection(db, "lots")),
    can("moderate") ? getDocs(pendingDocumentsQuery()) : Promise.resolve({ docs: [], size: 0 }),
    getDocs(openDisputesQuery()),
  ]);
  const orders = ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const partners = partnersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const lots = lotsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const pendingDocs = docsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const openDisputes = disputesSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const week = orders.filter((o) => ageDays(o.createdAt) <= 7);
  const waiting = orders.filter((o) => o.status === "created" || o.status === "pending_payment");
  const pendingPartners = partners.filter((p) => p.status === "pending_review");
  const openLots = lots.filter((l) => l.status === "open");
  const soldOut = lots.filter((l) => l.status === "fully_booked");
  const revenueWeek = week.filter((o) => o.status !== "cancelled").reduce((s, o) => s + (Number(o.amount) || 0), 0);

  // Signals: not "how many", but "what needs a human". Each one is a thing that has gone quiet
  // for longer than it should. A dispute comes first and needs no waiting period: it is a buyer
  // standing at the door with meat they refused.
  const signals = [];
  const excerpt = (text) => { const s = String(text || "").trim(); return s.length > 120 ? s.slice(0, 117) + "…" : s; };
  openDisputes.filter((d) => (d.status || "new") === "new").forEach((d) => signals.push({
    title: "Новый спор — никто не взял в работу",
    text: excerpt(d.description),
    href: "#disputes",
  }));
  openDisputes.filter((d) => d.status === "in_review" && ageDays(d.takenAt || d.createdAt) > 2).forEach((d) => signals.push({
    title: "Спор в работе больше двух дней",
    text: excerpt(d.description),
    href: "#disputes",
  }));
  waiting.filter((o) => ageDays(o.createdAt) > 3).forEach((o) => signals.push({
    title: `Заказ ждёт фермера ${Math.floor(ageDays(o.createdAt))} ${pluralRu(Math.floor(ageDays(o.createdAt)), "день", "дня", "дней")}`,
    text: `«${o.lotTitle || "лот"}», ${orderWhat(o).toLowerCase()}, покупатель ${o.contactPhone || o.buyerPhone || "—"}`,
    href: "#orders",
  }));
  pendingDocs.filter((d) => ageDays(d.uploadedAt) > 1).forEach((d) => signals.push({
    title: "Документ ждёт проверки больше суток",
    text: `${d.label || "Документ"} · ${d.fileName || ""}`,
    href: "#documents",
  }));
  pendingPartners.filter((p) => ageDays(p.createdAt) > 2).forEach((p) => signals.push({
    title: "Хозяйство ждёт проверки больше двух дней",
    text: `${p.displayName || "Без названия"} · ${p.phone || ""}`,
    href: "#partners",
  }));
  // A deal 3 hours past handover is completed by autoCompleteOrders every 15 minutes. One still
  // hanging well after that means the schedule is not running - the job, its permissions, or the
  // function itself.
  orders.filter((o) => o.status === "delivered" && toDate(o.autoCompleteAt) && Date.now() - toDate(o.autoCompleteAt).getTime() > 45 * 60000)
    .forEach((o) => signals.push({
      title: "Сделка не завершилась автоматически",
      text: `«${o.lotTitle || "лот"}» передан ${ago(o.steps?.handover?.at)} — проверьте функцию autoCompleteOrders`,
      href: "#orders",
    }));
  soldOut.forEach((l) => {
    const stuck = orders.filter((o) => o.lotId === l.id && (o.status === "created" || o.status === "pending_payment"));
    if (stuck.length) signals.push({
      title: "Лот распродан, но фермер не подтвердил заказы",
      text: `«${l.name || "лот"}» — ${stuck.length} ${pluralRu(stuck.length, "заказ ждёт", "заказа ждут", "заказов ждут")} подтверждения`,
      href: "#orders",
    });
  });

  // A label is either fixed text (the revenue card) or [one, few, many], agreed with the number -
  // fixed plurals printed "1 хозяйств на проверке" on the live panel.
  const stat = (n, label, warn) => {
    const text = Array.isArray(label) ? pluralRu(Number(n) || 0, ...label) : label;
    return `<div class="card stat${warn && n ? " warn" : ""}"><div class="n">${esc(n)}</div><div class="l">${esc(text)}</div></div>`;
  };

  view.innerHTML = `
    <h2>Сводка</h2>
    <p class="lede">Что происходит на площадке сейчас.</p>
    <div class="grid">
      ${stat(week.length, ["заказ за 7 дней", "заказа за 7 дней", "заказов за 7 дней"])}
      ${stat(tenge(revenueWeek), "оборот за 7 дней")}
      ${stat(waiting.length, ["заказ ждёт подтверждения фермера", "заказа ждут подтверждения фермера", "заказов ждут подтверждения фермера"], true)}
      ${stat(openDisputes.length, ["открытый спор", "открытых спора", "открытых споров"], true)}
      ${stat(pendingPartners.length, ["хозяйство на проверке", "хозяйства на проверке", "хозяйств на проверке"], true)}
      ${can("moderate") ? stat(pendingDocs.length, ["документ на проверке", "документа на проверке", "документов на проверке"], true) : ""}
      ${stat(openLots.length, ["лот в продаже", "лота в продаже", "лотов в продаже"])}
      ${stat(soldOut.length, ["лот распродан", "лота распроданы", "лотов распродано"])}
      ${stat(partners.filter((p) => p.status === "verified" || p.status === "active").length, ["одобренное хозяйство", "одобренных хозяйства", "одобренных хозяйств"])}
    </div>
    <h2 style="margin-top:28px">Требует внимания</h2>
    <p class="lede">То, что застряло дольше, чем должно.</p>
    ${signals.length
      ? `<div class="stack">${signals.map((s) => `
          <a class="card signal" href="${esc(s.href)}" style="display:block;text-decoration:none;color:inherit">
            <b>${esc(s.title)}</b><span class="meta">${esc(s.text)}</span>
          </a>`).join("")}</div>`
      : '<div class="card empty">Ничего не застряло.</div>'}`;
}

// ---- farms ------------------------------------------------------------------------------------

// Reject needs a reason (the farmer sees it), approve does not. Both ask for one more click.
// Actions on a farm that was already reviewed. reviewPartner accepts a decision whatever the
// current status, but the panel only ever offered one on the pending list - so a rejected farm had
// no way back, and a checked farm that went bad could not be taken off the storefront.
function farmRowControls(p) {
  const id = esc(p.id);
  if (p.status === "rejected") {
    return `<div class="actions"><button class="btn" data-approve="${id}">Одобрить повторно</button></div>
      <p class="error" data-error="${id}" hidden></p>`;
  }
  if (p.status !== "verified" && p.status !== "active") return "";
  return `
    <div class="actions"><button class="btn danger" data-reject-open="${id}">Снять одобрение…</button></div>
    <div class="reject-box" data-reject-box="${id}" hidden>
      <label>Причина — её увидит фермер. Лоты хозяйства сразу пропадут с витрины, новые заказы не будут приниматься.</label>
      <textarea data-reject-note="${id}" maxlength="500"></textarea>
      <div class="actions">
        <button class="btn danger" data-reject="${id}">Снять одобрение</button>
        <button class="btn" data-reject-cancel="${id}">Отмена</button>
      </div>
    </div>
    <p class="error" data-error="${id}" hidden></p>`;
}

function decisionControls(key, who = "фермер") {
  return `
    <div class="actions">
      <button class="btn primary" data-approve="${esc(key)}">Одобрить</button>
      <button class="btn danger" data-reject-open="${esc(key)}">Отклонить…</button>
    </div>
    <div class="reject-box" data-reject-box="${esc(key)}" hidden>
      <label>Причина отказа — её увидит ${esc(who)}</label>
      <textarea data-reject-note="${esc(key)}" maxlength="500"></textarea>
      <div class="actions">
        <button class="btn danger" data-reject="${esc(key)}">Отклонить</button>
        <button class="btn" data-reject-cancel="${esc(key)}">Отмена</button>
      </div>
    </div>
    <p class="error" data-error="${esc(key)}" hidden></p>`;
}

// One handler for approve/reject on any list. `decide(key, decision, note)` performs the call.
function wireDecisions(view, decide, afterwards, rejectHint = "Опишите причину — фермер должен понять, что исправить.") {
  view.onclick = async (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    const key = t.dataset.approve || t.dataset.reject || t.dataset.rejectOpen || t.dataset.rejectCancel;
    if (!key) return;
    const box = view.querySelector(`[data-reject-box="${CSS.escape(key)}"]`);
    const err = view.querySelector(`[data-error="${CSS.escape(key)}"]`);
    const showErr = (m) => { if (err) { err.textContent = m; err.hidden = !m; } };

    if (t.dataset.rejectOpen) { box.hidden = false; box.querySelector("textarea").focus(); return; }
    if (t.dataset.rejectCancel) { box.hidden = true; showErr(""); return; }

    const decision = t.dataset.approve ? "approve" : "reject";
    const note = decision === "reject" ? view.querySelector(`[data-reject-note="${CSS.escape(key)}"]`).value.trim() : "";
    if (decision === "reject" && note.length < 5) return showErr(rejectHint);

    t.disabled = true;
    showErr("");
    try {
      await decide(key, decision, note);
      await refreshBadges();
      await afterwards();
    } catch (e) {
      console.error(e);
      showErr(describeError(e));
      t.disabled = false;
    }
  };
}

async function viewPartners(view) {
  const [pendingSnap, allSnap] = await Promise.all([
    getDocs(query(collection(db, "partners"), where("status", "==", "pending_review"))),
    getDocs(collection(db, "partners")),
  ]);
  const pending = pendingSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // What each waiting farm has actually supplied, so the decision is made on evidence.
  const evidence = new Map(await Promise.all(pending.map(async (p) => {
    // The IIN, the exact hub point and the legal details live in the farm's private records, which
    // staff may read; the farm's own certificates in its documents.
    const [animals, identitySnap, locationSnap, legalSnap, farmDocsSnap] = await Promise.all([
      getDocs(query(collection(db, "animals"), where("partnerId", "==", p.id))),
      getDoc(doc(db, "partners", p.id, "private", "identity")),
      getDoc(doc(db, "partners", p.id, "private", "location")),
      getDoc(doc(db, "partners", p.id, "private", "legal")),
      getDocs(collection(db, "partners", p.id, "documents")),
    ]);
    let docsTotal = 0, docsApproved = 0;
    await Promise.all(animals.docs.map(async (a) => {
      const ds = await getDocs(collection(db, "animals", a.id, "documents"));
      docsTotal += ds.size;
      docsApproved += ds.docs.filter((x) => x.data().status === "approved").length;
    }));
    return [p.id, {
      animals: animals.size, docsTotal, docsApproved,
      iin: identitySnap.exists() ? identitySnap.data().iin : null,
      exact: locationSnap.exists() ? locationSnap.data() : null,
      legal: legalSnap.exists() ? legalSnap.data() : null,
      farmDocs: farmDocsSnap.docs.map((d) => d.data()),
    }];
  })));

  const others = allSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.status !== "pending_review");
  // The moderator's reason is in each farm's private record now; older decisions carried it on
  // the profile itself.
  // Решение модератора и счёт для выплат — обе записи закрытые, и читает их только сотрудник.
  // Счёт нужен здесь, а не в очереди на проверку: платят уже проверенному хозяйству, и человек,
  // который делает перевод, ищет реквизиты в списке хозяйств, а не в заявках.
  const details = new Map(await Promise.all(others.map(async (p) => {
    const [r, b] = await Promise.all([
      getDoc(doc(db, "partners", p.id, "private", "review")).catch(() => null),
      getDoc(doc(db, "partners", p.id, "private", "bank")).catch(() => null),
    ]);
    return [p.id, {
      reason: (r && r.exists() && r.data().note) || p.reviewNote || "",
      bank: b && b.exists() ? b.data() : null,
    }];
  })));
  const reasons = new Map([...details].map(([id, d]) => [id, d.reason]));

  view.innerHTML = `
    <h2>Хозяйства</h2>
    <p class="lede">Покупатели видят только одобренные хозяйства, и только они принимают заказы. Каждое решение записывается в журнал.</p>
    ${pending.length ? `<div class="stack">${pending.map((p) => {
      const ev = evidence.get(p.id);
      return `
        <div class="card item">
          <div class="item-head">
            <div class="grow">
              <h3>${esc(p.displayName || "Без названия")}</h3>
              <p class="meta">Заявка ${esc(ago(p.createdAt))}</p>
            </div>
            ${chip(PARTNER_STATUS, p.status)}
          </div>
          <dl class="kv">
            <dt>Телефон</dt><dd>${esc(p.phone || "—")}</dd>
            <dt>ИИН/БИН</dt><dd>${iinHtml(ev.iin, p.iin)}</dd>
            <dt>Регион</dt><dd>${regionHtml(p)}</dd>
            <dt>Населённый пункт</dt><dd>${esc(p.city || "—")}</dd>
            <dt>Точка хаба</dt><dd>${pointHtml(ev.exact)}</dd>
            <dt>Реквизиты</dt><dd>${legalHtml(ev.legal)}</dd>
            <dt>Сертификаты</dt><dd>${farmCertsHtml(ev.farmDocs)}</dd>
            <dt>Витрина</dt><dd>${storefrontHtml(p.storefront)}</dd>
            <dt>Скот</dt><dd>${esc(ev.animals)} ${pluralRu(ev.animals, "голова", "головы", "голов")}</dd>
            <dt>Документы на скот</dt><dd>загружено: ${esc(ev.docsTotal)}, одобрено: ${esc(ev.docsApproved)}</dd>
          </dl>
          ${ev.exact || regionByCode(partnerRegion(p)) ? `<div class="mini-map" data-mini-map="${esc(p.id)}"></div>` : ""}
          ${decisionControls(p.id)}
        </div>`;
    }).join("")}</div>` : '<div class="card empty">Нет хозяйств на проверке.</div>'}
    <h2 style="margin-top:28px">Все хозяйства</h2>
    ${others.length ? `<div class="card"><table class="list">
      <thead><tr><th>Хозяйство</th><th>Телефон</th><th>Регион</th><th>Счёт для выплат</th><th>Статус</th><th>Решение</th><th>Действие</th></tr></thead>
      <tbody>${others.map((p) => `<tr>
        <td data-label="Хозяйство"><a href="#partner/${encodeURIComponent(p.id)}">${esc(p.displayName || "—")}</a></td>
        <td data-label="Телефон">${esc(p.phone || "—")}</td>
        <td data-label="Регион">${esc(regionName(partnerRegion(p)) || "—")}</td>
        <td data-label="Счёт для выплат">${bankHtml(details.get(p.id)?.bank)}</td>
        <td data-label="Статус">${chip(PARTNER_STATUS, p.status)}${p.certified ? ' <span class="chip ok">сертификаты</span>' : ""}</td>
        <td data-label="Решение">${p.reviewedAt ? esc(fmtDate(p.reviewedAt)) : "—"}${reasons.get(p.id) ? `<div class="meta">${esc(reasons.get(p.id))}</div>` : ""}</td>
        <td data-label="Действие">${farmRowControls(p)}</td>
      </tr>`).join("")}</tbody></table></div>` : '<div class="card empty">Пока пусто.</div>'}`;

  wireDecisions(view,
    (partnerId, decision, note) => call("reviewPartner")({ partnerId, decision, note }),
    () => viewPartners(view));

  // A map that fails to load (offline, blocked tiles) must not take the review card with it.
  for (const p of pending) {
    const box = view.querySelector(`[data-mini-map="${CSS.escape(p.id)}"]`);
    if (!box) continue;
    const region = regionByCode(partnerRegion(p));
    miniMap(box, {
      exact: evidence.get(p.id).exact,
      publicPoint: p.publicLocation || null,
      regionCenter: region ? region.center : null,
    }).catch((e) => { console.error(e); box.remove(); });
  }
}

// ---- карточка одного хозяйства ----------------------------------------------------------------

const LOT_STATUS = {
  draft: ["Черновик", "muted"],
  open: ["В продаже", "ok"],
  fully_booked: ["Всё забронировано", "pending"],
  in_transit: ["В пути", "pending"],
  sold: ["Продан", "muted"],
};
// Порядок, в котором лоты полезно видеть: сначала то, что сейчас в обороте, в конце — архив.
const LOT_ORDER = ["open", "fully_booked", "in_transit", "draft", "sold"];

/**
 * Всё об одном хозяйстве на одном экране — и его лоты, за которыми раньше приходилось лезть в
 * консоль Firebase. Человек, который разбирается с хозяйством, задаёт о нём несколько вопросов
 * подряд: кто это по документам, чем торгует, куда ему платить, что со справками.
 */
async function viewPartner(view, partnerId) {
  const priv = (name) => getDoc(doc(db, "partners", partnerId, "private", name)).catch(() => null);
  // Одно равенство индекса не требует. Составной индекс на каждую коллекцию был бы лишней
  // вещью, которая однажды разойдётся с firestore.indexes.json — сортируем на клиенте.
  const mine = (name) => getDocs(query(collection(db, name), where("partnerId", "==", partnerId)));
  const [pSnap, identity, legal, contact, bank, location, review, farmDocs, animals, lots, orders] =
    await Promise.all([
      getDoc(doc(db, "partners", partnerId)),
      priv("identity"), priv("legal"), priv("contact"), priv("bank"), priv("location"), priv("review"),
      getDocs(collection(db, "partners", partnerId, "documents")),
      mine("animals"), mine("lots"), mine("orders"),
    ]);

  const back = '<p class="lede"><a href="#partners">← ко всем хозяйствам</a></p>';
  if (!pSnap.exists()) {
    view.innerHTML = `${back}<div class="card empty">Хозяйство не найдено.</div>`;
    return;
  }

  const val = (s) => (s && s.exists() ? s.data() : null);
  const p = { id: pSnap.id, ...pSnap.data() };
  const certs = farmDocs.docs.map((d) => d.data());
  const herd = animals.docs.map((d) => ({ id: d.id, ...d.data() }));
  const rows = lots.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) =>
    (LOT_ORDER.indexOf(a.status) - LOT_ORDER.indexOf(b.status))
    || String(a.name || "").localeCompare(String(b.name || ""), "ru"));
  const deals = orders.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0));
  const earned = deals.filter((o) => o.status === "completed")
    .reduce((sum, o) => sum + (Number(o.amount) || 0), 0);

  const whole = (l) => (Number(l.pricePerKg) > 0 && Number(l.totalWeight) > 0
    ? Math.round(Number(l.pricePerKg) * Number(l.totalWeight))
    : (Number(l.pricePerShare) || 0) * (Number(l.totalShares) || 0));

  view.innerHTML = `
    ${back}
    <div class="card item">
      <div class="item-head">
        <div class="grow">
          <h2>${esc(p.displayName || "Без названия")}</h2>
          <p class="meta">${esc(p.phone || "—")} · ${regionHtml(p)}${p.city ? " · " + esc(p.city) : ""}</p>
        </div>
        ${chip(PARTNER_STATUS, p.status)}${p.certified ? ' <span class="chip ok">сертификаты</span>' : ""}
      </div>
      <dl class="kv">
        <dt>Реквизиты</dt><dd>${legalHtml(val(legal))}</dd>
        <dt>ИИН/БИН</dt><dd>${iinHtml(val(identity)?.iin, p.iin)}</dd>
        <dt>Счёт для выплат</dt><dd>${bankHtml(val(bank))}</dd>
        <dt>Почта для заказов</dt><dd>${esc(val(contact)?.email || "не указана")}</dd>
        <dt>Точка хаба</dt><dd>${pointHtml(val(location))}</dd>
        <dt>Сертификаты</dt><dd>${farmCertsHtml(certs)}</dd>
        <dt>Витрина</dt><dd>${storefrontHtml(p.storefront)}</dd>
        <dt>Сделки</dt><dd>${esc(deals.length)} ${pluralRu(deals.length, "заказ", "заказа", "заказов")},
          завершено на ${esc(tenge(earned))}${p.rating ? ` · рейтинг ${esc(p.rating)}` : ""}</dd>
        <dt>Решение</dt><dd>${p.reviewedAt ? esc(fmtDate(p.reviewedAt)) : "—"}${
          val(review)?.note ? `<div class="meta">${esc(val(review).note)}</div>` : ""}</dd>
      </dl>
    </div>

    <h2 style="margin-top:28px">Лоты · ${esc(rows.length)}</h2>
    <p class="lede">Удаление необратимо и записывается в журнал. Заказы на удалённый лот остаются —
      пропадает только карточка туши из каталога.</p>
    ${rows.length ? `<div class="card"><table class="list">
      <thead><tr><th>Туша</th><th>Состояние</th><th>Доли</th><th>Вес и цена</th><th>Действие</th></tr></thead>
      <tbody>${rows.map((l) => {
        const booked = Number(l.bookedShares) || 0;
        const total = Number(l.totalShares) || 0;
        return `<tr>
        <td data-label="Туша">${esc(l.name || "без названия")}
          <div class="meta">${esc(l.location || "")} ${l.imageUrl ? "· с фото" : "· без фото"}</div></td>
        <td data-label="Состояние">${chip(LOT_STATUS, l.status)}</td>
        <td data-label="Доли">${esc(booked)} из ${esc(total)} занято</td>
        <td data-label="Вес и цена">${l.totalWeight ? esc(l.totalWeight) + " кг" : "вес не указан"}
          <div class="meta">${l.pricePerKg ? esc(tenge(l.pricePerKg)) + "/кг · " : ""}целая ${esc(tenge(whole(l)))}</div></td>
        <td data-label="Действие">
          <button class="btn danger" data-del-lot="${esc(l.id)}" data-booked="${esc(booked)}"
            data-name="${esc(l.name || "лот")}">Удалить</button>
          <p class="error" data-lot-error="${esc(l.id)}" hidden></p></td>
      </tr>`; }).join("")}</tbody></table></div>` : '<div class="card empty">Лотов нет.</div>'}

    <h2 style="margin-top:28px">Скот · ${esc(herd.length)}</h2>
    ${herd.length ? `<div class="card"><table class="list">
      <thead><tr><th>Животное</th><th>Вид</th><th>Возраст</th><th>Вес</th></tr></thead>
      <tbody>${herd.slice(0, 30).map((a) => `<tr>
        <td data-label="Животное">${esc(a.breed || "порода не указана")}</td>
        <td data-label="Вид">${esc(a.type === "horse" ? "конина" : "говядина")}</td>
        <td data-label="Возраст">${esc(a.ageCategory || "—")}</td>
        <td data-label="Вес">${a.weight ? esc(a.weight) + " кг" : "—"}</td>
      </tr>`).join("")}</tbody></table></div>` : '<div class="card empty">Скота нет.</div>'}

    <h2 style="margin-top:28px">Последние заказы</h2>
    ${deals.length ? `<div class="card"><table class="list">
      <thead><tr><th>Когда</th><th>Что</th><th>Состояние</th></tr></thead>
      <tbody>${deals.slice(0, 10).map((o) => `<tr>
        <td data-label="Когда">${esc(fmtDate(o.createdAt))}</td>
        <td data-label="Что">${esc(orderWhat(o))} · ${esc(tenge(o.amount))}</td>
        <td data-label="Состояние">${chip(ORDER_STATUS, o.status)}</td>
      </tr>`).join("")}</tbody></table></div>` : '<div class="card empty">Заказов не было.</div>'}`;

  wireLotDeletes(view, partnerId);
}

/**
 * Удаление лота. Сервер отказывает, если в лоте есть брони и не передан `force`, — поэтому
 * занятый лот спрашивают дважды: сначала здесь словами, что станет с заказами, и только потом
 * уходит подтверждённый запрос.
 */
function wireLotDeletes(view, partnerId) {
  view.querySelectorAll("[data-del-lot]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const lotId = btn.dataset.delLot;
      const booked = Number(btn.dataset.booked) || 0;
      const warn = booked > 0
        ? `\n\nВ лоте занято ${booked} ${pluralRu(booked, "доля", "доли", "долей")}. `
          + "Заказы на него останутся и будут ссылаться на то, чего уже нет."
        : "";
      if (!window.confirm(`Удалить «${btn.dataset.name}»? Отменить это нельзя.${warn}`)) return;

      const box = view.querySelector(`[data-lot-error="${CSS.escape(lotId)}"]`);
      if (box) box.hidden = true;
      btn.disabled = true;
      btn.textContent = "Удаляем…";
      try {
        await call("deleteLot")({ lotId, force: booked > 0 });
        await viewPartner(view, partnerId);
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "Удалить";
        if (box) { box.textContent = describeError(e); box.hidden = false; }
      }
    });
  });
}

const LEGAL_FORM = { kh: "КХ", fh: "ФХ", ip: "ИП", too: "ТОО" };
// Счёт хозяйства так, чтобы по нему можно было сделать перевод и не переспрашивать: IBAN
// целиком, под ним банк, БИК и КБе. Моноширинный шрифт нарочно - IBAN читают и сверяют по
// знакам, а пропорциональный шрифт для этого плохо приспособлен.
function bankHtml(bank) {
  if (!bank || !bank.iban) return '<span class="meta">не указан</span>';
  const tail = [bank.bankName, bank.bic ? "БИК " + bank.bic : "", bank.kbe ? "КБе " + bank.kbe : ""]
    .filter(Boolean).join(" · ");
  return `<code>${esc(bank.iban)}</code>${tail ? `<div class="meta">${esc(tail)}</div>` : ""}`;
}

function legalHtml(legal) {
  if (!legal) return "не заполнены";
  const form = LEGAL_FORM[legal.form] || legal.form || "";
  const name = String(legal.legalName || "");
  // "ИП Ждущий" already says what it is - no "ИП ИП Ждущий".
  const prefix = form && !name.toUpperCase().startsWith(form.toUpperCase()) ? form + " " : "";
  return `${esc(prefix)}${esc(name)}<div class="meta">${esc(legal.address || "")}</div>`;
}

const FARM_DOC_LABEL = { ses: "СЭС", vet_control: "Ветконтроль", other: "Другой" };
function farmCertsHtml(docs) {
  const line = (kind) => {
    const mine = (docs || []).filter((d) => d.kind === kind);
    const best = mine.find((d) => d.status === "approved") || mine.find((d) => d.status === "pending") || mine[0];
    return `${FARM_DOC_LABEL[kind]}: ${best ? esc((DOC_STATUS[best.status] || [best.status])[0]).toLowerCase() : "нет"}`;
  };
  return `${line("ses")} · ${line("vet_control")}`;
}

function storefrontHtml(sf) {
  if (!sf) return "не заполнена";
  const parts = [
    sf.videoUrl ? "есть видео цеха" : "без видео",
    `${(sf.cutting || []).length} ${pluralRu((sf.cutting || []).length, "платная разделка", "платные разделки", "платных разделок")}`,
    `доставка: ${(sf.delivery || []).length} ${pluralRu((sf.delivery || []).length, "город", "города", "городов")}${sf.pickup ? " + самовывоз" : ""}`,
  ];
  return esc(parts.join(" · "));
}

// Where the IIN came from matters: one on the public profile (written by the apps, or before the
// site moved it) is readable by anyone, and the reviewer should know that.
function iinHtml(privateIin, publicIin) {
  if (privateIin) return esc(privateIin);
  if (publicIin) return `${esc(publicIin)} <span class="meta warn-text">— в открытом профиле</span>`;
  return "не указан";
}

function regionHtml(p) {
  const code = partnerRegion(p);
  if (!code) return "не указан";
  // A region read from the city text is a guess, and is labelled as one.
  return esc(regionName(code)) + (p.regionCode ? "" : ' <span class="meta">— по названию города</span>');
}

function pointHtml(exact) {
  if (!exact) return "не отмечена";
  const lat = Number(exact.lat).toFixed(5), lng = Number(exact.lng).toFixed(5);
  return `${esc(lat)}, ${esc(lng)}
    · <a href="https://www.openstreetmap.org/?mlat=${esc(lat)}&amp;mlon=${esc(lng)}#map=15/${esc(lat)}/${esc(lng)}" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>
    · <a href="https://2gis.kz/geo/${esc(lng)}%2C${esc(lat)}" target="_blank" rel="noopener noreferrer">2ГИС</a>`;
}

// ---- documents --------------------------------------------------------------------------------

function isImage(d) { return String(d.contentType || "").startsWith("image/"); }

// The queue holds two kinds of paperwork under the same "documents" name: certificates on an
// animal (animals/{id}/documents) and the farm's own СЭС / ветконтроль (partners/{id}/documents).
const isFarmDoc = (d) => String(d.path || "").startsWith("partners/");

async function viewDocuments(view) {
  const [docsSnap, partners] = await Promise.all([getDocs(pendingDocumentsQuery()), partnersById()]);
  const docs = docsSnap.docs.map((d) => ({ id: d.id, path: d.ref.path, ...d.data() }));

  // Breed for each animal, fetched once per animal rather than once per document.
  const animalIds = [...new Set(docs.map((d) => d.animalId).filter(Boolean))];
  const animals = new Map(await Promise.all(animalIds.map(async (id) => {
    const s = await getDoc(doc(db, "animals", id));
    return [id, s.exists() ? s.data() : null];
  })));

  view.innerHTML = `
    <h2>Документы на проверке</h2>
    <p class="lede">Ветеринарные документы на скот и сертификаты хозяйств (СЭС, ветконтроль), от старых к
      новым. Файл открывается на отдельном домене хранилища, поэтому даже подложный файл не получит
      доступа к этой странице. Хозяйство получает бейдж «Сертификаты», когда одобрены и СЭС, и ветконтроль.</p>
    ${docs.length ? `<div class="stack">${docs.map((d) => {
      const farm = partners.get(d.partnerId);
      const animal = animals.get(d.animalId);
      const farmDoc = isFarmDoc(d);
      const key = farmDoc ? `farm/${d.partnerId}/${d.id}` : `${d.animalId}/${d.id}`;
      const preview = isImage(d)
        ? `<img class="thumb" src="${esc(d.fileUrl)}" alt="" referrerpolicy="no-referrer">`
        : `<div class="file-glyph">${d.contentType === "application/pdf" ? "PDF" : "DOC"}</div>`;
      const subject = farmDoc
        ? "сертификат хозяйства"
        : `${esc(animal?.breed || "животное")}${animal?.weight ? ` · ${esc(animal.weight)} кг` : ""}`;
      return `
        <div class="card item">
          <div class="item-head">
            ${preview}
            <div class="grow">
              <h3>${esc(d.label || "Документ")}</h3>
              <p class="meta">${esc(d.fileName || "")}</p>
              <p class="meta"><b>${esc(farm?.displayName || "Хозяйство не найдено")}</b> · ${subject}</p>
              <p class="meta">Загружен ${esc(ago(d.uploadedAt))}</p>
            </div>
            <a class="btn" href="${esc(d.fileUrl)}" target="_blank" rel="noopener noreferrer">Открыть файл</a>
          </div>
          ${decisionControls(key)}
        </div>`;
    }).join("")}</div>` : '<div class="card empty">Нет документов на проверке.</div>'}`;

  wireDecisions(view,
    (key, decision, note) => {
      if (key.startsWith("farm/")) {
        const [, partnerId, docId] = key.split("/");
        return call("reviewDocument")({ partnerId, docId, decision, note });
      }
      const [animalId, docId] = key.split("/");
      return call("reviewDocument")({ animalId, docId, decision, note });
    },
    () => viewDocuments(view));
}

// ---- orders -----------------------------------------------------------------------------------

// The steps the farm has taken, the weighing and the payout plan - what staff need to see to help
// either side or to settle a dispute.
function fileLinks(files) {
  return (files || []).map((f, i) => `<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer">${esc(f.kind === "video" ? "видео" : f.kind === "doc" ? "документ" : "фото")} ${i + 1}</a>`).join(", ");
}
function orderStepsHtml(o) {
  const s = o.steps || {};
  const rows = [];
  if (o.acceptedAt) rows.push(["Принят", fmtDate(o.acceptedAt)]);
  if (s.identify) rows.push(["Шаг 1: животное", `${fmtDate(s.identify.at)} · ${fileLinks(s.identify.files)}`]);
  if (s.meat) {
    rows.push(["Шаг 2: мясо", `${fmtDate(s.meat.at)} · ${fileLinks(s.meat.files)}${(s.meat.documents || []).length ? " · документы: " + fileLinks(s.meat.documents) : ""}`]);
    if (o.weighing) {
      const d = Number(o.weighing.difference) || 0;
      rows.push(["Взвешивание", `${esc(o.weighing.weightKg)} кг${o.weighing.meat != null ? ` → итог ${esc(tenge(o.weighing.total))}, ${d > 0 ? "доплата " + esc(tenge(d)) : d < 0 ? "возврат " + esc(tenge(-d)) : "без перерасчёта"}` : ""}`]);
    }
  }
  if (s.shipped) rows.push(["Шаг 3: отправлен", fmtDate(s.shipped.at)]);
  if (s.handover) rows.push(["Шаг 4: передан", `${fmtDate(s.handover.at)}${o.status === "delivered" ? ` · автозавершение ${fmtDate(o.autoCompleteAt)}` : ""}`]);
  if (o.completedAt) rows.push(["Завершён", `${fmtDate(o.completedAt)} · ${esc(COMPLETED_BY[o.completedBy] || o.completedBy || "")}`]);
  if (o.payouts) {
    const p = o.payouts;
    rows.push(["Выплаты", `доля фермера ${esc(tenge(p.net))}: аванс ${esc(tenge(p.advance?.amount))} (${esc(PAYOUT_STATE[p.advance?.status] || "")}),
      25 % ${esc(tenge(p.meat?.amount))} (${esc(PAYOUT_STATE[p.meat?.status] || "")}), 25 % ${esc(tenge(p.final?.amount))} (${esc(PAYOUT_STATE[p.final?.status] || "")})`]);
  }
  return rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
}

async function viewOrders(view) {
  const [ordersSnap, partners] = await Promise.all([
    getDocs(query(collection(db, "orders"), orderBy("createdAt", "desc"), limit(200))),
    partnersById(),
  ]);
  const orders = ordersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  view.innerHTML = `
    <h2>Заказы</h2>
    <p class="lede">Последние 200. Поиск по телефону, номеру заказа или названию лота.</p>
    <input type="search" id="q" placeholder="Телефон, номер заказа, лот…">
    <div class="card" style="margin-top:12px"><table class="list">
      <thead><tr><th>Когда</th><th>Лот</th><th>Покупатель</th><th>Хозяйство</th><th>Сумма</th><th>Статус</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <div id="detail"></div>`;

  const rows = view.querySelector("#rows");
  const paint = (term) => {
    const t = term.trim().toLowerCase();
    const hit = (o) => !t || [o.id, o.buyerPhone, o.contactPhone, o.lotTitle].some((v) => String(v || "").toLowerCase().includes(t));
    const list = orders.filter(hit);
    rows.innerHTML = list.length ? list.map((o) => `
      <tr class="clickable" data-order="${esc(o.id)}">
        <td data-label="Когда">${esc(fmtDate(o.createdAt))}</td>
        <td data-label="Лот">${esc(o.lotTitle || "—")}</td>
        <td data-label="Покупатель">${esc(o.contactPhone || o.buyerPhone || "—")}</td>
        <td data-label="Хозяйство">${esc(partners.get(o.partnerId)?.displayName || "—")}</td>
        <td data-label="Сумма">${esc(orderWhat(o))} · ${esc(tenge(o.amount))}</td>
        <td data-label="Статус">${chip(ORDER_STATUS, o.status)}</td>
      </tr>`).join("") : '<tr><td colspan="6" class="empty">Ничего не найдено.</td></tr>';
  };
  paint("");
  view.querySelector("#q").addEventListener("input", (e) => paint(e.target.value));

  rows.addEventListener("click", (e) => {
    const tr = e.target.closest("[data-order]");
    if (!tr) return;
    const o = orders.find((x) => x.id === tr.dataset.order);
    const pay = o.payment || {};
    view.querySelector("#detail").innerHTML = `
      <div class="card item" style="margin-top:16px">
        <div class="item-head">
          <div class="grow">
            <h3>Заказ ${esc(o.id)}</h3>
            <p class="meta">${esc(o.lotTitle || "")} · ${esc(partners.get(o.partnerId)?.displayName || "")}</p>
          </div>
          ${chip(ORDER_STATUS, o.status)}
        </div>
        <dl class="kv">
          <dt>Покупатель</dt><dd>${esc(o.contactPhone || o.buyerPhone || "—")}</dd>
          <dt>Заказ</dt><dd>${esc(orderWhat(o))}</dd>
          ${o.pricing ? `
            <dt>Сумма</dt><dd>мясо ${esc(tenge(o.pricing.meat))}${o.pricePerKg ? ` (${esc(tenge(o.pricePerKg))}/кг)` : ""}
              + разделка ${esc(tenge(o.pricing.cutting))} + доставка ${esc(tenge(o.pricing.delivery))} = <b>${esc(tenge(o.amount))}</b></dd>
            <dt>Разделка</dt><dd>${esc(o.cutting?.name || "стандартная")}</dd>
            <dt>Доставка</dt><dd>${esc(o.delivery?.mode === "pickup" ? "самовывоз" : o.delivery?.mode === "city" ? o.delivery.city : "по договорённости")}</dd>
            <dt>Желаемая дата</dt><dd>${esc(o.deliveryDate ? o.deliveryDate.split("-").reverse().join(".") : "—")}${o.deliverySlot ? ", " + esc(SLOT_LABEL[o.deliverySlot] || o.deliverySlot) : ""}</dd>`
          : `<dt>Доли</dt><dd>${esc(o.shares)} × ${esc(tenge(o.pricePerShare))} = ${esc(tenge(o.amount))}</dd>`}
          <dt>Адрес</dt><dd>${esc(o.delivery?.mode === "pickup" ? "самовывоз из хаба" : (o.deliveryAddress || "—"))}</dd>
          ${o.group ? `<dt>Совместная покупка</dt><dd>${esc(o.group.size)} ${esc(pluralRu(o.group.size, "участник", "участника", "участников"))}:
            ${(o.group.members || []).map((m) => `${esc(m.name || "участник")} — ${esc(tenge(m.amount))}`).join("; ")}</dd>` : ""}
          ${orderStepsHtml(o)}
          <dt>Оплата</dt><dd>${esc(pay.status === "not_required" ? "не через платформу (пилот)" : (pay.status || "—"))}</dd>
          <dt>Создан</dt><dd>${esc(fmtDate(o.createdAt))}</dd>
          ${o.cancelledBy ? `<dt>Отменил</dt><dd>${esc(o.cancelledBy === "partner" ? "фермер" : "покупатель")}</dd>` : ""}
        </dl>
        ${Array.isArray(o.statusHistory) && o.statusHistory.length ? `
          <p class="meta" style="margin-top:14px"><b>История</b></p>
          <ul class="timeline">${o.statusHistory.map((h) => `
            <li>${esc((ORDER_STATUS[h.status] || [h.status])[0])} — ${esc(fmtDate(h.at))}</li>`).join("")}
          </ul>` : ""}
      </div>`;
    view.querySelector("#detail").scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

// ---- disputes ---------------------------------------------------------------------------------

// Everything the team needs to settle one case: what the buyer says, their evidence, their order
// for that lot and how to reach both sides. Refunds happen outside the platform for now, so the
// decision recorded here is also the buyer's receipt of what was done.
// ---- reviews ---------------------------------------------------------------------------------
// A review belongs to a completed order and only its buyer can write it (submitReview), so what
// is decided here is whether it goes on the farm's page - and with it, the farm's rating, which
// moderateReview recomputes from everything published.

const REVIEW_STATUS = {
  pending: ["На проверке", "pending"],
  published: ["Опубликован", "ok"],
  rejected: ["Отклонён", "bad"],
};

const stars = (n) => "★".repeat(Number(n) || 0) + "☆".repeat(Math.max(0, 5 - (Number(n) || 0)));

function reviewCard(r, farm) {
  const id = esc(r.id);
  const decided = r.status !== "pending";
  return `
    <div class="card item">
      <div class="item-head">
        <div class="grow">
          <h3>${esc(stars(r.rating))} <span class="meta">${esc(farm?.displayName || r.partnerId || "")}</span></h3>
          <p class="meta">${esc(r.buyerName || "Покупатель")} · ${esc(ago(r.createdAt))} · ${esc(fmtDate(r.createdAt))}</p>
        </div>
        ${chip(REVIEW_STATUS, r.status || "pending")}
      </div>
      ${r.text ? `<div class="claim">${esc(r.text)}</div>` : '<p class="meta">Без комментария.</p>'}
      <dl class="kv">
        <dt>Лот</dt><dd>${esc(r.lotTitle || "—")}</dd>
        <dt>Заказ</dt><dd>${esc(r.orderId || "—")}</dd>
        ${r.moderationNote ? `<dt>Причина отказа</dt><dd>${esc(r.moderationNote)}</dd>` : ""}
      </dl>
      ${decided || !can("moderate") ? "" : decisionControls(r.id, "покупатель")}
    </div>`;
}

async function viewReviews(view) {
  const [snap, partners] = await Promise.all([
    getDocs(query(collection(db, "reviews"), orderBy("createdAt", "desc"), limit(200))),
    partnersById(),
  ]);
  const reviews = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const pending = reviews.filter((r) => (r.status || "pending") === "pending");
  const decided = reviews.filter((r) => (r.status || "pending") !== "pending");

  view.innerHTML = `
    <h2>Отзывы</h2>
    <p class="lede">Оценки покупателей о хозяйствах. Отзыв можно оставить только по завершённой сделке.
      Публикация меняет рейтинг хозяйства — он считается по опубликованным отзывам.</p>
    ${pending.length
      ? `<div class="stack">${pending.map((r) => reviewCard(r, partners.get(r.partnerId))).join("")}</div>`
      : '<div class="card empty">Новых отзывов нет.</div>'}
    ${decided.length
      ? `<h2 style="margin-top:28px">Рассмотренные</h2><div class="stack">${decided.map((r) => reviewCard(r, partners.get(r.partnerId))).join("")}</div>`
      : ""}`;

  wireDecisions(view,
    (reviewId, decision, note) => call("moderateReview")({ reviewId, decision, note }),
    () => viewReviews(view),
    "Опишите причину — её увидит покупатель на странице своего заказа.");
}

function disputeCard(d, ctx) {
  const id = esc(d.id);
  const status = d.status || "new";
  const firstOrder = ctx.orders[0] || {};
  const buyerPhone = ctx.client?.phone || firstOrder.contactPhone || firstOrder.buyerPhone || "—";
  const lotName = ctx.lot?.name || firstOrder.lotTitle || "лот не найден";
  const orders = ctx.orders.length
    ? ctx.orders.map((o) => `${esc(orderWhat(o))}`
        + ` · ${esc(tenge(o.amount))} · ${esc((ORDER_STATUS[o.status] || [o.status || "—"])[0])}`).join("<br>")
    : "не найден — возможно, покупка из приложения";
  const evidence = d.mediaUrl
    ? `<a href="${esc(d.mediaUrl)}" target="_blank" rel="noopener noreferrer">Открыть фото или видео</a>`
    : "не приложено";
  const resolution = d.resolution ? `
    <div class="resolution">
      <b>${esc(DISPUTE_OUTCOME[d.resolution.outcome] || d.resolution.outcome)}</b>
      <span class="meta"> · ${esc(fmtDate(d.resolution.decidedAt))}</span>
      <div>${esc(d.resolution.note || "")}</div>
    </div>` : "";
  const controls = status === "resolved" || !can("orders.act") ? "" : `
    <div class="actions">
      ${status === "new" ? `<button class="btn" data-take="${id}">Взять в работу</button>` : ""}
      <button class="btn primary" data-resolve-open="${id}">Закрыть спор…</button>
    </div>
    <div class="resolve-box" data-resolve-box="${id}" hidden>
      <label for="outcome-${id}">Решение</label>
      <select id="outcome-${id}" data-outcome="${id}">
        ${Object.entries(DISPUTE_OUTCOME).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}
      </select>
      <label for="note-${id}">Что сделали — это увидит покупатель на странице заказа</label>
      <textarea id="note-${id}" data-note="${id}" maxlength="1000" placeholder="Например: вернули 50 000 ₸ на карту покупателя 22.09"></textarea>
      <div class="actions">
        <button class="btn primary" data-resolve="${id}">Закрыть спор</button>
        <button class="btn" data-resolve-cancel="${id}">Отмена</button>
      </div>
    </div>
    <p class="error" data-error="${id}" hidden></p>`;

  return `
    <div class="card item">
      <div class="item-head">
        <div class="grow">
          <h3>«${esc(lotName)}»</h3>
          <p class="meta">Подан ${esc(ago(d.createdAt))} · ${esc(fmtDate(d.createdAt))}</p>
        </div>
        ${chip(DISPUTE_STATUS, status)}
      </div>
      <div class="claim">${esc(d.description || "")}</div>
      <dl class="kv">
        <dt>Покупатель</dt><dd>${esc(buyerPhone)}${ctx.client?.displayName ? " · " + esc(ctx.client.displayName) : ""}</dd>
        <dt>Хозяйство</dt><dd>${esc(ctx.farm?.displayName || "—")}${ctx.farm?.phone ? " · " + esc(ctx.farm.phone) : ""}</dd>
        <dt>Заказ</dt><dd>${orders}</dd>
        <dt>Доказательство</dt><dd>${evidence}</dd>
      </dl>
      ${resolution}
      ${controls}
    </div>`;
}

async function viewDisputes(view) {
  const [snap, partners] = await Promise.all([
    getDocs(query(collection(db, "disputes"), orderBy("createdAt", "desc"), limit(200))),
    partnersById(),
  ]);
  const disputes = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // One failed lookup must not blank the whole queue - the claim itself is what matters.
  const quietly = (promise) => promise.catch((e) => { console.error(e); return null; });
  const context = new Map(await Promise.all(disputes.map(async (d) => {
    // A dispute opened from an order names it; an older one only its lot, so the buyer's orders
    // for that lot stand in.
    const [lotSnap, orderSnaps, clientSnap] = await Promise.all([
      d.lotId ? quietly(getDoc(doc(db, "lots", d.lotId))) : null,
      d.orderId
        ? quietly(getDoc(doc(db, "orders", d.orderId))).then((s) => (s && s.exists() ? [s] : []))
        : d.lotId && d.uid
          ? quietly(getDocs(query(collection(db, "orders"), where("lotId", "==", d.lotId), where("buyerUid", "==", d.uid)))).then((s) => (s ? s.docs : []))
          : Promise.resolve([]),
      d.uid ? quietly(getDoc(doc(db, "clients", d.uid))) : null,
    ]);
    const lot = lotSnap && lotSnap.exists() ? lotSnap.data() : null;
    const orders = orderSnaps.map((o) => ({ id: o.id, ...o.data() }));
    const client = clientSnap && clientSnap.exists() ? clientSnap.data() : null;
    return [d.id, { lot, orders, client, farm: partners.get(lot?.partnerId || orders[0]?.partnerId) }];
  })));

  const isOpen = (d) => OPEN_DISPUTES.includes(d.status || "new");
  const open = disputes.filter(isOpen);
  const closed = disputes.filter((d) => !isOpen(d));

  view.innerHTML = `
    <h2>Споры</h2>
    <p class="lede">Претензии покупателей. Пока деньги по спорам возвращаются вручную: здесь записывается,
      кто взял спор, что решили и почему. Решение и комментарий увидит покупатель на странице заказа.</p>
    ${open.length
      ? `<div class="stack">${open.map((d) => disputeCard(d, context.get(d.id))).join("")}</div>`
      : '<div class="card empty">Открытых споров нет.</div>'}
    ${closed.length
      ? `<h2 style="margin-top:28px">Закрытые</h2><div class="stack">${closed.map((d) => disputeCard(d, context.get(d.id))).join("")}</div>`
      : ""}`;

  view.onclick = async (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    const id = t.dataset.take || t.dataset.resolve || t.dataset.resolveOpen || t.dataset.resolveCancel;
    if (!id) return;
    const box = view.querySelector(`[data-resolve-box="${CSS.escape(id)}"]`);
    const err = view.querySelector(`[data-error="${CSS.escape(id)}"]`);
    const showErr = (m) => { if (err) { err.textContent = m; err.hidden = !m; } };

    if (t.dataset.resolveOpen) { box.hidden = false; box.querySelector("textarea").focus(); return; }
    if (t.dataset.resolveCancel) { box.hidden = true; showErr(""); return; }

    const data = { disputeId: id, action: t.dataset.take ? "take" : "resolve" };
    if (data.action === "resolve") {
      data.outcome = view.querySelector(`[data-outcome="${CSS.escape(id)}"]`).value;
      data.note = view.querySelector(`[data-note="${CSS.escape(id)}"]`).value.trim();
      if (data.note.length < 5) return showErr("Опишите, что сделали, — это увидит покупатель.");
    }
    t.disabled = true;
    showErr("");
    try {
      await call("reviewDispute")(data);
      await refreshBadges();
      await viewDisputes(view);
    } catch (e) {
      console.error(e);
      showErr(describeError(e));
      t.disabled = false;
    }
  };
}

// ---- journal ----------------------------------------------------------------------------------

async function viewJournal(view) {
  const snap = await getDocs(query(collection(db, "adminActions"), orderBy("at", "desc"), limit(200)));
  const entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // Status CODES mean nothing to the people this journal is for; show what they mean.
  const STATUS_MAPS = { partner: PARTNER_STATUS, document: DOC_STATUS, dispute: DISPUTE_STATUS };
  const statusLabel = (e, s) => ((STATUS_MAPS[e.targetType] || {})[s] || [s || "—"])[0];
  const describe = (e) => {
    const b = e.before || {}, a = e.after || {};
    if (e.targetType === "staff") return `${a.phone || b.phone || ""}: ${ROLE_LABEL[b.role] || "без роли"} → ${ROLE_LABEL[a.role] || "без роли"}`;
    const outcome = a.outcome ? ` · ${DISPUTE_OUTCOME[a.outcome] || a.outcome}` : "";
    return `${statusLabel(e, b.status)} → ${statusLabel(e, a.status)}${outcome}`;
  };

  view.innerHTML = `
    <h2>Журнал</h2>
    <p class="lede">Каждое действие сотрудников. Записи нельзя изменить или удалить — даже администратору.</p>
    ${entries.length ? `<div class="card"><table class="list">
      <thead><tr><th>Когда</th><th>Кто</th><th>Действие</th><th>Что изменилось</th><th>Причина</th></tr></thead>
      <tbody>${entries.map((e) => `<tr>
        <td data-label="Когда">${esc(fmtDate(e.at))}</td>
        <td data-label="Кто">${esc(e.actorPhone || "—")}<div class="meta">${esc(ROLE_LABEL[e.actorRole] || e.actorRole || "")}</div></td>
        <td data-label="Действие">${esc(ACTION_LABEL[e.action] || e.action)}</td>
        <td data-label="Что изменилось">${esc(describe(e))}</td>
        <td data-label="Причина">${esc(e.note || "—")}</td>
      </tr>`).join("")}</tbody></table></div>` : '<div class="card empty">Действий пока не было.</div>'}`;
}

// ---- team -------------------------------------------------------------------------------------

async function viewTeam(view) {
  const snap = await getDocs(collection(db, "staff"));
  const staff = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  view.innerHTML = `
    <h2>Команда</h2>
    <p class="lede">Сотрудники с доступом к панели. Отзыв действует сразу, без ожидания.</p>
    <div class="card"><table class="list">
      <thead><tr><th>Телефон</th><th>Роль</th><th>С какого момента</th><th></th></tr></thead>
      <tbody>${staff.map((s) => `<tr>
        <td data-label="Телефон">${esc(s.phone || "—")}${s.id === me.uid ? ' <span class="chip muted">вы</span>' : ""}</td>
        <td data-label="Роль">${esc(ROLE_LABEL[s.role] || s.role)}</td>
        <td data-label="С какого момента">${esc(fmtDate(s.grantedAt))}</td>
        <td>${s.id === me.uid ? "" : `<button class="btn danger" data-revoke="${esc(s.phone)}">Отозвать</button>`}</td>
      </tr>`).join("")}</tbody></table></div>

    <h2 style="margin-top:28px">Добавить сотрудника</h2>
    <p class="lede">Человек должен хотя бы раз войти на сайт или в приложение со своим номером —
      роль привязывается к существующему аккаунту.</p>
    <div class="card item">
      <div class="field"><label for="g-phone">Телефон</label>
        <input id="g-phone" type="tel" placeholder="+7 700 000 00 00"></div>
      <div class="field" style="margin-top:10px"><label for="g-role">Роль</label>
        <select id="g-role">
          <option value="support">Поддержка — смотрит площадку и помогает с заказами</option>
          <option value="admin">Администратор — всё, включая одобрение и команду</option>
        </select></div>
      <div class="actions"><button class="btn primary" id="grant">Выдать доступ</button></div>
      <p class="error" id="team-err" hidden></p>
    </div>`;

  const err = view.querySelector("#team-err");
  const showErr = (m) => { err.textContent = m; err.hidden = !m; };

  view.querySelector("#grant").addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    const phone = normalisePhone(view.querySelector("#g-phone").value);
    const role = view.querySelector("#g-role").value;
    if (!/^\+\d{10,15}$/.test(phone)) return showErr("Введите номер полностью.");
    btn.disabled = true;
    showErr("");
    try {
      await call("grantStaffRole")({ phone, role });
      await viewTeam(view);
    } catch (e) {
      console.error(e);
      showErr(describeError(e));
      btn.disabled = false;
    }
  });

  view.querySelectorAll("[data-revoke]").forEach((btn) => btn.addEventListener("click", async () => {
    if (!window.confirm(`Отозвать доступ у ${btn.dataset.revoke}? Он пропадёт сразу.`)) return;
    btn.disabled = true;
    showErr("");
    try {
      await call("revokeStaffRole")({ phone: btn.dataset.revoke });
      await viewTeam(view);
    } catch (e) {
      console.error(e);
      showErr(describeError(e));
      btn.disabled = false;
    }
  }));
}
