// The pantry: what you actually have. Only two kinds of things can be in it, both confirmed by you:
//   product  a scanned (or typed-in) packaged product, with the values you confirmed against the label
//   food     a food you added by name without a barcode (fruit, vegetables, ...), with Livsmedelsverket values
// Nothing the app only suggests is ever counted.
import { NUTRIENT_KEYS } from './nutrition.js';

export const SODIUM_MG_PER_G_SALT = 400; // salt is 39.3 % sodium by weight

// keys that a label must give. When they are missing the product is unusable, so they are never estimated.
const CORE = new Set(['energy_kcal', 'protein_g', 'fat_g', 'carbs_g']);

/**
 * Per-100 g nutrient values of one stored product.
 * Label values come first. A nutrient the label does not list is taken from the generic food the user linked
 * (prod.micro, a Livsmedelsverket food number), if any, and reported in `est`. What neither gives is `unknown` (counted as 0).
 */
export function productPer100(prod, db) {
  const v = {}, est = [], unknown = [];
  const food = prod.micro != null ? db.get(prod.micro) : null;
  for (const k of NUTRIENT_KEYS) {
    let x = prod.per100[k];
    if (k === 'sodium_mg' && (x === undefined || x === null) && prod.per100.salt_g != null) x = prod.per100.salt_g * SODIUM_MG_PER_G_SALT;
    if (x !== undefined && x !== null) { v[k] = x; continue; }
    const g = food && !CORE.has(k) ? food.vals[db.ix[k]] : null;
    if (g !== null && g !== undefined) { v[k] = g; est.push(k); } else { v[k] = 0; unknown.push(k); }
  }
  return { v, est, unknown };
}

/** Per-100 g values of a generic food. Values the database lacks are `unknown`. */
export function foodPer100(food, db) {
  const v = {}, unknown = [];
  for (const k of NUTRIENT_KEYS) {
    const x = food.vals[db.ix[k]];
    if (x === null || x === undefined) { v[k] = 0; unknown.push(k); } else v[k] = x;
  }
  return { v, est: [], unknown };
}

/** Per-100 g values of a pantry item, or null when what it points to no longer exists. */
export function itemPer100(item, products, db) {
  if (item.kind === 'product') { const p = products[item.ref]; return p ? productPer100(p, db) : null; }
  const f = db.get(Number(item.ref));
  return f ? foodPer100(f, db) : null;
}

/** Pantry items ready for the scheduler: [{ id, name, g, v, est, unknown }]. Items with no grams left are left out. */
export function pantryItems(pantry, products, db) {
  const out = [];
  for (const it of pantry) {
    if (!(it.g > 0)) continue;
    const p = itemPer100(it, products, db);
    if (!p) continue;
    out.push({ id: `${it.kind}:${it.ref}`, name: it.name, g: it.g, v: p.v, est: p.est, unknown: p.unknown, kind: it.kind, ref: it.ref });
  }
  return out;
}

/** Add `g` grams of something to the pantry (or top up the entry that is already there). Returns the entry. */
export function addToPantry(pantry, { kind, ref, name, g }) {
  const key = String(ref);
  let it = pantry.find((x) => x.kind === kind && String(x.ref) === key);
  if (it) { it.g = Math.round((it.g + g) * 10) / 10; if (name) it.name = name; } else { it = { kind, ref: key, name, g: Math.round(g * 10) / 10 }; pantry.push(it); }
  return it;
}

/** Take `g` grams out (eaten). Removes the entry when it is used up. */
export function takeFromPantry(pantry, kind, ref, g) {
  const i = pantry.findIndex((x) => x.kind === kind && String(x.ref) === String(ref));
  if (i < 0) return;
  pantry[i].g = Math.round((pantry[i].g - g) * 10) / 10;
  if (pantry[i].g <= 0.5) pantry.splice(i, 1);
}

/**
 * Package size in grams from Open Food Facts text such as "400 g", "1 kg", "0,5 L", "6 x 33 cl", "2 × 125 g".
 * Millilitres count as grams (1 ml = 1 g), as everywhere in this app. Returns null when it cannot tell.
 */
export function parsePack(text) {
  if (!text) return null;
  const t = String(text).toLowerCase().replace(',', '.');
  const m = /(?:(\d+)\s*[x×*]\s*)?(\d+(?:\.\d+)?)\s*(kg|g|l|dl|cl|ml)\b/.exec(t);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  const f = { kg: 1000, g: 1, l: 1000, dl: 100, cl: 10, ml: 1 }[m[3]];
  const g = n * parseFloat(m[2]) * f;
  return g > 0 && g < 20000 ? Math.round(g) : null;
}
