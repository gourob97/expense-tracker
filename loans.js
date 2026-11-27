// Personal loans: one running balance per person, built from two kinds of transaction.
//
//   "gave": money left you (you lent it, or paid back what you owed)  → they owe you more
//   "got":  money came to you (you borrowed it, or were paid back)    → they owe you less
//
// Balance > 0: they owe you. Balance < 0: you owe them. 0: settled.
// Loans are neither income nor spending; only their cash movement counts towards "Left to spend".
// Sums are done in paisa (integer cents) so repeated decimals can't leave a ৳0.0000001 balance.

export const DIRS = ["gave", "got"];
const cents = n => Math.round(Number(n) * 100);

export const isValidTxn = t =>
  !!t && DIRS.includes(t.dir) && typeof t.personId === "string" && Number.isFinite(Number(t.amount)) && Number(t.amount) > 0;

// Change to the person's balance, in cents
const effect = t => (t.dir === "gave" ? 1 : -1) * cents(t.amount);

export const cleanName = s => String(s ?? "").trim().replace(/\s+/g, " ");
const normName = s => cleanName(s).toLocaleLowerCase();
// Case- and spacing-insensitive, so "rahim " and "Rahim" are the same person
export const findPerson = (people, name) => {
  const n = normName(name);
  return n ? people.find(p => normName(p.name) === n) || null : null;
};

// Oldest first; same-day entries by creation time
export const byDateAsc = (a, b) => (a.date || "").localeCompare(b.date || "") || (a.createdAt || 0) - (b.createdAt || 0);

// One entry per person: { person, balance, count, last }. Transactions for unknown people
// (e.g. deleted on another device while this one was offline) and malformed ones are ignored.
export function balances(people, txns) {
  const acc = new Map(people.map(p => [p.id, { person: p, c: 0, count: 0, last: "" }]));
  for (const t of txns) {
    const e = acc.get(t.personId);
    if (!e || !isValidTxn(t)) continue;
    e.c += effect(t);
    e.count++;
    if ((t.date || "") > e.last) e.last = t.date;
  }
  return [...acc.values()].map(({ person, c, count, last }) => ({ person, balance: c / 100, count, last }));
}

export function totals(entries) {
  let toYou = 0, youOwe = 0, toYouN = 0, youOweN = 0;
  for (const { balance } of entries) {
    const c = cents(balance);
    if (c > 0) { toYou += c; toYouN++; } else if (c < 0) { youOwe -= c; youOweN++; }
  }
  return { owedToYou: toYou / 100, youOwe: youOwe / 100, toYouN, youOweN };
}

// Cash that moved through loans between two ISO dates (inclusive): { in, out }
export function flowBetween(txns, start, end, isKnown = () => true) {
  let inC = 0, outC = 0;
  for (const t of txns) {
    if (!isValidTxn(t) || !isKnown(t.personId) || !(t.date >= start && t.date <= end)) continue;
    if (t.dir === "gave") outC += cents(t.amount); else inC += cents(t.amount);
  }
  return { in: inC / 100, out: outC / 100 };
}

// One person's transactions, oldest first, each with the balance right after it (`after`)
export function history(txns, personId) {
  let c = 0;
  return txns.filter(t => t.personId === personId && isValidTxn(t)).sort(byDateAsc)
    .map(t => { c += effect(t); return { ...t, after: c / 100 }; });
}

// Balance after applying a change: `without` is a transaction being edited (its old effect is taken out first)
export function balanceWith(balance, { dir, amount }, without = null) {
  let c = cents(balance);
  if (without && isValidTxn(without)) c -= effect(without);
  if (DIRS.includes(dir) && Number(amount) > 0) c += effect({ dir, amount });
  return c / 100;
}
