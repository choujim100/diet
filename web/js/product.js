// Barcode products: look-up in Open Food Facts, conversion to this app's nutrient keys, and sanity checks.
// Open Food Facts is volunteer-entered, so nothing from it is trusted blindly: values are checked,
// problems are shown, and the user can correct a value against the package before it is used.
// Only the barcode number leaves the device.

const API = 'https://world.openfoodfacts.org/api/v2/product/';
const FIELDS = 'code,product_name,product_name_sv,brands,quantity,product_quantity,serving_quantity,nutriments,nutrition_data_per';

// OFF stores everything except energy in grams per 100 g. [our key, OFF key, factor to our unit]
const MAP = [
  ['protein_g', 'proteins', 1], ['fat_g', 'fat', 1], ['saturated_fat_g', 'saturated-fat', 1],
  ['carbs_g', 'carbohydrates', 1], ['sugars_g', 'sugars', 1], ['fibre_g', 'fiber', 1],
  ['vitamin_d_ug', 'vitamin-d', 1e6], ['vitamin_b12_ug', 'vitamin-b12', 1e6], ['folate_ug', 'vitamin-b9', 1e6],
  ['vitamin_c_mg', 'vitamin-c', 1e3], ['vitamin_a_re_ug', 'vitamin-a', 1e6], ['vitamin_e_mg', 'vitamin-e', 1e3],
  ['vitamin_b6_mg', 'vitamin-b6', 1e3], ['riboflavin_mg', 'vitamin-b2', 1e3],
  ['calcium_mg', 'calcium', 1e3], ['iron_mg', 'iron', 1e3], ['zinc_mg', 'zinc', 1e3], ['magnesium_mg', 'magnesium', 1e3],
  ['potassium_mg', 'potassium', 1e3], ['selenium_ug', 'selenium', 1e6], ['iodine_ug', 'iodine', 1e6], ['phosphorus_mg', 'phosphorus', 1e3],
];
export const MACRO_KEYS = ['energy_kcal', 'fat_g', 'saturated_fat_g', 'carbs_g', 'sugars_g', 'fibre_g', 'protein_g', 'salt_g'];

/** EAN-8, UPC-A, EAN-13 and ITF-14 check digit. */
export function validBarcode(code) {
  if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
  const d = code.split('').map(Number);
  const check = d.pop();
  let sum = 0;
  for (let i = d.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += d[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

const round = (x) => (x === null ? null : Math.round(x * 1000) / 1000);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)) ? Number(x) : null);

/** Open Food Facts product -> { code, name, brand, per100: {key: value}, kj, sodium_g, grams, source, notes } */
export function fromOff(p) {
  const n = p.nutriments || {};
  const per100 = {};
  let kcal = num(n['energy-kcal_100g']);
  const kj = num(n['energy-kj_100g']) ?? num(n['energy_100g']);
  if (kcal === null && kj !== null) kcal = kj / 4.184;
  if (kcal !== null) per100.energy_kcal = round(kcal);
  for (const [key, off, f] of MAP) { const v = num(n[`${off}_100g`]); if (v !== null) per100[key] = round(v * f); }
  const salt = num(n.salt_100g), sodium = num(n.sodium_100g);
  if (salt !== null) per100.salt_g = round(salt);
  else if (sodium !== null) per100.salt_g = round(sodium * 2.5);
  const grams = num(p.serving_quantity) || 100; // not the package size: logging a whole jar by accident would be easy
  const notes = [];
  if (p.nutrition_data_per === 'serving' && !num(p.serving_quantity)) notes.push('Entered per serving without a serving size, so the per-100 g values may be wrong.');
  return {
    code: p.code, name: p.product_name_sv || p.product_name || '', brand: p.brands || '', quantity: p.quantity || '',
    per100, kj, added_sugars: num(n['added-sugars_100g']), salt_raw: salt, sodium_raw: sodium, grams, source: 'openfoodfacts', notes,
  };
}

/** Largest value of each nutrient in the Livsmedelsverket foods, per 100 g. Used as a plausibility ceiling. */
export function maxPer100(db, keys) {
  const out = {};
  for (const k of keys) { let m = 0; for (const f of db.all) { const v = f.vals[db.ix[k]]; if (v > m) m = v; } out[k] = m; }
  return out;
}

/**
 * Sanity checks on per-100 g values. Returns [{ key|null, text }]. An empty list means nothing looked wrong
 * (which is not proof the label was typed correctly).
 */
export function checkProduct(prod, maxes = {}) {
  const v = prod.per100;
  const issues = [];
  const add = (key, text) => issues.push({ key, text });
  for (const k of ['energy_kcal', 'protein_g', 'fat_g', 'carbs_g']) if (v[k] === undefined) add(k, 'Missing. Without this the product cannot be tracked properly.');
  for (const [k, x] of Object.entries(v)) if (x < 0) add(k, 'Negative value.');
  for (const k of ['protein_g', 'fat_g', 'saturated_fat_g', 'carbs_g', 'sugars_g', 'fibre_g', 'salt_g']) if (v[k] > 100) add(k, 'More than 100 g in 100 g.');
  if (v.energy_kcal > 900) add('energy_kcal', 'More than 900 kcal per 100 g, which only pure fat reaches.');
  if (v.protein_g !== undefined && v.fat_g !== undefined && v.carbs_g !== undefined && v.protein_g + v.fat_g + v.carbs_g > 101) add(null, 'Protein, fat and carbohydrate add up to more than 100 g.');
  if (v.saturated_fat_g > (v.fat_g ?? Infinity) + 0.1) add('saturated_fat_g', 'Saturated fat is more than total fat.');
  if (v.sugars_g > (v.carbs_g ?? Infinity) + 0.1) add('sugars_g', 'Sugars are more than total carbohydrate.');
  if (prod.added_sugars != null && v.sugars_g !== undefined && v.sugars_g + 0.05 < prod.added_sugars) add('sugars_g', `Total sugars (${v.sugars_g} g) are less than the added sugars (${prod.added_sugars} g) on the same entry, so one of the two is wrong.`);
  if (v.energy_kcal !== undefined && v.protein_g !== undefined && v.fat_g !== undefined && v.carbs_g !== undefined) {
    const est = 4 * v.protein_g + 4 * v.carbs_g + 9 * v.fat_g + 2 * (v.fibre_g || 0);
    if (Math.abs(v.energy_kcal - est) > Math.max(30, 0.25 * est)) add('energy_kcal', `Energy ${Math.round(v.energy_kcal)} kcal does not fit the macros (about ${Math.round(est)} kcal). Alcohol or polyols can explain this, a typing error is more likely.`);
  }
  if (prod.kj != null && v.energy_kcal !== undefined && Math.abs(prod.kj - 4.184 * v.energy_kcal) > 0.06 * prod.kj + 10) add('energy_kcal', `kJ (${Math.round(prod.kj)}) and kcal (${Math.round(v.energy_kcal)}) do not match.`);
  if (prod.salt_raw != null && prod.sodium_raw != null && Math.abs(prod.salt_raw - 2.5 * prod.sodium_raw) > 0.15 * prod.salt_raw + 0.05) add('salt_g', 'Salt and sodium on this product do not match (salt should be 2.5 × sodium).');
  for (const [k, x] of Object.entries(v)) {
    const m = maxes[k];
    if (m && x > m * 1.5 + 1e-9) add(k, `Higher than any food in the Livsmedelsverket database (highest: ${Math.round(m * 100) / 100}). Fortified products and supplements can do this, so also check the unit.`);
  }
  for (const t of prod.notes || []) add(null, t);
  return issues;
}
export const hasMicros = (prod) => Object.keys(prod.per100).some((k) => !MACRO_KEYS.includes(k));

/** Look a barcode up. Resolves { status: 'found', product } | { status: 'notfound' } | { status: 'error', message }. */
export async function lookupOff(code, fetchFn = fetch) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), 10000) : null;
  try {
    const r = await fetchFn(`${API}${encodeURIComponent(code)}.json?fields=${FIELDS}`, ctl ? { signal: ctl.signal } : undefined);
    if (r.status === 404) return { status: 'notfound' };
    if (!r.ok) return { status: 'error', message: `Open Food Facts answered HTTP ${r.status}.` };
    const j = await r.json();
    if (j.status !== 1 || !j.product) return { status: 'notfound' };
    return { status: 'found', product: fromOff({ ...j.product, code }) };
  } catch (e) {
    return { status: 'error', message: e.name === 'AbortError' ? 'Open Food Facts did not answer in time.' : 'Could not reach Open Food Facts. Check the connection.' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Nutrient totals for `g` grams of a stored product. Nutrients the label does not list stay out of `n` and are reported in `missing`. */
export function productNutrients(prod, g, allKeys) {
  const n = {}, missing = [];
  for (const k of allKeys) {
    const x = prod.per100[k];
    if (x === undefined || x === null) { n[k] = 0; missing.push(k); } else n[k] = (x * g) / 100;
  }
  return { n, missing };
}

// ---- camera / photo scanning (Chrome on Android has BarcodeDetector built in) ----
export const canUseCamera = () => typeof window !== 'undefined' && 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
export const canDecodePhoto = () => typeof window !== 'undefined' && 'BarcodeDetector' in window;
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

/** Start the camera in `video` and call onCode(code) once for the first valid barcode. Returns a stop function. */
export async function startCamera(video, onCode, onError) {
  const detector = new BarcodeDetector({ formats: FORMATS });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  await video.play();
  let stopped = false;
  const stop = () => { stopped = true; stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
  const tick = async () => {
    if (stopped) return;
    try {
      for (const b of await detector.detect(video)) {
        const code = (b.rawValue || '').trim();
        // UPC-A is read as 12 digits, and the shops here print EAN-13, so also accept the 13-digit form with a leading zero
        if (validBarcode(code)) { stop(); onCode(code.length === 12 ? '0' + code : code); return; }
      }
    } catch (e) { if (onError) onError(e); }
    setTimeout(tick, 200);
  };
  tick();
  return stop;
}

/** Read a barcode from a photo file. Resolves the code or null. */
export async function decodePhoto(file) {
  const detector = new BarcodeDetector({ formats: FORMATS });
  const bmp = await createImageBitmap(file);
  try {
    for (const b of await detector.detect(bmp)) {
      const code = (b.rawValue || '').trim();
      if (validBarcode(code)) return code.length === 12 ? '0' + code : code;
    }
    return null;
  } finally { bmp.close && bmp.close(); }
}
