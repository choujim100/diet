// node tools/test_product.mjs  -- checks barcode validation, OFF conversion and the sanity checks
import { validBarcode, fromOff, checkProduct, lookupOff, productNutrients } from '../web/js/product.js';
import assert from 'node:assert/strict';

// check digits
assert.ok(validBarcode('3017620422003'), 'Nutella EAN-13');
assert.ok(validBarcode('4006381333931'), 'EAN-13');
assert.ok(validBarcode('96385074'), 'EAN-8');
assert.ok(validBarcode('036000291452'), 'UPC-A');
assert.ok(!validBarcode('3017620422004'), 'wrong check digit');
assert.ok(!validBarcode('12345'), 'wrong length');
assert.ok(!validBarcode('abcdefghijklm'), 'not digits');

// conversion: OFF stores vitamins and minerals in grams per 100 g
const p = fromOff({ code: '1', product_name: 'Test', nutriments: {
  'energy-kcal_100g': 400, 'energy-kj_100g': 1674, proteins_100g: 10, fat_100g: 20, 'saturated-fat_100g': 5, carbohydrates_100g: 45, sugars_100g: 10, fiber_100g: 3,
  sodium_100g: 0.4, 'vitamin-d_100g': 0.000005, calcium_100g: 0.12, iron_100g: 0.002, 'vitamin-b12_100g': 0.0000024 } });
assert.equal(p.per100.salt_g, 1);            // sodium 0.4 g x 2.5
assert.equal(p.per100.vitamin_d_ug, 5);      // 5e-6 g = 5 ug
assert.equal(p.per100.calcium_mg, 120);
assert.equal(p.per100.iron_mg, 2);
assert.equal(p.per100.vitamin_b12_ug, 2.4);
assert.deepEqual(checkProduct(p, {}), []);

// the real kind of error found earlier: B12 entered as grams-instead-of-micrograms shows up as an impossible value
const bad = fromOff({ code: '2', nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5, fat_100g: 2, carbohydrates_100g: 15, 'vitamin-b12_100g': 2 } });
assert.equal(bad.per100.vitamin_b12_ug, 2e6);
assert.ok(checkProduct(bad, { vitamin_b12_ug: 30 }).some((i) => i.key === 'vitamin_b12_ug'));

// macro consistency
const e = (o) => checkProduct({ per100: o, notes: [] }, {}).map((i) => i.key);
assert.ok(e({ energy_kcal: 900, protein_g: 5, fat_g: 2, carbs_g: 15 }).includes('energy_kcal'), 'energy does not fit macros');
assert.ok(e({ energy_kcal: 100, protein_g: 40, fat_g: 40, carbs_g: 40 }).includes(null), 'macros over 100 g');
assert.ok(e({ energy_kcal: 100, protein_g: 5, fat_g: 2, saturated_fat_g: 3, carbs_g: 15 }).includes('saturated_fat_g'));
assert.ok(e({ energy_kcal: 100, protein_g: 5, fat_g: 2, carbs_g: 15, sugars_g: 20 }).includes('sugars_g'));
assert.ok(e({ protein_g: 5, fat_g: 2 }).includes('energy_kcal'), 'missing energy');
assert.deepEqual(e({ energy_kcal: 100, protein_g: 5, fat_g: 2, carbs_g: 15 }), []);

// grams -> nutrients, missing ones counted
const r = productNutrients({ per100: { energy_kcal: 200, protein_g: 10 } }, 50, ['energy_kcal', 'protein_g', 'iron_mg']);
assert.equal(r.n.energy_kcal, 100); assert.equal(r.n.protein_g, 5); assert.deepEqual(r.missing, ['iron_mg']);

// look-up with a fake fetch
const ok = await lookupOff('3017620422003', async () => ({ ok: true, status: 200, json: async () => ({ status: 1, product: { product_name: 'X', nutriments: { 'energy-kcal_100g': 1 } } }) }));
assert.equal(ok.status, 'found'); assert.equal(ok.product.code, '3017620422003');
assert.equal((await lookupOff('1', async () => ({ ok: true, status: 200, json: async () => ({ status: 0 }) }))).status, 'notfound');
assert.equal((await lookupOff('1', async () => ({ ok: false, status: 404 }))).status, 'notfound');
assert.equal((await lookupOff('1', async () => ({ ok: false, status: 503 }))).status, 'error');
assert.equal((await lookupOff('1', async () => { throw new Error('offline'); })).status, 'error');
console.log('product tests passed');
