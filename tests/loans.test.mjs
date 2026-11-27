import { test } from "node:test";
import assert from "node:assert/strict";
import { balances, totals, flowBetween, history, balanceWith, findPerson, cleanName, isValidTxn } from "../loans.js";

const people = [{ id: "a", name: "Rahim" }, { id: "b", name: "Karim" }, { id: "c", name: "Nadia" }];
let seq = 0;
const tx = (personId, dir, amount, date, extra = {}) => ({ id: "t" + ++seq, personId, dir, amount, date, createdAt: seq, ...extra });
const bal = (list, id) => balances(people, list).find(e => e.person.id === id);

test("gave raises what they owe you, got lowers it", () => {
  const list = [tx("a", "gave", 5000, "2026-11-01"), tx("a", "got", 2000, "2026-11-10")];
  assert.deepEqual({ ...bal(list, "a"), person: undefined }, { person: undefined, balance: 3000, count: 2, last: "2026-11-10", nextDue: "" });
});

test("borrowing makes the balance negative; overpaying flips the sign", () => {
  const list = [tx("b", "got", 10000, "2026-11-01"), tx("b", "gave", 4000, "2026-11-05")];
  assert.equal(bal(list, "b").balance, -6000);
  list.push(tx("b", "gave", 7000, "2026-11-20"));
  assert.equal(bal(list, "b").balance, 1000);
});

test("a person with no entries is settled", () => {
  assert.equal(bal([], "c").balance, 0);
  assert.equal(bal([], "c").count, 0);
});

test("decimals don't leave dust", () => {
  const list = [];
  for (let i = 0; i < 10; i++) list.push(tx("a", "gave", 0.1, "2026-11-01"));
  list.push(tx("a", "got", 1, "2026-11-02"));
  assert.equal(bal(list, "a").balance, 0);
  assert.deepEqual(totals(balances(people, list)), { owedToYou: 0, youOwe: 0, toYouN: 0, youOweN: 0 });
});

test("unknown people and malformed entries are ignored", () => {
  const list = [
    tx("ghost", "gave", 100, "2026-11-01"),
    tx("a", "lent", 100, "2026-11-01"),
    tx("a", "gave", -5, "2026-11-01"),
    tx("a", "gave", "abc", "2026-11-01"),
    tx("a", "gave", 0, "2026-11-01"),
    { id: "x", dir: "gave", amount: 10, date: "2026-11-01" },
    tx("a", "gave", "250", "2026-11-01")
  ];
  assert.equal(bal(list, "a").balance, 250);
  assert.equal(bal(list, "a").count, 1);
  assert.ok(!isValidTxn(null));
});

test("totals split what you're owed from what you owe", () => {
  const list = [tx("a", "gave", 3000, "2026-11-01"), tx("b", "got", 1200, "2026-11-01"), tx("c", "gave", 500, "2026-11-01"), tx("c", "got", 500, "2026-11-02")];
  assert.deepEqual(totals(balances(people, list)), { owedToYou: 3000, youOwe: 1200, toYouN: 1, youOweN: 1 });
});

test("flowBetween counts cash in and out inside the range, inclusive", () => {
  const list = [
    tx("a", "gave", 100, "2026-10-31"),
    tx("a", "gave", 200, "2026-11-01"),
    tx("b", "got", 300, "2026-11-15"),
    tx("a", "got", 50, "2026-11-30"),
    tx("a", "got", 999, "2026-12-01"),
    tx("ghost", "got", 1, "2026-11-10")
  ];
  const known = id => people.some(p => p.id === id);
  assert.deepEqual(flowBetween(list, "2026-11-01", "2026-11-30", known), { in: 350, out: 200 });
  assert.deepEqual(flowBetween(list, "2026-11-01", "2026-11-30"), { in: 351, out: 200 });
});

test("history is oldest first with the running balance", () => {
  const list = [
    tx("a", "got", 1000, "2026-11-10"),
    tx("a", "gave", 5000, "2026-11-01"),
    tx("b", "gave", 1, "2026-11-02"),
    tx("a", "gave", 500, "2026-11-10")
  ];
  assert.deepEqual(history(list, "a").map(t => [t.date, t.dir, t.after]),
    [["2026-11-01", "gave", 5000], ["2026-11-10", "got", 4000], ["2026-11-10", "gave", 4500]]);
});

test("balanceWith previews a new entry or an edit", () => {
  assert.equal(balanceWith(3000, { dir: "got", amount: 3000 }), 0);
  assert.equal(balanceWith(0, { dir: "got", amount: 500 }), -500);
  const old = tx("a", "gave", 1000, "2026-11-01");
  assert.equal(balanceWith(1000, { dir: "got", amount: 200 }, old), -200);
  assert.equal(balanceWith(1000, { dir: "gave", amount: NaN }, old), 0);
});

test("findPerson ignores case and spacing", () => {
  assert.equal(findPerson(people, "  rahim ")?.id, "a");
  assert.equal(findPerson([{ id: "z", name: "Abdul  Karim" }], "abdul karim")?.id, "z");
  assert.equal(findPerson(people, "   "), null);
  assert.equal(findPerson(people, "Someone"), null);
  assert.equal(cleanName("  Abdul   Karim "), "Abdul Karim");
});

test("repayments pay off the oldest entries first", () => {
  const list = [tx("a", "gave", 500, "2026-11-01"), tx("a", "gave", 300, "2026-11-05"), tx("a", "got", 600, "2026-11-10")];
  assert.deepEqual(history(list, "a").map(x => x.open), [0, 200, 0]);
});

test("overpaying opens an entry the other way", () => {
  const list = [tx("b", "got", 1000, "2026-11-01"), tx("b", "gave", 1500, "2026-11-03")];
  assert.deepEqual(history(list, "b").map(x => x.open), [0, 500]);
});

test("next due date skips paid-off entries", () => {
  const list = [
    tx("a", "gave", 500, "2026-11-01", { due: "2026-11-15" }),
    tx("a", "gave", 300, "2026-11-05", { due: "2026-12-01" }),
    tx("a", "got", 500, "2026-11-10")
  ];
  assert.equal(bal(list, "a").nextDue, "2026-12-01");
  list.push(tx("a", "got", 300, "2026-11-20"));
  assert.equal(bal(list, "a").nextDue, "");
});

test("next due date is the earliest open one, and ignores malformed dates", () => {
  const list = [
    tx("c", "got", 200, "2026-11-01", { due: "2026-12-20" }),
    tx("c", "got", 200, "2026-11-02", { due: "2026-12-05" }),
    tx("c", "got", 200, "2026-11-03", { due: "soon" })
  ];
  assert.equal(bal(list, "c").nextDue, "2026-12-05");
});
