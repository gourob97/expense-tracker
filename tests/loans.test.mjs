import { test } from "node:test";
import assert from "node:assert/strict";
import { loanStates, totals, flowBetween, maxPayment, findPerson, cleanName, isValidLoan, isValidPayment, isValidDue } from "../loans.js";

const people = [{ id: "a", name: "Rahim" }, { id: "b", name: "Karim" }];
let seq = 0;
const loan = (personId, dir, amount, date, extra = {}) => ({ id: "l" + ++seq, personId, dir, amount, date, createdAt: seq, ...extra });
const pay = (loanId, amount, date, extra = {}) => ({ id: "p" + ++seq, loanId, amount, date, createdAt: seq, ...extra });
const stateOf = (loans, pays, id) => loanStates(people, loans, pays).find(s => s.loan.id === id);

test("a loan with no payments is fully open", () => {
  const l = loan("a", "gave", 1000, "2026-11-01");
  const s = stateOf([l], [], l.id);
  assert.equal(s.paid, 0); assert.equal(s.left, 1000); assert.equal(s.settled, false);
});

test("partial payments reduce what's left, each with what was left after it", () => {
  const l = loan("a", "gave", 1000, "2026-11-01");
  const pays = [pay(l.id, 300, "2026-11-10"), pay(l.id, 200, "2026-11-05")];
  const s = stateOf([l], pays, l.id);
  assert.equal(s.paid, 500); assert.equal(s.left, 500);
  assert.deepEqual(s.payments.map(p => [p.date, p.leftAfter]), [["2026-11-05", 800], ["2026-11-10", 500]]);
});

test("a loan is settled once paid in full, on the day of the last payment needed", () => {
  const l = loan("b", "got", 500, "2026-11-01");
  const s = stateOf([l], [pay(l.id, 200, "2026-11-03"), pay(l.id, 300, "2026-11-08")], l.id);
  assert.equal(s.settled, true); assert.equal(s.left, 0); assert.equal(s.settledOn, "2026-11-08");
});

test("overpaying settles without going negative", () => {
  const l = loan("a", "gave", 100, "2026-11-01");
  const s = stateOf([l], [pay(l.id, 150, "2026-11-02")], l.id);
  assert.equal(s.left, 0); assert.equal(s.paid, 100); assert.equal(s.settled, true);
});

test("two loans with the same person stay separate", () => {
  const l1 = loan("a", "gave", 1000, "2026-11-01"), l2 = loan("a", "gave", 300, "2026-11-05");
  const pays = [pay(l2.id, 300, "2026-11-06")];
  assert.equal(stateOf([l1, l2], pays, l1.id).left, 1000);
  assert.equal(stateOf([l1, l2], pays, l2.id).settled, true);
});

test("unknown people, malformed loans and stray payments are ignored", () => {
  const ok = loan("a", "gave", 100, "2026-11-01");
  const states = loanStates(people, [ok, loan("zzz", "gave", 100, "2026-11-01"), loan("a", "sideways", 100, "2026-11-01"), loan("a", "got", -5, "2026-11-01")],
    [pay("nope", 50, "2026-11-02"), pay(ok.id, 0, "2026-11-02")]);
  assert.equal(states.length, 1); assert.equal(states[0].left, 100);
});

test("totals add up what's left both ways and count open loans", () => {
  const l1 = loan("a", "gave", 1000, "2026-11-01"), l2 = loan("b", "got", 400, "2026-11-01"), l3 = loan("b", "gave", 50, "2026-11-01");
  const st = loanStates(people, [l1, l2, l3], [pay(l1.id, 250, "2026-11-02"), pay(l3.id, 50, "2026-11-03")]);
  assert.deepEqual(totals(st), { owedToYou: 750, youOwe: 400, toYouN: 1, youOweN: 1 });
});

test("cash flow: lending goes out and comes back in; borrowing comes in and goes back out", () => {
  const l1 = loan("a", "gave", 1000, "2026-10-30"), l2 = loan("b", "got", 400, "2026-11-02");
  const st = loanStates(people, [l1, l2], [pay(l1.id, 300, "2026-11-05"), pay(l2.id, 100, "2026-11-06"), pay(l2.id, 100, "2026-12-01")]);
  assert.deepEqual(flowBetween(st, "2026-11-01", "2026-11-30"), { in: 400 + 300, out: 100 });
});

test("max payment is what's left, plus the edited payment's own amount", () => {
  const l = loan("a", "gave", 1000, "2026-11-01"), p1 = pay(l.id, 600, "2026-11-02");
  const s = stateOf([l], [p1], l.id);
  assert.equal(maxPayment(s), 400);
  assert.equal(maxPayment(s, p1), 1000);
});

test("decimals don't leave dust", () => {
  const l = loan("a", "gave", 1, "2026-11-01");
  const pays = Array.from({ length: 10 }, () => pay(l.id, 0.1, "2026-11-02"));
  assert.equal(stateOf([l], pays, l.id).settled, true);
});

test("validation and names", () => {
  assert.equal(isValidDue("2026-12-01"), true); assert.equal(isValidDue("soon"), false);
  assert.equal(isValidLoan({ personId: "a", dir: "got", amount: 5 }), true);
  assert.equal(isValidPayment({ loanId: "x", amount: "abc" }), false);
  assert.equal(cleanName("  Rahim   Uddin "), "Rahim Uddin");
  assert.equal(findPerson(people, " rahim ")?.id, "a");
  assert.equal(findPerson(people, ""), null);
});
