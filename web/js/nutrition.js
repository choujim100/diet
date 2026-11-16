// Nutrition maths. Everything is computed from the Livsmedelsverket values in data/foods.json.

export const NUTRIENTS = [
  // key, label, unit, group
  ['energy_kcal', 'Energy', 'kcal', 'macro'],
  ['protein_g', 'Protein', 'g', 'macro'],
  ['fat_g', 'Fat', 'g', 'macro'],
  ['saturated_fat_g', 'Saturated fat', 'g', 'macro'],
  ['carbs_g', 'Carbohydrate', 'g', 'macro'],
  ['sugars_g', 'Sugars (total)', 'g', 'macro'],
  ['fibre_g', 'Fibre', 'g', 'macro'],
  ['salt_g', 'Salt', 'g', 'macro'],
  ['vitamin_d_ug', 'Vitamin D', 'µg', 'vitamin'],
  ['vitamin_b12_ug', 'Vitamin B12', 'µg', 'vitamin'],
  ['folate_ug', 'Folate', 'µg', 'vitamin'],
  ['vitamin_c_mg', 'Vitamin C', 'mg', 'vitamin'],
  ['vitamin_a_re_ug', 'Vitamin A', 'µg RE', 'vitamin'],
  ['vitamin_e_mg', 'Vitamin E', 'mg', 'vitamin'],
  ['vitamin_b6_mg', 'Vitamin B6', 'mg', 'vitamin'],
  ['riboflavin_mg', 'Riboflavin (B2)', 'mg', 'vitamin'],
  ['calcium_mg', 'Calcium', 'mg', 'mineral'],
  ['iron_mg', 'Iron', 'mg', 'mineral'],
  ['zinc_mg', 'Zinc', 'mg', 'mineral'],
  ['magnesium_mg', 'Magnesium', 'mg', 'mineral'],
  ['potassium_mg', 'Potassium', 'mg', 'mineral'],
  ['selenium_ug', 'Selenium', 'µg', 'mineral'],
  ['iodine_ug', 'Iodine', 'µg', 'mineral'],
  ['phosphorus_mg', 'Phosphorus', 'mg', 'mineral'],
];
export const NUTRIENT_INFO = Object.fromEntries(NUTRIENTS.map(([key, label, unit, group]) => [key, { key, label, unit, group }]));
export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n[0]);

export class FoodDB {
  constructor(foodsData) {
    this.keys = foodsData.keys;
    this.ix = Object.fromEntries(this.keys.map((k, i) => [k, i]));
    this.byNumber = new Map();
    this.byCurated = new Map();
    for (const row of foodsData.foods) {
      const f = { number: row[0], name: row[1], name_sv: row[2], curated_id: row[3], type: row[4], vals: row[5] };
      this.byNumber.set(f.number, f);
      if (f.curated_id) this.byCurated.set(f.curated_id, f);
    }
    this.all = [...this.byNumber.values()];
  }
  get(ref) { // curated id or numeric food number
    if (typeof ref === 'number') return this.byNumber.get(ref);
    if (/^\d+$/.test(ref)) return this.byNumber.get(parseInt(ref, 10));
    return this.byCurated.get(ref);
  }
  /** Nutrient totals for `grams` of a food, only the tracked keys. Missing values count as 0 and are listed in `missing`. */
  nutrients(food, grams) {
    const out = {};
    const missing = [];
    for (const k of NUTRIENT_KEYS) {
      const v = food.vals[this.ix[k]];
      if (v === null || v === undefined) { out[k] = 0; missing.push(k); } else out[k] = (v * grams) / 100;
    }
    return { n: out, missing };
  }
  search(query, limit = 30) {
    const q = query.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').trim();
    if (!q) return [];
    const words = q.split(/\s+/);
    const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
    const scored = [];
    for (const f of this.all) {
      const hay = norm(f.name_sv) + ' | ' + norm(f.name);
      if (!words.every((w) => hay.includes(w))) continue;
      let s = 0;
      if (norm(f.name_sv).startsWith(words[0])) s += 3;
      if (f.curated_id) s += 2;
      if (f.type === 'A') s += 1;
      s -= (f.name_sv || f.name).length / 100;
      scored.push([s, f]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, limit).map((x) => x[1]);
  }
}

export function sumInto(total, add, mult = 1) {
  for (const k of NUTRIENT_KEYS) total[k] = (total[k] || 0) + (add[k] || 0) * mult;
  return total;
}
export function emptyTotals() { return Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, 0])); }

/** Per-portion nutrition for a recipe at scale 1. */
export function recipeNutrition(db, recipe) {
  const total = emptyTotals();
  const missing = new Set();
  for (const ing of recipe.ingredients) {
    const food = db.get(ing.id);
    if (!food) throw new Error(`recipe ${recipe.id}: unknown ingredient ${ing.id}`);
    const { n, missing: m } = db.nutrients(food, ing.g);
    sumInto(total, n);
    m.forEach((x) => missing.add(x));
  }
  return { n: total, grams: recipe.ingredients.reduce((s, i) => s + i.g, 0), missing: [...missing] };
}

/**
 * Daily targets from settings + NNR 2023 data.
 * kind: 'min' (at least), 'max' (at most), 'range' (between lo and hi), 'goal' (aim for it).
 */
export function dailyTargets(settings, nnr) {
  const kcal = settings.kcal;
  const prof = nnr.profiles[`${settings.sex}_${settings.age}`];
  const t = {};
  t.energy_kcal = { kind: 'goal', target: kcal, lo: kcal * 0.95, hi: kcal * 1.05, note: 'your own energy target' };
  const [pl, ph] = nnr.macro.protein_e_pct;
  t.protein_g = { kind: 'range', lo: (pl / 100) * kcal / 4, hi: (ph / 100) * kcal / 4, target: (nnr.macro.protein_e_pct_planning_target / 100) * kcal / 4, note: `${pl}-${ph} E% (NNR 2023)` };
  const [fl, fh] = nnr.macro.fat_e_pct;
  t.fat_g = { kind: 'range', lo: (fl / 100) * kcal / 9, hi: (fh / 100) * kcal / 9, note: `${fl}-${fh} E%` };
  t.saturated_fat_g = { kind: 'max', hi: (nnr.macro.saturated_fat_e_pct_max / 100) * kcal / 9, note: `under ${nnr.macro.saturated_fat_e_pct_max} E%` };
  const [cl, ch] = nnr.macro.carbs_e_pct;
  t.carbs_g = { kind: 'range', lo: (cl / 100) * kcal / 4, hi: (ch / 100) * kcal / 4, note: `${cl}-${ch} E%` };
  t.fibre_g = { kind: 'min', lo: nnr.macro.fibre_g[0], note: `${nnr.macro.fibre_g[0]}-${nnr.macro.fibre_g[1]} g/day` };
  t.salt_g = { kind: 'max', hi: nnr.salt_g_max, note: 'maximum' };
  for (const [k, v] of Object.entries(prof)) {
    if (k === 'label') continue;
    t[k] = { kind: 'min', lo: v, note: nnr.kind[k] };
  }
  return t;
}

/** Compare totals with targets. Returns rows for display. */
export function evaluate(totals, targets) {
  const rows = [];
  for (const [key, label, unit, group] of NUTRIENTS) {
    const value = totals[key] || 0;
    const tg = targets[key];
    let status = 'info', pct = null;
    if (tg) {
      if (tg.kind === 'min') { pct = value / tg.lo; status = value >= tg.lo ? 'ok' : pct >= 0.7 ? 'near' : 'low'; }
      else if (tg.kind === 'max') { pct = value / tg.hi; status = value <= tg.hi ? 'ok' : 'high'; }
      else { // range or goal
        pct = value / (tg.target || (tg.lo + tg.hi) / 2);
        status = value < tg.lo ? (value >= tg.lo * 0.85 ? 'near' : 'low') : value > tg.hi ? 'high' : 'ok';
      }
    }
    rows.push({ key, label, unit, group, value, target: tg, pct, status });
  }
  return rows;
}

/** Penalty (0 = perfect) for one nutrient, used by the planner. */
export function shortfall(value, tg) {
  if (!tg) return 0;
  if (tg.kind === 'min') return Math.max(0, 1 - value / tg.lo);
  if (tg.kind === 'max') return Math.max(0, value / tg.hi - 1);
  if (value < tg.lo) return 1 - value / tg.lo;
  if (value > tg.hi) return value / tg.hi - 1;
  return 0;
}

export function fmt(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2).replace(/\.?0+$/, '');
  return unit ? `${s} ${unit}` : s;
}
