// node tools/test_label.mjs  -- label text parsing and comparison (the OCR itself is tested in the browser)
import { parseLabel, parseLabels, compareLabel } from '../web/js/label.js';
import assert from 'node:assert/strict';

const v = (t) => Object.fromEntries(Object.entries(parseLabel(t).values).map(([k, x]) => [k, x.value]));

// Swedish label, per 100 g
assert.deepEqual(v(`Näringsvärde per 100 g
Energi 2225 kJ / 533 kcal
Fett 32,1 g
varav mättat fett 14,1 g
Kolhydrat 55,6 g
varav sockerarter 3,2 g
Fiber 2,1 g
Protein 5,5 g
Salt 2,29 g`), { energy_kcal: 533, fat_g: 32.1, saturated_fat_g: 14.1, carbs_g: 55.6, sugars_g: 3.2, fibre_g: 2.1, protein_g: 5.5, salt_g: 2.29 });

// two columns (per 100 g and per portion): first amount is taken, and the caller is told
const two = parseLabel(`Energi 2225 kJ/533 kcal 667 kJ/160 kcal
Fett 32,1 g 9,6 g
varav mättat fett 14,1 g 4,2 g
Protein 5,5 g 1,7 g`);
assert.equal(two.values.fat_g.value, 32.1);
assert.equal(two.values.energy_kcal.value, 533);
assert.ok(two.columns);

// energy on the line after the heading; kcal missing, so it is derived from kJ
assert.equal(v('Energi\n2225 kJ / 533 kcal\nFett 32,1 g').energy_kcal, 533);
assert.equal(v('Energi 2225 kJ\nFett 32,1 g').energy_kcal, 531.8);

// typical OCR slips: g read as 9, O for 0, space for the decimal comma, "<"
assert.equal(v('Fett 32,1 9').fat_g, 32.1);
assert.equal(v('Protein 5,O g').protein_g, 5);
assert.equal(v('Salt 2 . 29 g').salt_g, 2.29);
assert.equal(v('Salt 2,29g').salt_g, 2.29);
const lt = parseLabel('Salt <0,01 g').values.salt_g;
assert.equal(lt.value, 0.01); assert.ok(lt.lt);

// other languages
assert.deepEqual(v(`Brennwert 2225 kJ / 533 kcal
Fett 32,1 g
davon gesättigte Fettsäuren 14,1 g
Kohlenhydrate 55,6 g
davon Zucker 3,2 g
Eiweiß 5,5 g
Salz 2,29 g`), { energy_kcal: 533, fat_g: 32.1, saturated_fat_g: 14.1, carbs_g: 55.6, sugars_g: 3.2, protein_g: 5.5, salt_g: 2.29 });

// added sugars are not total sugars
assert.equal(v('varav sockerarter 1 g\nvarav tillsatt socker 3,2 g').sugars_g, 1);

// noise and nothing useful
assert.deepEqual(v('Ingredienser: potatis, palmolja, lökpulver'), {});

// real OCR output from a test photo (two passes). Commas were dropped and "g" read as "9" in different places.
const passA = `Näringsvärde per 100 g
Energi                               2225 kJ / 533 kcal
Fett                          321g
varav mättat fett               14,1g
Kolhydrat                            55,6 g
varav sockerarter                 3,29
Fiber                         219
Protein                                 559g
Salt                                    2,29 g`;
const passB = `Näringsvärde per 100 g
Energi 2225 kJ / 533 kcal
Fett 32,1g
varav mättat fett 14,1 g
Kolhydrat 55,6 g
varav sockerarter 3,29
Fiber 219
Protein 5,59
Salt 2,29 g`;
const merged = parseLabels([passA, passB]).values;
const got = Object.fromEntries(Object.entries(merged).map(([k, x]) => [k, x.value]));
assert.deepEqual(got, { energy_kcal: 533, fat_g: 32.1, saturated_fat_g: 14.1, carbs_g: 55.6, sugars_g: 3.2, fibre_g: 2.1, protein_g: 5.5, salt_g: 2.29 });
assert.ok(merged.fibre_g.uncertain, 'fibre is ambiguous (2.1 or 21.9) and must be flagged');
// one bad pass alone: the energy check still repairs fat ("321g" -> 32.1); protein "559g" has no good reading
// in that pass, which is why two passes are used
const alone = parseLabel(passA).values;
assert.equal(alone.fat_g.value, 32.1); assert.ok(alone.protein_g.value < 6 && alone.protein_g.adjusted, 'protein repaired and flagged as adjusted');
assert.ok(!merged.fat_g.uncertain && !merged.carbs_g.uncertain, 'energy check passed, macros trusted');
// when fat + carbohydrate + protein cannot give the energy, the macros are flagged, not silently accepted
const fixed = parseLabels(['Energi 490 kcal\nFett 23,6 g\nKolhydrat 60,6 g\nProtein 7949']).values; // "7,9 g" read as 7949
assert.ok(Math.abs(fixed.protein_g.value - 7.94) < 0.001 && fixed.protein_g.adjusted && !fixed.protein_g.uncertain);
const bad = parseLabels(['Energi 900 kcal\nFett 10,0 g\nKolhydrat 10,0 g\nProtein 10,0 g']).values;
assert.ok(bad.fat_g.uncertain && bad.protein_g.uncertain, 'macros that cannot give the energy are flagged');
// energy that fits nothing leaves the numbers as read
const nofit = parseLabel('Energi 100 kcal\nFett 32,1 g\nKolhydrat 55,6 g\nProtein 5,5 g').values;
assert.equal(nofit.fat_g.value, 32.1);

// comparison
const rows = compareLabel({ energy_kcal: 533, fat_g: 32.1, sugars_g: 1, protein_g: 5.5 }, parseLabel('Energi 533 kcal\nFett 32,1 g\nvarav sockerarter 3,2 g\nFiber 2,1 g'));
const by = Object.fromEntries(rows.map((r) => [r.key, r.status]));
assert.deepEqual(by, { energy_kcal: 'same', fat_g: 'same', sugars_g: 'differs', fibre_g: 'new' });
console.log('label tests passed');
