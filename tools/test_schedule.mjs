// node tools/test_schedule.mjs  -- pantry, scheduler, run-out analysis and purchase suggestions
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { FoodDB, dailyTargets, NUTRIENT_KEYS } from '../web/js/nutrition.js';
import { pantryItems, productPer100, parsePack, addToPantry, takeFromPantry, piecesLeft } from '../web/js/pantry.js';
import { scheduleWeek, coverage, averageDays, usableG } from '../web/js/schedule.js';
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

// ---- foods kept in whole pieces (6 avocados in a bag): never split a piece
const pieceList = rich.map((x) => ({ ...x }));
const banana = pieceList.find((x) => x.name === 'banana'); banana.g = 1500; banana.unit = 1500 / 10;      // 10 bananas of 150 g
const apple = pieceList.find((x) => x.name === 'apple'); apple.g = 2 * 180; apple.unit = 180;           // only 2 apples for the week
const onion = pieceList.find((x) => x.name === 'onion_yellow'); onion.g = 500; onion.unit = 500 / 6;   // 6 onions: 83.333 g each
const wp = scheduleWeek({ items: items(pieceList), targets, kcal: 2000 });
const eaten = { banana: 0, apple: 0, onion: 0 };
const nm = (id) => db.get(id).name_sv || db.get(id).name;
for (const d of wp.days) for (const l of d.lines) {
  for (const [key, it] of [['banana', banana], ['apple', apple], ['onion', onion]]) if (l.id === 'food:' + db.get(it.name).number) {
    assert.ok(l.pieces >= 1 && Math.abs(l.g - l.pieces * it.unit) < 0.06, `${key}: ${l.g} g is not ${l.pieces} whole pieces of ${it.unit}`);
    eaten[key] += l.pieces;
  }
}
assert.ok(eaten.banana <= 10 && eaten.banana >= 5, `bananas ${eaten.banana}`);
assert.ok(eaten.apple >= 1 && eaten.apple <= 2, `two apples are used, one piece at a time: ${eaten.apple}`);
assert.ok(eaten.onion <= 6 && eaten.onion >= 3, `onions ${eaten.onion}`);
assert.equal(usableG(500 - 5 * (500 / 6) + 0.04, 500 / 6) > 80, true, 'the last piece is not lost to rounding');
assert.equal(piecesLeft({ g: 255, unit: 85 }), 3); assert.equal(piecesLeft({ g: 100 }), null);
// leftover smaller than a piece is not usable and not counted as food
assert.equal(usableG(100, 85), 85); assert.equal(usableG(84, 85), 0);
const covP = coverage({ items: items([{ ...apple, g: 100 }]), targets, kcal: 2000 });   // 100 g of 180 g pieces: nothing usable
assert.equal(covP.rows.find((r) => r.key === 'energy_kcal').coverDays, 0);
// adding with a piece count, topping up, and eating whole pieces from the pantry
const pl = [];
addToPantry(pl, { kind: 'food', ref: 7, name: 'avocado', g: 510, pieces: 6 });
assert.equal(pl[0].unit, 85); assert.equal(piecesLeft(pl[0]), 6);
takeFromPantry(pl, 'food', 7, 85 * 5); assert.equal(piecesLeft(pl[0]), 1);
takeFromPantry(pl, 'food', 7, 85); assert.equal(pl.length, 0, 'used up');
console.log('thin pantry:', ws.foodDays.toFixed(1), 'food days; suggestions:', sug.map((s) => `${s.name_sv} ${s.g} g`).join(', '));
console.log('schedule tests passed');
