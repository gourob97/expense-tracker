import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanAmount } from "../amount.js";

const v = s => cleanAmount(s).value;

test("letters and symbols are dropped", () => {
  assert.equal(v("12a3"), "123");
  assert.equal(v("abc"), "");
  assert.equal(v("-50"), "50");
  assert.equal(v("1e5"), "15");
  assert.equal(v("৳1,250.50"), "1250.50");
  assert.equal(v("  2 000 "), "2000");
});

test("one decimal point, at most two decimals", () => {
  assert.equal(v("1.2.3"), "1.23");
  assert.equal(v("10.999"), "10.99");
  assert.equal(v(".5"), "0.5");
  assert.equal(v("5."), "5.");
});

test("leading zeros go, a lone zero stays", () => {
  assert.equal(v("007"), "7");
  assert.equal(v("0"), "0");
  assert.equal(v("00.5"), "0.5");
  assert.equal(v("০০৫"), "৫");
});

test("Bangla digits are kept as typed", () => {
  assert.equal(v("১২৩৪.৫"), "১২৩৪.৫");
  assert.equal(v("১২a৩"), "১২৩");
});

test("whole part is capped at 10 digits", () => {
  assert.equal(v("123456789012"), "1234567890");
  assert.equal(v("12345678901.25"), "1234567890.25");
});

test("caret stays where the person was typing", () => {
  // typed "x" between 12 and 34: "12x34" with caret after x (3) → "1234", caret 2
  assert.deepEqual(cleanAmount("12x34", 3), { value: "1234", caret: 2 });
  // pasted "৳1,250" at the start, caret at end
  assert.deepEqual(cleanAmount("৳1,250", 6), { value: "1250", caret: 4 });
  // ".5" with caret after the dot → "0.5", caret after the dot
  assert.deepEqual(cleanAmount(".5", 1), { value: "0.5", caret: 2 });
  // stripped leading zero before the caret moves it back
  assert.deepEqual(cleanAmount("05", 2), { value: "5", caret: 1 });
});

import { groupAmount, formatAmountInput } from "../amount.js";

test("groups like 1,25,000", () => {
  const g = s => groupAmount(s).value;
  assert.equal(g(""), "");
  assert.equal(g("5"), "5");
  assert.equal(g("999"), "999");
  assert.equal(g("1250"), "1,250");
  assert.equal(g("125000"), "1,25,000");
  assert.equal(g("1234567.5"), "12,34,567.5");
  assert.equal(g("1234567890"), "1,23,45,67,890");
  assert.equal(g("১২৫০০০"), "১,২৫,০০০");
  assert.equal(g("0."), "0.");
});

test("formatting keeps the caret on the same digit", () => {
  // typing the 4th digit at the end: "125|" + "0" → "1,250|"
  assert.deepEqual(formatAmountInput("1250", 4), { value: "1,250", caret: 5 });
  // already grouped text is re-read: "1,250" + "0" at end → "12,500"
  assert.deepEqual(formatAmountInput("1,2500", 6), { value: "12,500", caret: 6 });
  // deleting the comma's neighbour: "1,25|0" backspace → "1,20" → "120"
  assert.deepEqual(formatAmountInput("1,20", 3), { value: "120", caret: 2 });
  // caret before the first digit stays there
  assert.deepEqual(formatAmountInput("9125000", 1), { value: "91,25,000", caret: 1 });
  // a letter typed mid-number is dropped and the caret doesn't move past the next digit
  assert.deepEqual(formatAmountInput("12x50", 3), { value: "1,250", caret: 3 });
});
