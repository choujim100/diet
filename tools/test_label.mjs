// node tools/test_label.mjs  -- label text parsing and comparison (the OCR itself is tested in the browser)
import { parseLabel, parseLabels, compareLabel, wordsToText } from '../web/js/label.js';
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
assert.equal(v('Energi 2225 kJ\nFett 32,1 g').energy_kcal, 532);

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

// Nordic packs: Swedish / Finnish / Danish on every row
const tri = `Näringsvärde / Ravintoarvo / Næringsindhold per 100 g
Energi / Energia / Energi 2225 kJ / 533 kcal
Fett / Rasva / Fedt 32,1 g
varav mättat fett / josta tyydyttynyttä rasvaa / heraf mættede fedtsyrer 14,1 g
varav enkelomättat fett / josta kertatyydyttymättömiä / heraf enkeltumættede 9,0 g
Kolhydrat / Hiilihydraatit / Kulhydrat 55,6 g
varav sockerarter / josta sokereita / heraf sukkerarter 3,2 g
Fiber / Kuitu / Kostfibre 2,1 g
Protein / Proteiini / Protein 5,5 g
Salt / Suola / Salt 0,03 g`;
assert.deepEqual(v(tri), { energy_kcal: 533, fat_g: 32.1, saturated_fat_g: 14.1, carbs_g: 55.6, sugars_g: 3.2, fibre_g: 2.1, protein_g: 5.5, salt_g: 0.03 });
// Danish and Finnish alone; "unsaturated" rows are never taken for saturated fat
assert.equal(v('Fedt 20 g\nheraf mættede fedtsyrer 7,5 g').saturated_fat_g, 7.5);
assert.equal(v('Rasva 20 g\njosta tyydyttyneitä rasvahappoja 7,5 g').saturated_fat_g, 7.5);
assert.equal(v('josta sokereita 4,4 g').sugars_g, 4.4);
assert.equal(v('heraf enkeltumættede fedtsyrer 9,0 g\nheraf mættede fedtsyrer 7,5 g').saturated_fat_g, 7.5);
assert.equal(v('varav enkelomättat fett 9,0 g').saturated_fat_g, undefined);
assert.equal(v('davon ungesättigte Fettsäuren 9,0 g').saturated_fat_g, undefined);
// a long row that wrapped: the amount sits alone on the next line
assert.equal(v('varav mättat fett / josta tyydyttynyttä rasvaa / heraf mættede fedtsyrer\n14,1 g\nKolhydrat 55,6 g').saturated_fat_g, 14.1);
// energy with "kcal" misread
assert.equal(v('Energi 2225 kJ / 533 keal\nFett 32,1 g').energy_kcal, 533);


// two columns (per 100 g | per portion): the per-100 g amount of the saturated-fat row was not read, so only the
// per-portion amount is left. It must not be taken for per 100 g.
const W = (text, x0, x1) => ({ text, x0, x1 });
const wl = (...words) => ({ words });
const cols = wordsToText([
  wl(W('Näringsvärde', 20, 200), W('per', 500, 540), W('100', 545, 590), W('g', 595, 610), W('per', 700, 740), W('30', 745, 775), W('g', 780, 795)),
  wl(W('Energi', 20, 100), W('2225', 500, 560), W('kJ', 565, 590), W('/', 595, 600), W('533', 605, 650), W('kcal', 655, 700), W('668', 705, 750), W('kJ', 755, 780), W('/', 785, 790), W('160', 795, 830), W('kcal', 835, 880)),
  wl(W('Fett', 20, 70), W('32', 500, 530), W('g', 535, 550), W('9,6', 700, 735), W('g', 744, 756)),
  wl(W('varav', 20, 80), W('mättat', 90, 160), W('fett', 170, 210), W('4,2', 701, 735), W('g', 744, 756)),
  wl(W('Kolhydrat', 20, 120), W('55,6', 495, 550), W('g', 555, 570), W('16,7', 695, 750), W('g', 755, 770)),
  wl(W('Salt', 20, 70), W('0,13', 498, 548), W('g', 552, 565), W('0,04', 698, 748), W('g', 752, 765)),
]);
assert.equal(cols.columns, 2);
const cv = v(cols.text);
assert.equal(cv.saturated_fat_g, undefined, 'a per-portion amount must not be read as per 100 g');
assert.equal(cv.fat_g, 32); assert.equal(cv.carbs_g, 55.6); assert.equal(cv.salt_g, 0.13); assert.equal(cv.energy_kcal, 533);
// a one-column label is left as it is
const one = wordsToText([wl(W('Fett', 20, 70), W('32,1', 500, 550), W('g', 555, 570)), wl(W('Salt', 20, 70), W('0,13', 495, 545), W('g', 550, 565))]);
assert.equal(one.columns, 1); assert.equal(v(one.text).salt_g, 0.13);

// comparison: small values must not be waved through (0.13 g against 0.03 g salt is a real difference)
const cmp = (db, txt) => compareLabel(db, parseLabel(txt)).map((r) => r.status);
assert.deepEqual(cmp({ salt_g: 0.13 }, 'Salt 0,03 g'), ['differs']);
assert.deepEqual(cmp({ salt_g: 0.1 }, 'Salt 0,13 g'), ['same']); // one-decimal rounding
assert.deepEqual(cmp({ salt_g: 0.03 }, 'Salt 0,03 g'), ['same']);
assert.deepEqual(cmp({ fat_g: 0.3 }, 'Fett 0,8 g'), ['differs']);
assert.deepEqual(cmp({ fat_g: 32.2 }, 'Fett 32,1 g'), ['same']);
assert.deepEqual(cmp({ sugars_g: 1.0 }, 'varav sockerarter 3,2 g'), ['differs']);

// comparison
const rows = compareLabel({ energy_kcal: 533, fat_g: 32.1, sugars_g: 1, protein_g: 5.5 }, parseLabel('Energi 533 kcal\nFett 32,1 g\nvarav sockerarter 3,2 g\nFiber 2,1 g'));
const by = Object.fromEntries(rows.map((r) => [r.key, r.status]));
assert.deepEqual(by, { energy_kcal: 'same', fat_g: 'same', sugars_g: 'differs', fibre_g: 'new' });
console.log('label tests passed');

// wrapped three-language row: name on two lines, amounts on the second (it also names the key in Finnish/Danish)
assert.equal(v('varav mättat fett / josta tyydyttynyttä\nrasvaa / heraf mættede fedtsyrer 14,1 g\nKolhydrat 55,6 g').saturated_fat_g, 14.1);
assert.equal(v('Fett 32,1 g\nvarav mättat fett\n14,1 g\nKolhydrat 55,6 g').saturated_fat_g, 14.1);
// ...but a row with no amount does not borrow the next row's amount
assert.equal(v('varav mättat fett\nKolhydrat 55,6 g').saturated_fat_g, undefined);
const wrapped = wordsToText([
  wl(W('Fett', 20, 70), W('32', 500, 530), W('g', 535, 550), W('9,6', 700, 735), W('g', 744, 756)),
  wl(W('varav', 20, 80), W('mättat', 90, 160), W('fett', 170, 210), W('/', 220, 225), W('josta', 230, 280)),
  wl(W('rasvaa', 20, 90), W('/', 100, 105), W('heraf', 110, 160), W('mættede', 170, 240), W('14', 500, 520), W('g', 525, 540), W('4,2', 701, 735), W('g', 744, 756)),
  wl(W('Salt', 20, 70), W('0,13', 498, 548), W('g', 552, 565), W('0,04', 698, 748), W('g', 752, 765)),
]);
assert.equal(v(wrapped.text).saturated_fat_g, 14);
console.log('wrapped-row tests passed');

// a lost decimal comma after a leading zero ("0,8 g" -> "08g"), and "g" read as 8 by some fonts
assert.equal(v('varav sockerarter 08g').sugars_g, 0.8);
assert.equal(v('Protein 9,48').protein_g, 9.4);
assert.equal(v('Fiber 7,28').fibre_g, 7.2);
console.log('misread-unit tests passed');
