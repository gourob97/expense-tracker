import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence,
  collection, doc, onSnapshot, query, where, orderBy, getDoc, getDocs, waitForPendingWrites, writeBatch,
  addDoc as fsAddDoc, deleteDoc as fsDeleteDoc, setDoc as fsSetDoc, updateDoc as fsUpdateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { STRINGS, CAT_BN } from "./i18n.js";
import { periodRange, periodOf, shiftPeriod, dateInPeriod, addDays, daysBetween, inPeriod, isPeriodKey, normalizeStartDay, DEFAULT_START_DAY } from "./period.js";
import { formatAmountInput } from "./amount.js";
import { balances, totals, flowBetween, history as personHistory, balanceWith, findPerson, cleanName } from "./loans.js";

// ===== FIREBASE WEB CONFIG =====
const firebaseConfig = {
  apiKey: "AIzaSyCxGxl9MB56Hukv5qij_t-jbtdrdVoNacs",
  authDomain: "personal-expense-tracker-d2914.firebaseapp.com",
  projectId: "personal-expense-tracker-d2914",
  appId: "1:642059260081:web:0e3f0055881797852ad290"
};
// ===============================

const DEFAULT_CATEGORIES = ["Food", "Transport", "Bills", "Rent", "Shopping", "Health", "Entertainment", "Other"];
const TABS = ["expenses", "income", "planned", "budgets", "loans"];
const NEAR_LIMIT = 0.9;

const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, "0");
const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoOf(new Date());
const parseISO = iso => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const sum = arr => arr.reduce((s, x) => s + Number(x.amount || 0), 0);

// ----- Motion -----
// CSS shortens every animation under prefers-reduced-motion; animations started from JS check this themselves
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const EASE_OUT = "cubic-bezier(.2, .8, .2, 1)"; // same curve as --ease-out in styles.css
// Exit animations are CSS keyframes under [data-leaving]. playExit sets the attribute and runs done() once they end
// (at once if none run, e.g. the element isn't rendered). cancelExit removes it, which cancels the animation and
// skips done(); it returns whether an exit was in progress.
function playExit(el, done) {
  if ("leaving" in el.dataset) return;
  el.dataset.leaving = "";
  Promise.allSettled(el.getAnimations().map(a => a.finished)).then(() => {
    if (!("leaving" in el.dataset)) return;
    delete el.dataset.leaving;
    done();
  });
}
function cancelExit(el) {
  if (!("leaving" in el.dataset)) return false;
  delete el.dataset.leaving;
  return true;
}

// ----- Write tracking: each Firestore write promise settles only when the server acknowledges it,
// so counting unsettled ones tells us whether this session has changes that haven't synced yet -----
let pendingWrites = 0;
const tracked = fn => (...args) => {
  const p = fn(...args);
  pendingWrites++; updateSync();
  p.finally(() => { pendingWrites--; updateSync(); }).catch(() => {});
  return p;
};
const addDoc = tracked(fsAddDoc), setDoc = tracked(fsSetDoc), updateDoc = tracked(fsUpdateDoc), deleteDoc = tracked(fsDeleteDoc);
// Runs ops (each `batch => batch.set/delete(...)`) as atomic batches; Firestore caps a batch at 500 writes
const commitBatch = tracked(b => b.commit());
function writeAll(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const b = writeBatch(db);
    ops.slice(i, i + 450).forEach(op => op(b));
    writeInBackground(commitBatch(b));
  }
}

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
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  download: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  gave: '<path d="M7 17L17 7"/><path d="M9 7h8v8"/>',
  got: '<path d="M17 7L7 17"/><path d="M15 17H7V9"/>'
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
// "November 2026" for calendar months, otherwise "25 Nov – 24 Dec" (year shown only when the period is outside the current year)
function periodLabel(key, sd = startDay) {
  if (sd === 1) return monthName(key);
  const { start, end } = periodRange(key, sd);
  const year = String(new Date().getFullYear());
  const opts = { day: "numeric", month: "short" };
  if (!start.startsWith(year) && !end.startsWith(year)) opts.year = "numeric";
  const f = new Intl.DateTimeFormat(LOCALES[lang], opts);
  return f.formatRange ? f.formatRange(parseISO(start), parseISO(end)) : `${f.format(parseISO(start))} – ${f.format(parseISO(end))}`;
}
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
// Amount inputs are text fields (type=number mangles Bangla digits and decimals), so filter what gets typed or
// pasted and group it as 1,25,000. Bound before any other input listener so those see the formatted value. Skipped
// mid-composition: changing the value then breaks IME keyboards (Bangla phonetic input); compositionend cleans up.
function setAmountText(el, raw, caret = String(raw).length) {
  const { value, caret: at } = formatAmountInput(String(raw), caret);
  if (value !== el.value) el.value = value;
  if (document.activeElement === el) el.setSelectionRange(at, at);
}
function bindAmountInput(el) {
  const reformat = () => setAmountText(el, el.value, el.selectionStart ?? el.value.length);
  el.addEventListener("input", e => { if (!e.isComposing) reformat(); });
  el.addEventListener("compositionend", reformat);
  // Backspace just after a grouping comma (or Delete just before one) removes the digit beyond it; deleting only
  // the comma would be undone by the regrouping, so the key would seem to do nothing
  el.addEventListener("beforeinput", e => {
    const s = el.selectionStart, v = el.value;
    if (s == null || s !== el.selectionEnd) return;
    const back = e.inputType === "deleteContentBackward", fwd = e.inputType === "deleteContentForward";
    if (back && v[s - 1] === "," && s >= 2) { e.preventDefault(); setAmountText(el, v.slice(0, s - 2) + v.slice(s), s - 2); el.dispatchEvent(new Event("input")); }
    else if (fwd && v[s] === ",") { e.preventDefault(); setAmountText(el, v.slice(0, s + 1) + v.slice(s + 2), s); el.dispatchEvent(new Event("input")); }
  });
}
bindAmountInput($("eAmount"));

// ----- Toast: confirmations auto-hide, errors stay until tapped, optional action (Undo) -----
let toastTimer;
function hideToast() {
  const el = $("toast");
  if (!el.hidden) playExit(el, () => { el.hidden = true; });
}
function toast(msg, { error = false, actionLabel, onAction } = {}) {
  const el = $("toast"), btn = $("toastAction");
  clearTimeout(toastTimer);
  if (!msg) { hideToast(); return; }
  cancelExit(el); // a new message while the old one fades out takes over the visible toast
  $("toastMsg").textContent = msg;
  el.classList.toggle("error", error);
  btn.hidden = !actionLabel;
  if (actionLabel) { btn.textContent = actionLabel; btn.onclick = () => { toast(""); onAction(); }; }
  el.hidden = false;
  if (!error) toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 3500);
}

// ----- Dialogs: open and close through these so closing plays the exit animation first -----
function openDialog(d) {
  if (cancelExit(d) || d.open) return; // reopened mid-exit: it never closed, so stopping the exit is enough
  d.showModal();
}
function closeDialog(d, { instant = false } = {}) {
  if (!d.open) return;
  if (instant) { cancelExit(d); d.close(); return; }
  playExit(d, () => d.close());
}
// Esc (and Android back) animate out too. If the browser won't allow the close to be deferred, it closes at once.
// The confirm dialog handles cancel itself, since it has to resolve its promise.
["entryDialog", "cycleDialog", "accountDialog", "nameDialog"].forEach(id => $(id).addEventListener("cancel", e => {
  if (!e.cancelable) return;
  e.preventDefault();
  closeDialog(e.currentTarget);
}));
$("toastMsg").onclick = () => toast("");
const onErr = e => toast(e.message || String(e), { error: true });
// Wrap async actions so errors show in the toast instead of failing silently
const guard = fn => async (...args) => { try { await fn(...args); } catch (e) { onErr(e); } };

// ----- Popover menu (row actions) -----
let menuAnchor = null;
function openMenu(anchor, items) {
  const m = $("menu");
  if (menuAnchor === anchor && !m.hidden) { closeMenu(true); return; }
  closeMenu(false);
  m.replaceChildren(...items.map(it =>
    h("button", { type: "button", role: "menuitem", class: "menu-item" + (it.danger ? " danger" : ""),
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

// ----- Theme: "system" (default, follows the OS) or a manual light/dark choice remembered on this device -----
const systemTheme = () => (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
function themePref() {
  try { const v = localStorage.getItem("theme"); return v === "light" || v === "dark" ? v : "system"; } catch (e) { return "system"; }
}
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0E1116" : "#F4F4F0";
}
function setThemePref(pref) {
  try { if (pref === "system") localStorage.removeItem("theme"); else localStorage.setItem("theme", pref); } catch (e) {}
  applyTheme(pref === "system" ? systemTheme() : pref);
}
setThemePref(themePref());
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (themePref() === "system") applyTheme(systemTheme());
});

// ----- State -----
// Day the user's budget month starts (salary day). Synced per account; cached on this device so the first paint is right.
const CYCLE_KEY = "cycleStartDay";
const cachedStartDay = () => { try { return normalizeStartDay(localStorage.getItem(CYCLE_KEY)); } catch (e) { return DEFAULT_START_DAY; } };
let startDay = cachedStartDay();
// Key of the period being viewed: "YYYY-MM" of the month it starts in (see period.js).
// Lives in the URL hash (#/tab?m=YYYY-MM) so reload and back/forward keep it; omitted for the current period.
// The Loans tab adds the person being viewed (&p=<id>), so back returns from their history to the list.
const nowPeriod = () => periodOf(todayISO(), startDay);
function readHash() {
  const [tab, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(qs), m = params.get("m"), p = params.get("p");
  return { tab, month: m && isPeriodKey(m) ? m : null, person: tab === "loans" && p && /^[\w-]{1,64}$/.test(p) ? p : null };
}
let selectedMonth = readHash().month || nowPeriod();
let selectedPerson = readHash().person;
const currentRange = () => periodRange(selectedMonth, startDay);
let user = null;
let categories = [...DEFAULT_CATEGORIES];
let expenses = [], income = [], planned = [], budgets = {}, recurring = [], recurringIncome = [];
// Loans are all-time (balances span months), so they load once per sign-in rather than per period
let people = [], loanTxns = [];
let unsubs = [], monthUnsubs = [];
let auth, db;
let currentTab = "expenses", filterCat = null, searchQ = "", editingBudgets = false, budgetEditKey = "";
const userDoc = (...path) => doc(db, "users", user.uid, ...path);
const userCol = name => collection(db, "users", user.uid, name);

// ----- Tabs (state lives in the URL hash as #/name so reload and back/forward work) -----
const tabFromHash = () => readHash().tab;
function hashFor(tab, month, person = null) {
  const q = new URLSearchParams();
  if (month !== nowPeriod()) q.set("m", month);
  if (tab === "loans" && person) q.set("p", person);
  const qs = q.toString();
  return `#/${tab}` + (qs ? "?" + qs : "");
}
// Writes tab + month to the URL. push=true adds a history entry (back returns to the previous month).
function syncHash(push) {
  document.querySelectorAll('a[href^="#/"]:not([data-person])').forEach(a => { a.href = hashFor(a.getAttribute("href").replace(/^#\/?/, "").split("?")[0], selectedMonth); });
  const target = hashFor(currentTab, selectedMonth, selectedPerson);
  if (location.hash === target) return;
  if (push) location.hash = target; else history.replaceState(history.state, "", target);
}
const KIND_FOR_TAB = { expenses: "expense", income: "income", planned: "planned", budgets: "expense", loans: "loan" };
const ADD_LABEL = { expense: "addExpense", income: "addIncome", planned: "addPlanned", loan: "addLoan" };
const TAB_TITLE = { expenses: "tabExpenses", income: "tabIncome", planned: "tabPlanned", budgets: "tabBudgets", loans: "tabLoans" };
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
  const { tab, month, person } = readHash(), prevTab = currentTab, prevPerson = selectedPerson;
  showTab(tab);
  selectedPerson = currentTab === "loans" ? person : null;
  setMonth(month || nowPeriod(), { fromHash: true });
  syncHash(false); // normalise unknown tabs / stale params
  if (selectedPerson !== prevPerson) renderLists();
  if ((currentTab !== prevTab || selectedPerson !== prevPerson) && window.scrollY > 0) window.scrollTo({ top: 0 });
});
// Opens one person's history (null: back to the list). Pushes a history entry so back returns.
function openPerson(id) {
  if (selectedPerson === id && currentTab === "loans") return;
  location.hash = hashFor("loans", selectedMonth, id);
}

// ----- Month switching -----
function setMonth(ym, { fromHash = false } = {}) {
  if (!isPeriodKey(ym) || ym === selectedMonth) return;
  startMonthSlide(ym > selectedMonth ? 1 : -1); // period keys are YYYY-MM, so they compare as strings
  selectedMonth = ym;
  $("month").value = ym;
  filterCat = null;
  if (!fromHash) syncHash(true);
  renderAll();
  if (user) subscribeMonth();
}
const shiftMonth = delta => setMonth(shiftPeriod(selectedMonth, delta));

// Re-maps the viewed period when the start day changes: stays on "now" if viewing it, otherwise on the period
// that overlaps the old one most (the one containing its midpoint)
function applyStartDay(next) {
  next = normalizeStartDay(next);
  try { if (next === DEFAULT_START_DAY) localStorage.removeItem(CYCLE_KEY); else localStorage.setItem(CYCLE_KEY, String(next)); } catch (e) {}
  if (next === startDay) return;
  const old = currentRange(), today = todayISO();
  const anchor = inPeriod(today, old) ? today : addDays(old.start, Math.floor(old.days / 2));
  startDay = next;
  selectedMonth = periodOf(anchor, startDay);
  $("month").value = selectedMonth;
  filterCat = null;
  syncHash(false);
  renderAll();
  if (user) subscribeMonth();
}
$("prevMonth").onclick = () => shiftMonth(-1);
$("nextMonth").onclick = () => shiftMonth(1);
$("monthBtn").onclick = () => { try { $("month").showPicker(); } catch (e) { /* type=month unsupported (e.g. desktop Firefox): chevrons still work */ } };
$("month").onchange = e => setMonth(e.target.value);
$("month").value = selectedMonth;

// ----- Sync status: "synced", "syncing", "offline" (nothing waiting) or "offline-pending" -----
// pendingWrites covers this session. Writes queued by an earlier session (reloaded while offline) live only in
// Firestore's own queue, so on sign-in we also wait on that. "Syncing" appears after a short delay so a normal
// online write (acknowledged in a few hundred ms) doesn't make the status flicker.
const SYNC_TEXT = { synced: "syncSynced", syncing: "syncSyncing", offline: "syncOffline", "offline-pending": "syncOfflinePending" };
let queuedFromBefore = false, syncShown = "synced", syncTimer;
function syncState() {
  const pending = pendingWrites > 0 || queuedFromBefore;
  if (!navigator.onLine) return pending ? "offline-pending" : "offline";
  return pending ? "syncing" : "synced";
}
function updateSync() {
  const next = syncState();
  clearTimeout(syncTimer);
  if (next === "syncing" && syncShown === "synced") {
    syncTimer = setTimeout(() => { if (syncState() === "syncing") showSync("syncing"); }, 600);
  } else showSync(next);
}
function showSync(state) {
  syncShown = state;
  document.body.dataset.sync = state;
  document.querySelectorAll(".sync-text").forEach(el => { el.textContent = t(SYNC_TEXT[state]); });
  $("accountBtn").setAttribute("aria-label", user ? `${t("accountMenu")} · ${t(SYNC_TEXT[state])}` : t("accountMenu"));
}
function watchQueuedWrites() {
  const uid = user.uid;
  queuedFromBefore = true;
  updateSync();
  waitForPendingWrites(db).catch(() => {}).finally(() => {
    if (user?.uid !== uid) return;
    queuedFromBefore = false;
    updateSync();
  });
}
window.addEventListener("online", updateSync);
window.addEventListener("offline", updateSync);

// ----- Account identity: Google photo with an initials fallback (also used offline, when the photo can't load) -----
function initialsOf(u) {
  const first = w => [...w][0] || "";
  const words = (u.displayName || "").trim().split(/\s+/).filter(Boolean);
  if (words.length) return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : "")).toUpperCase();
  return first(u.email || "?").toUpperCase();
}
function fillAvatar(el) {
  const key = user ? `${user.uid}|${user.photoURL || ""}|${user.displayName || ""}` : "";
  if (el.dataset.key === key && el.firstChild) return; // don't refetch the photo on every render
  el.dataset.key = key;
  [...el.classList].filter(c => c.startsWith("tone-")).forEach(c => el.classList.remove(c));
  el.classList.toggle("has-initials", !!user);
  if (!user) { el.replaceChildren(svg("user", 18)); return; }
  el.classList.add(`tone-${hashStr(user.uid) % 8}`);
  const initials = h("span", { text: initialsOf(user) });
  // Google photo URLs can refuse requests that carry a referrer; on any failure the initials underneath stay visible
  el.replaceChildren(initials);
  if (user.photoURL) el.append(h("img", { src: user.photoURL, alt: "", referrerpolicy: "no-referrer", decoding: "async", onerror: e => e.currentTarget.remove() }));
}
function renderAccount() {
  const name = user ? (user.displayName || user.email || t("account")) : t("account");
  document.querySelectorAll("[data-account-name]").forEach(el => { el.textContent = name; });
  const email = user?.displayName && user.email ? user.email : "";
  $("acctEmail").textContent = email;
  $("acctEmail").hidden = !email;
  document.querySelectorAll("[data-avatar]").forEach(fillAvatar);
  $("acctCycleVal").textContent = t("cycleValue", { day: fmtInt(startDay) });
  showSync(syncShown); // refreshes the text in the current language
}

// ----- Account panel: bottom sheet on phones, popover anchored to the account button from 600px up -----
const wideLayout = matchMedia("(min-width: 600px)");
const isShown = el => el.getClientRects().length > 0;
let panelAnchor = null;
function openAccount(anchor) {
  const d = $("accountDialog");
  if (d.open) { closeDialog(d); return; }
  closeMenu(false);
  renderAccount();
  d.querySelector(`input[name="themePref"][value="${themePref()}"]`).checked = true;
  d.querySelector(`input[name="langPref"][value="${lang}"]`).checked = true;
  panelAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  openDialog(d);
  placeAccount();
  d.querySelector('input[name="themePref"]:checked').focus({ preventScroll: true });
}
function placeAccount() {
  const d = $("accountDialog");
  if (!d.open) return;
  if (!wideLayout.matches) { d.style.left = d.style.top = ""; return; }
  // Layout can change while open (window resized past a breakpoint): follow whichever account button is visible
  if (!panelAnchor || !isShown(panelAnchor)) panelAnchor = [$("accountBtnSide"), $("accountBtn")].find(isShown) || panelAnchor;
  const r = panelAnchor.getBoundingClientRect(), w = d.offsetWidth, ht = d.offsetHeight;
  const fromSide = panelAnchor.id === "accountBtnSide";
  const left = Math.min(innerWidth - w - 8, Math.max(8, fromSide ? r.left : r.right - w));
  let top = r.bottom + 8;
  if (top + ht > innerHeight - 8) top = Math.max(8, r.top - ht - 8);
  d.style.left = left + "px";
  d.style.top = top + "px";
  d.style.setProperty("--panel-origin", `${top > r.top ? "top" : "bottom"} ${fromSide ? "left" : "right"}`);
}
window.addEventListener("resize", placeAccount);
$("accountDialog").addEventListener("close", () => {
  $("accountBtn").setAttribute("aria-expanded", "false");
  $("accountBtnSide").setAttribute("aria-expanded", "false");
  // Safari doesn't focus buttons on click, so the dialog has nothing to hand focus back to
  const a = panelAnchor; panelAnchor = null;
  if (a && isShown(a) && (!document.activeElement || document.activeElement === document.body)) a.focus({ preventScroll: true });
});
// The panel's content fills the dialog, so a click whose target is the dialog itself landed on the backdrop
$("accountDialog").addEventListener("click", e => { if (e.target === e.currentTarget) closeDialog(e.currentTarget); });
document.querySelectorAll("#accountDialog [data-icon]").forEach(el => el.replaceWith(svg(el.dataset.icon, 18)));
document.querySelectorAll('input[name="themePref"]').forEach(r => r.addEventListener("change", () => setThemePref(r.value)));
document.querySelectorAll('input[name="langPref"]').forEach(r => r.addEventListener("change", () => setLang(r.value)));
$("acctCycle").onclick = () => { closeDialog($("accountDialog")); openCycleDialog(); };
$("exportCsv").onclick = guard(() => exportData("csv"));
$("exportJson").onclick = guard(() => exportData("json"));
$("acctSignOut").onclick = guard(signOutSafely);
$("accountBtn").onclick = e => openAccount(e.currentTarget);
$("accountBtnSide").onclick = e => openAccount(e.currentTarget);

// ----- Sign out -----
const delay = ms => new Promise(r => setTimeout(r, ms));
// Signing out wipes the offline cache, which also holds writes the server hasn't received yet.
// Give them a chance to flush; if they can't (offline, or the server is slow), ask before throwing them away.
async function signOutSafely() {
  closeDialog($("accountDialog"));
  const flushed = waitForPendingWrites(db).then(() => true, () => true);
  let synced = await Promise.race([flushed, delay(400).then(() => false)]);
  if (!synced && navigator.onLine) {
    toast(t("signOutSyncing"));
    synced = await Promise.race([flushed, delay(8000).then(() => false)]);
    toast("");
  }
  if (!synced && !(await confirmAction(t("signOutUnsynced"), t("signOutAnyway")))) return;
  await signOutAndClear();
}
// Sign out and wipe this device's offline copy of the data, so the next person on a shared browser can't read it
async function signOutAndClear() {
  await signOut(auth);
  try { localStorage.removeItem(CYCLE_KEY); } catch (e) {}
  try { await terminate(db); await clearIndexedDbPersistence(db); }
  catch (e) { /* another tab still holds the cache; it is cleared once that tab signs out or closes */ }
  location.reload();
}

// ----- Export: CSV of every entry (for spreadsheets) or a JSON backup of everything -----
const ENTRY_COLS = [["expenses", "expense"], ["income", "income"], ["planned", "planned"]];
const ALL_COLS = ["expenses", "income", "planned", "recurring", "recurringIncome", "people", "loanTxns"];
const SETTINGS_DOCS = ["categories", "budgets", "preferences"];
// Quotes when needed; a leading = + - @ is neutralised so spreadsheets don't run a note as a formula
function csvCell(v) {
  if (typeof v === "number") return String(v);
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name, style: "display:none" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function exportData(format) {
  const uid = user.uid, btn = $(format === "csv" ? "exportCsv" : "exportJson");
  btn.disabled = true;
  try {
    // getDocs reads the server when reachable and falls back to this device's cache when offline
    const [snaps, settings] = await Promise.all([
      Promise.all(ALL_COLS.map(n => getDocs(userCol(n)))),
      Promise.all(SETTINGS_DOCS.map(n => getDoc(userDoc("settings", n))))
    ]);
    if (user?.uid !== uid) return;
    const data = Object.fromEntries(ALL_COLS.map((n, i) => [n, mapDocs(snaps[i])]));
    const stamp = todayISO();
    if (format === "json") {
      const out = {
        app: "expense-ledger", version: 1, exportedAt: new Date().toISOString(),
        settings: Object.fromEntries(SETTINGS_DOCS.map((n, i) => [n, settings[i].exists() ? settings[i].data() : null])),
        ...data
      };
      download(`expense-ledger-backup-${stamp}.json`, JSON.stringify(out, null, 2), "application/json");
    } else {
      const rows = ENTRY_COLS.flatMap(([n, type]) => data[n].map(e =>
        [type, e.date || "", e.category || "", Number(e.amount) || 0, e.note || "", e.recurringId ? "yes" : "", ""]));
      // Loan money: "loan gave" (lent, or repaid what you owed) and "loan got" (borrowed, or were repaid)
      const names = new Map(data.people.map(p => [p.id, p.name]));
      data.loanTxns.forEach(x => rows.push([`loan ${x.dir}`, x.date || "", "", Number(x.amount) || 0, x.note || "", "", names.get(x.personId) || ""]));
      rows.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
      const lines = [["Type", "Date", "Category", "Amount", "Note", "Recurring", "Person"], ...rows].map(r => r.map(csvCell).join(","));
      // BOM so Excel reads UTF-8 (Bangla notes) correctly
      download(`expense-ledger-${stamp}.csv`, "\uFEFF" + lines.join("\r\n"), "text/csv;charset=utf-8");
    }
    const fromCache = [...snaps, ...settings].some(x => x.metadata.fromCache);
    toast(t(fromCache ? "exportedOffline" : "exported"));
  } finally {
    btn.disabled = false;
  }
}

// Styled confirm for deletes that are hard to redo by hand. Resolves true only on the confirm button.
function confirmAction(message, yesLabel) {
  const d = $("confirmDialog");
  $("confirmMsg").textContent = message;
  $("confirmYes").textContent = yesLabel;
  return new Promise(resolve => {
    const done = v => { closeDialog(d); resolve(v); };
    $("confirmYes").onclick = () => done(true);
    $("confirmNo").onclick = () => done(false);
    d.oncancel = e => { e.preventDefault(); done(false); };
    d.onclick = e => { if (e.target === d) done(false); };
    openDialog(d);
    $("confirmNo").focus();
  });
}

// ----- Month start day -----
function openCycleDialog() {
  const d = $("cycleDialog"), sel = $("cycleDay");
  sel.replaceChildren(...Array.from({ length: 31 }, (_, i) => i + 1).map(n =>
    h("option", { value: n, text: n === 1 ? t("cycleCalendar", { day: fmtInt(n) }) : fmtInt(n) })));
  sel.value = String(startDay);
  const preview = () => { $("cyclePreview").textContent = t("cyclePreview", { range: periodLabel(periodOf(todayISO(), Number(sel.value)), Number(sel.value)) }); };
  sel.onchange = preview;
  preview();
  $("cycleCancel").onclick = () => closeDialog(d);
  d.onclick = e => { if (e.target === d) closeDialog(d); };
  $("cycleSave").onclick = guard(() => {
    const day = normalizeStartDay(sel.value);
    closeDialog(d);
    if (day === startDay) return;
    applyStartDay(day); // optimistic; the snapshot listener confirms
    writeInBackground(setDoc(userDoc("settings", "preferences"), { cycleStartDay: day }, { merge: true }));
    toast(t("cycleSaved", { day: fmtInt(day) }));
  });
  openDialog(d);
  sel.focus();
}

// Phone insights card remembers open/closed on this device
try { $("insightsCard").open = localStorage.getItem("insightsOpen") === "1"; } catch (e) {}
$("insightsCard").addEventListener("toggle", e => { try { localStorage.setItem("insightsOpen", e.currentTarget.open ? "1" : "0"); } catch (err) {} });


// ----- Language (remembered on this device) -----
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t("docTitle");
  setFormatters();
  document.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll("[data-i18n-aria]").forEach(el => { el.setAttribute("aria-label", t(el.dataset.i18nAria)); });
  showTab(currentTab);
  setKind(entryKind);
  budgetEditKey = "";
  renderAll();
}
function setLang(next) {
  if (next === lang) return;
  lang = next;
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

// ===== Entry sheet: expense / income / planned / loan, add or edit =====
let entryKind = "expense";
// Set while the sheet edits an existing item: { col, item }. Null when adding.
let editing = null;
const COL_KIND = { expenses: "expense", income: "income", planned: "planned", recurring: "expense", recurringIncome: "income", loanTxns: "loan" };
const isRuleCol = col => col === "recurring" || col === "recurringIncome";
const usesCategory = kind => kind === "expense" || kind === "planned";
const loanDir = () => document.querySelector('input[name="loanDir"]:checked')?.value || "gave";

function setKind(kind) {
  entryKind = kind;
  const radio = document.querySelector(`input[name="kind"][value="${kind}"]`);
  if (radio) radio.checked = true;
  const loan = kind === "loan";
  $("eCatField").hidden = !usesCategory(kind);
  $("ePersonField").hidden = !loan;
  $("eDirField").hidden = !loan;
  $("eRepeatRow").hidden = kind === "planned" || loan || !!editing;
  $("eNote").placeholder = t(kind === "income" ? "phSource" : kind === "planned" ? "phWhat" : loan ? "phLoanNote" : "phNote");
  $("entrySubmit").textContent = t(editing ? "saveChanges" : ADD_LABEL[kind]);
  clearFieldErrors();
  updateSheet();
}
document.querySelectorAll('input[name="kind"]').forEach(r => { r.onchange = () => setKind(r.value); });
document.querySelectorAll('input[name="loanDir"]').forEach(r => { r.onchange = updateSheet; });

// The amount box says what the money did and takes its colour: out (spent, gave), in (received, got), planned
const AMOUNT_MODE = {
  expense: ["amtSpent", "−", "out"], planned: ["amtPlan", "", "plan"], income: ["amtReceived", "+", "in"],
  gave: ["amtGave", "−", "out"], got: ["amtGot", "+", "in"]
};
// Everything in the sheet that depends on the type, direction, amount, person or note
function updateSheet() {
  const loan = entryKind === "loan", dir = loanDir();
  const [label, sign, tone] = AMOUNT_MODE[loan ? dir : entryKind];
  const hasAmount = $("eAmount").value !== "";
  $("eAmountLabel").textContent = t(label);
  $("eAmountSign").textContent = hasAmount ? sign : "";
  $("eAmountBox").dataset.tone = tone;
  $("eAmountClear").hidden = !hasAmount;
  $("eDirHint").textContent = t(dir === "gave" ? "dirHintGave" : "dirHintGot");
  updateLoanPreview();
  renderSuggestions();
}

// ----- Inline errors, shown under the field they're about -----
function fieldError(id, msg) { const el = $(id); el.textContent = msg; el.hidden = !msg; }
function clearFieldErrors() {
  ["eAmountErr", "ePersonErr", "eDateErr"].forEach(id => fieldError(id, ""));
  $("eAmountBox").classList.remove("invalid");
  $("eAmount").removeAttribute("aria-invalid");
}
$("eAmount").addEventListener("input", () => { $("eAmountBox").classList.remove("invalid"); $("eAmount").removeAttribute("aria-invalid"); fieldError("eAmountErr", ""); updateSheet(); });
$("eAmountClear").onclick = () => { $("eAmount").value = ""; $("eAmount").focus(); updateSheet(); };
$("eAmountBox").addEventListener("click", e => { if (!e.target.closest("button, input")) $("eAmount").focus(); });

// ----- Category chips: most used this month first (ties keep the list order). `select` pre-selects one; a
// category since removed from the list is still offered so editing can keep it. -----
function buildCatGrid(select) {
  const grid = $("eCatGrid");
  const prev = select || grid.querySelector("input:checked")?.value;
  const base = select && !categories.includes(select) ? [...categories, select] : categories;
  const uses = {};
  [...expenses, ...planned].forEach(e => { uses[e.category] = (uses[e.category] || 0) + 1; });
  const list = base.map((c, i) => [c, i]).sort((a, b) => (uses[b[0]] || 0) - (uses[a[0]] || 0) || a[1] - b[1]).map(([c]) => c);
  grid.replaceChildren(...list.map((c, i) => {
    const s = catStyle(c);
    return h("label", { class: "chip-opt" },
      h("input", { type: "radio", name: "cat", value: c, checked: (prev ? prev === c : i === 0) || null }),
      h("span", { class: "chip-face" }, h("span", { class: `cat-icon xs tone-${s.tone}` }, svg(s.icon, 16)), h("span", { text: catLabel(c) })));
  }));
  if (!grid.querySelector("input:checked")) grid.querySelector("input")?.click();
}
const checkCategory = c => { const r = [...$("eCatGrid").querySelectorAll("input")].find(i => i.value === c); if (r) r.checked = true; };

// ----- Person chips (loan): the 8 most recently active people with their balance, plus "New" -----
function buildPeopleChips(selectedId, { allowNew = true } = {}) {
  const st = loanState();
  const recent = [...st.entries].sort((a, b) => (b.last || "").localeCompare(a.last || "") || a.person.name.localeCompare(b.person.name));
  let shown = recent.slice(0, 8);
  if (selectedId && st.byId.has(selectedId) && !shown.some(e => e.person.id === selectedId)) shown = [st.byId.get(selectedId), ...shown.slice(0, 7)];
  const chip = e => h("label", { class: "chip-opt person-chip" },
    h("input", { type: "radio", name: "person", value: e.person.id, checked: e.person.id === selectedId || null }),
    h("span", { class: "chip-face" }, personIcon(e.person),
      h("span", { class: "pc-text" }, h("span", { class: "pc-name", text: e.person.name }),
        h("span", { class: `pc-bal ${balanceClass(e.balance)}`, text: e.balance ? `${balanceLabel(e.balance)} ${fmt(Math.abs(e.balance))}` : balanceLabel(0) }))));
  // With nobody yet, "New" is the only choice, so it starts selected
  const newChip = allowNew ? h("label", { class: "chip-opt new-chip" },
    h("input", { type: "radio", name: "person", value: "", checked: (!selectedId && !shown.length) || null }),
    h("span", { class: "chip-face" }, svg("plus", 16), h("span", { text: t("newPerson") }))) : null;
  $("ePeople").replaceChildren(...shown.map(chip), newChip);
  $("peopleNames").replaceChildren(...st.entries.map(e => h("option", { value: e.person.name })));
  $("ePersonNew").value = "";
  syncPersonNew();
}
const personChoice = () => $("ePeople").querySelector('input[name="person"]:checked')?.value;
function syncPersonNew() { $("ePersonNew").hidden = personChoice() !== ""; }
// The person the sheet points at: a chip, or a typed name (an existing person if it matches one)
function sheetPerson() {
  const v = personChoice();
  if (v === undefined) return { person: null, typed: "", isNew: false };
  if (v) return { person: people.find(p => p.id === v) || null, typed: "", isNew: false };
  const typed = cleanName($("ePersonNew").value);
  return { person: findPerson(people, typed), typed, isNew: true };
}
$("ePeople").addEventListener("change", () => {
  syncPersonNew();
  fieldError("ePersonErr", "");
  if (personChoice() === "") $("ePersonNew").focus();
  updateSheet();
});
$("ePersonNew").addEventListener("input", () => { fieldError("ePersonErr", ""); updateLoanPreview(); });

// Live "After this: Rahim owes you ৳3,000" above Save
function updateLoanPreview() {
  const el = $("ePreview");
  const amount = parseNum($("eAmount").value), { person, typed } = sheetPerson(), name = person ? person.name : typed;
  if (entryKind !== "loan" || !name || !(amount > 0)) { el.hidden = true; el.textContent = ""; return; }
  const txn = editing?.col === "loanTxns" ? editing.item : null;
  const base = person ? loanState().byId.get(person.id)?.balance || 0 : 0;
  // An edit replaces the entry's old effect, but only on the person it already belonged to
  const next = balanceWith(base, { dir: loanDir(), amount }, txn && person && txn.personId === person.id ? txn : null);
  el.textContent = t("previewAfter", { status: statusText(name, next) });
  el.hidden = false;
}

// ----- Date chips: Today, Yesterday, or any date from the picker. eDate holds the value. -----
function setDate(iso) { $("eDate").value = iso; syncDateChips(); }
function syncDateChips() {
  const v = $("eDate").value, today = todayISO(), yest = addDays(today, -1);
  document.querySelectorAll('input[name="dateChoice"]').forEach(r => { r.checked = (r.value === "today" && v === today) || (r.value === "yesterday" && v === yest); });
  const other = !!v && v !== today && v !== yest;
  $("eDatePick").classList.toggle("selected", other);
  $("eDateLabel").textContent = other ? fmtDate(v) : t("pickDate");
  if (v) fieldError("eDateErr", "");
}
document.querySelectorAll('input[name="dateChoice"]').forEach(r => { r.onchange = () => setDate(r.value === "today" ? todayISO() : addDays(todayISO(), -1)); });
$("eDate").addEventListener("change", syncDateChips);
// The date input covers its chip invisibly: phones open their picker on tap; desktop browsers need showPicker()
$("eDate").addEventListener("click", () => { try { $("eDate").showPicker(); } catch (e) { /* opens natively, or unsupported */ } });

// ----- Note suggestions: the notes used most for this type, narrowed as you type. Picking one for an
// expense or plan also picks the category it was last used with ("Uber" → Transport). -----
function noteSuggestions(kind, typed) {
  const src = kind === "income" ? income : kind === "loan" ? loanTxns : [...expenses, ...planned];
  const byNote = new Map();
  for (const x of src) {
    const note = (x.note || "").trim();
    if (!note) continue;
    const key = note.toLocaleLowerCase(), at = x.createdAt || 0;
    const m = byNote.get(key) || { note, count: 0, last: -1, category: null };
    m.count++;
    if (at >= m.last) { m.last = at; m.note = note; m.category = x.category || null; }
    byNote.set(key, m);
  }
  const q = typed.trim().toLocaleLowerCase();
  return [...byNote.values()]
    .filter(m => { const n = m.note.toLocaleLowerCase(); return !q || (n.startsWith(q) && n !== q); })
    .sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 4);
}
function renderSuggestions() {
  const box = $("eSuggest"), list = noteSuggestions(entryKind, $("eNote").value);
  box.hidden = !list.length;
  box.replaceChildren(...(list.length ? [h("span", { class: "suggest-label", text: t("recentNotes") })] : []),
    ...list.map(m => h("button", { type: "button", class: "chip", onclick: () => {
      $("eNote").value = m.note;
      if (usesCategory(entryKind) && m.category) checkCategory(m.category);
      renderSuggestions();
    } }, m.note)));
}
$("eNote").addEventListener("input", renderSuggestions);

// Default date: today when viewing the current period (or on Loans, which isn't tied to one), otherwise the first
// day of the viewed period
const defaultDate = () => { const r = currentRange(), today = todayISO(); return currentTab === "loans" || inPeriod(today, r) ? today : r.start; };

// kind: the entry type; col + item: what is being edited (none when adding);
// personId / dir: a new loan entry started from a person's page ("I gave" / "I got")
function openSheet(kind, col = null, item = null, { personId = null, dir = null } = {}) {
  if (!user) return;
  editing = item ? { col, item } : null;
  const rule = !!item && isRuleCol(col), loanEdit = col === "loanTxns";
  closeMenu(false);
  buildCatGrid(item?.category);
  const pid = loanEdit ? item.personId : personId;
  const balance = (pid && loanState().byId.get(pid)?.balance) || 0;
  document.querySelector(`input[name="loanDir"][value="${item?.dir || dir || (balance > 0 ? "got" : "gave")}"]`).checked = true;
  buildPeopleChips(pid, { allowNew: !loanEdit });
  $("eKindSeg").hidden = !!item; // moving an item between types isn't an edit
  $("eDateField").hidden = rule;
  $("eDayRow").hidden = !rule;
  $("eNote").value = item?.note || "";
  $("eRepeat").checked = false;
  // The button that settles up pre-fills the outstanding amount (selected, so typing replaces it)
  const settles = !item && dir && (dir === "got" ? balance > 0 : balance < 0);
  const amount = item ? item.amount : settles ? Math.abs(balance) : null;
  $("eAmount").value = amount == null ? "" : formatAmountInput(plainFmt.format(amount)).value;
  setDate(item && !rule ? item.date : defaultDate());
  if (rule) {
    $("eDay").replaceChildren(...Array.from({ length: 31 }, (_, i) => h("option", { value: i + 1, text: fmtInt(i + 1) })));
    $("eDay").value = String(item.day);
  }
  setKind(kind); // after the fields are filled: it refreshes everything that depends on them
  $("entryTitle").textContent = t(!item ? "newEntry" : rule ? "editRecurring" : loanEdit ? "editLoan" : "editEntry");
  openDialog($("entryDialog"));
  $("eAmount").focus();
  if ($("eAmount").value) $("eAmount").select();
}
const openEntry = (kind = KIND_FOR_TAB[currentTab]) => openSheet(kind, null, null, kind === "loan" ? { personId: selectedPerson } : {});
const openEdit = (col, item) => openSheet(COL_KIND[col], col, item);
const openLoanSheet = ({ personId = null, dir = null, txn = null } = {}) => openSheet("loan", txn ? "loanTxns" : null, txn, { personId, dir });
$("fab").onclick = () => openEntry();
$("addBtn").onclick = () => openEntry();
$("entryCancel").onclick = () => closeDialog($("entryDialog"));
// Clicking the dimmed backdrop closes the sheet
$("entryDialog").addEventListener("click", e => { if (e.target === e.currentTarget) closeDialog(e.currentTarget); });
$("entryForm").addEventListener("submit", e => { e.preventDefault(); guard(submitEntry)(); });

// Phones: keep the sheet, and its Save button, above the on-screen keyboard. iOS doesn't shrink the layout viewport
// for the keyboard, so the sheet is lifted by the part of the window the keyboard covers (0 everywhere else).
const vv = window.visualViewport;
function fitSheetToKeyboard() {
  const a = document.activeElement;
  const typing = !!a?.closest?.("dialog.sheet") && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
  const kb = vv && typing ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
  document.documentElement.style.setProperty("--kb", kb + "px");
}
vv?.addEventListener("resize", fitSheetToKeyboard);
vv?.addEventListener("scroll", fitSheetToKeyboard);
document.addEventListener("focusin", fitSheetToKeyboard);
document.addEventListener("focusout", () => setTimeout(fitSheetToKeyboard, 60));

// A write lands in the local cache at once, and the snapshot listeners update the screen from there; its promise
// settles only when the server acknowledges it, which can take seconds, or never while offline. So the sheet closes
// and confirms straight away, and a write the server rejects surfaces later as an error toast.
const writeInBackground = p => { p.catch(onErr); };

function submitEntry() {
  if ("leaving" in $("entryDialog").dataset) return; // Enter while the sheet animates out
  const amount = parseNum($("eAmount").value);
  const editingRule = !!editing && isRuleCol(editing.col);
  const date = $("eDate").value;
  let bad = null;
  if (!(amount > 0)) {
    fieldError("eAmountErr", t("amountNeeded"));
    $("eAmountBox").classList.add("invalid");
    $("eAmount").setAttribute("aria-invalid", "true");
    bad = $("eAmount");
  }
  if (!date && !editingRule) { fieldError("eDateErr", t("dateNeeded")); bad ||= $("eDate"); }
  if (bad) { bad.focus(); return; }
  const note = $("eNote").value.trim();
  if (entryKind === "loan") { submitLoan({ amount, date, note }); return; }
  const category = $("eCatGrid").querySelector("input:checked")?.value || categories[0];
  const repeat = !editing && entryKind !== "planned" && $("eRepeat").checked;
  if (editing) { saveEdit({ amount, date, note, category }); return; }
  // Close before writing, so the totals and bars visibly update as the sheet leaves
  closeDialog($("entryDialog"));
  let msg;
  if (entryKind === "planned") {
    writeInBackground(addDoc(userCol("planned"), { amount, category, date, note, createdAt: Date.now() }));
    msg = t("plannedAdded");
  } else {
    const isIncome = entryKind === "income";
    let recurringId = null;
    // A repeating entry also creates its rule, linked by id so "Add all" won't duplicate this month's entry.
    // The id is generated locally, so neither write waits for the other.
    if (repeat) {
      const day = Number(date.slice(8, 10));
      const rule = isIncome ? { amount, day, note } : { amount, category, day, note };
      const ruleRef = doc(userCol(isIncome ? "recurringIncome" : "recurring"));
      recurringId = ruleRef.id;
      writeInBackground(setDoc(ruleRef, rule));
    }
    const data = { amount, date, note, recurringId, createdAt: Date.now() };
    if (!isIncome) data.category = category;
    writeInBackground(addDoc(userCol(isIncome ? "income" : "expenses"), data));
    msg = t(isIncome ? (repeat ? "incomeAddedRec" : "incomeAdded") : (repeat ? "expenseAddedRec" : "expenseAdded"));
  }
  setMonth(periodOf(date, startDay));
  toast(msg);
}

// Updates the item being edited; only the fields the sheet shows are touched (createdAt, recurringId stay)
function saveEdit({ amount, date, note, category }) {
  const { col, item } = editing;
  const rule = isRuleCol(col);
  const changes = { amount, note };
  if (COL_KIND[col] !== "income") changes.category = category;
  if (rule) changes.day = Number($("eDay").value); else changes.date = date;
  closeDialog($("entryDialog"));
  if (Object.keys(changes).every(k => changes[k] === (item[k] ?? (k === "note" ? "" : undefined)))) return;
  const uid = user.uid, { id, ...before } = item;
  const ref = doc(db, "users", uid, col, id);
  writeInBackground(updateDoc(ref, changes));
  if (!rule) setMonth(periodOf(date, startDay));
  toast(t(rule ? "ruleUpdated" : "entryUpdated"), { actionLabel: t("undo"), onAction: () => {
    writeInBackground(setDoc(ref, before));
    toast(t("restored"));
  } });
}

// A loan entry: "gave" or "got" with a person. A new name creates the person, in the same batch as the entry.
// Editing can move the entry to another existing person.
function submitLoan({ amount, date, note }) {
  const dir = loanDir(), txn = editing?.col === "loanTxns" ? editing.item : null;
  const { person, typed, isNew } = sheetPerson();
  if (!person && !typed) {
    fieldError("ePersonErr", t(isNew ? "needName" : "pickPerson"));
    (isNew ? $("ePersonNew") : $("ePeople").querySelector("input"))?.focus();
    return;
  }
  if (txn && !person) { closeDialog($("entryDialog")); toast(t("personGone"), { error: true }); return; } // deleted elsewhere meanwhile
  const name = person ? person.name : typed; // an existing person keeps their spelling, whatever was typed
  closeDialog($("entryDialog"));
  const uid = user.uid;

  if (txn) {
    const { id, ...before } = txn;
    const changes = { dir, amount, date, note, personId: person.id };
    if (Object.keys(changes).every(k => changes[k] === (before[k] ?? (k === "note" ? "" : undefined)))) return;
    const ref = doc(db, "users", uid, "loanTxns", id);
    writeInBackground(updateDoc(ref, changes));
    toast(t("entryUpdated"), { actionLabel: t("undo"), onAction: () => { writeInBackground(setDoc(ref, before)); toast(t("restored")); } });
    return;
  }
  const prev = person ? loanState().byId.get(person.id)?.balance || 0 : 0;
  const ops = [];
  let pid = person?.id;
  if (!pid) {
    const ref = doc(userCol("people"));
    pid = ref.id;
    ops.push(b => b.set(ref, { name, createdAt: Date.now() }));
  }
  const txnRef = doc(userCol("loanTxns"));
  ops.push(b => b.set(txnRef, { personId: pid, dir, amount, date, note, createdAt: Date.now() }));
  writeAll(ops);
  toast(t("savedStatus", { status: statusText(name, balanceWith(prev, { dir, amount })) }));
}

function openRename(person) {
  const d = $("nameDialog"), input = $("nameInput");
  input.value = person.name;
  $("nameCancel").onclick = () => closeDialog(d);
  d.onclick = e => { if (e.target === d) closeDialog(d); };
  $("nameForm").onsubmit = e => {
    e.preventDefault();
    if ("leaving" in d.dataset) return;
    const name = cleanName(input.value);
    if (!name) { input.focus(); return; }
    const clash = findPerson(people, name);
    if (clash && clash.id !== person.id) { toast(t("nameExists", { name }), { error: true }); input.focus(); return; }
    closeDialog(d);
    if (name === person.name) return;
    writeInBackground(updateDoc(userDoc("people", person.id), { name }));
    toast(t("renamed"));
  };
  openDialog(d);
  input.focus();
  input.select();
}

// Deletes the person and every entry with them; Undo restores all of it with the same ids.
// Entries go before the person (and come back after it), so a batch split can't leave entries with nobody.
async function deletePerson(person) {
  const txns = loanTxns.filter(x => x.personId === person.id);
  if (!(await confirmAction(t("confirmDelPerson", { name: person.name, n: fmtInt(txns.length) }), t("delete")))) return;
  const uid = user.uid;
  const pRef = doc(db, "users", uid, "people", person.id);
  const { id, ...pData } = person;
  const saved = txns.map(({ id: tid, ...data }) => [doc(db, "users", uid, "loanTxns", tid), data]);
  writeAll([...saved.map(([ref]) => b => b.delete(ref)), b => b.delete(pRef)]);
  if (selectedPerson === person.id) { selectedPerson = null; syncHash(false); renderLists(); }
  toast(t("deletedPerson", { name: person.name }), { actionLabel: t("undo"), onAction: () => {
    writeAll([b => b.set(pRef, pData), ...saved.map(([ref, data]) => b => b.set(ref, data))]);
    toast(t("restored"));
  } });
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
  syncHash(false);

  onAuthStateChanged(auth, u => {
    user = u;
    stopListeners();
    closeMenu(false);
    // The account changed under them, so they go at once rather than animating over the new state
    ["entryDialog", "cycleDialog", "accountDialog", "nameDialog"].forEach(id => closeDialog($(id), { instant: true }));
    if (u) {
      document.body.dataset.auth = "in";
      subscribeAll();
      watchQueuedWrites();
    } else {
      document.body.dataset.auth = "out";
      queuedFromBefore = false;
      expenses = []; income = []; planned = []; budgets = {}; recurring = []; recurringIncome = [];
      people = []; loanTxns = [];
      categories = [...DEFAULT_CATEGORIES];
      editingBudgets = false;
      applyStartDay(DEFAULT_START_DAY);
    }
    renderAll();
  });
}

function stopListeners() {
  unsubs.forEach(f => f()); unsubs = [];
  monthUnsubs.forEach(f => f()); monthUnsubs = [];
  monthPending = new Set(MONTH_COLS);
  loansPending = new Set(LOAN_COLS);
  cancelMonthSlide();
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
  unsubs.push(onSnapshot(userDoc("settings", "preferences"), s => {
    applyStartDay(s.exists() ? s.data().cycleStartDay : DEFAULT_START_DAY);
  }, onErr));
  unsubs.push(onSnapshot(userCol("recurring"), s => { recurring = mapDocs(s); renderAll(); }, onErr));
  unsubs.push(onSnapshot(userCol("recurringIncome"), s => { recurringIncome = mapDocs(s); renderAll(); }, onErr));
  loansPending = new Set(LOAN_COLS);
  const listenLoans = (name, assign) => onSnapshot(userCol(name),
    s => { assign(mapDocs(s)); loansPending.delete(name); renderAll(); },
    e => { loansPending.delete(name); onErr(e); });
  unsubs.push(listenLoans("people", docs => { people = docs; }), listenLoans("loanTxns", docs => { loanTxns = docs; }));
}

// Listens to expenses, income and planned items for the selected period only
function subscribeMonth() {
  monthUnsubs.forEach(f => f()); monthUnsubs = [];
  monthPending = new Set(MONTH_COLS);
  const { start, end } = currentRange();
  const listen = (name, assign) => onSnapshot(
    query(userCol(name), where("date", ">=", start), where("date", "<=", end), orderBy("date", "desc")),
    s => { assign(mapDocs(s)); monthPending.delete(name); renderAll(); },
    e => { monthPending.delete(name); onErr(e); });
  monthUnsubs.push(
    listen("expenses", docs => { expenses = sortDesc(docs); }),
    listen("income", docs => { income = sortDesc(docs); }),
    listen("planned", docs => { planned = docs; }));
}
// Newest first; same-day entries by creation time
const sortDesc = arr => arr.sort((a, b) => (b.date || "").localeCompare(a.date || "") || (b.createdAt || 0) - (a.createdAt || 0));
const sortAsc = arr => [...arr].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0));

// ===== Rendering =====
// Month data is settled once all three month listeners have delivered. Changes animate only between two settled
// renders, so loading and month switches show their numbers at once instead of counting up from zero.
const MONTH_COLS = ["expenses", "income", "planned"];
let monthPending = new Set(MONTH_COLS);
// Loan money counts towards "Left to spend", so the summary is settled only once loans have loaded too
const LOAN_COLS = ["people", "loanTxns"];
let loansPending = new Set(LOAN_COLS);
let lastRenderSettled = false;

function renderAll() {
  const settled = monthPending.size === 0 && loansPending.size === 0;
  const animate = settled && lastRenderSettled && !reducedMotion.matches && !document.hidden;
  lastRenderSettled = settled;
  renderSummary(animate);
  renderLists(animate);
  renderBudgets();
  renderSide();
  renderChart();
  renderBadges();
  renderAccount();
  animateBars(animate);
  pulseNewlyOver(animate);
  if (settled && monthSlide) finishMonthSlide();
}

// ----- List motion. Rows are rebuilt on every render, so arrivals and departures are found by data-key: a new key
// grows in from zero height, a vanished one goes back in as an inert ghost that collapses away, and a row whose
// content changed flashes. Animating height lets everything below follow the layout, with no per-row offsets.
const LIST_IDS = ["list", "incomeList", "plannedList", "recurring", "recurringIncome", "loanOpen", "loanSettled", "loanTimeline"];
const LIST_MS = 260;
const keyedChildren = el => (el ? [...el.children].filter(c => c.dataset.key) : []);
// Grouped lists are day groups (keyed) holding rows (keyed); flat lists are rows only
function captureList(box) {
  return keyedChildren(box).map(node => {
    const inner = node.querySelector(":scope > .day-rows");
    return { key: node.dataset.key, node, text: node.textContent, inner, children: inner ? captureLevel(inner) : null };
  });
}
const captureLevel = el => keyedChildren(el).map(node => ({ key: node.dataset.key, node, text: node.textContent }));

function animateList(box, before) {
  const after = captureList(box);
  diffLevel(box, before, after);
  // The last item went: it collapses above the empty state, which grows in (diffLevel put the ghosts first)
  const empty = box.querySelector(":scope > .empty");
  if (empty && before.length) growIn(empty);
}
function diffLevel(parent, before, after) {
  const now = new Map(after.map(i => [i.key, i]));
  const old = new Map(before.map(i => [i.key, i]));
  // Departed items go back where they were: before the next item that is still there, else at the end
  // (or, when nothing is left, above the empty state)
  const end = after.length ? null : parent.firstElementChild;
  const ghosts = before.filter(i => !now.has(i.key)).map(i => {
    const next = before.slice(before.indexOf(i) + 1).find(j => now.has(j.key));
    makeGhost(i.node);
    parent.insertBefore(i.node, next ? now.get(next.key).node : end);
    return i.node;
  });
  after.forEach(i => {
    const was = old.get(i.key);
    if (!was) { growIn(i.node); (i.children ? i.children.map(c => c.node) : [i.node]).forEach(flashRow); }
    else if (i.children) diffLevel(i.inner, was.children, i.children);
    else if (was.text !== i.text) flashRow(i.node);
  });
  ghosts.forEach(collapseOut);
}
function makeGhost(node) {
  node.inert = true;
  node.setAttribute("aria-hidden", "true");
  [node, ...node.querySelectorAll("[data-key]")].forEach(n => n.removeAttribute("data-key")); // never captured again
}
// Box metrics animated alongside height, so a row with padding and a min-height can reach zero
const BOX_PROPS = ["minHeight", "paddingTop", "paddingBottom", "borderTopWidth"];
const boxFrame = (el, height, opacity) => {
  const cs = getComputedStyle(el), f = { height: height + "px", opacity };
  BOX_PROPS.forEach(p => { f[p] = cs[p]; });
  return f;
};
const zeroFrame = { height: "0px", opacity: 0, minHeight: "0px", paddingTop: "0px", paddingBottom: "0px", borderTopWidth: "0px" };
function growIn(el) {
  const h = el.offsetHeight;
  if (!h) return; // in a hidden tab
  el.style.overflow = "hidden";
  el.animate([zeroFrame, boxFrame(el, h, 1)], { duration: LIST_MS, easing: EASE_OUT })
    .finished.catch(() => {}).then(() => { el.style.overflow = ""; });
}
function collapseOut(el) {
  const h = el.offsetHeight;
  if (!h) { el.remove(); return; }
  el.style.overflow = "hidden";
  el.animate([boxFrame(el, h, 1), zeroFrame], { duration: LIST_MS, easing: "cubic-bezier(.4, 0, .2, 1)" })
    .finished.catch(() => {}).then(() => el.remove());
}
function flashRow(el) {
  const soft = getComputedStyle(document.documentElement).getPropertyValue("--accent-soft").trim();
  el.animate([{ backgroundColor: soft }, { backgroundColor: "rgba(0, 0, 0, 0)" }], { duration: 1400, easing: "ease-in" });
}

// ----- Over budget: when a change pushes a category over its limit, its bars blink and the Budgets badge pulses -----
let overBefore = null; // categories over budget at the last render
function pulseNewlyOver(animate) {
  const byCat = spentByCategory();
  const over = new Set(categories.filter(c => budgetInfo(c, byCat).over));
  const fresh = animate && overBefore ? [...over].filter(c => !overBefore.has(c)) : [];
  overBefore = over;
  if (!fresh.length) return;
  const keys = new Set(fresh.flatMap(c => ["budget:" + c, "watch:" + c]));
  document.querySelectorAll("[data-bar]").forEach(el => {
    if (keys.has(el.dataset.bar)) el.animate([{ opacity: 1 }, { opacity: .25 }, { opacity: 1 }], { duration: 450, iterations: 2, delay: 450 });
  });
  $("badge-budgets").animate([{ transform: "scale(1)" }, { transform: "scale(1.6)" }, { transform: "scale(1)" }], { duration: 450, iterations: 2, easing: "ease-in-out" });
}

// ----- Month change: the current month slides out at once; the new one slides in when its data has arrived -----
let monthSlide = null; // { dir, out, timer } while a month change waits for its data
function startMonthSlide(dir) {
  cancelMonthSlide();
  if (!user || reducedMotion.matches || document.hidden) return;
  const out = $("appCards").animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${-dir * 24}px)` }],
    { duration: 140, easing: "cubic-bezier(.4, 0, 1, 1)", fill: "forwards" });
  // If the data is slow (or a listener fails), show what there is rather than a blank page
  monthSlide = { dir, out, timer: setTimeout(finishMonthSlide, 1500) };
}
function finishMonthSlide() {
  if (!monthSlide) return;
  const { dir, out, timer } = monthSlide;
  monthSlide = null;
  clearTimeout(timer);
  // Let the slide-out finish first; a newer month change cancels it, which skips this one
  out.finished.then(() => {
    out.cancel();
    $("appCards").animate([{ opacity: 0, transform: `translateX(${dir * 24}px)` }, { opacity: 1, transform: "none" }],
      { duration: 260, easing: EASE_OUT });
    drawChartIn();
  }, () => {});
}
function cancelMonthSlide() {
  if (!monthSlide) return;
  clearTimeout(monthSlide.timer);
  monthSlide.out.cancel();
  monthSlide = null;
}
// The spending line reveals left to right, then its end dot and label appear
function drawChartIn() {
  document.querySelectorAll(".chart-plot > svg").forEach(el => el.animate(
    [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 650, delay: 120, easing: EASE_OUT, fill: "backwards" }));
  document.querySelectorAll(".chart-plot > .chart-dot, .chart-plot > .chart-tip").forEach(el => el.animate(
    [{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 700, fill: "backwards" }));
}

// ----- Animated amounts: a changed total counts from the value on screen to the new one -----
const shownAmounts = new WeakMap(); // element → { value, raf }: value is what is displayed right now
function setAmount(el, value, format, animate) {
  const prev = shownAmounts.get(el);
  if (prev) cancelAnimationFrame(prev.raf);
  const from = prev?.value;
  const state = { value };
  shownAmounts.set(el, state);
  if (!animate || from == null || from === value) { el.textContent = format(value); return; }
  state.value = from;
  const duration = 700;
  let start; // from the first frame's timestamp, which can be earlier than performance.now() here
  const step = now => {
    start ??= now;
    const p = Math.min(1, (now - start) / duration);
    state.value = p < 1 ? from + (value - from) * (1 - (1 - p) ** 3) : value; // ease-out cubic
    el.textContent = format(p < 1 ? Math.round(state.value) : value);
    if (p < 1) state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
}

// ----- Animated bars: they are rebuilt on every render, so each one's last width is kept by its data-bar key -----
const barWidths = new Map();
function animateBars(animate) {
  const prev = new Map(barWidths); // read old widths from a copy: one key can appear twice (the phone insights clone)
  document.querySelectorAll("[data-bar]").forEach(el => {
    const key = el.dataset.bar, to = el.style.width;
    if (!to) return;
    const from = prev.get(key) || "0%";
    barWidths.set(key, to);
    if (animate && from !== to) el.animate([{ width: from }, { width: to }], { duration: 700, easing: EASE_OUT });
  });
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

// Derived loan state, recomputed only when a loan snapshot replaces one of the arrays
let loanMemo = null;
function loanState() {
  if (loanMemo && loanMemo.people === people && loanMemo.txns === loanTxns) return loanMemo;
  const entries = balances(people, loanTxns);
  return (loanMemo = {
    people, txns: loanTxns, entries, totals: totals(entries),
    byId: new Map(entries.map(e => [e.person.id, e]))
  });
}
const loanFlowNow = () => { const { start, end } = currentRange(), { byId } = loanState(); return flowBetween(loanTxns, start, end, id => byId.has(id)); };

function renderSummary(animate) {
  $("monthLabel").textContent = periodLabel(selectedMonth);
  const spent = sum(expenses), earned = sum(income), plannedTotal = sum(planned);
  // Cash view: loan money that moved this period counts (borrowed/repaid to you in, lent/repaid by you out).
  // Spending itself is only ever the expenses, so budgets and categories never see loans.
  const flow = loanFlowNow(), hasLoanFlow = flow.in > 0 || flow.out > 0;
  const balance = earned - spent + flow.in - flow.out, left = balance - plannedTotal;
  $("leftLabel").textContent = t(left < 0 ? "overPlan" : "leftToSpend");
  setAmount($("leftValue"), left, v => fmt(Math.abs(v)), animate);
  $("leftValue").classList.toggle("neg", left < 0);
  // How the big number is reached, read top to bottom: balance − planned (or income − spent when nothing is planned).
  // When loan money moved, it gets its own lines so borrowed cash never hides inside the total.
  const lines = hasLoanFlow ? [
    ["heroIncomeSpent", signed(earned - spent), earned - spent < 0 ? "neg" : "pos"],
    flow.in ? ["heroLoanIn", "+ " + fmt(flow.in), "pos"] : null,
    flow.out ? ["heroLoanOut", "− " + fmt(flow.out), "spent"] : null,
    plannedTotal ? ["statPlanned", "− " + fmt(plannedTotal), "planned"] : null
  ].filter(Boolean) : plannedTotal
    ? [["heroBalance", signed(balance), balance < 0 ? "neg" : "pos"], ["statPlanned", "− " + fmt(plannedTotal), "planned"]]
    : [["statIncome", fmt(earned), "pos"], ["statSpent", "− " + fmt(spent), "spent"]];
  $("leftSub").replaceChildren(...lines.map(([key, amt, tone]) => h("div", { class: `hb-row ${tone}` },
    h("span", { class: "hb-label", text: t(key) }), h("span", { class: "hb-amt num", text: amt }))));

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

  setAmount($("incomeTotal"), earned, fmt, animate);
  setAmount($("total"), spent, fmt, animate);
  setAmount($("planned"), plannedTotal, fmt, animate);
  $("incomeSub").textContent = t("entries", { n: fmtInt(income.length) });
  $("spentSub").textContent = earned > 0
    ? t("kpiSpentSub", { pct: fmtInt(Math.round(spent / earned * 100)), n: fmtInt(expenses.length) })
    : t("entries", { n: fmtInt(expenses.length) });
  $("plannedSub").textContent = t("kpiPlannedSub", { n: fmtInt(planned.length) });

  // Phone entry point to Loans (tablet and desktop have it in the nav)
  const lt = loanState().totals;
  $("loansLinkSub").textContent = lt.owedToYou || lt.youOwe
    ? [lt.owedToYou ? t("linkToGet", { amt: fmt(lt.owedToYou) }) : null, lt.youOwe ? t("linkToGive", { amt: fmt(lt.youOwe) }) : null].filter(Boolean).join(" · ")
    : t("loansLinkEmpty");
}

function renderBadges() {
  const count = (id, n) => { $(id).textContent = n ? fmtInt(n) : ""; };
  count("badge-expenses", expenses.length);
  count("badge-income", income.length);
  count("badge-planned", planned.length);
  const lt = loanState().totals;
  count("badge-loans", lt.toYouN + lt.youOweN);
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
// Every snapshot re-renders everything, so a container whose output wouldn't change keeps its nodes: rebuilding it
// would cut off animations still running there (and do needless work). Each one remembers what it last showed.
const lastRendered = new WeakMap();
function unchanged(box, ...inputs) {
  const sig = JSON.stringify(inputs);
  if (lastRendered.get(box) === sig) return true;
  lastRendered.set(box, sig);
  return false;
}

function renderGrouped(boxId, items, rowFn, empty) {
  const box = $(boxId);
  if (unchanged(box, items, lang, todayISO(), empty.msg, empty.actionLabel)) return; // today's date: "Today" labels
  if (!items.length) { box.replaceChildren(emptyState(empty)); return; }
  box.replaceChildren(...groupByDate(items).map(g => h("div", { class: "day-group", "data-key": "day:" + g.date },
    h("div", { class: "day-head" }, h("span", { text: dayLabel(g.date) }), h("span", { class: "num", text: fmt(g.total) })),
    h("div", { class: "day-rows" }, g.items.map(rowFn)))));
}
function renderFlat(boxId, items, rowFn, emptyMsg) {
  const box = $(boxId);
  if (unchanged(box, items, lang, emptyMsg)) return;
  box.replaceChildren(...(items.length ? items.map(rowFn) : [emptyState({ msg: emptyMsg })]));
}

// onOpen: tapping the row (outside its buttons) opens the editor; the ⋯ menu's Edit does the same for keyboard users
// key: "<collection>:<id>", which list motion uses to tell arriving and departing rows apart
function entryRow({ key, icon, title, sub, amount, amountClass = "", menu, extra, onOpen }) {
  return h("div", { class: onOpen ? "row tappable" : "row", "data-key": key, onclick: onOpen ? e => { if (!e.target.closest("button")) onOpen(); } : null },
    icon,
    h("div", { class: "row-info" }, h("div", { class: "row-title", text: title }), sub ? h("div", { class: "row-sub", text: sub }) : null),
    h("span", { class: `row-amt num ${amountClass}`, text: amount }),
    extra || null,
    menu ? h("button", { type: "button", class: "icon-btn row-menu", "aria-haspopup": "menu", "aria-expanded": "false",
      "aria-label": t("moreActions", { name: title }), onclick: e => openMenu(e.currentTarget, menu) }, svg("more", 20)) : null);
}
const editItem = (col, item) => ({ icon: "edit", label: t("edit"), onSelect: () => openEdit(col, item) });
const deleteItem = (col, item, msgKey) => [editItem(col, item), { icon: "trash", label: t("delete"), danger: true, onSelect: guard(() => deleteWithUndo(col, item, t(msgKey))) }];
const incomeIcon = () => h("span", { class: "cat-icon tone-5" }, svg("income"));

const expenseRow = e => entryRow({
  key: "expenses:" + e.id,
  icon: catIcon(e.category),
  title: e.note || catLabel(e.category),
  sub: [e.note ? catLabel(e.category) : null, e.recurringId ? t("monthly") : null].filter(Boolean).join(" · "),
  amount: fmt(e.amount),
  menu: deleteItem("expenses", e, "deletedExpense"), onOpen: () => openEdit("expenses", e)
});
const incomeRow = i => entryRow({
  key: "income:" + i.id,
  icon: incomeIcon(),
  title: i.note || t("income"),
  sub: i.recurringId ? t("monthly") : "",
  amount: "+" + fmt(i.amount), amountClass: "pos",
  menu: deleteItem("income", i, "deletedIncome"), onOpen: () => openEdit("income", i)
});
const plannedRow = p => entryRow({
  key: "planned:" + p.id,
  icon: catIcon(p.category),
  title: p.note || catLabel(p.category),
  sub: p.note ? catLabel(p.category) : "",
  amount: fmt(p.amount),
  extra: h("button", { type: "button", class: "mark-btn", "aria-label": `${t("markSpent")}: ${p.note || catLabel(p.category)}`,
    onclick: guard(() => markSpent(p)) }, svg("check", 18), h("span", { class: "mark-label", text: t("markSpent") })),
  menu: deleteItem("planned", p, "deletedPlanned"), onOpen: () => openEdit("planned", p)
});
const ruleRow = (r, isIncome) => entryRow({
  key: (isIncome ? "recurringIncome:" : "recurring:") + r.id,
  icon: isIncome ? incomeIcon() : catIcon(r.category),
  title: r.note || (isIncome ? t("income") : catLabel(r.category)),
  sub: [isIncome ? null : catLabel(r.category), t("dayOfMonth", { day: fmtInt(r.day) })].filter(Boolean).join(" · "),
  amount: (isIncome ? "+" : "") + fmt(r.amount), amountClass: isIncome ? "pos" : "",
  onOpen: () => openEdit(isIncome ? "recurringIncome" : "recurring", r),
  menu: [editItem(isIncome ? "recurringIncome" : "recurring", r), { icon: "trash", label: t("delete"), danger: true, onSelect: guard(async () => {
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

function renderLists(animate = false) {
  const before = animate ? LIST_IDS.map(id => captureList($(id))) : null;
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
  renderLoans();
  if (before) LIST_IDS.forEach((id, i) => animateList($(id), before[i]));
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

// ----- Loans: list of people with their balance, or one person's history -----
const personIcon = p => h("span", { class: `cat-icon person-icon tone-${hashStr(p.id) % 8}`, "aria-hidden": "true", text: ([...cleanName(p.name)][0] || "?").toUpperCase() });
const peopleText = n => t(new Intl.PluralRules(LOCALES[lang]).select(n) === "one" ? "onePerson" : "nPeople", { n: fmtInt(n) });
const balanceClass = b => (b > 0 ? "pos" : b < 0 ? "owe" : "settled");
const balanceLabel = b => t(b > 0 ? "owesYou" : b < 0 ? "youOweThem" : "settled");
const dirLabel = dir => t(dir === "gave" ? "youGave" : "youGot");
// "Rahim owes you ৳500" / "You owe Rahim ৳500" / "You and Rahim are settled"
function statusText(name, balance) {
  if (balance > 0) return t("statusOwesYou", { name, amt: fmt(balance) });
  if (balance < 0) return t("statusYouOwe", { name, amt: fmt(-balance) });
  return t("statusSettled", { name });
}
const afterText = b => (b > 0 ? t("afterOwesYou", { amt: fmt(b) }) : b < 0 ? t("afterYouOwe", { amt: fmt(-b) }) : t("afterSettled"));

function renderLoans() {
  const st = loanState();
  // A person in the URL who doesn't exist (deleted, or a stale link) falls back to the list once loans have loaded
  if (selectedPerson && !st.byId.has(selectedPerson) && loansPending.size === 0) {
    selectedPerson = null;
    if (currentTab === "loans") syncHash(false);
  }
  $("loansOverview").hidden = !!selectedPerson;
  $("personView").hidden = !selectedPerson;
  renderLoanOverview(st);
  renderPersonView(selectedPerson ? st.byId.get(selectedPerson) : null);
}

// People rows are links (#/loans?p=id), so they work with the keyboard and back/forward
const personRow = e => h("a", {
  class: "row tappable person-row", "data-key": "people:" + e.person.id, "data-person": e.person.id,
  href: hashFor("loans", selectedMonth, e.person.id)
},
  personIcon(e.person),
  h("div", { class: "row-info" }, h("div", { class: "row-title", text: e.person.name }),
    h("div", { class: "row-sub", text: [balanceLabel(e.balance), e.last ? t("lastOn", { date: fmtDate(e.last) }) : null].filter(Boolean).join(" · ") })),
  e.balance ? h("span", { class: `row-amt num ${balanceClass(e.balance)}`, text: fmt(Math.abs(e.balance)) }) : null,
  h("span", { class: "row-chev" }, svg("chevron", 18)));

function renderLoanOverview(st) {
  const { owedToYou, youOwe, toYouN, youOweN } = st.totals;
  const tot = $("loanTotals");
  if (!unchanged(tot, st.totals, lang)) tot.replaceChildren(
    h("div", { class: "lt-item" }, h("div", { class: "label", text: t("owedToYou") }),
      h("div", { class: `lt-value num ${owedToYou ? "pos" : ""}`, text: fmt(owedToYou) }), h("div", { class: "lt-sub", text: peopleText(toYouN) })),
    h("div", { class: "lt-item" }, h("div", { class: "label", text: t("youOwe") }),
      h("div", { class: `lt-value num ${youOwe ? "owe" : ""}`, text: fmt(youOwe) }), h("div", { class: "lt-sub", text: peopleText(youOweN) })));

  const notes = new Map();
  loanTxns.forEach(x => { if (x.note) notes.set(x.personId, (notes.get(x.personId) || "") + " " + x.note); });
  const visible = st.entries.filter(e => matchesSearch(e.person.name, notes.get(e.person.id)));
  const open = visible.filter(e => e.balance !== 0).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || a.person.name.localeCompare(b.person.name));
  const settled = visible.filter(e => e.balance === 0).sort((a, b) => (b.last || "").localeCompare(a.last || "") || a.person.name.localeCompare(b.person.name));
  $("peopleCount").textContent = st.entries.length ? peopleText(st.entries.length) : "";

  const openBox = $("loanOpen"), settledBox = $("loanSettled");
  const sig = [lang, todayISO(), selectedMonth];
  if (!st.entries.length) {
    if (!unchanged(openBox, "none", sig)) openBox.replaceChildren(emptyState({ msg: t("noLoans"), actionLabel: t("addLoan"), onAction: () => openLoanSheet() }));
  } else if (!visible.length) {
    if (!unchanged(openBox, "nomatch", sig)) openBox.replaceChildren(emptyState({ msg: t("noMatches") }));
  } else if (!unchanged(openBox, open, sig)) openBox.replaceChildren(...open.map(personRow));
  if (!unchanged(settledBox, settled, sig)) settledBox.replaceChildren(...settled.map(personRow));
  $("settledHead").hidden = !settled.length;
}

function renderPersonView(entry) {
  const card = $("personCard"), box = $("loanTimeline");
  if (!entry) {
    [card, box].forEach(el => { lastRendered.delete(el); el.replaceChildren(); });
    $("historyCount").textContent = "";
    return;
  }
  const { person, balance } = entry;
  // The settling direction is the primary action: "I got" when they owe you, "I gave" when you owe them
  const action = dir => h("button", {
    type: "button", class: `btn ${(dir === "got" ? balance > 0 : balance < 0) ? "primary" : "secondary"}`,
    onclick: () => openLoanSheet({ personId: person.id, dir })
  }, svg(dir, 18), t(dir === "gave" ? "iGave" : "iGot"));
  if (!unchanged(card, person, balance, lang, selectedMonth)) card.replaceChildren(
    h("div", { class: "person-top" },
      h("a", { class: "back-link", href: hashFor("loans", selectedMonth) }, svg("back", 18), t("peopleTitle")),
      h("button", { type: "button", class: "icon-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": t("moreActions", { name: person.name }),
        onclick: e => openMenu(e.currentTarget, [
          { icon: "edit", label: t("rename"), onSelect: () => openRename(person) },
          { icon: "trash", label: t("deletePerson"), danger: true, onSelect: guard(() => deletePerson(person)) }
        ]) }, svg("more", 20))),
    h("div", { class: "person-id" }, personIcon(person), h("h2", { class: "person-name", text: person.name })),
    h("div", { class: "person-bal" },
      h("div", { class: "label", text: balanceLabel(balance) }),
      h("div", { class: `person-amt num ${balanceClass(balance)}`, text: fmt(Math.abs(balance)) })),
    h("div", { class: "person-actions" }, action("gave"), action("got")));

  const hist = personHistory(loanTxns, person.id).reverse(); // newest first
  $("historyCount").textContent = t("entries", { n: fmtInt(hist.length) });
  // The empty state's button belongs to this person, so a different person always rebuilds the list
  if (box.dataset.person !== person.id) { lastRendered.delete(box); box.dataset.person = person.id; }
  renderGrouped("loanTimeline", hist.filter(x => matchesSearch(x.note, dirLabel(x.dir))), loanTxnRow,
    searchQ ? { msg: t("noMatches") } : { msg: t("noLoanTxns"), actionLabel: t("addLoan"), onAction: () => openLoanSheet({ personId: person.id }) });
}

// `after` (running balance) is display-only; strip it before writing the entry back
const rawTxn = ({ after, ...x }) => x;
const loanTxnRow = x => entryRow({
  key: "loanTxns:" + x.id,
  icon: h("span", { class: `cat-icon ${x.dir === "got" ? "tone-5" : "tone-0"}` }, svg(x.dir)),
  title: x.note || dirLabel(x.dir),
  sub: [x.note ? dirLabel(x.dir) : null, afterText(x.after)].filter(Boolean).join(" · "),
  amount: (x.dir === "got" ? "+" : "−") + fmt(x.amount), amountClass: x.dir === "got" ? "pos" : "",
  menu: [
    { icon: "edit", label: t("edit"), onSelect: () => openLoanSheet({ txn: rawTxn(x) }) },
    { icon: "trash", label: t("delete"), danger: true, onSelect: guard(() => deleteWithUndo("loanTxns", rawTxn(x), t("deletedLoanTxn"))) }
  ],
  onOpen: () => openLoanSheet({ txn: rawTxn(x) })
});

// ----- Budgets -----
function renderBudgets() {
  const byCat = spentByCategory();
  const infos = categories.map(c => budgetInfo(c, byCat));
  const budgeted = infos.filter(i => i.b > 0);
  $("editBudgets").textContent = t(editingBudgets ? "done" : "edit");

  // Summary
  const sumBox = $("budgetSummary");
  if (!budgeted.length) {
    lastRendered.delete(sumBox);
    sumBox.replaceChildren(
      h("div", { class: "label", text: t("noBudgetsTitle") }),
      h("p", { class: "hint", text: t("noBudgetsHint") }),
      editingBudgets ? null : h("div", {}, h("button", { type: "button", class: "btn secondary small", onclick: () => startBudgetEdit(categories[0]) }, t("setBudgets"))));
  } else {
    const totalB = budgeted.reduce((s, i) => s + i.b, 0), totalS = budgeted.reduce((s, i) => s + i.s, 0);
    const overN = budgeted.filter(i => i.over).length, nearN = budgeted.filter(i => i.near).length;
    if (!unchanged(sumBox, budgeted, lang)) sumBox.replaceChildren(
      h("div", { class: "label", text: t("spentAgainst") }),
      h("div", { class: "bs-value" }, h("strong", { class: "num", text: fmt(totalS) }), h("span", { text: t("ofBudget", { budget: fmt(totalB) }) })),
      h("span", { class: "track" }, h("span", { class: `fill ${totalS > totalB ? "over" : "accent"}`, "data-bar": "budget-total", style: `width:${Math.min(100, totalS / totalB * 100)}%` })),
      h("div", { class: "pills" },
        overN ? h("span", { class: "pill over" }, svg("alert", 14), t("overCount", { n: fmtInt(overN) })) : null,
        nearN ? h("span", { class: "pill near", text: t("nearCount", { n: fmtInt(nearN) }) }) : null,
        h("span", { class: "pill", text: t("leftAmt", { amt: fmt(Math.max(0, totalB - totalS)) }) })));
  }

  const list = $("budgetList");
  if (editingBudgets) {
    lastRendered.delete(list); // so leaving edit mode always rebuilds the read rows
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
  if (!unchanged(list, sorted, lang)) list.replaceChildren(...sorted.map(budgetReadRow));
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
      h("span", { class: "track" }, h("span", { class: `fill ${state}`, "data-bar": "budget:" + i.c, style: `width:${Math.min(100, i.ratio * 100)}%` })),
      h("span", { class: `brow-status ${state}` }, i.over ? svg("alert", 14) : null, status)));
}

function budgetEditRow(c, idx) {
  const name = catLabel(c);
  const input = h("input", { id: "b-" + idx, class: "num", inputmode: "decimal", autocomplete: "off", placeholder: t("noLimitPh") });
  input.value = budgetText(c);
  bindAmountInput(input);
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
  if (unchanged(where, entries, lang)) { /* same breakdown: keep the nodes */ }
  else if (!total) where.replaceChildren(h("p", { class: "hint", text: t("noExpenses") }));
  else {
    const top = entries.slice(0, 5), rest = entries.slice(5);
    const restSum = rest.reduce((s, [, v]) => s + v, 0);
    const rows = top.map(([c, v]) => ({ key: c, name: catLabel(c), v, tone: catStyle(c).tone }));
    if (rest.length) rows.push({ key: "\u0000rest", name: rest.length === 1 ? catLabel(rest[0][0]) : t("moreCats", { n: fmtInt(rest.length) }), v: restSum, tone: 7 });
    const pct = v => Math.round(v / total * 100);
    const bar = h("div", { class: "where-bar", role: "img", "aria-label": rows.map(r => `${r.name} ${fmtInt(pct(r.v))}%`).join(", ") },
      rows.map(r => h("span", { class: `tone-${r.tone}`, "data-bar": "where:" + r.key, style: `width:${r.v / total * 100}%` })));
    const list = h("div", { class: "where-list" }, rows.map(r => h("div", { class: "where-row" },
      h("span", { class: `dot tone-${r.tone}` }), h("span", { class: "name", text: r.name }),
      h("span", { class: "pct", text: fmtInt(pct(r.v)) + "%" }), h("span", { class: "amt num", text: fmt(r.v) }))));
    where.replaceChildren(bar, list);
    // Phone insights card shows the same nodes (static markup, no listeners, so clones are safe)
    $("insightsBar").replaceChildren(bar.cloneNode(true));
    $("insightsList").replaceChildren(list.cloneNode(true));
  }
  $("insightsCard").hidden = !total;

  // Budget watch: over or close to the limit
  const watch = categories.map(c => budgetInfo(c, byCat)).filter(i => i.over || i.near).sort((a, b) => b.ratio - a.ratio).slice(0, 3);
  $("watchCard").hidden = !watch.length;
  if (!unchanged($("watch"), watch, lang)) $("watch").replaceChildren(...watch.map(i => h("div", { class: "watch-item" },
    h("div", { class: "brow-line" }, h("span", { class: "brow-name", text: catLabel(i.c) }),
      h("span", { class: "brow-amt num" }, fmt(i.s), h("span", { class: "of", text: " / " + fmt(i.b) }))),
    h("span", { class: "track" }, h("span", { class: `fill ${i.over ? "over" : "near"}`, "data-bar": "watch:" + i.c, style: `width:${Math.min(100, i.ratio * 100)}%` })),
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
  const range = currentRange(), dim = range.days;
  const dateAt = i => addDays(range.start, i - 1); // 1-based day of the period → ISO date
  const budgetTotal = categories.reduce((acc, c) => acc + (Number(budgets[c]) || 0), 0);
  $("chartPaceLegend").hidden = $("mChartPaceLegend").hidden = !budgetTotal;
  $("chartPaceText").textContent = $("mChartPaceText").textContent = t("chartPace", { amt: fmt(budgetTotal) });
  if (unchanged(box, expenses.map(e => [e.date, e.amount]), budgetTotal, range, lang, todayISO())) return;
  if (!expenses.length) { box.replaceChildren(h("p", { class: "muted chart-empty", text: t("noExpenses") })); return; }

  const daily = new Array(dim).fill(0);
  expenses.forEach(e => { const i = daysBetween(range.start, e.date); if (i >= 0 && i < dim) daily[i] += Number(e.amount); });
  const today = todayISO();
  const lastWithData = daily.reduce((acc, v, i) => (v ? i + 1 : acc), 0);
  const elapsed = inPeriod(today, range) ? daysBetween(range.start, today) + 1 : today > range.end ? dim : 0;
  const end = Math.max(elapsed, lastWithData);
  const cum = []; daily.slice(0, end).reduce((acc, v, i) => (cum[i] = acc + v), 0);
  const total = cum[end - 1];
  const maxV = niceCeil(Math.max(total, budgetTotal) * 1.05);
  const W = 600, H = 200;
  const x = d => (dim > 1 ? (d - 1) / (dim - 1) : 0) * W;
  const yv = v => H - v / maxV * H;
  const pts = cum.map((v, i) => `${x(i + 1).toFixed(1)},${yv(v).toFixed(1)}`);

  const plot = svgNode("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img",
    "aria-label": t("chartAria", { amt: fmt(total), date: fmtDate(dateAt(end)) }) });
  plot.append(svgNode("path", { class: "chart-area", d: `M0,${H} L${pts.join(" L")} L${x(end).toFixed(1)},${H} Z` }));
  if (budgetTotal) plot.append(svgNode("line", { class: "chart-pace", x1: 0, y1: H, x2: W, y2: yv(budgetTotal).toFixed(1), "vector-effect": "non-scaling-stroke" }));
  plot.append(svgNode("polyline", { class: "chart-line", points: pts.join(" "), "vector-effect": "non-scaling-stroke" }));

  const leftPct = x(end) / W * 100, topPct = yv(total) / H * 100;
  const tip = h("div", { class: "chart-tip", style: `left:${leftPct}%;top:${topPct}%`, text: t("chartBy", { amt: fmt(total), date: fmtDate(dateAt(end)) }) });
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
      h("span", { text: i === 0 || i === xDays.length - 1 ? fmtDate(dateAt(d)) : fmtInt(Number(dateAt(d).slice(8, 10))) }))));
  $("mChart").replaceChildren(...[...box.childNodes].map(n => n.cloneNode(true)));
}

// ===== Writes =====

// Delete immediately and offer Undo, which restores the same document id and data
function deleteWithUndo(col, item, msg) {
  const uid = user.uid;
  const { id, ...data } = item;
  writeInBackground(deleteDoc(doc(db, "users", uid, col, id)));
  toast(msg, { actionLabel: t("undo"), onAction: () => {
    writeInBackground(setDoc(doc(db, "users", uid, col, id), data));
    toast(t("restored"));
  } });
}

// Turns a planned item into a real expense and removes it from the plan. A second tap on the same item (before the
// re-render replaces its button) is ignored, so it can't become two expenses.
const markedSpent = new Set();
function markSpent(p) {
  if (markedSpent.has(p.id)) return;
  markedSpent.add(p.id);
  writeInBackground(addDoc(userCol("expenses"), {
    amount: p.amount, category: p.category, date: p.date,
    note: p.note || "", recurringId: null, createdAt: Date.now()
  }));
  writeInBackground(deleteDoc(userDoc("planned", p.id)));
  toast(t("movedToExpenses"));
}

function saveBudget(c, input) {
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
  writeInBackground(setDoc(userDoc("settings", "budgets"), next));
  toast(t("budgetSaved"));
}

function addCategory(input) {
  const name = input.value.trim();
  if (!name) return;
  // Match against both the stored name and its Bangla label, so "খাবার" can't duplicate "Food"
  const lower = name.toLowerCase();
  if (categories.some(c => c.toLowerCase() === lower || CAT_BN[c] === name)) { toast(t("catExists", { name }), { error: true }); return; }
  writeInBackground(setDoc(userDoc("settings", "categories"), { list: [...categories, name] }));
  input.value = "";
  toast(t("catAdded", { name }));
}

async function removeCategory(name) {
  if (categories.length <= 1) { toast(t("keepOneCat"), { error: true }); return; }
  if (!(await confirmAction(t("confirmRemoveCat", { name: catLabel(name) }), t("remove")))) return;
  const uid = user.uid, index = categories.indexOf(name), prevBudget = budgets[name];
  const catRef = doc(db, "users", uid, "settings", "categories"), budRef = doc(db, "users", uid, "settings", "budgets");
  writeInBackground(setDoc(catRef, { list: categories.filter(c => c !== name) }));
  if (prevBudget !== undefined) { const next = { ...budgets }; delete next[name]; writeInBackground(setDoc(budRef, next)); }
  toast(t("catRemoved", { name: catLabel(name) }), { actionLabel: t("undo"), onAction: () => {
    // Restore against the current state so edits made in between are kept
    if (!categories.includes(name)) { const list = [...categories]; list.splice(Math.min(index, list.length), 0, name); writeInBackground(setDoc(catRef, { list })); }
    if (prevBudget !== undefined) writeInBackground(setDoc(budRef, { ...budgets, [name]: prevBudget }));
    toast(t("restored"));
  } });
}

// Creates one entry per recurring rule for the selected period, skipping any already created. Rules applied in this
// session are remembered too, so a second tap before the banner re-renders can't create duplicates.
const appliedRules = new Set();
function applyRecurringTo(rules, col, existing, kind) {
  const key = selectedMonth, sd = startDay;
  let added = 0;
  for (const r of rules) {
    const tag = `${col}:${r.id}:${key}:${sd}`;
    if (existing.some(x => x.recurringId === r.id) || appliedRules.has(tag)) continue;
    appliedRules.add(tag);
    writeInBackground(addDoc(userCol(col), {
      amount: r.amount, category: r.category || "Income", note: r.note || "",
      date: dateInPeriod(key, r.day, sd), recurringId: r.id, createdAt: Date.now()
    }));
    added++;
  }
  toast(added ? t("applied" + kind, { n: fmtInt(added), month: periodLabel(key, sd) }) : t("nothing" + kind));
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
