// All user data lives in this browser (localStorage). Nothing is sent anywhere.
const KEY = 'eat.v1';

export const DEFAULTS = {
  settings: {
    sex: 'f', age: '25_50', kcal: 2000, budget: 700, diet: 'omnivore',
    dislikes: [], likes: [], meals: { breakfast: true, lunch: true, dinner: true }, days: 7, // budget, likes, meals and days are no longer used
  },
  prices: {},   // user overrides: { ingredientId: sek_per_kg }
  offers: [],   // [{ id, sek_per_kg, label, line, until }]
  pantry: [],   // what you have: [{ kind: 'product'|'food', ref: barcode|food number, name, g: grams left }]. Only confirmed items.
  eatenDays: {}, // { 'YYYY-MM-DD': true } days already marked as eaten from the schedule
  log: {},      // { 'YYYY-MM-DD': [{ food: number, g, name } | { recipe, scale, name } | { product: barcode, g, name }] }
  products: {}, // scanned products: { barcode: { code, name, per100: { nutrient_key: value per 100 g }, source, micro: food number or null } }
};

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const d = JSON.parse(raw);
    return {
      ...structuredClone(DEFAULTS), ...d,
      settings: { ...DEFAULTS.settings, ...(d.settings || {}), meals: { ...DEFAULTS.settings.meals, ...((d.settings || {}).meals || {}) } },
    };
  } catch (e) {
    console.warn('could not read saved data', e);
    return structuredClone(DEFAULTS);
  }
}
export function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); return true; }
  catch (e) { console.warn('could not save', e); return false; }
}
export function exportJSON(state) { return JSON.stringify(state, null, 1); }
export function importJSON(text) {
  const d = JSON.parse(text);
  if (typeof d !== 'object' || !d.settings) throw new Error('This does not look like an export from this app.');
  return { ...structuredClone(DEFAULTS), ...d, settings: { ...DEFAULTS.settings, ...d.settings, meals: { ...DEFAULTS.settings.meals, ...(d.settings.meals || {}) } } };
}
export function todayISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return todayISO(new Date(y, m - 1, d + n));
}
