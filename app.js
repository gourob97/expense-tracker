import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence,
  collection, doc, addDoc, deleteDoc, setDoc, onSnapshot, query, where, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { STRINGS, CAT_BN } from "./i18n.js";

// ===== FIREBASE WEB CONFIG =====
const firebaseConfig = {
  apiKey: "AIzaSyCxGxl9MB56Hukv5qij_t-jbtdrdVoNacs",
  authDomain: "personal-expense-tracker-d2914.firebaseapp.com",
  projectId: "personal-expense-tracker-d2914",
  appId: "1:642059260081:web:0e3f0055881797852ad290"
};
// ===============================

const DEFAULT_CATEGORIES = ["Food", "Transport", "Bills", "Rent", "Shopping", "Health", "Entertainment", "Other"];
const TABS = ["expenses", "income", "planned", "budgets"];
const NEAR_LIMIT = 0.9;

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoOf(new Date());
const parseISO = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const sum = arr => arr.reduce((s, x) => s + Number(x.amount || 0), 0);

// ----- Icons (static, trusted markup) -----
const ICONS = {
  food: '<path d="M7 3v18"/><path d="M4 3v5a3 3 0 0 0 6 0V3"/><path d="M18 21V3c-2.5 0-4 2.5-4 6s1.5 4 4 4"/>',
  transport: '<rect x="4" y="3" width="16" height="14" rx="3"/><path d="M4 11h16"/><path d="M8 21v-4"/><path d="M16 21v-4"/>',
  bills: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  rent: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  shopping: '<path d="M5 8h14l-1 13H6z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  health: '<path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z"/>',
  fun: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
  other: '<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/>',
  income: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h16"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  more: '<circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v4"/><path d="M12 17.5v.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>',
  logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>'
};
function svg(name, size = 20) {
  const tpl = document.createElement("template");
  tpl.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.tag}</svg>`;
  return tpl.content.firstElementChild;
}

// Small element builder. Text always goes through textContent, never HTML.
function h(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  n.append(...children.flat(2).filter(c => c != null && c !== false));
  return n;
}

// ----- Categories: built-ins get a fixed tone and icon; custom ones get a stable tone from their name -----
const CAT_STYLE = { Food: [0, "food"], Transport: [1, "transport"], Bills: [2, "bills"], Rent: [3, "rent"], Shopping: [4, "shopping"], Health: [5, "health"], Entertainment: [6, "fun"], Other: [7, "other"] };
const hashStr = s => [...String(s)].reduce((acc, ch) => (acc * 31 + ch.codePointAt(0)) >>> 0, 7);
const catStyle = c => CAT_STYLE[c] ? { tone: CAT_STYLE[c][0], icon: CAT_STYLE[c][1] } : { tone: hashStr(c) % 8, icon: "tag" };
const catIcon = (c, cls = "") => { const s = catStyle(c); return h("span", { class: `cat-icon tone-${s.tone} ${cls}` }, svg(s.icon, cls ? 18 : 20)); };

// ----- Language & formatting -----
const LOCALES = { en: "en-IN", bn: "bn-BD" };
let lang = "en";
let numFmt, intFmt, plainFmt, dateFmt, weekdayFmt, compactFmt;

function t(key, vars) {
  let s = STRINGS[lang]?.[key] ?? STRINGS.en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return s;
}
function setFormatters() {
  const loc = LOCALES[lang];
  numFmt = new Intl.NumberFormat(loc, { maximumFractionDigits: 2 });
  intFmt = new Intl.NumberFormat(loc, { useGrouping: false });
  plainFmt = new Intl.NumberFormat(loc, { useGrouping: false, maximumFractionDigits: 2 });
  dateFmt = new Intl.DateTimeFormat(loc, { day: "numeric", month: "short" });
  weekdayFmt = new Intl.DateTimeFormat(loc, { weekday: "short", day: "numeric", month: "short" });
  compactFmt = new Intl.NumberFormat(loc, { notation: "compact", maximumFractionDigits: 1 });
}
setFormatters();
const catLabel = c => (lang === "bn" && CAT_BN[c]) || c;
const fmtInt = n => intFmt.format(n);
// Budget field text in the active language's digits; parseNum reads both
const budgetText = c => (budgets[c] == null ? "" : plainFmt.format(budgets[c]));
const fmt = n => "৳" + numFmt.format(Number(n || 0));
const signed = n => (n < 0 ? "−" : "") + fmt(Math.abs(n));
const fmtDate = iso => dateFmt.format(parseISO(iso));
const monthName = ym => { const [y, m] = ym.split("-").map(Number); return new Date(y, m - 1, 1).toLocaleString(LOCALES[lang], { month: "long", year: "numeric" }); };
function dayLabel(iso) {
  const today = new Date(); const yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (iso === isoOf(today)) return `${t("today")} · ${fmtDate(iso)}`;
  if (iso === isoOf(yest)) return `${t("yesterday")} · ${fmtDate(iso)}`;
  return weekdayFmt.format(parseISO(iso));
}
// Accepts Latin or Bangla digits, commas and a leading ৳; returns NaN for anything else
const parseNum = str => {
  const s = String(str ?? "").trim().replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d)).replace(/[,\s৳]/g, "");
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
};

// ----- Toast: confirmations auto-hide, errors stay until tapped, optional action (Undo) -----
let toastTimer;
function toast(msg, { error = false, actionLabel, onAction } = {}) {
  const el = $("toast"), btn = $("toastAction");
  clearTimeout(toastTimer);
  if (!msg) { el.hidden = true; return; }
  $("toastMsg").textContent = msg;
  el.classList.toggle("error", error);
  btn.hidden = !actionLabel;
  if (actionLabel) { btn.textContent = actionLabel; btn.onclick = () => { toast(""); onAction(); }; }
  el.hidden = false;
  if (!error) toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 6000 : 3500);
}
$("toastMsg").onclick = () => toast("");
const onErr = e => toast(e.message || String(e), { error: true });
// Wrap async actions so errors show in the toast instead of failing silently
const guard = fn => async (...args) => { try { await fn(...args); } catch (e) { onErr(e); } };

// ----- Popover menu (row actions, account) -----
let menuAnchor = null;
function openMenu(anchor, items) {
  const m = $("menu");
  if (menuAnchor === anchor && !m.hidden) { closeMenu(true); return; }
  closeMenu(false);
  m.replaceChildren(...items.map(it => it.header != null
    ? h("div", { class: "menu-header", text: it.header })
    : h("button", { type: "button", role: "menuitem", class: "menu-item" + (it.danger ? " danger" : ""), lang: it.lang,
        onclick: () => { closeMenu(true); it.onSelect(); } }, it.icon ? svg(it.icon, 18) : null, h("span", { text: it.label }))));
  m.hidden = false;
  menuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const r = anchor.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  const left = Math.min(window.innerWidth - mw - 8, Math.max(8, r.right - mw));
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = left + "px";
  m.style.top = top + "px";
  m.querySelector("button")?.focus();
}
function closeMenu(refocus) {
  const m = $("menu");
  if (m.hidden) return;
  m.hidden = true;
  const a = menuAnchor; menuAnchor = null;
  if (a) { a.setAttribute("aria-expanded", "false"); if (refocus && a.isConnected) a.focus({ preventScroll: true }); }
}
document.addEventListener("pointerdown", e => {
  if (!$("menu").hidden && !$("menu").contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu(false);
});
window.addEventListener("resize", () => closeMenu(false));
window.addEventListener("scroll", () => closeMenu(false), { passive: true });
$("menu").addEventListener("keydown", e => {
  const items = [...$("menu").querySelectorAll("button")];
  const i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
  else if (e.key === "Tab") closeMenu(false);
});

// ----- Theme (system default; a manual choice is remembered on this device) -----
const savedTheme = () => { try { return localStorage.getItem("theme"); } catch (e) { return null; } };
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0E1116" : "#F4F4F0";
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("theme", next); } catch (e) {}
  applyTheme(next);
}
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", e => {
  if (!savedTheme()) applyTheme(e.matches ? "light" : "dark");
});

// ----- State -----
let selectedMonth = todayISO().slice(0, 7);
let user = null;
let categories = [...DEFAULT_CATEGORIES];
let expenses = [], income = [], planned = [], budgets = {}, recurring = [], recurringIncome = [];
let unsubs = [], monthUnsubs = [];
let auth, db;
let currentTab = "expenses", filterCat = null, searchQ = "", editingBudgets = false, budgetEditKey = "";
const userDoc = (...path) => doc(db, "users", user.uid, ...path);
const userCol = name => collection(db, "users", user.uid, name);

// ----- Tabs (state lives in the URL hash as #/name so reload and back/forward work) -----
const tabFromHash = () => location.hash.replace(/^#\/?/, "");
const KIND_FOR_TAB = { expenses: "expense", income: "income", planned: "planned", budgets: "expense" };
const ADD_LABEL = { expense: "addExpense", income: "addIncome", planned: "addPlanned" };
const TAB_TITLE = { expenses: "tabExpenses", income: "tabIncome", planned: "tabPlanned", budgets: "tabBudgets" };
function showTab(name) {
  if (!TABS.includes(name)) name = TABS[0];
  currentTab = name;
  document.body.dataset.tab = name;
  document.querySelectorAll(".tab-panel").forEach(p => { p.hidden = p.dataset.panel !== name; });
  document.querySelectorAll(".nav-item").forEach(a => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("pageTitle").textContent = t(TAB_TITLE[name]);
  $("addBtnLabel").textContent = t(ADD_LABEL[KIND_FOR_TAB[name]]);
  return name;
}
window.addEventListener("hashchange", () => {
  showTab(tabFromHash());
  if (window.scrollY > 0) window.scrollTo({ top: 0 });
});

// ----- Month switching -----
function setMonth(ym) {
  if (!/^\d{4}-\d{2}$/.test(ym) || ym === selectedMonth) return;
  selectedMonth = ym;
  $("month").value = ym;
  filterCat = null;
  renderAll();
  if (user) subscribeMonth();
}
function shiftMonth(delta) {
  const [y, m] = selectedMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  setMonth(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
}
$("prevMonth").onclick = () => shiftMonth(-1);
$("nextMonth").onclick = () => shiftMonth(1);
$("monthBtn").onclick = () => { try { $("month").showPicker(); } catch (e) { /* type=month unsupported (e.g. desktop Firefox): chevrons still work */ } };
$("month").onchange = e => setMonth(e.target.value);
$("month").value = selectedMonth;

// ----- Account menu -----
function openAccountMenu(anchor) {
  const dark = document.documentElement.dataset.theme === "dark";
  const items = [];
  if (user) items.push({ header: user.email || user.displayName || "" });
  items.push({ icon: dark ? "sun" : "moon", label: t(dark ? "themeToLight" : "themeToDark"), onSelect: toggleTheme });
  items.push({ icon: "globe", label: lang === "en" ? "বাংলা" : "English", lang: lang === "en" ? "bn" : "en", onSelect: toggleLang });
  if (user) items.push({ icon: "logout", label: t("signOut"), onSelect: guard(signOutAndClear) });
  openMenu(anchor, items);
}
// Sign out and wipe this device's offline copy of the data, so the next person on a shared browser can't read it
async function signOutAndClear() {
  await signOut(auth);
  try { await terminate(db); await clearIndexedDbPersistence(db); }
  catch (e) { /* another tab still holds the cache; it is cleared once that tab signs out or closes */ }
  location.reload();
}

// Styled confirm for deletes that are hard to redo by hand. Resolves true only on the confirm button.
function confirmAction(message, yesLabel) {
  const d = $("confirmDialog");
  $("confirmMsg").textContent = message;
  $("confirmYes").textContent = yesLabel;
  return new Promise(resolve => {
    const done = v => { if (d.open) d.close(); resolve(v); };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
    d.oncancel = e => { e.preventDefault(); done(false); };
    d.onclick = e => { if (e.target === d) done(false); };
    d.showModal();
    $("confirmNo").focus();
  });
}

$("accountBtn").onclick = e => openAccountMenu(e.currentTarget);
$("accountBtnSide").onclick = e => openAccountMenu(e.currentTarget);

// ----- Language (remembered on this device) -----
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t("docTitle");
  setFormatters();
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  $("accountBtnSide").setAttribute("aria-label", t("accountMenu"));
  showTab(currentTab);
  setKind(entryKind);
  budgetEditKey = "";
  renderAll();
}
function toggleLang() {
  lang = lang === "en" ? "bn" : "en";
  try { localStorage.setItem("lang", lang); } catch (e) {}
  applyLang();
}

// ----- In-app browsers (Messenger, Facebook, Instagram, Android webviews): Google blocks OAuth there -----
function initInAppNotice() {
  const ua = navigator.userAgent;
  if (!/FBAN|FBAV|FB_IAB|Instagram|Messenger|Line\/|MicroMessenger|; wv\)/.test(ua)) return;
  $("inAppNotice").hidden = false;
  $("copyLinkBtn").onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast(t("linkCopied")); }
    catch (e) { toast(t("copyFailed"), { error: true }); }
  };
  if (/Android/.test(ua)) {
    const b = $("openChromeBtn");
    b.hidden = false;
    b.onclick = () => { location.href = `intent://${location.host}${location.pathname}${location.search}#Intent;scheme=https;package=com.android.chrome;end`; };
  }
}

// ===== Entry sheet (expense / income / planned) =====
let entryKind = "expense";
function setKind(kind) {
  entryKind = kind;
  const radio = document.querySelector(`input[name="kind"][value="${kind}"]`);
  if (radio) radio.checked = true;
  $("eCatField").hidden = kind === "income";
  $("eRepeatRow").hidden = kind === "planned";
  $("eNote").placeholder = t(kind === "income" ? "phSource" : kind === "planned" ? "phWhat" : "phNote");
  $("entrySubmit").textContent = t(ADD_LABEL[kind]);
}
document.querySelectorAll('input[name="kind"]').forEach(r => { r.onchange = () => setKind(r.value); });

function buildCatGrid() {
  const grid = $("eCatGrid");
  const prev = grid.querySelector("input:checked")?.value;
  grid.replaceChildren(...categories.map((c, i) => {
    const s = catStyle(c);
    return h("label", { class: "cat-opt" },
      h("input", { type: "radio", name: "cat", value: c, checked: (prev ? prev === c : i === 0) || null }),
      h("span", { class: "tile" }, h("span", { class: `cat-icon sm tone-${s.tone}` }, svg(s.icon, 18)), h("span", { class: "tile-name", text: catLabel(c) })));
  }));
  if (!grid.querySelector("input:checked")) grid.querySelector("input")?.click();
}
// Default date: today when viewing the current month, otherwise the 1st of the viewed month
const defaultDate = () => (todayISO().startsWith(selectedMonth) ? todayISO() : `${selectedMonth}-01`);

function openEntry(kind = KIND_FOR_TAB[currentTab]) {
  if (!user) return;
  closeMenu(false);
  buildCatGrid();
  setKind(kind);
  $("eAmount").value = "";
  $("eNote").value = "";
  $("eRepeat").checked = false;
  $("eDate").value = defaultDate();
  $("entryDialog").showModal();
  $("eAmount").focus();
}
$("fab").onclick = () => openEntry();
$("addBtn").onclick = () => openEntry();
$("entryCancel").onclick = () => $("entryDialog").close();
// Clicking the dimmed backdrop closes the sheet
$("entryDialog").addEventListener("click", e => { if (e.target === e.currentTarget) e.currentTarget.close(); });
$("entryForm").addEventListener("submit", e => { e.preventDefault(); guard(submitEntry)(); });

let submitting = false;
async function submitEntry() {
  if (submitting) return;
  const amount = parseNum($("eAmount").value);
  if (!(amount > 0)) { toast(t("invalidAmount"), { error: true }); $("eAmount").focus(); return; }
  const date = $("eDate").value;
  if (!date) { $("eDate").focus(); return; }
  const note = $("eNote").value.trim();
  const category = $("eCatGrid").querySelector("input:checked")?.value || categories[0];
  const repeat = entryKind !== "planned" && $("eRepeat").checked;
  submitting = true; $("entrySubmit").disabled = true;
  try {
    let msg;
    if (entryKind === "planned") {
      await addDoc(userCol("planned"), { amount, category, date, note, createdAt: Date.now() });
      msg = t("plannedAdded");
    } else {
      const isIncome = entryKind === "income";
      let recurringId = null;
      // A repeating entry creates its rule first, so this month's entry is linked and "Add all" won't duplicate it
      if (repeat) {
        const day = Number(date.slice(8, 10));
        const rule = isIncome ? { amount, day, note } : { amount, category, day, note };
        recurringId = (await addDoc(userCol(isIncome ? "recurringIncome" : "recurring"), rule)).id;
      }
      const data = { amount, date, note, recurringId, createdAt: Date.now() };
      if (!isIncome) data.category = category;
      await addDoc(userCol(isIncome ? "income" : "expenses"), data);
      msg = t(isIncome ? (repeat ? "incomeAddedRec" : "incomeAdded") : (repeat ? "expenseAddedRec" : "expenseAdded"));
    }
    $("entryDialog").close();
    setMonth(date.slice(0, 7));
    toast(msg);
  } finally {
    submitting = false; $("entrySubmit").disabled = false;
  }
}

// Keyboard: N = new entry, / = search (desktop). Ignored while typing or when a dialog is open.
document.addEventListener("keydown", e => {
  if (!user || e.metaKey || e.ctrlKey || e.altKey || document.querySelector("dialog[open]")) return;
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
  if (e.key === "n" || e.key === "N") { e.preventDefault(); openEntry(); }
  else if (e.key === "/" && $("search").offsetParent) { e.preventDefault(); $("search").focus(); }
});
$("search").addEventListener("input", e => { searchQ = e.target.value.trim().toLowerCase(); renderLists(); });

// ===== Firebase =====
function initLang() {
  let saved = null;
  try { saved = localStorage.getItem("lang"); } catch (e) {}
  lang = saved === "bn" || saved === "en" ? saved : (/^bn\b/i.test(navigator.language || "") ? "bn" : "en");
  applyLang();
}

function init() {
  $("signInBtn").onclick = guard(() => signInWithPopup(auth, new GoogleAuthProvider()));
  $("editBudgets").onclick = () => { editingBudgets = !editingBudgets; budgetEditKey = ""; renderBudgets(); };
  showTab(tabFromHash());

  onAuthStateChanged(auth, u => {
    user = u;
    stopListeners();
    closeMenu(false);
    if ($("entryDialog").open) $("entryDialog").close();
    if (u) {
      document.body.dataset.auth = "in";
      subscribeAll();
    } else {
      document.body.dataset.auth = "out";
      expenses = []; income = []; planned = []; budgets = {}; recurring = []; recurringIncome = [];
      categories = [...DEFAULT_CATEGORIES];
      editingBudgets = false;
    }
    renderAll();
  });
}

function stopListeners() {
  unsubs.forEach(f => f()); unsubs = [];
  monthUnsubs.forEach(f => f()); monthUnsubs = [];
}
const mapDocs = s => s.docs.map(d => ({ id: d.id, ...d.data() }));

function subscribeAll() {
  subscribeMonth();
  unsubs.push(onSnapshot(userDoc("settings", "categories"), s => {
    categories = s.exists() && Array.isArray(s.data().list) ? s.data().list : [...DEFAULT_CATEGORIES];
    renderAll();
  }, onErr));
  unsubs.push(onSnapshot(userDoc("settings", "budgets"), s => {
    budgets = s.exists() ? s.data() : {};
    renderAll();
  }, onErr));
  unsubs.push(onSnapshot(userCol("recurring"), s => { recurring = mapDocs(s); renderAll(); }, onErr));
  unsubs.push(onSnapshot(userCol("recurringIncome"), s => { recurringIncome = mapDocs(s); renderAll(); }, onErr));
}

// Listens to expenses, income and planned items for the selected month only
function subscribeMonth() {
  monthUnsubs.forEach(f => f()); monthUnsubs = [];
  const start = `${selectedMonth}-01`, end = `${selectedMonth}-31`;
  const monthQuery = name => query(userCol(name), where("date", ">=", start), where("date", "<=", end), orderBy("date", "desc"));
  monthUnsubs.push(onSnapshot(monthQuery("expenses"), s => { expenses = sortDesc(mapDocs(s)); renderAll(); }, onErr));
  monthUnsubs.push(onSnapshot(monthQuery("income"), s => { income = sortDesc(mapDocs(s)); renderAll(); }, onErr));
  monthUnsubs.push(onSnapshot(monthQuery("planned"), s => { planned = mapDocs(s); renderAll(); }, onErr));
}
// Newest first; same-day entries by creation time
const sortDesc = arr => arr.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
const sortAsc = arr => [...arr].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));

// ===== Rendering =====
function renderAll() {
  renderSummary();
  renderLists();
  renderBudgets();
  renderSide();
  renderChart();
  renderBadges();
}

function spentByCategory() {
  const byCat = {};
  expenses.forEach(e => { byCat[e.category] = (byCat[e.category] || 0) + Number(e.amount); });
  return byCat;
}
function budgetInfo(c, byCat) {
  const b = Number(budgets[c]) || 0, s = byCat[c] || 0;
  const ratio = b ? s / b : 0;
  return { c, b, s, ratio, over: b > 0 && s > b, near: b > 0 && s <= b && ratio >= NEAR_LIMIT };
}

function renderSummary() {
  $("monthLabel").textContent = monthName(selectedMonth);
  const spent = sum(expenses), earned = sum(income), plannedTotal = sum(planned);
  const balance = earned - spent, left = balance - plannedTotal;
  $("leftLabel").textContent = t(left < 0 ? "overPlan" : "leftToSpend");
  $("leftValue").textContent = fmt(Math.abs(left));
  $("leftValue").classList.toggle("neg", left < 0);
  $("leftSub").textContent = plannedTotal
    ? t("heroSub", { balance: signed(balance), planned: fmt(plannedTotal) })
    : t("heroSubNoPlan", { income: fmt(earned), spent: fmt(spent) });

  const bar = $("stackBar");
  if (earned > 0 || spent > 0) {
    const spPct = earned > 0 ? Math.min(100, spent / earned * 100) : 100;
    const plPct = earned > 0 ? Math.min(100 - spPct, plannedTotal / earned * 100) : 0;
    $("stackSpent").style.width = spPct + "%";
    $("stackPlanned").style.width = plPct + "%";
    bar.classList.toggle("over", spent > earned);
    bar.setAttribute("aria-label", t("stackAria", { income: fmt(earned), spent: fmtInt(Math.round(spPct)), planned: fmtInt(Math.round(plPct)) }));
    bar.hidden = false;
  } else bar.hidden = true;

  $("incomeTotal").textContent = fmt(earned);
  $("total").textContent = fmt(spent);
  $("planned").textContent = fmt(plannedTotal);
  $("incomeSub").textContent = t("entries", { n: fmtInt(income.length) });
  $("spentSub").textContent = earned > 0
    ? t("kpiSpentSub", { pct: fmtInt(Math.round(spent / earned * 100)), n: fmtInt(expenses.length) })
    : t("entries", { n: fmtInt(expenses.length) });
  $("plannedSub").textContent = t("kpiPlannedSub", { n: fmtInt(planned.length) });
}

function renderBadges() {
  const count = (id, n) => { $(id).textContent = n ? fmtInt(n) : ""; };
  count("badge-expenses", expenses.length);
  count("badge-income", income.length);
  count("badge-planned", planned.length);
  const byCat = spentByCategory();
  const overN = categories.filter(c => budgetInfo(c, byCat).over).length;
  $("badge-budgets").textContent = overN ? fmtInt(overN) : "";
  if (overN) $("navBudgets").setAttribute("aria-label", t("budgetsOverAria", { n: fmtInt(overN) }));
  else $("navBudgets").removeAttribute("aria-label");
}

// ----- Lists -----
function groupByDate(items) {
  const groups = [];
  for (const it of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === it.date) { last.items.push(it); last.total += Number(it.amount); }
    else groups.push({ date: it.date, items: [it], total: Number(it.amount) });
  }
  return groups;
}
function emptyState({ msg, actionLabel, onAction }) {
  return h("div", { class: "empty" }, h("p", { text: msg }),
    actionLabel ? h("button", { type: "button", class: "btn secondary small", onclick: onAction }, svg("plus", 16), actionLabel) : null);
}
function renderGrouped(boxId, items, rowFn, empty) {
  const box = $(boxId);
  if (!items.length) { box.replaceChildren(emptyState(empty)); return; }
  box.replaceChildren(...groupByDate(items).map(g => h("div", { class: "day-group" },
    h("div", { class: "day-head" }, h("span", { text: dayLabel(g.date) }), h("span", { class: "num", text: fmt(g.total) })),
    h("div", { class: "day-rows" }, g.items.map(rowFn)))));
}
function renderFlat(boxId, items, rowFn, emptyMsg) {
  const box = $(boxId);
  box.replaceChildren(...(items.length ? items.map(rowFn) : [emptyState({ msg: emptyMsg })]));
}

function entryRow({ icon, title, sub, amount, amountClass = "", menu, extra }) {
  return h("div", { class: "row" },
    icon,
    h("div", { class: "row-info" }, h("div", { class: "row-title", text: title }), sub ? h("div", { class: "row-sub", text: sub }) : null),
    h("span", { class: `row-amt num ${amountClass}`, text: amount }),
    extra || null,
    menu ? h("button", { type: "button", class: "icon-btn row-menu", "aria-haspopup": "menu", "aria-expanded": "false",
      "aria-label": t("moreActions", { name: title }), onclick: e => openMenu(e.currentTarget, menu) }, svg("more", 20)) : null);
}
const deleteItem = (col, item, msgKey) => [{ icon: "trash", label: t("delete"), danger: true, onSelect: guard(() => deleteWithUndo(col, item, t(msgKey))) }];
const incomeIcon = () => h("span", { class: "cat-icon tone-5" }, svg("income"));

const expenseRow = e => entryRow({
  icon: catIcon(e.category),
  title: e.note || catLabel(e.category),
  sub: [e.note ? catLabel(e.category) : null, e.recurringId ? t("monthly") : null].filter(Boolean).join(" · "),
  amount: fmt(e.amount),
  menu: deleteItem("expenses", e, "deletedExpense")
});
const incomeRow = i => entryRow({
  icon: incomeIcon(),
  title: i.note || t("income"),
  sub: i.recurringId ? t("monthly") : "",
  amount: "+" + fmt(i.amount), amountClass: "pos",
  menu: deleteItem("income", i, "deletedIncome")
});
const plannedRow = p => entryRow({
  icon: catIcon(p.category),
  title: p.note || catLabel(p.category),
  sub: p.note ? catLabel(p.category) : "",
  amount: fmt(p.amount),
  extra: h("button", { type: "button", class: "mark-btn", "aria-label": `${t("markSpent")}: ${p.note || catLabel(p.category)}`,
    onclick: guard(() => markSpent(p)) }, svg("check", 18), h("span", { class: "mark-label", text: t("markSpent") })),
  menu: deleteItem("planned", p, "deletedPlanned")
});
const ruleRow = (r, isIncome) => entryRow({
  icon: isIncome ? incomeIcon() : catIcon(r.category),
  title: r.note || (isIncome ? t("income") : catLabel(r.category)),
  sub: [isIncome ? null : catLabel(r.category), t("dayOfMonth", { day: fmtInt(r.day) })].filter(Boolean).join(" · "),
  amount: (isIncome ? "+" : "") + fmt(r.amount), amountClass: isIncome ? "pos" : "",
  menu: [{ icon: "trash", label: t("delete"), danger: true, onSelect: guard(async () => {
    if (await confirmAction(t(isIncome ? "confirmDelRecInc" : "confirmDelRec"), t("delete"))) await deleteWithUndo(isIncome ? "recurringIncome" : "recurring", r, t("deletedRec"));
  }) }]
});

const matchesSearch = (...parts) => !searchQ || parts.filter(Boolean).join(" ").toLowerCase().includes(searchQ);

function renderFilterChips() {
  const box = $("catFilter");
  const used = new Set(expenses.map(e => e.category));
  const present = [...categories.filter(c => used.has(c)), ...[...used].filter(c => !categories.includes(c))];
  if (filterCat && !used.has(filterCat)) filterCat = null;
  if (present.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  const chip = (label, value) => h("button", { type: "button", class: "chip", "aria-pressed": String(filterCat === value),
    onclick: () => { filterCat = value; renderLists(); } }, label);
  box.replaceChildren(chip(t("all"), null), ...present.map(c => chip(catLabel(c), c)));
}

function renderLists() {
  renderFilterChips();
  const filtering = Boolean(filterCat || searchQ);
  const exp = expenses.filter(e => (!filterCat || e.category === filterCat) && matchesSearch(e.note, catLabel(e.category), e.category));
  $("expCount").textContent = t("entries", { n: fmtInt(exp.length) });
  renderGrouped("list", exp, expenseRow, filtering ? { msg: t("noMatches") }
    : { msg: t("noExpenses"), actionLabel: t("addExpense"), onAction: () => openEntry("expense") });

  const inc = income.filter(i => matchesSearch(i.note, t("income")));
  $("incCount").textContent = t("entries", { n: fmtInt(inc.length) });
  renderGrouped("incomeList", inc, incomeRow, searchQ ? { msg: t("noMatches") }
    : { msg: t("noIncome"), actionLabel: t("addIncome"), onAction: () => openEntry("income") });

  const pl = sortAsc(planned).filter(p => matchesSearch(p.note, catLabel(p.category), p.category));
  $("planCount").textContent = fmt(sum(pl));
  renderGrouped("plannedList", pl, plannedRow, searchQ ? { msg: t("noMatches") }
    : { msg: t("noPlanned"), actionLabel: t("addPlanned"), onAction: () => openEntry("planned") });

  renderFlat("recurring", recurring, r => ruleRow(r, false), t("noRecurring"));
  renderFlat("recurringIncome", recurringIncome, r => ruleRow(r, true), t("noRecurringIncome"));
  renderRecBanner("recBannerExp", recurring, expenses, "expenses", "Exp");
  renderRecBanner("recBannerInc", recurringIncome, income, "income", "Inc");
}

// Recurring rules not yet turned into an entry for the viewed month
function renderRecBanner(boxId, rules, existing, col, kind) {
  const box = $(boxId);
  const pending = rules.filter(r => !existing.some(x => x.recurringId === r.id));
  box.hidden = !pending.length;
  if (!pending.length) { box.replaceChildren(); return; }
  const names = pending.map(r => r.note || (kind === "Exp" ? catLabel(r.category) : t("income"))).join(", ");
  box.replaceChildren(
    h("span", { class: "rec-icon" }, svg("repeat", 18)),
    h("div", { class: "rec-text" },
      h("div", { class: "rec-title", text: t("recPending", { n: fmtInt(pending.length) }) }),
      h("div", { class: "rec-sub", text: `${names} · ${fmt(sum(pending))}` })),
    h("button", { type: "button", class: "btn primary", onclick: guard(() => applyRecurringTo(rules, col, existing, kind)) }, t("addAll")));
}

// ----- Budgets -----
function renderBudgets() {
  const byCat = spentByCategory();
  const infos = categories.map(c => budgetInfo(c, byCat));
  const budgeted = infos.filter(i => i.b > 0);
  $("editBudgets").textContent = t(editingBudgets ? "done" : "edit");

  // Summary
  const sumBox = $("budgetSummary");
  if (!budgeted.length) {
    sumBox.replaceChildren(
      h("div", { class: "label", text: t("noBudgetsTitle") }),
      h("p", { class: "hint", text: t("noBudgetsHint") }),
      editingBudgets ? null : h("div", {}, h("button", { type: "button", class: "btn secondary small", onclick: () => startBudgetEdit(categories[0]) }, t("setBudgets"))));
  } else {
    const totalB = budgeted.reduce((s, i) => s + i.b, 0), totalS = budgeted.reduce((s, i) => s + i.s, 0);
    const overN = budgeted.filter(i => i.over).length, nearN = budgeted.filter(i => i.near).length;
    sumBox.replaceChildren(
      h("div", { class: "label", text: t("spentAgainst") }),
      h("div", { class: "bs-value" }, h("strong", { class: "num", text: fmt(totalS) }), h("span", { text: t("ofBudget", { budget: fmt(totalB) }) })),
      h("span", { class: "track" }, h("span", { class: `fill ${totalS > totalB ? "over" : "accent"}`, style: `width:${Math.min(100, totalS / totalB * 100)}%` })),
      h("div", { class: "pills" },
        overN ? h("span", { class: "pill over" }, svg("alert", 14), t("overCount", { n: fmtInt(overN) })) : null,
        nearN ? h("span", { class: "pill near", text: t("nearCount", { n: fmtInt(nearN) }) }) : null,
        h("span", { class: "pill", text: t("leftAmt", { amt: fmt(Math.max(0, totalB - totalS)) }) })));
  }

  const list = $("budgetList");
  if (editingBudgets) {
    // Rebuild only when the category set changes, so typing in a field isn't wiped by a snapshot
    const key = categories.join("\u0000") + "|" + lang;
    if (key === budgetEditKey) {
      categories.forEach((c, i) => { const inp = $("b-" + i); if (inp && inp !== document.activeElement) inp.value = budgetText(c); });
      return;
    }
    budgetEditKey = key;
    list.replaceChildren(...categories.map(budgetEditRow), addCategoryForm());
    return;
  }
  budgetEditKey = "";
  const rank = i => (i.over ? 0 : i.near ? 1 : i.b ? 2 : 3);
  const sorted = [...infos].sort((a, b) => rank(a) - rank(b) || (a.b && b.b ? b.ratio - a.ratio : b.s - a.s));
  list.replaceChildren(...sorted.map(budgetReadRow));
}

function budgetReadRow(i) {
  const name = catLabel(i.c);
  if (!i.b) {
    return h("button", { type: "button", class: "brow nolimit", onclick: () => startBudgetEdit(i.c) },
      catIcon(i.c, "sm"),
      h("span", { class: "brow-body" }, h("span", { class: "brow-name", text: name }), h("span", { class: "brow-status", text: t("noLimit", { amt: fmt(i.s) }) })),
      h("span", { class: "brow-action", text: t("setLimit") }));
  }
  const state = i.over ? "over" : i.near ? "near" : "";
  const status = i.over ? t("overBy", { amt: fmt(i.s - i.b) })
    : i.s === i.b ? t("fullyUsed")
    : i.near ? t("leftPct", { amt: fmt(i.b - i.s), pct: fmtInt(Math.round(i.ratio * 100)) })
    : t("leftAmt", { amt: fmt(i.b - i.s) });
  return h("button", { type: "button", class: "brow", onclick: () => startBudgetEdit(i.c) },
    catIcon(i.c, "sm"),
    h("span", { class: "brow-body" },
      h("span", { class: "brow-line" }, h("span", { class: "brow-name", text: name }),
        h("span", { class: "brow-amt num" }, fmt(i.s), h("span", { class: "of", text: " / " + fmt(i.b) }))),
      h("span", { class: "track" }, h("span", { class: `fill ${state}`, style: `width:${Math.min(100, i.ratio * 100)}%` })),
      h("span", { class: `brow-status ${state}` }, i.over ? svg("alert", 14) : null, status)));
}

function budgetEditRow(c, idx) {
  const name = catLabel(c);
  const input = h("input", { id: "b-" + idx, class: "num", inputmode: "decimal", autocomplete: "off", placeholder: t("noLimitPh") });
  input.value = budgetText(c);
  input.addEventListener("change", guard(() => saveBudget(c, input)));
  input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
  return h("div", { class: "brow edit" },
    catIcon(c, "sm"),
    h("label", { class: "brow-name", for: "b-" + idx, text: name }),
    h("span", { class: "budget-input" }, h("span", { "aria-hidden": "true", text: "৳" }), input),
    h("button", { type: "button", class: "icon-btn", "aria-label": t("removeCatNamed", { name }), onclick: guard(() => removeCategory(c)) }, svg("x", 18)));
}

function addCategoryForm() {
  const input = h("input", { class: "input", type: "text", maxlength: "30", placeholder: t("phNewCat"), "aria-label": t("phNewCat") });
  return h("form", { class: "add-cat", onsubmit: e => { e.preventDefault(); guard(() => addCategory(input))(); } },
    input, h("button", { type: "submit", class: "btn secondary" }, svg("plus", 18), t("add")));
}

function startBudgetEdit(c) {
  editingBudgets = true;
  budgetEditKey = "";
  renderBudgets();
  const idx = categories.indexOf(c);
  $("b-" + (idx < 0 ? 0 : idx))?.focus();
}

// ----- Side cards (tablet / desktop) -----
function renderSide() {
  const byCat = spentByCategory();
  const total = sum(expenses);

  // Where it went: top 5 categories plus the rest
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const where = $("where");
  if (!total) where.replaceChildren(h("p", { class: "hint", text: t("noExpenses") }));
  else {
    const top = entries.slice(0, 5), rest = entries.slice(5);
    const restSum = rest.reduce((s, [, v]) => s + v, 0);
    const rows = top.map(([c, v]) => ({ name: catLabel(c), v, tone: catStyle(c).tone }));
    if (rest.length) rows.push({ name: rest.length === 1 ? catLabel(rest[0][0]) : t("moreCats", { n: fmtInt(rest.length) }), v: restSum, tone: 7 });
    const pct = v => Math.round(v / total * 100);
    where.replaceChildren(
      h("div", { class: "where-bar", role: "img", "aria-label": rows.map(r => `${r.name} ${fmtInt(pct(r.v))}%`).join(", ") },
        rows.map(r => h("span", { class: `tone-${r.tone}`, style: `width:${r.v / total * 100}%` }))),
      h("div", { class: "where-list" }, rows.map(r => h("div", { class: "where-row" },
        h("span", { class: `dot tone-${r.tone}` }), h("span", { class: "name", text: r.name }),
        h("span", { class: "pct", text: fmtInt(pct(r.v)) + "%" }), h("span", { class: "amt num", text: fmt(r.v) })))));
  }

  // Budget watch: over or close to the limit
  const watch = categories.map(c => budgetInfo(c, byCat)).filter(i => i.over || i.near).sort((a, b) => b.ratio - a.ratio).slice(0, 3);
  $("watchCard").hidden = !watch.length;
  $("watch").replaceChildren(...watch.map(i => h("div", { class: "watch-item" },
    h("div", { class: "brow-line" }, h("span", { class: "brow-name", text: catLabel(i.c) }),
      h("span", { class: "brow-amt num" }, fmt(i.s), h("span", { class: "of", text: " / " + fmt(i.b) }))),
    h("span", { class: "track" }, h("span", { class: `fill ${i.over ? "over" : "near"}`, style: `width:${Math.min(100, i.ratio * 100)}%` })),
    h("span", { class: `brow-status ${i.over ? "over" : "near"}` }, i.over ? svg("alert", 14) : null,
      i.over ? t("overBy", { amt: fmt(i.s - i.b) }) : i.s === i.b ? t("fullyUsed") : t("leftPct", { amt: fmt(i.b - i.s), pct: fmtInt(Math.round(i.ratio * 100)) })))));

  // Planned preview
  const next = sortAsc(planned).slice(0, 3);
  $("plannedPreviewCard").hidden = !next.length;
  $("plannedPreview").replaceChildren(...next.map(p => h("div", { class: "mini-row" },
    h("div", { class: "row-info" }, h("div", { class: "row-title", text: p.note || catLabel(p.category) }),
      h("div", { class: "row-sub", text: `${fmtDate(p.date)} · ${fmt(p.amount)}` })),
    h("button", { type: "button", class: "btn secondary small", onclick: guard(() => markSpent(p)) }, t("markSpent")))));
}

// ----- Chart: cumulative spending vs an even budget pace (desktop) -----
const SVGNS = "http://www.w3.org/2000/svg";
const svgNode = (tag, attrs) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
function niceCeil(v) {
  if (v <= 0) return 1000;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].find(step => n <= step) * p;
}
function renderChart() {
  const box = $("chart");
  const [y, m] = selectedMonth.split("-").map(Number);
  const dim = new Date(y, m, 0).getDate();
  const budgetTotal = categories.reduce((acc, c) => acc + (Number(budgets[c]) || 0), 0);
  $("chartPaceLegend").hidden = !budgetTotal;
  $("chartPaceText").textContent = t("chartPace", { amt: fmt(budgetTotal) });
  if (!expenses.length) { box.replaceChildren(h("p", { class: "muted chart-empty", text: t("noExpenses") })); return; }

  const daily = new Array(dim).fill(0);
  expenses.forEach(e => { const d = Number(e.date.slice(8, 10)); if (d >= 1 && d <= dim) daily[d - 1] += Number(e.amount); });
  const thisMonth = todayISO().slice(0, 7);
  const lastWithData = daily.reduce((acc, v, i) => (v ? i + 1 : acc), 0);
  const end = Math.max(selectedMonth === thisMonth ? Number(todayISO().slice(8, 10)) : selectedMonth < thisMonth ? dim : 0, lastWithData);
  const cum = []; daily.slice(0, end).reduce((acc, v, i) => (cum[i] = acc + v), 0);
  const total = cum[end - 1];
  const maxV = niceCeil(Math.max(total, budgetTotal) * 1.05);
  const W = 600, H = 200;
  const x = d => (dim > 1 ? (d - 1) / (dim - 1) : 0) * W;
  const yv = v => H - v / maxV * H;
  const pts = cum.map((v, i) => `${x(i + 1).toFixed(1)},${yv(v).toFixed(1)}`);

  const plot = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img",
    "aria-label": t("chartAria", { amt: fmt(total), date: fmtDate(`${selectedMonth}-${pad(end)}`) }) });
  plot.append(svgNode("path", { class: "chart-area", d: `M0,${H} L${pts.join(" L")} L${x(end).toFixed(1)},${H} Z` }));
  if (budgetTotal) plot.append(svgNode("line", { class: "chart-pace", x1: 0, y1: H, x2: W, y2: yv(budgetTotal).toFixed(1), "vector-effect": "non-scaling-stroke" }));
  plot.append(svgNode("polyline", { class: "chart-line", points: pts.join(" "), "vector-effect": "non-scaling-stroke" }));

  const leftPct = x(end) / W * 100, topPct = yv(total) / H * 100;
  const tip = h("div", { class: "chart-tip", style: `left:${leftPct}%;top:${topPct}%`, text: t("chartBy", { amt: fmt(total), date: fmtDate(`${selectedMonth}-${pad(end)}`) }) });
  if (leftPct < 30) tip.style.transform = "translate(0, -135%)";
  const ticks = [4, 3, 2, 1, 0].map(k => compactFmt.format(maxV * k / 4));
  const xDays = [1, 8, 15, 22, dim];
  box.replaceChildren(
    h("div", { class: "chart-wrap" },
      h("div", { class: "chart-y", "aria-hidden": "true" }, ticks.map(v => h("span", { text: v }))),
      h("div", { class: "chart-plot" },
        h("div", { class: "chart-grid", "aria-hidden": "true" }, [0, 1, 2, 3, 4].map(() => h("span"))),
        plot,
        h("span", { class: "chart-dot", style: `left:${leftPct}%;top:${topPct}%`, "aria-hidden": "true" }),
        tip)),
    h("div", { class: "chart-x", "aria-hidden": "true" }, xDays.map((d, i) =>
      h("span", { text: i === 0 || i === xDays.length - 1 ? fmtDate(`${selectedMonth}-${pad(d)}`) : fmtInt(d) }))));
}

// ===== Writes =====

// Delete immediately and offer Undo, which restores the same document id and data
async function deleteWithUndo(col, item, msg) {
  const uid = user.uid;
  const { id, ...data } = item;
  await deleteDoc(doc(db, "users", uid, col, id));
  toast(msg, { actionLabel: t("undo"), onAction: guard(async () => {
    await setDoc(doc(db, "users", uid, col, id), data);
    toast(t("restored"));
  }) });
}

// Turns a planned item into a real expense, then removes it from the plan
async function markSpent(p) {
  await addDoc(userCol("expenses"), {
    amount: p.amount, category: p.category, date: p.date,
    note: p.note || "", recurringId: null, createdAt: Date.now()
  });
  await deleteDoc(userDoc("planned", p.id));
  toast(t("movedToExpenses"));
}

async function saveBudget(c, input) {
  const raw = input.value.trim();
  const next = { ...budgets };
  if (raw === "") {
    if (budgets[c] === undefined) return;
    delete next[c];
  } else {
    const v = parseNum(raw);
    if (!(v > 0)) { toast(t("invalidAmount"), { error: true }); input.value = budgetText(c); return; }
    if (Number(budgets[c]) === v) return;
    next[c] = v;
  }
  await setDoc(userDoc("settings", "budgets"), next);
  toast(t("budgetSaved"));
}

async function addCategory(input) {
  const name = input.value.trim();
  if (!name) return;
  // Match against both the stored name and its Bangla label, so "খাবার" can't duplicate "Food"
  const lower = name.toLowerCase();
  if (categories.some(c => c.toLowerCase() === lower || CAT_BN[c] === name)) { toast(t("catExists", { name }), { error: true }); return; }
  await setDoc(userDoc("settings", "categories"), { list: [...categories, name] });
  input.value = "";
  toast(t("catAdded", { name }));
}

async function removeCategory(name) {
  if (categories.length <= 1) { toast(t("keepOneCat"), { error: true }); return; }
  if (!(await confirmAction(t("confirmRemoveCat", { name: catLabel(name) }), t("remove")))) return;
  const uid = user.uid, index = categories.indexOf(name), prevBudget = budgets[name];
  const catRef = doc(db, "users", uid, "settings", "categories"), budRef = doc(db, "users", uid, "settings", "budgets");
  await setDoc(catRef, { list: categories.filter(c => c !== name) });
  if (prevBudget !== undefined) { const next = { ...budgets }; delete next[name]; await setDoc(budRef, next); }
  toast(t("catRemoved", { name: catLabel(name) }), { actionLabel: t("undo"), onAction: guard(async () => {
    // Restore against the current state so edits made in between are kept
    if (!categories.includes(name)) { const list = [...categories]; list.splice(Math.min(index, list.length), 0, name); await setDoc(catRef, { list }); }
    if (prevBudget !== undefined) await setDoc(budRef, { ...budgets, [name]: prevBudget });
    toast(t("restored"));
  }) });
}

// Creates one entry per recurring rule for the selected month, skipping any already created
async function applyRecurringTo(rules, col, existing, kind) {
  const [y, m] = selectedMonth.split("-").map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const month = selectedMonth;
  let added = 0;
  for (const r of rules) {
    if (existing.some(x => x.recurringId === r.id)) continue;
    const day = Math.min(r.day, daysInMonth);
    await addDoc(userCol(col), {
      amount: r.amount, category: r.category || "Income", note: r.note || "",
      date: `${month}-${pad(day)}`, recurringId: r.id, createdAt: Date.now()
    });
    added++;
  }
  toast(added ? t("applied" + kind, { n: fmtInt(added), month: monthName(month) }) : t("nothing" + kind));
}

// ===== Start (last, so every helper above is initialised) =====
const configured = !firebaseConfig.apiKey.startsWith("YOUR_");
initInAppNotice();
initLang();

if (!configured) {
  document.body.dataset.auth = "setup";
} else {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  // Offline cache: the app opens and shows data without a connection; writes sync when back online
  try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch (e) { db = getFirestore(app); }
  init();
}

// Offline app shell
if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
