// Loans: each one is its own item, lent ("gave") or borrowed ("got"), with someone, paid back in parts.
//
//   loan:    { personId, dir: "gave" | "got", amount, date, due?, note }
//   payment: { loanId, amount, date, note }   money coming back on a loan you gave, or going out on one you got
//
// A loan is settled once its payments add up to its amount. Loans are neither income nor spending;
// only the cash they move counts towards "Left to spend".
// Sums are done in paisa (integer cents) so repeated decimals can't leave a ৳0.0000001 balance.

export const DIRS = ["gave", "got"];
const cents = n => Math.round(Number(n) * 100);
const positive = n => Number.isFinite(Number(n)) && Number(n) > 0;

// Optional due date on a loan: when it should be paid back ("YYYY-MM-DD")
export const isValidDue = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
export const isValidLoan = l => !!l && DIRS.includes(l.dir) && typeof l.personId === "string" && positive(l.amount);
export const isValidPayment = p => !!p && typeof p.loanId === "string" && positive(p.amount);

export const cleanName = s => String(s ?? "").trim().replace(/\s+/g, " ");
const normName = s => cleanName(s).toLocaleLowerCase();
// Case- and spacing-insensitive, so "rahim " and "Rahim" are the same person
export const findPerson = (people, name) => {
  const n = normName(name);
  return n ? people.find(p => normName(p.name) === n) || null : null;
};

// Oldest first; same-day items by creation time
export const byDateAsc = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0);

// One state per loan: { loan, person, paid, left, settled, settledOn, payments }.
// payments: oldest first, each with what was left right after it (`leftAfter`).
// Loans with someone unknown (e.g. deleted on another device while this one was offline), malformed loans and
// payments for unknown loans are ignored. Paying more than the loan's amount just settles it.
export function loanStates(people, loans, payments) {
  const byPerson = new Map(people.map(p => [p.id, p]));
  const byLoan = new Map();
  for (const p of payments) if (isValidPayment(p)) (byLoan.get(p.loanId) || byLoan.set(p.loanId, []).get(p.loanId)).push(p);
  const out = [];
  for (const loan of loans) {
    const person = byPerson.get(loan.personId);
    if (!person || !isValidLoan(loan)) continue;
    const total = cents(loan.amount);
    let paid = 0, settledOn = "";
    const list = (byLoan.get(loan.id) || []).sort(byDateAsc).map(p => {
      paid += cents(p.amount);
      if (!settledOn && paid >= total) settledOn = p.date || "";
      return { ...p, leftAfter: Math.max(0, total - paid) / 100 };
    });
    const left = Math.max(0, total - paid);
    out.push({ loan, person, paid: Math.min(paid, total) / 100, left: left / 100, settled: left === 0, settledOn, payments: list });
  }
  return out;
}

// What's still owed both ways, and how many open loans make it up
export function totals(states) {
  let toYou = 0, youOwe = 0, toYouN = 0, youOweN = 0;
  for (const s of states) {
    const c = cents(s.left);
    if (!c) continue;
    if (s.loan.dir === "gave") { toYou += c; toYouN++; } else { youOwe += c; youOweN++; }
  }
  return { owedToYou: toYou / 100, youOwe: youOwe / 100, toYouN, youOweN };
}

// Cash that loans moved between two ISO dates (inclusive): { in, out }.
// Lending is money out and its payments come in; borrowing is money in and its payments go out.
export function flowBetween(states, start, end) {
  let inC = 0, outC = 0;
  const add = (date, amount, isIn) => {
    if (!(date >= start && date <= end)) return;
    if (isIn) inC += cents(amount); else outC += cents(amount);
  };
  for (const { loan, payments } of states) {
    add(loan.date, loan.amount, loan.dir === "got");
    for (const p of payments) add(p.date, p.amount, loan.dir === "gave");
  }
  return { in: inC / 100, out: outC / 100 };
}

// The most a payment can be: the loan's amount minus every other payment on it
// (`editing`: a payment being edited, whose own amount is free again)
export function maxPayment(state, editing = null) {
  const others = state.payments.reduce((c, p) => c + (editing && p.id === editing.id ? 0 : cents(p.amount)), 0);
  return Math.max(0, cents(state.loan.amount) - others) / 100;
}
