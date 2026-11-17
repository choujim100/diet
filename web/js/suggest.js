// What to buy when the pantry runs short. These are SUGGESTIONS only: nothing here is counted as food you have.
// A suggestion becomes food only after you buy it, scan it (or add it by name) and confirm it in the pantry.
import { NUTRIENT_KEYS } from './nutrition.js';

const K = NUTRIENT_KEYS;
const MEAT = new Set(['chicken_breast', 'chicken_thigh', 'turkey_fillet', 'beef_mince_10', 'beef_mince_15', 'pork_mince_8', 'pork_tenderloin', 'bacon']);
const NOT_VEGAN = new Set(['egg', 'butter', 'honey', 'mayonnaise_30', 'pesto']);
const QTY = [100, 200, 300, 500, 750, 1000, 1500];
const PRICE_SOFTENER = 25; // SEK: price counts, but health comes first

/** Is this curated ingredient allowed on the user's diet? */
export function allowedByDiet(id, category, diet) {
  if (diet === 'omnivore' || !diet) return true;
  if (diet === 'pescatarian') return !MEAT.has(id);
  if (diet === 'vegetarian') return !MEAT.has(id) && category !== 'fish';
  if (diet === 'vegan') return !MEAT.has(id) && category !== 'fish' && category !== 'dairy' && !NOT_VEGAN.has(id);
  return true;
}

/**
 * Pick foods that close the gaps over `horizon` days.
 * supply: nutrient totals in the pantry. targets/kcal: as for the scheduler.
 * candidates: [{ id, name, name_sv, category, v (per 100 g), sekPerKg }].
 * Returns [{ id, name, name_sv, g, cost, fixes: [{ key, share }], needBy }] with `needBy` = day index (0 = today)
 * by which the first of the nutrients it fixes runs out.
 */
export function suggestPurchases({ supply, targets, kcal, horizon = 7, candidates, coverDays, maxItems = 9 }) {
  // weekly need per nutrient: the minimum (or lower end of the range) over the horizon, less what the pantry holds
  const need = {}, week = {}, weight = {};
  const add = (k, lo, w) => { week[k] = lo * horizon; weight[k] = w; need[k] = Math.max(0, week[k] - (supply[k] || 0)); };
  add('energy_kcal', kcal * 0.98, 1);
  for (const k of K) {
    const t = targets[k];
    if (!t || k === 'energy_kcal') continue;
    if (t.kind === 'min') add(k, t.lo, 1);
    else if (t.kind === 'range' && t.lo) add(k, t.lo, k === 'protein_g' ? 1 : 0.5);
  }
  const limit = {}; // weekly ceilings: salt, saturated fat
  for (const k of ['salt_g', 'saturated_fat_g']) if (targets[k] && targets[k].kind === 'max') limit[k] = targets[k].hi * horizon;
  const share = Math.max(0.35, 0); // one food at most this share of the week's energy
  const taken = new Map();
  const perCategory = new Map(); // a second and third food from the same group is worth less: variety
  const out = [];
  const cur = { ...supply };
  for (let round = 0; round < maxItems; round++) {
    let best = null;
    for (const c of candidates) {
      const kc = c.v.energy_kcal || 0;
      const qmax = Math.min(2000, kc > 1 ? (share * kcal * horizon * 100) / kc : 2000) - (taken.get(c.id) || 0);
      for (const q of QTY) {
        if (q > qmax) break;
        let gain = 0;
        for (const k of Object.keys(need)) {
          const left = Math.max(0, week[k] - (cur[k] || 0));
          if (!left) continue;
          gain += weight[k] * Math.min(left, ((c.v[k] || 0) * q) / 100) / week[k];
        }
        let harm = 0;
        for (const k of Object.keys(limit)) {
          const over = (cur[k] || 0) + ((c.v[k] || 0) * q) / 100 - limit[k];
          if (over > 0) harm += Math.min(over, ((c.v[k] || 0) * q) / 100) / limit[k];
        }
        const value = (gain - harm) * Math.pow(0.7, taken.has(c.id) ? 0 : perCategory.get(c.category) || 0);
        const cost = (c.sekPerKg * q) / 1000;
        const ratio = value / (cost + PRICE_SOFTENER);
        if (value > 0 && (!best || ratio > best.ratio)) best = { c, q, value, ratio, cost };
      }
    }
    if (!best || best.value < 0.03) break;
    const { c, q } = best;
    const fixes = [];
    for (const k of Object.keys(need)) {
      const left = Math.max(0, week[k] - (cur[k] || 0));
      const got = Math.min(left, ((c.v[k] || 0) * q) / 100);
      if (got / week[k] >= 0.05) fixes.push({ key: k, share: got / week[k] });
    }
    for (const k of K) cur[k] = (cur[k] || 0) + ((c.v[k] || 0) * q) / 100;
    if (!taken.has(c.id)) perCategory.set(c.category, (perCategory.get(c.category) || 0) + 1);
    taken.set(c.id, (taken.get(c.id) || 0) + q);
    const prev = out.find((o) => o.id === c.id);
    const needBy = Math.min(horizon - 1, Math.max(0, Math.floor(Math.min(...(fixes.length ? fixes : [{ key: 'energy_kcal' }]).map((f) => (coverDays && coverDays[f.key] !== undefined ? coverDays[f.key] : horizon))))));
    if (prev) { prev.g += q; prev.cost += best.cost; for (const f of fixes) { const o = prev.fixes.find((x) => x.key === f.key); if (o) o.share += f.share; else prev.fixes.push(f); } prev.needBy = Math.min(prev.needBy, needBy); }
    else out.push({ id: c.id, name: c.name, name_sv: c.name_sv, category: c.category, g: q, cost: best.cost, fixes, needBy });
  }
  for (const o of out) { o.fixes.sort((a, b) => b.share - a.share); o.fixes = o.fixes.slice(0, 4); }
  out.sort((a, b) => a.needBy - b.needBy || b.cost - a.cost);
  return out;
}
