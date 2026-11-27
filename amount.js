// Amount fields: keep only what can be part of an amount, as the person types or pastes.
// Digits (Latin or Bangla), one decimal point, at most 2 decimals and 10 whole digits.
// Commas and anything else are dropped, so a pasted "৳1,250.50" becomes "1250.50".
// Returns the cleaned value and where the caret goes, so editing mid-number doesn't jump to the end.

const DIGIT = /[0-9০-৯]/, ZERO = /[0০]/;
export const MAX_WHOLE_DIGITS = 10, MAX_DECIMALS = 2;

export function cleanAmount(value, caret = String(value ?? "").length) {
  const src = String(value ?? "");
  const kept = []; // [char, index in src]
  let dot = false, whole = 0, decimals = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (DIGIT.test(ch)) {
      if (dot ? decimals < MAX_DECIMALS : whole < MAX_WHOLE_DIGITS) {
        kept.push([ch, i]);
        if (dot) decimals++; else whole++;
      }
    } else if (ch === "." && !dot) {
      dot = true;
      kept.push([ch, i]);
    }
  }
  // "007" → "7", but "0" and "0.5" stay
  while (kept.length > 1 && ZERO.test(kept[0][0]) && DIGIT.test(kept[1][0])) kept.shift();
  // ".5" → "0.5"
  if (kept[0]?.[0] === ".") kept.unshift(["0", -1]);
  return { value: kept.map(k => k[0]).join(""), caret: kept.filter(k => k[1] < caret).length };
}

// Groups the whole part the way Bangladesh and India write it: 1,25,000 (last three digits, then pairs).
// Takes a cleanAmount() result and maps the caret across the inserted commas.
export function groupAmount(value, caret = value.length) {
  const dot = value.indexOf(".");
  const whole = dot < 0 ? value : value.slice(0, dot);
  const n = whole.length;
  // A comma goes after digit i when the digits left after it are 3, 5, 7…
  const commaAfter = i => { const left = n - 1 - i; return left === 3 || (left > 3 && left % 2 === 1); };
  let out = "", commasBefore = 0;
  for (let i = 0; i < n; i++) {
    out += whole[i];
    if (commaAfter(i)) { out += ","; if (i + 1 <= caret) commasBefore++; }
  }
  return { value: out + (dot < 0 ? "" : value.slice(dot)), caret: caret + commasBefore };
}

// What an amount input shows after each keystroke: only valid characters, grouped
export const formatAmountInput = (raw, caret) => { const c = cleanAmount(raw, caret); return groupAmount(c.value, c.caret); };
