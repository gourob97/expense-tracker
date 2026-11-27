import { test } from "node:test";
import assert from "node:assert/strict";
import { periodRange, periodOf, shiftPeriod, dateInPeriod, addDays, normalizeStartDay } from "../period.js";

test("startDay 1 is the calendar month", () => {
  assert.deepEqual(periodRange("2026-11", 1), { start: "2026-11-01", end: "2026-11-30", days: 30 });
  assert.deepEqual(periodRange("2028-02", 1), { start: "2028-02-01", end: "2028-02-29", days: 29 });
  assert.deepEqual(periodRange("2026-12", 1), { start: "2026-12-01", end: "2026-12-31", days: 31 });
  assert.equal(periodOf("2026-11-01", 1), "2026-11");
  assert.equal(periodOf("2026-11-30", 1), "2026-11");
});

test("startDay 25 runs 25th to 24th, across year ends", () => {
  assert.deepEqual(periodRange("2026-11", 25), { start: "2026-11-25", end: "2026-12-24", days: 30 });
  assert.deepEqual(periodRange("2026-12", 25), { start: "2026-12-25", end: "2027-01-24", days: 31 });
  assert.equal(periodOf("2026-11-24", 25), "2026-10");
  assert.equal(periodOf("2026-11-25", 25), "2026-11");
  assert.equal(periodOf("2027-01-10", 25), "2026-12");
});

test("startDay past a month's end uses its last day", () => {
  assert.deepEqual(periodRange("2026-01", 31), { start: "2026-01-31", end: "2026-02-27", days: 28 });
  assert.deepEqual(periodRange("2026-02", 31), { start: "2026-02-28", end: "2026-03-30", days: 31 });
  assert.deepEqual(periodRange("2026-04", 31), { start: "2026-04-30", end: "2026-05-30", days: 31 });
  assert.equal(periodOf("2026-02-27", 31), "2026-01");
  assert.equal(periodOf("2026-02-28", 31), "2026-02");
});

test("periods tile the timeline with no gaps or overlaps, for every start day", () => {
  for (let sd = 1; sd <= 31; sd++) {
    let key = "2025-11";
    let prevEnd = periodRange(shiftPeriod(key, -1), sd).end;
    for (let i = 0; i < 40; i++, key = shiftPeriod(key, 1)) {
      const r = periodRange(key, sd);
      assert.equal(r.start, addDays(prevEnd, 1), `sd=${sd} key=${key} start`);
      for (let d = 0; d < r.days; d++) assert.equal(periodOf(addDays(r.start, d), sd), key, `sd=${sd} ${addDays(r.start, d)}`);
      prevEnd = r.end;
    }
  }
});

test("recurring day lands inside the period", () => {
  assert.equal(dateInPeriod("2026-11", 25, 25), "2026-11-25");
  assert.equal(dateInPeriod("2026-11", 5, 25), "2026-12-05");
  assert.equal(dateInPeriod("2026-11", 31, 25), "2026-11-30");
  assert.equal(dateInPeriod("2026-02", 31, 1), "2026-02-28");
  assert.equal(dateInPeriod("2026-01", 28, 31), "2026-02-27");
  for (let sd = 1; sd <= 31; sd++) for (let day = 1; day <= 31; day++) {
    const r = periodRange("2026-01", sd), d = dateInPeriod("2026-01", day, sd);
    assert.ok(d >= r.start && d <= r.end, `sd=${sd} day=${day} → ${d}`);
  }
});

test("shiftPeriod and normalizeStartDay", () => {
  assert.equal(shiftPeriod("2026-12", 1), "2027-01");
  assert.equal(shiftPeriod("2026-01", -1), "2025-12");
  assert.equal(normalizeStartDay(25), 25);
  assert.equal(normalizeStartDay("7"), 7);
  for (const bad of [0, 32, 2.5, null, undefined, "x"]) assert.equal(normalizeStartDay(bad), 1);
});
