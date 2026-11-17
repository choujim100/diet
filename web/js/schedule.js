// Schedules the food you have for the coming days, and says when each nutrient will run out.
// Pure functions, no DOM. Input items are what is in the pantry: [{ id, name, g, v }] with v = per-100 g values by
// nutrient key. There are no recipes: for every day the scheduler picks amounts of the foods you have so that the
// day comes as close as it can to your energy target and the NNR 2023 reference values, using only what is in stock.
import { NUTRIENT_KEYS } from './nutrition.js';

const K = NUTRIENT_KEYS;
const NK = K.length;
const E = K.indexOf('energy_kcal');
const IX = Object.fromEntries(K.map((k, i) => [k, i]));

export const HORIZON = 7;
const MAX_ENERGY_SHARE = 0.35;   // one food gives at most this share of a day's energy
const MAX_DAY_G = 500;           // and at most this many grams a day
const FLEX = 1.35;               // a food may be used up to this much faster than an even spread over the days
const STOP = 0.98;               // a day is filled when it reaches this share of the energy target
const LOW_DAY = 0.9;             // below this share of the energy target, a day counts as "short of food"

/** Weight of each nutrient in the day's score. Sodium is left out because salt (the same limit) already counts. */
function weights() {
  const w = new Float64Array(NK).fill(1);
  w[IX.fat_g] = 0.5; w[IX.carbs_g] = 0.5; w[IX.sodium_mg] = 0; w[E] = 0;
  return w;
}

/** How far a day's amounts are from the reference values (0 = nothing missing, nothing over a limit). */
function penalty(x, tgs, w) {
  let p = 0;
  for (let i = 0; i < NK; i++) {
    const t = tgs[i];
    if (!t || !w[i]) continue;
    let s = 0;
    if (t.kind === 'min') {
      s = Math.max(0, 1 - x[i] / t.lo);
      if (x[i] > 3 * t.lo) s += 0.25 * (x[i] / (3 * t.lo) - 1); // far above a reference value is not a goal
    } else if (t.kind === 'max') s = Math.max(0, x[i] / t.hi - 1);
    else if (x[i] < t.lo) s = 1 - x[i] / t.lo;
    else if (x[i] > t.hi) s = x[i] / t.hi - 1;
    p += w[i] * s;
  }
  return p;
}

/** Grams of a pantry item that can still be used: for a food kept in whole pieces, only the whole pieces. */
export const usableG = (g, unit) => (unit ? Math.floor(g / unit + PIECE_TOL) * unit : g);
const PIECE_TOL = 0.01; // absorbs the 0.1 g rounding of the stock
const round = (g) => (g >= 25 ? Math.round(g / 5) * 5 : Math.round(g));

function planDay({ items, remain, cap, tgs, w, kcal }) {
  const N = items.length;
  const amt = new Float64Array(N);
  const x = new Float64Array(NK);
  const trial = new Float64Array(NK);
  let P = penalty(x, tgs, w);
  for (let it = 0; it < 900 && x[E] < kcal * STOP; it++) {
    let bi = -1, bs = -Infinity, bstep = 0, bP = 0;
    for (let i = 0; i < N; i++) {
      const u = items[i].unit || 0; // grams in one piece: such a food is only ever used in whole pieces
      const room = Math.min(cap[i], remain[i]) - amt[i];
      if (room < (u ? u - 1e-6 : 1)) continue;
      const step = u || Math.min(room, Math.max(2, Math.min(10, cap[i] / 4)));
      const v = items[i].v;
      for (let k = 0; k < NK; k++) trial[k] = x[k] + (v[K[k]] * step) / 100;
      const dE = trial[E] - x[E];
      const P2 = penalty(trial, tgs, w);
      const score = (P - P2) / Math.max(dE, 8); // gain per kcal spent
      if (score > bs + 1e-12) { bs = score; bi = i; bstep = step; bP = P2; }
    }
    if (bi < 0) break;
    // nothing improves the day any more and what is left only makes it worse: stop once it is mostly filled
    if (bP - P > 0.05 && x[E] >= kcal * 0.85) break;
    amt[bi] += bstep;
    for (let k = 0; k < NK; k++) x[k] += (items[bi].v[K[k]] * bstep) / 100;
    P = bP;
  }
  return amt;
}

/**
 * Schedule the pantry over `horizon` days.
 * targets: from dailyTargets(). kcal: the energy target.
 * Returns { days: [{ index, lines: [{ id, name, g }], totals, kcal }], foodDays, shortFrom }.
 *   foodDays   how many days of the energy target the pantry holds (capped at the horizon)
 *   shortFrom  index of the first day that has less than 90 % of the energy target, or null
 */
export function scheduleWeek({ items, targets, kcal, horizon = HORIZON }) {
  const tgs = K.map((k) => targets[k]);
  const w = weights();
  const N = items.length;
  const remain = Float64Array.from(items.map((i) => i.g));
  const unit = items.map((i) => i.unit || 0);
  const carry = new Float64Array(N); // a piece-wise food that is used less than once a day saves up its share
  const energyOf = (i, g) => (items[i].v.energy_kcal * g) / 100;
  const stockEnergy = () => items.reduce((s, _, i) => s + energyOf(i, usableG(remain[i], unit[i])), 0);
  const foodDays = Math.min(horizon, stockEnergy() / (kcal * STOP));
  const days = [];
  for (let d = 0; d < horizon; d++) {
    const daysLeft = foodDays - d;
    const leftover = stockEnergy();
    const lines = [];
    const totals = Object.fromEntries(K.map((k) => [k, 0]));
    if (N && leftover >= 100) {
      const cap = new Float64Array(N);
      const share = Math.max(MAX_ENERGY_SHARE, 1.5 / N); // with only a few foods the limit would make a full day impossible
      const fairPieces = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        const kc = items[i].v.energy_kcal;
        const byEnergy = kc > 1 ? (share * kcal * 100) / kc : MAX_DAY_G;
        if (unit[i]) {
          const left = Math.floor(remain[i] / unit[i] + PIECE_TOL);
          fairPieces[i] = daysLeft >= 1 ? left / daysLeft : left;
          const allowed = daysLeft >= 1 ? Math.floor(carry[i] + fairPieces[i] * FLEX + 1e-9) : left;
          const byCaps = Math.max(1, Math.floor(Math.min(MAX_DAY_G, byEnergy) / unit[i] + 1e-9)); // at least one piece may be eaten
          cap[i] = Math.min(allowed, left, byCaps) * unit[i];
          continue;
        }
        const fair = daysLeft >= 1 ? (remain[i] / daysLeft) * FLEX : remain[i]; // the last, partial day takes what is left
        cap[i] = Math.min(MAX_DAY_G, byEnergy, fair, remain[i]);
      }
      const amt = planDay({ items, remain, cap, tgs, w, kcal: daysLeft >= 1 ? kcal : Math.min(kcal, leftover) });
      for (let i = 0; i < N; i++) {
        let g, pieces = 0;
        if (unit[i]) {
          pieces = Math.round(amt[i] / unit[i]);
          if (daysLeft >= 1) carry[i] = Math.max(0, carry[i] + fairPieces[i] - pieces);
          g = Math.min(pieces * unit[i], remain[i]);
          if (!pieces) continue;
        } else {
          g = Math.min(round(amt[i]), remain[i]);
          if (g < 1) continue;
          g = Math.floor(g * 10) / 10;
        }
        remain[i] -= g;
        lines.push(pieces ? { id: items[i].id, name: items[i].name, g: Math.round(g * 10) / 10, pieces, unit: unit[i] } : { id: items[i].id, name: items[i].name, g });
        for (let k = 0; k < NK; k++) totals[K[k]] += (items[i].v[K[k]] * g) / 100;
      }
    }
    lines.sort((a, b) => b.g - a.g);
    days.push({ index: d, lines, totals, kcal: totals.energy_kcal });
  }
  const short = days.findIndex((x) => x.kcal < kcal * LOW_DAY);
  return { days, foodDays, shortFrom: short < 0 ? null : short };
}

/**
 * How long the whole pantry covers each nutrient at the daily reference value.
 * Returns [{ key, supply, perDay, coverDays }] for every nutrient with a minimum, plus energy; sorted shortest first.
 */
export function coverage({ items, targets, kcal }) {
  const rows = [];
  const supply = Object.fromEntries(K.map((k) => [k, 0]));
  for (const it of items) { const g = usableG(it.g, it.unit); for (const k of K) supply[k] += (it.v[k] * g) / 100; }
  rows.push({ key: 'energy_kcal', supply: supply.energy_kcal, perDay: kcal, coverDays: supply.energy_kcal / kcal });
  for (const k of K) {
    const t = targets[k];
    if (!t || k === 'energy_kcal' || !(t.kind === 'min' || (t.kind === 'range' && t.lo))) continue;
    rows.push({ key: k, supply: supply[k], perDay: t.lo, coverDays: supply[k] / t.lo });
  }
  rows.sort((a, b) => a.coverDays - b.coverDays);
  return { rows, supply };
}

/** Weekly average of a schedule's days that have food, against nothing: just the averages. */
export function averageDays(days) {
  const used = days.filter((d) => d.kcal > 0);
  const avg = Object.fromEntries(K.map((k) => [k, 0]));
  for (const d of used) for (const k of K) avg[k] += d.totals[k] / used.length;
  return { avg, n: used.length };
}
