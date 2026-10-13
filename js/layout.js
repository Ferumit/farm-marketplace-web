import { icon } from "./icons.js";
import { authReady, isRealUser } from "./firebase-init.js";
import { getMyProfile } from "./auth.js";
import { escapeHtml } from "./data.js";
import { mountNotifications } from "./notifications.js";
import { mountCartButton } from "./cart.js";

const NAV_LINKS = [
  { href: "/lots", label: "Лоты" },
  { href: "/farmers", label: "Фермеры" },
  { href: "/#how-it-works", label: "Совместная покупка" },
  // Отдельная страница, а не якорь: сюда приходят с вопросом «сколько это стоит», и ответ
  // должен открываться по своей ссылке, которую можно переслать.
  { href: "/how-it-works", label: "Цены и условия" },
  { href: "/#trust", label: "Гарантии" },
  // Оферта в меню, а не только в подвале. Она и так стояла внизу каждой страницы, но проверяющий
  // эквайера до подвала не долистал и написал, что договора на сайте нет. Документ, который ищут
  // снаружи, должен открываться с первого экрана.
  { href: "/offer", label: "Оферта" },
];

// Prefix match on the whole path, not the last segment: a lot page is /lots/{id}, so taking
// the last segment would compare the document id against "/lots" and leave the nav dead on
// every detail page. The trailing-slash check keeps /lots from lighting up on /lots-archive.
function isActiveNav(href) {
  if (href.startsWith("/#")) return false; // anchors on the home page are never a section
  const path = window.location.pathname.replace(/\/$/, "") || "/";
  return path === href || path.startsWith(href + "/");
}

function headerHtml() {

  const links = NAV_LINKS.map((l) => {
    const active = isActiveNav(l.href) ? " style=\"color:var(--ink)\"" : "";
    return `<a href="${l.href}"${active}>${l.label}</a>`;
  }).join("");

  return `
    <div class="container" style="position:relative;">
      <a class="brand" href="/">
        <img src="/assets/icon.png" alt="ET">
        <span class="brand-word" aria-hidden="true">ET</span>
      </a>
      <nav class="nav-links">${links}</nav>
      <div class="nav-right">
        <button class="mobile-menu-btn" type="button" id="mobile-menu-btn" aria-label="Меню" aria-expanded="false">${icon("menu", { size: 20 })}</button>
        <!-- Переключатель языков снят до появления казахского. Неактивная кнопка «ҚАЗ» — первое,
             во что упирается проверяющий, и выглядит она как незаконченный сайт; одинокая «РУС»
             рядом с ней не лучше. Вернуть обе разом, когда будет что переключать. -->
        <button class="icon-btn" type="button" id="theme-btn" aria-label="Переключить тему"></button>
        <button class="icon-btn" type="button" id="search-btn" aria-label="Поиск">${icon("search", { size: 18 })}</button>
        <a class="btn-pill btn-ghost btn-sm nav-orders" href="/orders">Заказы</a>
        <span id="cart-slot"></span>
        <span id="notif-slot"></span>
        <span id="auth-slot"><a class="btn-pill btn-ghost btn-sm" href="/login">Войти</a></span>
      </div>
      <form class="search-panel" id="search-panel" hidden action="/lots" method="get">
        <input type="search" name="q" id="search-input" placeholder="Название лота, порода или хозяйство" aria-label="Поиск по лотам">
        <button class="btn-pill btn-primary btn-sm" type="submit">Найти</button>
      </form>
      <nav class="mobile-nav-panel" id="mobile-nav-panel" hidden>
        ${links}
        <a href="/cart">Корзина</a>
        <a href="/orders">Мои заказы</a>
      </nav>
    </div>`;
}

// The <head> of every page sets data-theme from localStorage before first paint; with nothing
// stored the attribute is absent and the system preference applies via the media query.
function activeTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "dark" || explicit === "light") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function wireThemeToggle() {
  const btn = document.getElementById("theme-btn");
  if (!btn) return;
  const paint = () => {
    const dark = activeTheme() === "dark";
    btn.innerHTML = icon(dark ? "sun" : "moon", { size: 18 });
    btn.title = dark ? "Светлая тема" : "Тёмная тема";
  };
  paint();
  btn.addEventListener("click", () => {
    const next = activeTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("et-theme", next); } catch (e) { /* private mode - theme just won't persist */ }
    paint();
  });
  // Follow the OS while the visitor hasn't picked a theme by hand.
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!document.documentElement.getAttribute("data-theme")) paint();
  });
}

// Reveal-on-scroll for any .section/.section-tight that isn't already on screen at load.
function wireReveal() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const targets = document.querySelectorAll(".section, .section-tight");
  if (!targets.length || !("IntersectionObserver" in window)) return;

  const armed = [];
  const show = (el) => { el.classList.add("in-view"); };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        show(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { rootMargin: "0px 0px -10% 0px" });

  targets.forEach((el) => {
    // Anything already on screen at load shouldn't start hidden and fade in late.
    if (el.getBoundingClientRect().top < window.innerHeight) return;
    el.classList.add("reveal-armed");
    armed.push(el);
    observer.observe(el);
  });

  // Safety net: a background tab or a browser that doesn't run the observer must never leave
  // content stuck invisible. After 2s, show whatever is still hidden regardless.
  if (armed.length) {
    setTimeout(() => armed.forEach(show), 2000);
  }
}

// The magnifier used to just link to the farmer catalogue. Now it opens a real search box that
// submits into /lots?q=..., which pre-fills the lot filters there.
function wireSearch() {
  const btn = document.getElementById("search-btn");
  const panel = document.getElementById("search-panel");
  const input = document.getElementById("search-input");
  if (!btn || !panel) return;

  btn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) input.focus();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") panel.hidden = true;
  });
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) panel.hidden = true;
  });
}

function wireMobileMenu() {
  const btn = document.getElementById("mobile-menu-btn");
  const panel = document.getElementById("mobile-nav-panel");
  if (!btn || !panel) return;
  const close = () => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); };
  btn.addEventListener("click", () => {
    const willOpen = panel.hidden;
    panel.hidden = !willOpen;
    btn.setAttribute("aria-expanded", String(willOpen));
  });
  panel.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
  document.addEventListener("click", (e) => {
    if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) close();
  });
}

// The header already carries the site navigation, so the footer does not repeat it: it says
// what ET is and holds the legal documents, grouped by the app they belong to.
//
// The site's own documents come first and open in the same tab: the offer, the payment rules and
// the privacy policy are the terms of the purchase made HERE, and the acquirer checks that they
// are reachable from every page. The app store documents live on another domain and open in a new
// tab, as before.
function footerHtml() {
  const year = new Date().getFullYear();
  const doc = (href, label) => `<a href="${href}" target="_blank" rel="noopener">${label}</a>`;
  // Страницы самого сайта откроются в той же вкладке — это условия покупки, сделанной ЗДЕСЬ.
  const page = (href, label) => `<a href="${href}">${label}</a>`;
  return `
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a class="brand" href="/"><img src="/assets/icon.png" alt="" width="34" height="34">ET</a>
          <p>Мясо со степи до твоего стола. Говядина и конина напрямую от проверенных фермерских хозяйств Казахстана — целиком или вместе с друзьями.</p>
          <!-- Чем и как платят — то, что эквайер ищет в подвале в первую очередь, а покупатель
               читает перед тем, как ввести карту. Данные карты вводятся на странице Freedom Pay
               и до наших серверов не доходят — об этом стоит сказать там же, где о картах. -->
          <p class="footer-pay">Оплата картами Visa и Mastercard через Freedom Pay.
            Данные карты вводятся на защищённой странице платёжного сервиса и на серверы ET
            не передаются.</p>
          <p class="footer-pay">${page("/how-it-works", "Цены и условия")} · ${page("/contacts", "Контакты")}</p>
          <p class="footer-pay">ТОО «Компания» · БИН 000000000000<br>
            +7 700 000 00 00 · support@example.kz</p>
        </div>
        <!-- Покупка на самом сайте: оферта, правила оплаты и возврата, политика сайта. Именно
             эти три страницы ищет эквайер, и ищет он их в подвале. -->
        <nav class="footer-col" aria-label="Покупка на example.kz">
          <p class="footer-title">Покупка на сайте</p>
          ${page("/offer", "Публичная оферта")}
          ${page("/payment-refund", "Оплата и возврат")}
          ${page("/privacy", "Политика конфиденциальности")}
        </nav>
        <nav class="footer-col" aria-label="Документы ET">
          <p class="footer-title">ET — покупателям</p>
          ${doc("https://example.kz/legal/privacy-et-client", "Политика конфиденциальности")}
          ${doc("https://example.kz/legal/terms-et-client", "Условия использования")}
          ${doc("https://example.kz/legal/delete-account-et", "Удаление аккаунта")}
        </nav>
        <nav class="footer-col" aria-label="Документы ET Partners">
          <p class="footer-title">ET Partners — фермерам</p>
          ${doc("https://example.kz/legal/privacy-et-partners", "Политика конфиденциальности")}
          ${doc("https://example.kz/legal/terms-et-partners", "Условия использования")}
          ${doc("https://example.kz/legal/delete-account-et-partners", "Удаление аккаунта")}
        </nav>
      </div>
      <div class="footer-bottom">© ${year} ET Ecosystem</div>
    </div>`;
}

async function renderAuthSlot() {
  const slot = document.getElementById("auth-slot");
  if (!slot) return;
  const user = await authReady;
  if (isRealUser(user)) {
    let initial = "?";
    try {
      const profile = await getMyProfile(user.uid);
      initial = (profile && profile.displayName || "?").trim().charAt(0).toUpperCase() || "?";
    } catch (e) { /* profile lookup best-effort for the avatar initial only */ }
    slot.innerHTML = `<a class="avatar-btn" href="/profile" title="Профиль">${escapeHtml(initial)}</a>`;
  } else {
    slot.innerHTML = `<a class="btn-pill btn-ghost btn-sm" href="/login">Войти</a>`;
  }
}

export function mountLayout() {
  const headerMount = document.getElementById("site-header");
  const footerMount = document.getElementById("site-footer");
  if (headerMount) {
    headerMount.className = "site-header";
    headerMount.innerHTML = headerHtml();
    renderAuthSlot();
    mountNotifications();
    mountCartButton();
    wireMobileMenu();
    wireSearch();
    wireThemeToggle();
    wireReveal();
  }
  if (footerMount) {
    footerMount.className = "site-footer";
    footerMount.innerHTML = footerHtml();
  }
}

document.addEventListener("DOMContentLoaded", mountLayout);
