// Headless check of the planner: node tools/test_planner.mjs [budget] [diet] [sex] [kcal]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FoodDB, dailyTargets, evaluate, fmt } from '../web/js/nutrition.js';
import { buildContext, generatePlan, planTotals, shoppingList } from '../web/js/planner.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'data');
const j = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const db = new FoodDB(j('foods.json'));
const recipes = j('recipes.json').recipes;
const nnr = j('nnr2023.json');
const prices = j('prices.json');
const meta = j('ingredients.json');
const priceOf = (id) => prices[id];

const settings = {
  sex: process.argv[4] || 'f', age: '25_50', kcal: +(process.argv[5] || 2000), budget: +(process.argv[2] || 700),
  diet: process.argv[3] || 'omnivore', dislikes: [], likes: [], meals: { breakfast: true, lunch: true, dinner: true }, days: 7,
};
const targets = dailyTargets(settings, nnr);
const ctx = buildContext({ db, recipes, settings, targets, priceOf });
const t0 = Date.now();
const plan = generatePlan(ctx, 1);
console.log(`plan in ${Date.now() - t0} ms | cost ${plan.summary.cost.toFixed(0)} SEK of ${settings.budget} | budgetMet=${plan.summary.budgetMet}`);
const counts = {};
for (const s of plan.slots) counts[s.recipeId] = (counts[s.recipeId] || 0) + 1;
console.log('recipes used:', Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}x${v}`).join(', '));
const tot = planTotals(ctx, plan);
console.log(`recomputed cost ${tot.cost.toFixed(0)}`);
const rows = evaluate(tot.avg, targets);
for (const r of rows) {
  const tg = r.target;
  const goal = tg ? (tg.kind === 'min' ? `>= ${fmt(tg.lo)}` : tg.kind === 'max' ? `<= ${fmt(tg.hi)}` : `${fmt(tg.lo)}-${fmt(tg.hi)}`) : '';
  console.log(`${r.label.padEnd(18)} ${fmt(r.value, r.unit).padEnd(12)} ${goal.padEnd(14)} ${r.status}`);
}
const low = rows.filter((r) => r.status === 'low' || r.status === 'high' || r.status === 'near').map((r) => `${r.label}(${r.status})`);
console.log('not fully met:', low.join(', ') || 'none');
const list = shoppingList(ctx, plan, meta);
console.log('shopping items:', list.length, '| top cost:', list.sort((a, b) => b.cost - a.cost).slice(0, 5).map((r) => `${r.id} ${r.cost.toFixed(0)}`).join(', '));
