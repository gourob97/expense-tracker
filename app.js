import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, terminate, clearIndexedDbPersistence,
  collection, doc, onSnapshot, query, where, orderBy, getDoc, getDocs, waitForPendingWrites, writeBatch,
  addDoc as fsAddDoc, deleteDoc as fsDeleteDoc, setDoc as fsSetDoc, updateDoc as fsUpdateDoc, deleteField
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { STRINGS, CAT_BN } from "./i18n.js";
import { BUILTIN, SUGGESTED } from "./icons-builtin.js";
import { periodRange, periodOf, shiftPeriod, dateInPeriod, addDays, daysBetween, inPeriod, isPeriodKey, normalizeStartDay, DEFAULT_START_DAY } from "./period.js";
import { formatAmountInput } from "./amount.js";
import { loanStates, totals, flowBetween, maxPayment, findPerson, cleanName, isValidDue } from "./loans.js";

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
  gift: '<rect x="3" y="9" width="18" height="12" rx="2"/><path d="M12 9v12"/><path d="M3 13h18"/><path d="M12 9C10 5.5 6.5 5.5 6.5 7.5S10 9 12 9z"/><path d="M12 9c2-3.5 5.5-3.5 5.5-1.5S14 9 12 9z"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 1h13v-3"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
  plane: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  coffee: '<path d="M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M17 11h1.5a2.5 2.5 0 0 1 0 5H17"/><path d="M8 3v3M12 3v3"/>',
  paw: '<circle cx="5.5" cy="10.5" r="1.8"/><circle cx="9" cy="6" r="1.8"/><circle cx="15" cy="6" r="1.8"/><circle cx="18.5" cy="10.5" r="1.8"/><path d="M12 12.5c-2.8 0-5 3.2-5 5.5 0 1.4 1.1 2.3 2.4 2.3 1.1 0 1.6-.6 2.6-.6s1.5.6 2.6.6c1.3 0 2.4-.9 2.4-2.3 0-2.3-2.2-5.5-5-5.5z"/>',
  dumbbell: '<path d="M6.5 7v10M3.5 9.5v5M17.5 7v10M20.5 9.5v5M6.5 12h11"/>',
  income: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  repeat: '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h16"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  more: '<circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
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
// Built-in category icons are Lucide's (see icons-builtin.js); the names stay, since saved categories store them
for (const [k, v] of Object.entries(BUILTIN)) ICONS[k] = v.svg;
const SVG_NS = "http://www.w3.org/2000/svg";
const svgShell = size => {
  const el = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) el.setAttribute(k, v);
  return el;
};
// A Lucide icon picked in the category editor is saved with its shapes, so it draws without the big icon file.
// That text comes back from the database, so it is rebuilt from known shapes and attributes, never set as HTML.
const SHAPES = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
const SHAPE_ATTRS = new Set(["d", "cx", "cy", "r", "rx", "ry", "x", "y", "width", "height", "x1", "y1", "x2", "y2", "points"]);
const shapeCache = new Map();
function shapesOf(markup) {
  if (shapeCache.has(markup)) return shapeCache.get(markup);
  const tpl = document.createElement("template"); // inert: nothing in it runs or loads
  tpl.innerHTML = `<svg>${markup}</svg>`;
  const shapes = [...(tpl.content.firstElementChild?.children || [])].filter(el => SHAPES.has(el.localName))
    .map(el => [el.localName, [...el.attributes].filter(a => SHAPE_ATTRS.has(a.name)).map(a => [a.name, a.value])]);
  shapeCache.set(markup, shapes);
  return shapes;
}
function svgMarkup(markup, size = 20) {
  const el = svgShell(size);
  for (const [tag, attrs] of shapesOf(markup)) {
    const n = document.createElementNS(SVG_NS, tag);
    attrs.forEach(([k, v]) => n.setAttribute(k, v));
    el.append(n);
  }
  return el;
}
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
// Icons a category can pick, and its chosen look (settings/categories.styles[name] = { icon, tone }) over the default
// A built-in name ("food"), or "lucide:<name>" with the icon's shapes in `svg`
const CAT_ICONS = ["food", "transport", "bills", "rent", "shopping", "health", "fun", "gift", "book", "phone", "plane", "coffee", "paw", "dumbbell", "tag", "other"];
const LUCIDE_TO_BUILTIN = Object.fromEntries(Object.entries(BUILTIN).map(([k, v]) => [v.lucide, k]));
let catStyles = {};
const isLucide = v => typeof v.icon === "string" && /^lucide:[a-z0-9-]{1,64}$/.test(v.icon) && typeof v.svg === "string" && v.svg.length <= 4000;
const validStyle = v => !!v && (CAT_ICONS.includes(v.icon) || isLucide(v)) && Number.isInteger(v.tone) && v.tone >= 0 && v.tone < 8;
const catStyle = c => validStyle(catStyles[c]) ? { tone: catStyles[c].tone, icon: catStyles[c].icon, svg: catStyles[c].svg }
  : CAT_STYLE[c] ? { tone: CAT_STYLE[c][0], icon: CAT_STYLE[c][1] } : { tone: hashStr(c) % 8, icon: "tag" };
const iconSvg = (s, size) => s.icon.startsWith("lucide:") && s.svg ? svgMarkup(s.svg, size) : svg(s.icon, size);
const catIcon = (c, cls = "") => { const s = catStyle(c); return h("span", { class: `cat-icon tone-${s.tone} ${cls}` }, iconSvg(s, cls ? 18 : 20)); };

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
// The month chip's label: "Nov 2026" for calendar months (localized, so Bangla gets its own short form);
// salary cycles keep their range ("25 Nov – 24 Dec")
function periodShort(key, sd = startDay) {
  if (sd !== 1) return periodLabel(key, sd);
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(LOCALES[lang], { month: "short", year: "numeric" });
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
  if (!el.hidden) playExit(el, () => { el.hidden = true; try { el.hidePopover?.(); } catch (e) { /* already closed */ } });
}
// Inside the topmost open dialog (so its Undo can be tapped), else the page; shown again as a popover each time
// so it sits above everything, including a dialog opened since the last toast
function raiseToast(el) {
  const host = [...openDialogs].reverse().find(d => d.open && !("leaving" in d.dataset)) || document.body;
  const wasOpen = el.matches?.(":popover-open");
  if (el.parentElement !== host) { if (wasOpen) try { el.hidePopover(); } catch (e) {} host.append(el); }
  if (!el.showPopover) return; // no popover support: still inside the dialog, so it shows and works
  try { if (el.matches(":popover-open")) el.hidePopover(); el.showPopover(); } catch (e) { /* not connected */ }
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
  raiseToast(el);
  if (!error) toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 3500);
}

// ----- Dialogs: open and close through these so closing plays the exit animation first -----
// Open modal dialogs, oldest first. A modal makes everything outside it inert, so the toast lives inside the
// topmost one while it shows (see raiseToast) and moves out again when that dialog closes.
const openDialogs = [];
function openDialog(d) {
  const i = openDialogs.indexOf(d);
  if (i >= 0) openDialogs.splice(i, 1);
  openDialogs.push(d);
  if (cancelExit(d) || d.open) return; // reopened mid-exit: it never closed, so stopping the exit is enough
  d.showModal();
}
function closeDialog(d, { instant = false } = {}) {
  if (!d.open) return;
  const i = openDialogs.indexOf(d);
  if (i >= 0) openDialogs.splice(i, 1);
  const tst = $("toast");
  if (!tst.hidden && d.contains(tst)) raiseToast(tst); // keep it on screen as its dialog goes
  if (instant) { cancelExit(d); d.close(); return; }
  playExit(d, () => d.close());
}
// Esc (and Android back) animate out too. If the browser won't allow the close to be deferred, it closes at once.
// The confirm dialog handles cancel itself, since it has to resolve its promise.
["entryDialog", "cycleDialog", "accountDialog", "nameDialog", "catDialog", "catsDialog", "spentDialog"].forEach(id => $(id).addEventListener("cancel", e => {
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
// The Loans tab adds the loan being viewed (&l=<id>), so back returns from it to the list.
const nowPeriod = () => periodOf(todayISO(), startDay);
function readHash() {
  const [tab, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(qs), m = params.get("m"), l = params.get("l");
  return { tab, month: m && isPeriodKey(m) ? m : null, loan: tab === "loans" && l && /^[\w-]{1,64}$/.test(l) ? l : null };
}
let selectedMonth = readHash().month || nowPeriod();
let selectedLoan = readHash().loan;
const currentRange = () => periodRange(selectedMonth, startDay);
let user = null;
let categories = [...DEFAULT_CATEGORIES];
let expenses = [], income = [], planned = [], budgets = {}, recurring = [], recurringIncome = [];
// Loans are all-time (they span months), so they load once per sign-in rather than per period
let people = [], loans = [], loanPayments = [];
let unsubs = [], monthUnsubs = [];
let auth, db;
let currentTab = "expenses", filterCat = null, searchQ = "", editingBudgets = false, budgetEditKey = "";
const userDoc = (...path) => doc(db, "users", user.uid, ...path);
const userCol = name => collection(db, "users", user.uid, name);

// ----- Tabs (state lives in the URL hash as #/name so reload and back/forward work) -----
const tabFromHash = () => readHash().tab;
function hashFor(tab, month, loan = null) {
  const q = new URLSearchParams();
  if (month !== nowPeriod()) q.set("m", month);
  if (tab === "loans" && loan) q.set("l", loan);
  const qs = q.toString();
  return `#/${tab}` + (qs ? "?" + qs : "");
}
// Writes tab + month to the URL. push=true adds a history entry (back returns to the previous month).
function syncHash(push) {
  document.querySelectorAll('a[href^="#/"]:not([data-loan])').forEach(a => { a.href = hashFor(a.getAttribute("href").replace(/^#\/?/, "").split("?")[0], selectedMonth); });
  const target = hashFor(currentTab, selectedMonth, selectedLoan);
  if (location.hash === target) return;
  if (push) location.hash = target; else history.replaceState(history.state, "", target);
}
const KIND_FOR_TAB = { expenses: "expense", income: "income", planned: "planned", budgets: "expense", loans: "loan" };
const ADD_LABEL = { expense: "addExpense", income: "addIncome", planned: "addPlanned", loan: "addLoan", payment: "addPayment" };
const TAB_TITLE = { expenses: "tabExpenses", income: "tabIncome", planned: "tabPlanned", budgets: "tabBudgets", loans: "tabLoans" };
function showTab(name) {
  if (!TABS.includes(name)) name = TABS[0];
  currentTab = name;
  document.body.dataset.tab = name;
  document.querySelectorAll(".tab-panel").forEach(p => { p.hidden = p.dataset.panel !== name; });
  document.querySelectorAll(".nav-item, .flow-switch a").forEach(a => {
    if (a.dataset.tab === name) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  $("pageTitle").textContent = t(TAB_TITLE[name]);
  $("addBtnLabel").textContent = t(ADD_LABEL[KIND_FOR_TAB[name]]);
  return name;
}
window.addEventListener("hashchange", () => {
  const { tab, month, loan } = readHash(), prevTab = currentTab, prevLoan = selectedLoan;
  showTab(tab);
  selectedLoan = currentTab === "loans" ? loan : null;
  setMonth(month || nowPeriod(), { fromHash: true });
  syncHash(false); // normalise unknown tabs / stale params
  if (selectedLoan !== prevLoan) renderLists();
  if ((currentTab !== prevTab || selectedLoan !== prevLoan) && window.scrollY > 0) window.scrollTo({ top: 0 });
});

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
  $("acctCatsVal").textContent = fmtInt(categories.length);
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
const ALL_COLS = ["expenses", "income", "planned", "recurring", "recurringIncome", "people", "loans", "loanPayments"];
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
        [type, e.date || "", e.category || "", Number(e.amount) || 0, e.note || "", e.recurringId ? "yes" : "", "", ""]));
      // Loans ("loan lent" / "loan borrowed") and their payments, with who they're with
      const names = new Map(data.people.map(p => [p.id, p.name])), loanById = new Map(data.loans.map(l => [l.id, l]));
      data.loans.forEach(l => rows.push([l.dir === "got" ? "loan borrowed" : "loan lent", l.date || "", "", Number(l.amount) || 0, l.note || "", "", names.get(l.personId) || "", l.due || ""]));
      data.loanPayments.forEach(x => { const l = loanById.get(x.loanId);
        rows.push([l?.dir === "got" ? "loan you repaid" : "loan repaid to you", x.date || "", "", Number(x.amount) || 0, x.note || "", "", names.get(l?.personId) || "", ""]); });
      rows.sort((x, y) => (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0));
      const lines = [["Type", "Date", "Category", "Amount", "Note", "Recurring", "Person", "Due"], ...rows].map(r => r.map(csvCell).join(","));
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

// ===== Entry sheet: expense / income / planned / loan / loan payment, add or edit =====
let entryKind = "expense";
// Set while the sheet edits an existing item: { col, item }. Null when adding.
let editing = null;
// The loan a payment is for (its state from loanState()), while the sheet adds or edits a payment
let payFor = null;
const COL_KIND = { expenses: "expense", income: "income", planned: "planned", recurring: "expense", recurringIncome: "income", loans: "loan", loanPayments: "payment" };
const isRuleCol = col => col === "recurring" || col === "recurringIncome";
const usesCategory = kind => kind === "expense" || kind === "planned";
const loanDir = () => document.querySelector('input[name="loanDir"]:checked')?.value || "gave";

function setKind(kind) {
  entryKind = kind;
  const radio = document.querySelector(`input[name="kind"][value="${kind}"]`);
  if (radio) radio.checked = true;
  const loan = kind === "loan", payment = kind === "payment";
  $("eCatField").hidden = !usesCategory(kind);
  $("ePersonField").hidden = !loan;
  $("eDirField").hidden = !loan;
  $("eDueRow").hidden = !loan;
  $("eRepeatRow").hidden = kind === "planned" || loan || payment || !!editing;
  $("eNote").placeholder = t(kind === "income" ? "phSource" : kind === "planned" ? "phWhat" : loan ? "phLoanNote" : payment ? "phPayNote" : "phNote");
  $("entrySubmit").textContent = t(editing ? "saveChanges" : ADD_LABEL[kind]);
  clearFieldErrors();
  updateSheet();
}
document.querySelectorAll('input[name="kind"]').forEach(r => { r.onchange = () => setKind(r.value); });
document.querySelectorAll('input[name="loanDir"]').forEach(r => { r.onchange = updateSheet; });

// The amount box says what the money did and takes its colour: out (spent, lent, paid back), in (received,
// borrowed, paid back to you), planned
const AMOUNT_MODE = {
  expense: ["amtSpent", "−", "out"], planned: ["amtPlan", "", "plan"], income: ["amtReceived", "+", "in"],
  gave: ["amtGave", "−", "out"], got: ["amtGot", "+", "in"],
  repaidToYou: ["amtRepaidToYou", "+", "in"], youRepaid: ["amtYouRepaid", "−", "out"]
};
const amountMode = () => entryKind === "loan" ? loanDir() : entryKind === "payment" ? (payFor?.loan.dir === "got" ? "youRepaid" : "repaidToYou") : entryKind;
// Everything in the sheet that depends on the type, direction, amount, person or note
function updateSheet() {
  const dir = loanDir();
  const [label, sign, tone] = AMOUNT_MODE[amountMode()];
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
function amountError(msg) {
  fieldError("eAmountErr", msg);
  $("eAmountBox").classList.add("invalid");
  $("eAmount").setAttribute("aria-invalid", "true");
  $("eAmount").focus();
}
function clearFieldErrors() {
  ["eAmountErr", "ePersonErr", "eDateErr", "eDueErr"].forEach(id => fieldError(id, ""));
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
      h("span", { class: "chip-face" }, h("span", { class: `cat-icon xs tone-${s.tone}` }, iconSvg(s, 16)), h("span", { text: catLabel(c) })));
  }), h("button", { type: "button", class: "chip-opt new-chip", onclick: () => openCatEditor(null, { onSaved: name => buildCatGrid(name) }) },
    h("span", { class: "chip-face" }, svg("plus", 16), h("span", { text: t("newCat") }))));
  if (!grid.querySelector("input:checked")) grid.querySelector("input")?.click();
}
const checkCategory = c => { const r = [...$("eCatGrid").querySelectorAll("input")].find(i => i.value === c); if (r) r.checked = true; };

// ----- Person chips (loan): the 8 most recently active people with what's open with them, plus "New" -----
function buildPeopleChips(selectedId, { allowNew = true } = {}) {
  const st = loanState();
  const recent = [...st.persons].sort((a, b) => (b.last || "").localeCompare(a.last || "") || a.person.name.localeCompare(b.person.name));
  let shown = recent.slice(0, 8);
  const sel = selectedId && st.persons.find(e => e.person.id === selectedId);
  if (sel && !shown.includes(sel)) shown = [sel, ...shown.slice(0, 7)];
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
  $("peopleNames").replaceChildren(...st.persons.map(e => h("option", { value: e.person.name })));
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

// Payments: live "After this: ৳400 left" / "After this: paid in full" above Save
function updateLoanPreview() {
  const el = $("ePreview"), amount = parseNum($("eAmount").value);
  if (entryKind !== "payment" || !payFor || !(amount > 0)) { el.hidden = true; el.textContent = ""; return; }
  const left = Math.round((maxPayment(payFor, editing?.item) - amount) * 100) / 100;
  el.textContent = left > 0 ? t("previewLeft", { amt: fmt(left) }) : left === 0 ? t("previewPaid") : t("payTooMuch", { amt: fmt(maxPayment(payFor, editing?.item)) });
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

// ----- Loan due date (optional): when the money should come back -----
function setDue(iso) { $("eDue").value = iso || ""; syncDue(); }
function syncDue() { $("eDueClear").hidden = !$("eDue").value; fieldError("eDueErr", ""); }
$("eDue").addEventListener("change", syncDue);
$("eDue").addEventListener("click", () => { try { $("eDue").showPicker(); } catch (e) { /* opens natively, or unsupported */ } });
$("eDueClear").onclick = () => { setDue(""); $("eDue").focus({ preventScroll: true }); };
// "Due 5 Dec" / "Due today" / "Overdue since 20 Nov"
const dueText = iso => { const today = todayISO(); return iso < today ? t("overdueSince", { date: fmtDate(iso) }) : t(iso === today ? "dueToday" : "dueOn", { date: fmtDate(iso) }); };
const isOverdue = iso => !!iso && iso < todayISO();

// ----- Note suggestions: the notes used most for this type, narrowed as you type. Picking one for an
// expense or plan also picks the category it was last used with ("Uber" → Transport). -----
function noteSuggestions(kind, typed) {
  const src = kind === "income" ? income : kind === "loan" ? loans : kind === "payment" ? loanPayments : [...expenses, ...planned];
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
// personId: a new loan's person; loanId: the loan a new payment is for
function openSheet(kind, col = null, item = null, { personId = null, loanId = null } = {}) {
  if (!user) return;
  editing = item ? { col, item } : null;
  const rule = !!item && isRuleCol(col), loanEdit = col === "loans", payEdit = col === "loanPayments";
  payFor = kind === "payment" ? loanState().byId.get(payEdit ? item.loanId : loanId) || null : null;
  if (kind === "payment" && !payFor) { editing = null; return; }
  closeMenu(false);
  buildCatGrid(item?.category);
  document.querySelector(`input[name="loanDir"][value="${loanEdit ? item.dir : "gave"}"]`).checked = true;
  buildPeopleChips(loanEdit ? item.personId : personId);
  $("eKindSeg").hidden = !!item || kind === "payment"; // moving an item between types isn't an edit
  $("eDateField").hidden = rule;
  $("eDayRow").hidden = !rule;
  $("eNote").value = item?.note || "";
  $("eRepeat").checked = false;
  // A new payment starts with what's left on the loan (selected, so typing replaces it)
  const amount = item ? item.amount : kind === "payment" ? payFor.left : null;
  $("eAmount").value = amount == null ? "" : formatAmountInput(plainFmt.format(amount)).value;
  setDate(item && !rule ? item.date : defaultDate());
  setDue(loanEdit ? item.due : "");
  if (rule) {
    $("eDay").replaceChildren(...Array.from({ length: 31 }, (_, i) => h("option", { value: i + 1, text: fmtInt(i + 1) })));
    $("eDay").value = String(item.day);
  }
  setKind(kind); // after the fields are filled: it refreshes everything that depends on them
  $("entryTitle").textContent = t(!item ? (kind === "payment" ? "addPayment" : "newEntry") : rule ? "editRecurring" : loanEdit ? "editLoan" : payEdit ? "editPayment" : "editEntry");
  openDialog($("entryDialog"));
  // With a mouse or trackpad there's no on-screen keyboard, so typing can start at once. On touch screens focusing
  // the amount would throw the keyboard up over the sheet before anything is picked; it opens when the amount is tapped.
  if (finePointer.matches) {
    $("eAmount").focus();
    if ($("eAmount").value) $("eAmount").select();
  }
}
const finePointer = matchMedia("(pointer: fine)");
const openEntry = (kind = KIND_FOR_TAB[currentTab]) => openSheet(kind);
const openEdit = (col, item) => openSheet(COL_KIND[col], col, item);
const openLoanSheet = ({ personId = null, item = null } = {}) => openSheet("loan", item ? "loans" : null, item, { personId });
const openPaymentSheet = ({ loanId = null, item = null } = {}) => openSheet("payment", item ? "loanPayments" : null, item, { loanId });
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
  if (entryKind === "loan") {
    const due = $("eDue").value;
    if (due && date && due < date) { fieldError("eDueErr", t("dueBeforeDate")); $("eDue").focus(); return; }
    submitLoan({ amount, date, note, due });
    return;
  }
  if (entryKind === "payment") { submitPayment({ amount, date, note }); return; }
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

// A loan: lent ("gave") or borrowed ("got") with someone. A new name creates the person, in the same batch.
// Editing can move the loan to someone else, but can't make it smaller than what's already been paid back.
function submitLoan({ amount, date, note, due }) {
  const dir = loanDir(), item = editing?.col === "loans" ? editing.item : null;
  const { person, typed, isNew } = sheetPerson();
  if (!person && !typed) {
    fieldError("ePersonErr", t(isNew ? "needName" : "pickPerson"));
    (isNew ? $("ePersonNew") : $("ePeople").querySelector("input"))?.focus();
    return;
  }
  const st = item && loanState().byId.get(item.id);
  if (st && amount < st.paid) { amountError(t("amountBelowPaid", { amt: fmt(st.paid) })); return; }
  if (st?.payments.length && date > st.payments[0].date) { fieldError("eDateErr", t("loanAfterPayment")); $("eDate").focus(); return; }
  const name = person ? person.name : typed; // an existing person keeps their spelling, whatever was typed
  closeDialog($("entryDialog"));
  const ops = [];
  let pid = person?.id;
  if (!pid) {
    const ref = doc(userCol("people"));
    pid = ref.id;
    ops.push(b => b.set(ref, { name, createdAt: Date.now() }));
  }
  if (item) {
    const { id, ...before } = item;
    const changes = { dir, amount, date, note, personId: pid };
    const dueChanged = due !== (before.due || "");
    if (!dueChanged && Object.keys(changes).every(k => changes[k] === (before[k] ?? (k === "note" ? "" : undefined)))) return;
    if (dueChanged) changes.due = due || deleteField();
    const ref = doc(db, "users", user.uid, "loans", id);
    writeAll([...ops, b => b.update(ref, changes)]);
    toast(t("entryUpdated"), { actionLabel: t("undo"), onAction: () => { writeInBackground(setDoc(ref, before)); toast(t("restored")); } });
    return;
  }
  const ref = doc(userCol("loans"));
  const data = { personId: pid, dir, amount, date, note, createdAt: Date.now() };
  if (due) data.due = due;
  writeAll([...ops, b => b.set(ref, data)]);
  toast(t(dir === "gave" ? "lentAdded" : "borrowedAdded", { name, amt: fmt(amount) }));
}

// A payment on a loan: at most what's left on it, and not before the loan itself
function submitPayment({ amount, date, note }) {
  const item = editing?.col === "loanPayments" ? editing.item : null;
  const st = payFor && loanState().byId.get(payFor.loan.id);
  if (!st) { closeDialog($("entryDialog")); toast(t("loanGone"), { error: true }); return; } // deleted elsewhere meanwhile
  const max = maxPayment(st, item);
  if (amount > max) { amountError(t("payTooMuch", { amt: fmt(max) })); return; }
  if (date < st.loan.date) { fieldError("eDateErr", t("payBeforeLoan")); $("eDate").focus(); return; }
  closeDialog($("entryDialog"));
  if (item) {
    const { id, ...before } = item, changes = { amount, date, note };
    if (Object.keys(changes).every(k => changes[k] === (before[k] ?? (k === "note" ? "" : undefined)))) return;
    const ref = doc(db, "users", user.uid, "loanPayments", id);
    writeInBackground(updateDoc(ref, changes));
    toast(t("entryUpdated"), { actionLabel: t("undo"), onAction: () => { writeInBackground(setDoc(ref, before)); toast(t("restored")); } });
    return;
  }
  writeInBackground(addDoc(userCol("loanPayments"), { loanId: st.loan.id, amount, date, note, createdAt: Date.now() }));
  const left = Math.round((max - amount) * 100) / 100;
  toast(left > 0 ? t("paymentLeft", { amt: fmt(left) }) : t("paymentSettled"));
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

// Deletes the loan and its payments (asking first if it has any); Undo restores all of it with the same ids.
// Payments go before the loan (and come back after it), so a batch split can't leave payments with no loan.
async function deleteLoan(st) {
  const n = st.payments.length;
  if (n && !(await confirmAction(t("confirmDelLoan", { n: fmtInt(n) }), t("delete")))) return;
  const uid = user.uid;
  const lRef = doc(db, "users", uid, "loans", st.loan.id);
  const { id, ...lData } = st.loan;
  const saved = st.payments.map(({ id: pid, leftAfter, ...data }) => [doc(db, "users", uid, "loanPayments", pid), data]);
  writeAll([...saved.map(([ref]) => b => b.delete(ref)), b => b.delete(lRef)]);
  if (selectedLoan === st.loan.id) { selectedLoan = null; syncHash(false); renderLists(); }
  toast(t("deletedLoan"), { actionLabel: t("undo"), onAction: () => {
    writeAll([b => b.set(lRef, lData), ...saved.map(([ref, data]) => b => b.set(ref, data))]);
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
  $("monthLabel").textContent = periodShort(selectedMonth); // the top bar shows straight away while booting

  onAuthStateChanged(auth, u => {
    user = u;
    stopListeners();
    closeMenu(false);
    // The account changed under them, so they go at once rather than animating over the new state
    ["entryDialog", "cycleDialog", "accountDialog", "nameDialog", "catDialog", "catsDialog", "spentDialog"].forEach(id => closeDialog($(id), { instant: true }));
    if (u) {
      document.body.dataset.auth = "in";
      startBooting();
      subscribeAll();
      watchQueuedWrites();
    } else {
      document.body.dataset.auth = "out";
      try { localStorage.removeItem("signedIn"); } catch (e) {}
      endBooting();
      queuedFromBefore = false;
      expenses = []; income = []; planned = []; budgets = {}; recurring = []; recurringIncome = [];
      people = []; loans = []; loanPayments = [];
      categories = [...DEFAULT_CATEGORIES]; catStyles = {};
      editingBudgets = false;
      applyStartDay(DEFAULT_START_DAY);
    }
    renderAll();
  });
}

function stopListeners() {
  unsubs.forEach(f => f()); unsubs = [];
  dueUnsub(); dueUnsub = () => {}; dueItems = [];
  monthUnsubs.forEach(f => f()); monthUnsubs = [];
  monthPending = new Set(MONTH_COLS);
  loansPending = new Set(LOAN_COLS);
  cancelMonthSlide();
}
const mapDocs = s => s.docs.map(d => ({ id: d.id, ...d.data() }));

function subscribeAll() {
  subscribeMonth();
  subscribeDue();
  unsubs.push(onSnapshot(userDoc("settings", "categories"), s => {
    categories = s.exists() && Array.isArray(s.data().list) ? s.data().list : [...DEFAULT_CATEGORIES];
    catStyles = s.exists() && s.data().styles && typeof s.data().styles === "object" ? s.data().styles : {};
    renderAll();
    if ($("catsDialog").open) renderCatsManager();
    if ($("entryDialog").open && usesCategory(entryKind)) buildCatGrid(); // keeps the chosen one; picks up renames and looks
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
  unsubs.push(listenLoans("people", docs => { people = docs; }), listenLoans("loans", docs => { loans = docs; }),
    listenLoans("loanPayments", docs => { loanPayments = docs; }));
}

// ----- Due planned payments: dated today or earlier, in any month, and not yet marked spent -----
// The month listener only sees the month on screen, so a payment planned in an earlier month and never marked
// spent would be forgotten. This one listens to every planned item up to today; a new day starts a new query.
let dueItems = [], dueUnsub = () => {}, dueDay = "";
function subscribeDue() {
  dueUnsub();
  dueDay = todayISO();
  dueUnsub = onSnapshot(query(userCol("planned"), where("date", "<=", dueDay), orderBy("date", "asc")),
    s => { dueItems = mapDocs(s); renderAll(); }, onErr);
}
// Past midnight with the app open (or reopened from the background): move the reminders to the new day
function checkNewDay() { if (user && dueDay && todayISO() !== dueDay) { subscribeDue(); renderAll(); } }
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkNewDay(); });
setInterval(checkNewDay, 60000);
const dueNow = () => dueItems.filter(p => p.date && p.date <= todayISO() && !markedSpent.has(p.id));
// "Due today" in amber, "3 days late" in red; nothing for later dates
function dueLabel(p) {
  if (!p.date) return null;
  const late = daysBetween(p.date, todayISO());
  if (late < 0) return null;
  return h("span", { class: `due-label ${late ? "late" : "today"}` }, svg(late ? "alert" : "clock", 13),
    h("span", { text: late ? plural(late, "oneDayLate", "nDaysLate") : t("plannedDueToday") }));
}
// Review / Show go to the Planned tab of the month holding the oldest of these
const goToPlannedFor = items => { location.hash = hashFor("planned", periodOf(items[0].date, startDay)); };
function renderDue() {
  const due = dueNow(), today = todayISO();
  const box = $("dueBanner");
  box.hidden = !due.length;
  if (due.length) {
    const late = due.filter(p => p.date < today).length, now = due.length - late;
    box.replaceChildren(
      h("span", { class: "rec-icon" }, svg("bell", 18)),
      h("div", { class: "rec-text" },
        h("div", { class: "rec-title", text: plural(due.length, "dueOnePayment", "dueNPayments") }),
        h("div", { class: "rec-sub", text: [late ? t("dueLateN", { n: fmtInt(late) }) : "", now ? t("dueTodayN", { n: fmtInt(now) }) : "", fmt(sum(due))].filter(Boolean).join(" · ") })),
      h("button", { type: "button", class: "btn primary", onclick: () => goToPlannedFor(due) }, t("review")));
  } else box.replaceChildren();
  // On the Planned tab: late ones from months before the one on screen, which its list can't show
  const { start } = currentRange(), earlier = due.filter(p => p.date < start);
  const eb = $("dueEarlier");
  eb.hidden = !earlier.length;
  if (earlier.length) {
    const months = new Set(earlier.map(p => periodOf(p.date, startDay)));
    eb.replaceChildren(
      h("span", { class: "rec-icon" }, svg("bell", 18)),
      h("div", { class: "rec-text" },
        h("div", { class: "rec-title", text: months.size === 1 ? t("earlierOne", { n: fmtInt(earlier.length), month: periodShort([...months][0]) }) : t("earlierN", { n: fmtInt(earlier.length) }) }),
        h("div", { class: "rec-sub", text: fmt(sum(earlier)) })),
      h("button", { type: "button", class: "btn secondary", onclick: () => goToPlannedFor(earlier) }, t("show")));
  } else eb.replaceChildren();
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
const LOAN_COLS = ["people", "loans", "loanPayments"];
let loansPending = new Set(LOAN_COLS);
let lastRenderSettled = false;

// ----- Booting: skeletons show from sign-in until the month and the loans have first loaded (index.html starts it
// before any script runs when the person was signed in last time). A fallback ends it if a load never answers.
let bootTimer = 0;
function startBooting() {
  try { localStorage.setItem("signedIn", "1"); } catch (e) {}
  document.body.dataset.booting = "";
  clearTimeout(bootTimer);
  bootTimer = setTimeout(endBooting, 10000);
}
function endBooting() {
  clearTimeout(bootTimer);
  delete document.body.dataset.booting;
}

function renderAll() {
  const settled = monthPending.size === 0 && loansPending.size === 0;
  if (settled && "booting" in document.body.dataset) endBooting();
  const animate = settled && lastRenderSettled && !reducedMotion.matches && !document.hidden;
  lastRenderSettled = settled;
  renderSummary(animate);
  renderLists(animate);
  renderBudgets();
  renderSide();
  renderChart();
  renderBadges();
  renderDue();
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

// Derived loan state, recomputed only when a loan snapshot replaces one of the arrays.
// persons: per person, the net of what's open with them (+ they owe you) and when they last came up, for the sheet's chips.
let loanMemo = null;
function loanState() {
  if (loanMemo && loanMemo.people === people && loanMemo.loans === loans && loanMemo.pays === loanPayments) return loanMemo;
  const states = loanStates(people, loans, loanPayments);
  const byPerson = new Map(people.map(p => [p.id, { person: p, balance: 0, last: "" }]));
  for (const st of states) {
    const e = byPerson.get(st.person.id), lastPay = st.payments.at(-1)?.date || "";
    e.balance = Math.round((e.balance + (st.loan.dir === "gave" ? st.left : -st.left)) * 100) / 100;
    e.last = [e.last, st.loan.date || "", lastPay].sort().at(-1);
  }
  return (loanMemo = {
    people, loans, pays: loanPayments, states, totals: totals(states), persons: [...byPerson.values()],
    byId: new Map(states.map(st => [st.loan.id, st]))
  });
}
const loanFlowNow = () => { const { start, end } = currentRange(); return flowBetween(loanState().states, start, end); };

function renderSummary(animate) {
  $("monthLabel").textContent = periodShort(selectedMonth);
  $("monthBtn").setAttribute("aria-label", `${t("pickMonth")}: ${periodLabel(selectedMonth)}`);
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
  $("incomeSub").textContent = plural(income.length, "oneEntry", "entries");
  $("spentSub").textContent = earned > 0
    ? t("kpiSpentSub", { pct: fmtInt(Math.round(spent / earned * 100)), n: fmtInt(expenses.length) })
    : plural(expenses.length, "oneEntry", "entries");
  $("plannedSub").textContent = t("kpiPlannedSub", { n: fmtInt(planned.length) });
}

function renderBadges() {
  const count = (id, n) => { $(id).textContent = n ? fmtInt(n) : ""; };
  count("badge-expenses", expenses.length);
  count("badge-income", income.length);
  count("badge-planned", planned.length);
  const due = dueNow().length;
  $("badge-planned-due").textContent = due ? fmtInt(due) : "";
  if (due) $("navPlanned").setAttribute("aria-label", t("plannedDueAria", { n: fmtInt(due) }));
  else $("navPlanned").removeAttribute("aria-label");
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
function entryRow({ key, icon, title, sub, subClass = "", amount, amountClass = "", menu, extra, onOpen }) {
  return h("div", { class: onOpen ? "row tappable" : "row", "data-key": key, onclick: onOpen ? e => { if (!e.target.closest("button")) onOpen(); } : null },
    icon,
    h("div", { class: "row-info" }, h("div", { class: "row-title", text: title }),
      Array.isArray(sub) ? (sub.length ? h("div", { class: "row-sub" }, sub) : null)
        : sub ? h("div", { class: `row-sub ${subClass}`.trim(), text: sub }) : null),
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
  sub: [dueLabel(p), p.note ? h("span", { class: "sub-text", text: catLabel(p.category) }) : null].filter(Boolean),
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
  $("expCount").textContent = plural(exp.length, "oneEntry", "entries");
  renderGrouped("list", exp, expenseRow, filtering ? { msg: t("noMatches") }
    : { msg: t("noExpenses"), actionLabel: t("addExpense"), onAction: () => openEntry("expense") });

  const inc = income.filter(i => matchesSearch(i.note, t("income")));
  $("incCount").textContent = plural(inc.length, "oneEntry", "entries");
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

// ----- Loans: the list of loans, or one loan with its payments -----
const personIcon = p => h("span", { class: `cat-icon person-icon tone-${hashStr(p.id) % 8}`, "aria-hidden": "true", text: ([...cleanName(p.name)][0] || "?").toUpperCase() });
const plural = (n, one, many) => t(new Intl.PluralRules(LOCALES[lang]).select(n) === "one" ? one : many, { n: fmtInt(n) });
const loanCountText = n => plural(n, "oneLoan", "nLoans");
const balanceClass = b => (b > 0 ? "pos" : b < 0 ? "owe" : "settled");
const balanceLabel = b => t(b > 0 ? "owesYou" : b < 0 ? "youOweThem" : "settled");
const dirLabel = dir => t(dir === "gave" ? "youGave" : "youGot"); // "You lent" / "You borrowed"
const loanTone = st => (st.settled ? "settled" : st.loan.dir === "gave" ? "pos" : "owe");
const dueOf = st => (!st.settled && isValidDue(st.loan.due) ? st.loan.due : "");
// Open loans with a due date first, soonest (so most overdue) on top; then the rest, newest first
const byDueThenNewest = (a, b) => {
  const da = dueOf(a), db = dueOf(b);
  return (!!db - !!da) || (da && db ? da.localeCompare(db) : 0)
    || (b.loan.date || "").localeCompare(a.loan.date || "") || (b.loan.createdAt || 0) - (a.loan.createdAt || 0);
};

function renderLoans() {
  const st = loanState();
  // A loan in the URL that doesn't exist (deleted, or a stale link) falls back to the list once loans have loaded
  if (selectedLoan && !st.byId.has(selectedLoan) && loansPending.size === 0) {
    selectedLoan = null;
    if (currentTab === "loans") syncHash(false);
  }
  $("loansOverview").hidden = !!selectedLoan;
  $("loanView").hidden = !selectedLoan;
  renderLoanOverview(st);
  renderLoanView(selectedLoan ? st.byId.get(selectedLoan) : null);
}

// Loan rows are links (#/loans?l=id), so they work with the keyboard and back/forward
const loanRow = st => {
  const due = dueOf(st);
  const status = st.settled ? (st.settledOn ? t("settledOn", { date: fmtDate(st.settledOn) }) : t("settled"))
    : due ? (isOverdue(due) ? t("overdue") : dueText(due)) : null;
  return h("a", {
    class: "row tappable person-row", "data-key": "loans:" + st.loan.id, "data-loan": st.loan.id,
    href: hashFor("loans", selectedMonth, st.loan.id)
  },
    personIcon(st.person),
    h("div", { class: "row-info" }, h("div", { class: "row-title", text: st.person.name }),
      h("div", { class: `row-sub${isOverdue(due) ? " overdue" : ""}`, text: [dirLabel(st.loan.dir), status, st.loan.note || null].filter(Boolean).join(" · ") })),
    h("span", { class: `row-amt num ${st.settled ? "" : loanTone(st)}`, text: fmt(st.settled ? st.loan.amount : st.left) }),
    h("span", { class: "row-chev" }, svg("chevron", 18)));
};

function renderLoanOverview(st) {
  const { owedToYou, youOwe, toYouN, youOweN } = st.totals;
  const tot = $("loanTotals");
  if (!unchanged(tot, st.totals, lang)) tot.replaceChildren(
    h("div", { class: "lt-item" }, h("div", { class: "label", text: t("owedToYou") }),
      h("div", { class: `lt-value num ${owedToYou ? "pos" : ""}`, text: fmt(owedToYou) }), h("div", { class: "lt-sub", text: loanCountText(toYouN) })),
    h("div", { class: "lt-item" }, h("div", { class: "label", text: t("youOwe") }),
      h("div", { class: `lt-value num ${youOwe ? "owe" : ""}`, text: fmt(youOwe) }), h("div", { class: "lt-sub", text: loanCountText(youOweN) })));

  const visible = st.states.filter(x => matchesSearch(x.person.name, x.loan.note, ...x.payments.map(p => p.note)));
  const open = visible.filter(x => !x.settled).sort(byDueThenNewest);
  const settled = visible.filter(x => x.settled).sort((a, b) => (b.settledOn || "").localeCompare(a.settledOn || "") || byDueThenNewest(a, b));
  $("loanCount").textContent = open.length ? loanCountText(open.length) : "";

  const openBox = $("loanOpen"), settledBox = $("loanSettled");
  const sig = [lang, todayISO(), selectedMonth];
  if (!st.states.length) {
    if (!unchanged(openBox, "none", sig)) openBox.replaceChildren(emptyState({ msg: t("noLoans"), actionLabel: t("addLoan"), onAction: () => openLoanSheet() }));
  } else if (!visible.length) {
    if (!unchanged(openBox, "nomatch", sig)) openBox.replaceChildren(emptyState({ msg: t("noMatches") }));
  } else if (!open.length) {
    if (!unchanged(openBox, "allsettled", sig)) openBox.replaceChildren(emptyState({ msg: t("noOpenLoans") }));
  } else if (!unchanged(openBox, open, sig)) openBox.replaceChildren(...open.map(loanRow));
  if (!unchanged(settledBox, settled, sig)) settledBox.replaceChildren(...settled.map(loanRow));
  $("settledHead").hidden = !settled.length;
}

function renderLoanView(st) {
  const card = $("loanCard"), box = $("loanTimeline");
  if (!st) {
    [card, box].forEach(el => { lastRendered.delete(el); el.replaceChildren(); });
    $("historyCount").textContent = "";
    return;
  }
  const { loan, person } = st, due = dueOf(st);
  const pct = Math.round(st.paid / Number(loan.amount) * 100);
  if (!unchanged(card, loan, person, st.paid, st.settledOn, todayISO(), lang, selectedMonth)) card.replaceChildren(...[
    h("div", { class: "person-top" },
      h("a", { class: "back-link", href: hashFor("loans", selectedMonth) }, svg("back", 18), t("tabLoans")),
      h("button", { type: "button", class: "icon-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": t("moreActions", { name: person.name }),
        onclick: e => openMenu(e.currentTarget, [
          { icon: "edit", label: t("editLoan"), onSelect: () => openLoanSheet({ item: loan }) },
          { icon: "user", label: t("renamePerson", { name: person.name }), onSelect: () => openRename(person) },
          { icon: "trash", label: t("deleteLoan"), danger: true, onSelect: guard(() => deleteLoan(st)) }
        ]) }, svg("more", 20))),
    h("div", { class: "person-id" }, personIcon(person),
      h("div", { class: "loan-who" }, h("h2", { class: "person-name", text: person.name }),
        h("div", { class: "loan-meta", text: [t(loan.dir === "gave" ? "lentOn" : "borrowedOn", { amt: fmt(loan.amount), date: fmtDate(loan.date) }), loan.note || null].filter(Boolean).join(" · ") }))),
    h("div", { class: "person-bal" },
      h("div", { class: "label", text: t(st.settled ? "settled" : loan.dir === "gave" ? "leftToGet" : "leftToPay") }),
      h("div", { class: `person-amt num ${loanTone(st)}`, text: fmt(st.settled ? loan.amount : st.left) }),
      h("div", { class: `loan-progress ${loanTone(st)}`, "aria-hidden": "true" }, h("span", { style: `width: ${pct}%` })),
      h("div", { class: "due-line", text: t("paidOf", { paid: fmt(st.paid), total: fmt(loan.amount) }) }),
      due ? h("div", { class: `due-line${isOverdue(due) ? " overdue" : ""}`, text: dueText(due) }) : null,
      st.settled && st.settledOn ? h("div", { class: "due-line", text: t("settledOn", { date: fmtDate(st.settledOn) }) }) : null),
    st.settled ? null : h("div", { class: "person-actions single" },
      h("button", { type: "button", class: "btn primary", onclick: () => openPaymentSheet({ loanId: loan.id }) }, svg("plus", 18), t("addPayment")))
  ].filter(Boolean));

  const list = [...st.payments].reverse(); // newest first
  $("historyCount").textContent = list.length ? plural(list.length, "onePayment", "nPayments") : "";
  // The empty state's button belongs to this loan, so a different loan always rebuilds the list
  if (box.dataset.loan !== loan.id) { lastRendered.delete(box); box.dataset.loan = loan.id; }
  renderGrouped("loanTimeline", list.filter(p => matchesSearch(p.note)), paymentRow(st),
    searchQ ? { msg: t("noMatches") } : st.settled ? { msg: t("noPayments") }
      : { msg: t("noPayments"), actionLabel: t("addPayment"), onAction: () => openPaymentSheet({ loanId: loan.id }) });
}

// `leftAfter` is display-only; strip it before writing the payment back
const rawPayment = ({ leftAfter, ...p }) => p;
const paymentRow = st => p => entryRow({
  key: "loanPayments:" + p.id,
  icon: h("span", { class: `cat-icon ${st.loan.dir === "gave" ? "tone-5" : "tone-0"}` }, svg(st.loan.dir === "gave" ? "got" : "gave")),
  title: p.note || t(st.loan.dir === "gave" ? "repaidToYou" : "youRepaid"),
  sub: [p.note ? t(st.loan.dir === "gave" ? "repaidToYou" : "youRepaid") : null, p.leftAfter > 0 ? t("leftAfter", { amt: fmt(p.leftAfter) }) : t("paidInFull")].filter(Boolean).join(" · "),
  amount: (st.loan.dir === "gave" ? "+" : "−") + fmt(p.amount), amountClass: st.loan.dir === "gave" ? "pos" : "",
  menu: [
    { icon: "edit", label: t("edit"), onSelect: () => openPaymentSheet({ item: rawPayment(p) }) },
    { icon: "trash", label: t("delete"), danger: true, onSelect: guard(() => deleteWithUndo("loanPayments", rawPayment(p), t("deletedPayment"))) }
  ],
  onOpen: () => openPaymentSheet({ item: rawPayment(p) })
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
    list.replaceChildren(...categories.map(budgetEditRow),
      h("div", { class: "add-cat" }, h("button", { type: "button", class: "btn secondary", onclick: () => openCatsManager() }, svg("tag", 18), t("manageCats"))));
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
    h("span", { class: "budget-input" }, h("span", { "aria-hidden": "true", text: "৳" }), input));
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
      h("div", { class: "row-sub" }, dueLabel(p), h("span", { class: "sub-text", text: `${fmtDate(p.date)} · ${fmt(p.amount)}` }))),
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

  const daily = new Array(dim).fill(0), counts = new Array(dim).fill(0);
  expenses.forEach(e => { const i = daysBetween(range.start, e.date); if (i >= 0 && i < dim) { daily[i] += Number(e.amount); counts[i]++; } });
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
  // Clones carry no listeners, so both charts get their own scrubber
  const model = { daily, counts, cum, end, dim, dateAt, budgetTotal, x, yv, W, H };
  [box, $("mChart")].forEach(b => attachScrub(b.querySelector(".chart-plot"), model));
}

// Scrubbing: touch and slide (or hover with a mouse, or arrow keys) to see any day up to today:
// that day's spending, the running total and, with budgets, how it stands against the pace line.
// Sideways drags scrub; up/down swipes still scroll the page (touch-action: pan-y). Lifting the finger hides it.
function attachScrub(plot, m) {
  const guide = h("span", { class: "chart-guide", "aria-hidden": "true" });
  const dot = h("span", { class: "chart-sdot", "aria-hidden": "true" });
  const card = h("div", { class: "chart-scard", "aria-live": "polite" });
  plot.append(guide, dot, card);
  plot.tabIndex = 0;
  plot.setAttribute("role", "group");
  plot.setAttribute("aria-label", t("chartScrub"));
  let day = 0, dragging = false, touch = false;
  const show = d => {
    d = Math.max(1, Math.min(m.end, d));
    if (d === day) return;
    if (day && touch) try { navigator.vibrate?.(5); } catch (e) { /* not allowed here */ }
    day = d;
    const total = m.cum[d - 1], spent = m.daily[d - 1], n = m.counts[d - 1];
    const leftPct = m.x(d) / m.W * 100, topPct = m.yv(total) / m.H * 100;
    guide.style.left = dot.style.left = `${leftPct}%`;
    dot.style.top = `${topPct}%`;
    card.classList.toggle("low", topPct < 45); // keep the card away from the dot vertically
    let pace = null;
    if (m.budgetTotal) {
      const diff = Math.round(total - m.budgetTotal * (m.dim > 1 ? (d - 1) / (m.dim - 1) : 1));
      pace = h("div", { class: `sc-pace ${diff > 0 ? "over" : "under"}`,
        text: Math.abs(diff) < 1 ? t("chartOnPace") : t(diff > 0 ? "chartOver" : "chartUnder", { amt: fmt(Math.abs(diff)) }) });
    }
    // replaceChildren would print a null as the text "null", so leave missing parts out
    card.replaceChildren(...[
      h("div", { class: "sc-date", text: dayLabel(m.dateAt(d)) }),
      h("div", { class: "sc-day", text: spent ? `${t("chartDayAmt", { amt: fmt(spent) })} · ${plural(n, "chartOneExp", "chartNExp")}` : t("chartNoSpend") }),
      h("div", { class: "sc-total", text: t("chartSoFar", { amt: fmt(total) }) }),
      pace].filter(Boolean));
    plot.classList.add("scrubbing");
    // Beside the line: to its right if the card fits there, else to its left, always inside the chart
    const pw = plot.clientWidth, cw = card.offsetWidth, gx = leftPct / 100 * pw, gap = 10;
    const at = gx + gap + cw <= pw ? gx + gap : gx - gap - cw;
    card.style.left = `${Math.max(0, Math.min(pw - cw, at))}px`;
  };
  const hide = () => { day = 0; dragging = false; plot.classList.remove("scrubbing"); card.replaceChildren(); };
  const dayAt = e => {
    const r = plot.getBoundingClientRect();
    return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * (m.dim - 1)) + 1;
  };
  plot.addEventListener("pointerdown", e => {
    if (e.button > 0) return;
    dragging = true; touch = e.pointerType !== "mouse";
    try { plot.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    show(dayAt(e));
  });
  plot.addEventListener("pointermove", e => { if (dragging || e.pointerType === "mouse") { touch = e.pointerType !== "mouse"; show(dayAt(e)); } });
  plot.addEventListener("pointerup", e => { if (e.pointerType === "mouse") dragging = false; else hide(); });
  plot.addEventListener("pointercancel", hide); // e.g. the browser took over for a vertical scroll
  plot.addEventListener("pointerleave", e => { if (e.pointerType === "mouse" && !dragging) hide(); });
  plot.addEventListener("keydown", e => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (step) { e.preventDefault(); touch = false; show((day || m.end) + (day ? step : 0)); }
    else if (e.key === "Home") { e.preventDefault(); show(1); }
    else if (e.key === "End") { e.preventDefault(); show(m.end); }
    else if (e.key === "Escape" && day) { e.preventDefault(); hide(); }
  });
  plot.addEventListener("blur", hide);
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
// Asks which day it was paid (today unless changed; not in the future), then moves it to expenses on that day
let spentFor = null;
function markSpent(p) {
  if (markedSpent.has(p.id)) return;
  spentFor = p;
  $("spentItem").textContent = `${p.note || catLabel(p.category)} · ${fmt(p.amount)}`;
  $("spentPlanned").textContent = p.date ? t("plannedFor", { date: fmtDate(p.date) }) : "";
  $("spentDate").max = todayISO();
  setSpentDate(todayISO());
  openDialog($("spentDialog"));
  $("spentSave").focus({ preventScroll: true });
}
function setSpentDate(iso) { $("spentDate").value = iso; syncSpentChips(); }
function syncSpentChips() {
  const v = $("spentDate").value, today = todayISO(), yest = addDays(today, -1);
  document.querySelectorAll('input[name="spentChoice"]').forEach(r => { r.checked = (r.value === "today" && v === today) || (r.value === "yesterday" && v === yest); });
  const other = !!v && v !== today && v !== yest;
  $("spentDatePick").classList.toggle("selected", other);
  $("spentDateLabel").textContent = other ? fmtDate(v) : t("pickDate");
  fieldError("spentDateErr", "");
}
document.querySelectorAll('input[name="spentChoice"]').forEach(r => { r.onchange = () => setSpentDate(r.value === "today" ? todayISO() : addDays(todayISO(), -1)); });
$("spentDate").addEventListener("change", syncSpentChips);
$("spentDate").addEventListener("click", () => { try { $("spentDate").showPicker(); } catch (e) { /* opens natively, or unsupported */ } });
$("spentCancel").onclick = () => closeDialog($("spentDialog"));
$("spentDialog").onclick = e => { if (e.target === $("spentDialog")) closeDialog($("spentDialog")); };
$("spentSave").onclick = guard(() => {
  const p = spentFor, date = $("spentDate").value;
  if (!p || "leaving" in $("spentDialog").dataset) return;
  if (!date) { fieldError("spentDateErr", t("dateNeeded")); return; }
  if (date > todayISO()) { fieldError("spentDateErr", t("spentFuture")); return; }
  if (markedSpent.has(p.id)) return;
  markedSpent.add(p.id);
  closeDialog($("spentDialog"));
  writeInBackground(addDoc(userCol("expenses"), {
    amount: p.amount, category: p.category, date,
    note: p.note || "", recurringId: null, createdAt: Date.now()
  }));
  writeInBackground(deleteDoc(userDoc("planned", p.id)));
  // Paid in another month than the one on screen: say where it went, since it won't appear here
  const { start, end } = currentRange();
  toast(date < start || date > end ? t("movedToExpensesOn", { date: fmtDate(date) }) : t("movedToExpenses"));
});

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

// ===== Categories: create, rename, restyle, delete =====
// settings/categories holds { list: [names, in order], styles: { name: { icon, tone } } }. Entries store the name,
// so a rename or a delete rewrites every expense, planned cost and expense repeat that uses it (all months).
const CAT_ENTRY_COLS = ["expenses", "planned", "recurring"];
const catsRef = () => doc(db, "users", user.uid, "settings", "categories");
const budgetsRef = () => doc(db, "users", user.uid, "settings", "budgets");
const saveCats = (list, styles) => b => b.set(catsRef(), { list, styles });
// Every entry in the category, read from the server (or the local cache when offline)
async function entriesInCategory(name) {
  const snaps = await Promise.all(CAT_ENTRY_COLS.map(col => getDocs(query(userCol(col), where("category", "==", name)))));
  return snaps.flatMap((sn, i) => sn.docs.map(d => ({ col: CAT_ENTRY_COLS[i], id: d.id })));
}
const entryRef = e => doc(db, "users", user.uid, e.col, e.id);
// Same name, ignoring case, or a built-in's Bangla label
const catClash = (name, except) => categories.find(c => c !== except && (c.toLowerCase() === name.toLowerCase() || CAT_BN[c] === name));
const usesThisMonth = c => [...expenses, ...planned].filter(e => e.category === c).length;

// ----- Editor: name, icon and colour; also the way into deleting -----
let catEdit = null; // { old: name | null, onSaved, mode: "edit" | "delete" }
function openCatEditor(old, { onSaved = null } = {}) {
  catEdit = { old, onSaved, mode: "edit" };
  const st = old ? catStyle(old) : null;
  // A new one starts on the least-used colour (the first such), so it stands apart from the rest
  const uses = [0, 1, 2, 3, 4, 5, 6, 7].map(n => categories.filter(c => catStyle(c).tone === n).length);
  const tone = st ? st.tone : uses.indexOf(Math.min(...uses.slice(0, 7))); // grey (7) is left for "Other"
  $("catTitle").textContent = t(old ? "editCatTitle" : "newCatTitle");
  $("catName").value = old ? catLabel(old) : "";
  catEdit.icon = st ? { icon: st.icon, svg: st.svg } : { icon: "tag" };
  $("catIconSearch").value = "";
  renderIconChoices();
  $("catTones").replaceChildren(...[0, 1, 2, 3, 4, 5, 6, 7].map(n => h("label", { class: `tone-opt tone-${n}` },
    h("input", { type: "radio", name: "catTone", value: n, checked: n === tone || null, "aria-label": t("colourN", { n: fmtInt(n + 1) }) }),
    h("span", { class: "tone-face" }))));
  setCatMode("edit");
  fieldError("catNameErr", "");
  syncCatPreview();
  openDialog($("catDialog"));
  if (!old) $("catName").focus();
}
// ----- Icon picker: built-ins and suggestions, or a search over every Lucide icon (loaded on first search) -----
const iconOption = (value, label, el) => h("label", { class: "icon-opt", title: label },
  h("input", { type: "radio", name: "catIcon", value, checked: value === catEdit.icon.icon || null, "aria-label": label }),
  h("span", { class: "icon-face" }, el));
const iconLabel = name => name.replace(/-/g, " ");
// value → { icon, svg } for whatever the grid is showing, so a pick can be saved with its shapes
let iconChoices = new Map();
function setIconChoices(list, note = "") {
  iconChoices = new Map(list.map(c => [c.icon, c]));
  $("catIcons").replaceChildren(...list.map(c => iconOption(c.icon, c.label, c.svg ? svgMarkup(c.svg, 20) : svg(c.icon, 20))));
  $("catIconNote").textContent = note;
  $("catIconNote").hidden = !note;
}
function renderIconChoices() {
  const q = $("catIconSearch").value.trim().toLowerCase();
  if (!q) {
    const list = [...CAT_ICONS.map(k => ({ icon: k, label: iconLabel(BUILTIN[k].lucide) })),
      ...Object.entries(SUGGESTED).map(([n, m]) => ({ icon: `lucide:${n}`, label: iconLabel(n), svg: m }))];
    // A Lucide icon picked earlier that isn't among these goes first, so the current choice is always visible
    const cur = catEdit.icon;
    if (!list.some(c => c.icon === cur.icon) && cur.svg) list.unshift({ icon: cur.icon, label: iconLabel(cur.icon.slice(7)), svg: cur.svg });
    setIconChoices(list);
    return;
  }
  if (!lucide) {
    setIconChoices([], t("iconsLoading"));
    loadLucide().then(() => { if ($("catDialog").open) renderIconChoices(); }, () => setIconChoices([], t("iconsOffline")));
    return;
  }
  const hits = searchIcons(q);
  setIconChoices(hits.slice(0, 120).map(n => LUCIDE_TO_BUILTIN[n]
    ? { icon: LUCIDE_TO_BUILTIN[n], label: iconLabel(n) }
    : { icon: `lucide:${n}`, label: iconLabel(n), svg: lucide.ICONS[n] }), hits.length ? "" : t("iconsNone"));
}
let lucide = null, lucideLoading = null;
const loadLucide = () => lucideLoading ||= import("./lucide-icons.js").then(m => { lucide = m; }, e => { lucideLoading = null; throw e; });
// Words match whole words or word beginnings ("car" finds car-front, not carrot's middle or bluetooth).
// Best first: the exact name, then words in the name, then search words (tags); icons matching only some
// of the words come after those matching all of them.
let iconIndex = null;
function searchIcons(q) {
  iconIndex ||= Object.keys(lucide.ICONS).map(n => [n, n.split("-"), (lucide.TAGS[n] || "").toLowerCase().split(/[\s-]+/)]);
  const words = q.split(/\s+/).filter(Boolean), joined = words.join("-");
  const scored = [];
  for (const [n, nameW, tagW] of iconIndex) {
    let score = n === joined ? 0 : 0.5, hit = 0;
    for (const w of words) {
      const s = nameW.includes(w) ? 1 : nameW.some(x => x.startsWith(w)) ? 2 : tagW.includes(w) ? 3 : tagW.some(x => x.startsWith(w)) ? 4 : 0;
      if (s) { hit++; score += s; }
    }
    if (hit) scored.push([words.length - hit, score, n.length, n]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : 1)).map(x => x[3]);
}
let iconSearchTimer;
$("catIconSearch").addEventListener("input", () => { clearTimeout(iconSearchTimer); iconSearchTimer = setTimeout(renderIconChoices, 120); });
// Enter in the search box shouldn't save the category
$("catIconSearch").addEventListener("keydown", e => { if (e.key === "Enter") e.preventDefault(); });
const catPick = name => $("catDialog").querySelector(`input[name="${name}"]:checked`)?.value;
// The big icon at the top, and the picked icon's highlight, follow the chosen icon and colour
function syncCatPreview() {
  const tone = Number(catPick("catTone") ?? 7);
  $("catPreview").replaceChildren(h("span", { class: `cat-icon tone-${tone}` }, iconSvg(catEdit.icon, 22)));
  $("catIcons").className = `icon-grid tone-${tone}`;
}
function setCatMode(mode) {
  catEdit.mode = mode;
  const del = mode === "delete";
  $("catMain").hidden = del;
  $("catDelBox").hidden = !del;
  $("catDelete").hidden = del || !catEdit.old;
  $("catSave").textContent = t(del ? "delete" : "save");
  $("catSave").classList.toggle("danger", del);
  $("catSave").classList.toggle("primary", !del);
  $("catCancel").textContent = t(del ? "back" : "cancel");
  if (del) {
    const old = catEdit.old, others = categories.filter(c => c !== old);
    $("catDelMsg").textContent = t("catDeleteTitle", { name: catLabel(old) });
    $("catMoveTo").replaceChildren(...others.map(c => h("option", { value: c, text: catLabel(c) })));
    $("catMoveTo").value = others.includes("Other") ? "Other" : others[0] || "";
  }
}
$("catDialog").addEventListener("change", e => {
  if (e.target.name === "catIcon") { const c = iconChoices.get(e.target.value); if (c) catEdit.icon = { icon: c.icon, svg: c.svg }; }
  if (e.target.name === "catIcon" || e.target.name === "catTone") syncCatPreview();
});
$("catName").addEventListener("input", () => fieldError("catNameErr", ""));
$("catCancel").onclick = () => { if (catEdit?.mode === "delete") setCatMode("edit"); else closeDialog($("catDialog")); };
$("catDelete").onclick = () => {
  if (categories.length <= 1) { toast(t("keepOneCat"), { error: true }); return; }
  setCatMode("delete");
};
$("catDialog").onclick = e => { if (e.target === $("catDialog")) closeDialog($("catDialog")); };
$("catForm").onsubmit = e => {
  e.preventDefault();
  if (!catEdit || "leaving" in $("catDialog").dataset) return;
  if (catEdit.mode === "delete") { guard(() => deleteCategory(catEdit.old, $("catMoveTo").value))(); return; }
  const name = $("catName").value.trim().replace(/\s+/g, " ");
  if (!name) { fieldError("catNameErr", t("catNeedName")); $("catName").focus(); return; }
  if (catClash(name, catEdit.old)) { fieldError("catNameErr", t("catExists", { name })); $("catName").focus(); return; }
  const ic = catEdit.icon, tone = Number(catPick("catTone") ?? 7);
  const style = ic.icon.startsWith("lucide:") && ic.svg ? { icon: ic.icon, svg: ic.svg, tone } : { icon: CAT_ICONS.includes(ic.icon) ? ic.icon : "tag", tone };
  const { old, onSaved } = catEdit;
  closeDialog($("catDialog"));
  guard(() => old ? saveCategory(old, name, style) : createCategory(name, style, onSaved))();
};

function createCategory(name, style, onSaved) {
  const list = [...categories, name], styles = { ...catStyles, [name]: style };
  writeAll([saveCats(list, styles)]);
  categories = list; catStyles = styles; // shown at once; the snapshot that follows says the same
  toast(t("catAdded", { name }));
  onSaved?.(name);
}

// Same name: only the look changes. New name: the list, its look, its budget and every entry move to it.
async function saveCategory(old, name, style) {
  if (name === old || name === catLabel(old)) {
    writeAll([saveCats(categories, { ...catStyles, [old]: style })]);
    toast(t("catSaved"));
    return;
  }
  const entries = await entriesInCategory(old);
  const styles = { ...catStyles, [name]: style };
  delete styles[old];
  const ops = [saveCats(categories.map(c => (c === old ? name : c)), styles)];
  if (budgets[old] !== undefined) {
    const next = { ...budgets, [name]: budgets[old] };
    delete next[old];
    ops.push(b => b.set(budgetsRef(), next));
  }
  entries.forEach(en => ops.push(b => b.update(entryRef(en), { category: name })));
  writeAll(ops);
  toast(t("catRenamed", { name, n: fmtInt(entries.length) }));
}

// Moves its entries to `target`, then removes it (with its look and budget). Undo puts all of it back.
async function deleteCategory(name, target) {
  if (categories.length <= 1 || !target || target === name) { toast(t("keepOneCat"), { error: true }); return; }
  closeDialog($("catDialog"));
  const entries = await entriesInCategory(name);
  const index = categories.indexOf(name), prevStyle = catStyles[name], prevBudget = budgets[name];
  const styles = { ...catStyles };
  delete styles[name];
  const ops = entries.map(en => b => b.update(entryRef(en), { category: target }));
  ops.push(saveCats(categories.filter(c => c !== name), styles));
  if (prevBudget !== undefined) { const next = { ...budgets }; delete next[name]; ops.push(b => b.set(budgetsRef(), next)); }
  writeAll(ops);
  toast(t("catDeleted", { name: catLabel(name), n: fmtInt(entries.length), to: catLabel(target) }), { actionLabel: t("undo"), onAction: () => {
    // Restore against the current state, so changes made in between are kept
    const list = categories.includes(name) ? [...categories] : [...categories.slice(0, index), name, ...categories.slice(index)];
    const back = [saveCats(list, prevStyle ? { ...catStyles, [name]: prevStyle } : catStyles),
      ...entries.map(en => b => b.update(entryRef(en), { category: name }))];
    if (prevBudget !== undefined) back.push(b => b.set(budgetsRef(), { ...budgets, [name]: prevBudget }));
    writeAll(back);
    toast(t("restored"));
  } });
}

// ----- Manager: every category with its use this month; tap one to edit it -----
function openCatsManager() {
  renderCatsManager();
  openDialog($("catsDialog"));
}
function renderCatsManager() {
  $("catsList").replaceChildren(...categories.map(c => {
    const n = usesThisMonth(c);
    return h("button", { type: "button", class: "cats-row", onclick: () => openCatEditor(c) },
      catIcon(c, "sm"),
      h("span", { class: "cats-text" }, h("span", { class: "cats-name", text: catLabel(c) }),
        h("span", { class: "cats-sub", text: n ? t("catUses", { n: fmtInt(n) }) : t("catUnused") })),
      h("span", { class: "row-chev" }, svg("chevron", 18)));
  }));
}
$("catsDone").onclick = () => closeDialog($("catsDialog"));
$("catsDialog").onclick = e => { if (e.target === $("catsDialog")) closeDialog($("catsDialog")); };
$("catsAdd").onclick = () => openCatEditor(null);
$("eCatEdit").onclick = () => openCatsManager();
$("acctCats").onclick = () => { closeDialog($("accountDialog")); openCatsManager(); };

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
