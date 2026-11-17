// node tools/test_schedule.mjs  -- pantry, scheduler, run-out analysis and purchase suggestions
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { FoodDB, dailyTargets, NUTRIENT_KEYS } from '../web/js/nutrition.js';
import { pantryItems, productPer100, parsePack, addToPantry, takeFromPantry } from '../web/js/pantry.js';
import { scheduleWeek, coverage, averageDays } from '../web/js/schedule.js';
import { suggestPurchases, allowedByDiet } from '../web/js/suggest.js';

const rd = (f) => JSON.parse(fs.readFileSync(new URL(`../web/data/${f}.json`, import.meta.url), 'utf8'));
const db = new FoodDB(rd('foods'));
const nnr = rd('nnr2023'), meta = rd('ingredients'), prices = rd('prices');
const settings = { sex: 'f', age: '25_50', kcal: 2000 };
const targets = dailyTargets(settings, nnr);
const food = (id, g) => ({ kind: 'food', ref: String(db.get(id).number), name: id, g });
const items = (list) => pantryItems(list, {}, db);

// ---- package sizes
assert.equal(parsePack('400 g'), 400); assert.equal(parsePack('1 kg'), 1000); assert.equal(parsePack('0,5 L'), 500);
assert.equal(parsePack('6 x 33 cl'), 1980); assert.equal(parsePack('2 × 125 g'), 250); assert.equal(parsePack('330ml'), 330);
assert.equal(parsePack('a lot'), null); assert.equal(parsePack(''), null);

// ---- a scanned product: label values win, missing vitamins come from the linked food and are marked as estimates
const link = db.search('potatischips')[0] || db.all[100];
const chips = { code: '1', name: 'Onion snack', per100: { energy_kcal: 533, protein_g: 5.5, fat_g: 32.1, carbs_g: 55.6, salt_g: 2.29, calcium_mg: 50 }, micro: link.number };
const pp = productPer100(chips, db);
assert.equal(pp.v.calcium_mg, 50, 'the label value is used');
assert.ok(!pp.est.includes('calcium_mg'));
assert.ok(Math.abs(pp.v.sodium_mg - 2.29 * 400) < 1e-9, 'sodium follows from the label salt');
assert.ok(pp.est.length > 3, 'vitamins and minerals are estimated from the linked food');
assert.equal(pp.v.energy_kcal, 533);
const noLink = productPer100({ ...chips, micro: null }, db);
assert.ok(noLink.unknown.includes('iron_mg') && noLink.v.iron_mg === 0, 'without a linked food it stays unknown (0)');

// ---- adding and taking from the pantry
const list = [];
addToPantry(list, { kind: 'food', ref: 5, name: 'x', g: 100 }); addToPantry(list, { kind: 'food', ref: 5, name: 'x', g: 50 });
assert.equal(list.length, 1); assert.equal(list[0].g, 150);
takeFromPantry(list, 'food', 5, 150); assert.equal(list.length, 0);

// ---- a well stocked pantry
const have = (id) => !!db.get(id);
const rich = [food('oats_rolled', 2000), food('milk_3', 4000), food('chicken_breast', 1000), food('broccoli', 1200), food('banana', 1400), food('egg', 800),
  food('rapeseed_oil', 300), food('rice_white', 1500), food('carrot', 1500), food('lentils_dried', 800), food('salmon', 700), food('almonds', 300),
  food('yoghurt_plain_3', 2000), food('apple', 1200), food('orange', 800), food('tomato', 800), food('onion_yellow', 500)].filter((x) => have(x.name));
const itemsRich = items(rich);
assert.ok(itemsRich.length >= 12, `pantry items found: ${itemsRich.length}`);
const week = scheduleWeek({ items: itemsRich, targets, kcal: 2000 });
assert.equal(week.days.length, 7);
assert.ok(week.foodDays >= 7, `food days ${week.foodDays}`);
for (const d of week.days) {
  assert.ok(d.kcal >= 2000 * 0.9 && d.kcal <= 2000 * 1.1, `day ${d.index} energy ${Math.round(d.kcal)}`);
  for (const l of d.lines) assert.ok(l.g <= 500 + 1e-9, `${l.name} ${l.g} g in one day`);
}
const used = {};
for (const d of week.days) for (const l of d.lines) used[l.id] = (used[l.id] || 0) + l.g;
for (const it of itemsRich) assert.ok((used[it.id] || 0) <= it.g + 1e-6, `${it.name} used ${used[it.id]} of ${it.g}`);
assert.equal(week.shortFrom, null);
const { avg } = averageDays(week.days);
console.log('rich pantry, weekly average per day: kcal', Math.round(avg.energy_kcal), 'protein', Math.round(avg.protein_g), 'fibre', Math.round(avg.fibre_g), 'salt', avg.salt_g.toFixed(1),
  '\n  vitD', avg.vitamin_d_ug.toFixed(1), 'iron', avg.iron_mg.toFixed(1), 'calcium', Math.round(avg.calcium_mg), 'vitC', Math.round(avg.vitamin_c_mg), 'B12', avg.vitamin_b12_ug.toFixed(1), 'iodine', Math.round(avg.iodine_ug));
assert.ok(avg.protein_g >= targets.protein_g.lo * 0.95, 'protein covered');
assert.ok(avg.salt_g <= targets.salt_g.hi, 'salt under the limit');

// ---- a thin pantry runs out
const thin = items([food('rice_white', 800), food('oats_rolled', 500), food('rapeseed_oil', 100), food('carrot', 400)].filter((x) => have(x.name)));
const ws = scheduleWeek({ items: thin, targets, kcal: 2000 });
assert.ok(ws.foodDays > 2 && ws.foodDays < 5, `food days ${ws.foodDays}`);
assert.ok(ws.shortFrom !== null && ws.shortFrom <= Math.ceil(ws.foodDays), `short from day ${ws.shortFrom}`);
const withFood = ws.days.filter((d) => d.kcal > 0).length;
assert.ok(withFood >= Math.floor(ws.foodDays) && withFood <= Math.ceil(ws.foodDays) + 1, `days with food ${withFood} for ${ws.foodDays} food days`);
assert.ok(ws.days.slice(Math.ceil(ws.foodDays) + 1).every((d) => d.kcal === 0), 'nothing scheduled once the food is gone');
const cov = coverage({ items: thin, targets, kcal: 2000 });
for (let i = 1; i < cov.rows.length; i++) assert.ok(cov.rows[i - 1].coverDays <= cov.rows[i].coverDays, 'sorted shortest first');
const calcium = cov.rows.find((r) => r.key === 'calcium_mg');
assert.ok(calcium && calcium.coverDays < 3, `calcium covers ${calcium.coverDays} days`);

// ---- suggestions fix gaps, respect the diet, and are not counted as stock
const cands = (diet) => Object.entries(meta).filter(([id, m]) => allowedByDiet(id, m.category, diet) && db.get(id))
  .map(([id, m]) => ({ id, name: m.name, name_sv: m.name_sv, category: m.category, v: Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, db.get(id).vals[db.ix[k]] ?? 0])), sekPerKg: prices[id].sek_per_kg }));
const cd = Object.fromEntries(cov.rows.map((r) => [r.key, r.coverDays]));
const sug = suggestPurchases({ supply: cov.supply, targets, kcal: 2000, candidates: cands('omnivore'), coverDays: cd });
assert.ok(sug.length >= 3 && sug.length <= 9, `suggestions ${sug.length}`);
for (const s of sug) { assert.ok(s.g >= 100 && s.cost > 0); assert.ok(s.needBy >= 0 && s.needBy <= 6); }
const extra = sug.map((s) => ({ id: `food:${s.id}`, name: s.name, g: s.g, v: cands('omnivore').find((c) => c.id === s.id).v }));
const cov2 = coverage({ items: [...thin, ...extra], targets, kcal: 2000 });
const weakBefore = cov.rows.slice(0, 6).reduce((a, r) => a + Math.min(r.coverDays, 7), 0);
const weakAfter = cov.rows.slice(0, 6).reduce((a, r) => a + Math.min(cov2.rows.find((x) => x.key === r.key).coverDays, 7), 0);
assert.ok(weakAfter > weakBefore + 3, `weakest six nutrients: ${weakBefore.toFixed(1)} -> ${weakAfter.toFixed(1)} days`);
assert.equal(thin.length, 4, 'suggestions do not change the pantry');
const vegan = suggestPurchases({ supply: cov.supply, targets, kcal: 2000, candidates: cands('vegan'), coverDays: cd });
for (const s of vegan) assert.ok(allowedByDiet(s.id, s.category, 'vegan'), `${s.id} is not vegan`);
console.log('thin pantry:', ws.foodDays.toFixed(1), 'food days; suggestions:', sug.map((s) => `${s.name_sv} ${s.g} g`).join(', '));
console.log('schedule tests passed');
