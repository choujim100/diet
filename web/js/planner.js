// Weekly meal planner: picks recipes for every meal slot, scales portions to the energy target,
// and optimises nutrient coverage first, then cost against the budget, then variety.
import { NUTRIENT_KEYS, emptyTotals, sumInto, shortfall, recipeNutrition } from './nutrition.js';

export const MEAL_WEIGHTS = { breakfast: 0.25, lunch: 0.35, dinner: 0.4 };
export const MEAL_ORDER = ['breakfast', 'lunch', 'dinner'];
const SCALE_MIN = 0.6, SCALE_MAX = 1.6;

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MEAT = new Set(['chicken_breast', 'chicken_thigh', 'turkey_fillet', 'beef_mince_10', 'beef_mince_15', 'pork_mince_8', 'pork_tenderloin', 'bacon']);

export function allowedByDiet(recipe, diet) {
  const t = recipe.tags || {};
  if (diet === 'vegan') return !!t.vegan;
  if (diet === 'vegetarian') return !!t.vegetarian;
  if (diet === 'pescatarian') return !!t.pescatarian;
  return true;
}

/** Everything the search needs, computed once. */
export function buildContext({ db, recipes, settings, targets, priceOf, have = new Set() }) {
  const dislikes = new Set(settings.dislikes || []);
  const likes = new Set(settings.likes || []);
  const meals = MEAL_ORDER.filter((m) => settings.meals[m]);
  if (!meals.length) throw new Error('Pick at least one meal to plan.');
  const wsum = meals.reduce((s, m) => s + MEAL_WEIGHTS[m], 0);
  const slotKcal = Object.fromEntries(meals.map((m) => [m, (settings.kcal * MEAL_WEIGHTS[m]) / wsum]));
  const pools = { breakfast: [], lunch: [], dinner: [] };
  const info = new Map();
  for (const r of recipes) {
    if (!allowedByDiet(r, settings.diet)) continue;
    if (r.ingredients.some((i) => dislikes.has(i.id))) continue;
    const base = recipeNutrition(db, r);
    info.set(r.id, { recipe: r, base, likeCount: r.ingredients.filter((i) => likes.has(i.id)).length });
    if (r.meal.includes('breakfast')) pools.breakfast.push(r.id);
    if (r.meal.includes('main')) { pools.lunch.push(r.id); pools.dinner.push(r.id); }
  }
  for (const m of meals) if (!pools[m].length) throw new Error(`No ${m} recipes match your diet and dislikes. Loosen the filters in Settings.`);
  const kcalKey = 'energy_kcal';
  function scaleFor(rid, meal) {
    const kcal = info.get(rid).base.n[kcalKey];
    return Math.min(SCALE_MAX, Math.max(SCALE_MIN, slotKcal[meal] / kcal));
  }
  function costOf(rid, scale) {
    let c = 0;
    for (const ing of info.get(rid).recipe.ingredients) {
      if (have.has(ing.id)) continue;
      c += (ing.g * scale / 1000) * priceOf(ing.id).sek_per_kg;
    }
    return c;
  }
  const cache = new Map();
  function slotData(rid, meal) {
    const key = rid + '|' + meal;
    let d = cache.get(key);
    if (!d) {
      const scale = scaleFor(rid, meal);
      d = { scale, n: info.get(rid).base.n, cost: costOf(rid, scale), likeCount: info.get(rid).likeCount };
      cache.set(key, d);
    }
    return d;
  }
  return { db, settings, targets, meals, slotKcal, pools, info, slotData, days: settings.days || 7, priceOf, have };
}

function evaluateAssignment(ctx, assign, costW) {
  const { days, meals, targets, settings } = ctx;
  const week = emptyTotals();
  let cost = 0, dayDev = 0, likeBonus = 0;
  for (let d = 0; d < days; d++) {
    let dayKcal = 0;
    for (const m of meals) {
      const sd = ctx.slotData(assign[d][m], m);
      sumInto(week, sd.n, sd.scale);
      dayKcal += sd.n.energy_kcal * sd.scale;
      cost += sd.cost;
      likeBonus += sd.likeCount;
    }
    dayDev += Math.abs(dayKcal - settings.kcal) / settings.kcal;
  }
  let nutr = 0;
  const avg = {};
  for (const k of NUTRIENT_KEYS) {
    avg[k] = week[k] / days;
    if (k === 'energy_kcal') continue;
    nutr += shortfall(avg[k], targets[k]);
  }
  // repeats and neighbours
  const counts = new Map();
  let adj = 0;
  for (let d = 0; d < days; d++) for (const m of meals) {
    const r = assign[d][m];
    counts.set(r, (counts.get(r) || 0) + 1);
    if (d > 0 && assign[d - 1][m] === r) adj += 1;
  }
  let rep = 0;
  for (const c of counts.values()) if (c > 2) rep += c - 2;
  for (let d = 0; d < days; d++) if (assign[d].lunch !== undefined && assign[d].lunch === assign[d].dinner) rep += 3; // same dish twice in a day
  const budget = settings.budget;
  const over = cost > budget ? (cost - budget) / budget : 0;
  const score = nutr * 1.0 + (dayDev / days) * 3 + rep * 0.25 + adj * 0.3 + over * costW + 0.15 * (cost / budget) - likeBonus * 0.02;
  return { score, avg, cost, week, nutr };
}

/**
 * Search for a good plan. Returns { slots, summary }.
 * summary.budgetMet is false when no plan within budget could be found.
 */
export function generatePlan(ctx, seed = 1) {
  const { days, meals, pools } = ctx;
  let best = null;
  for (let costW = 4; costW <= 64; costW *= 4) {
    const rand = rng(seed * 7919 + costW);
    for (let restart = 0; restart < 5; restart++) {
      const assign = [];
      for (let d = 0; d < days; d++) {
        const row = {};
        for (const m of meals) row[m] = pools[m][Math.floor(rand() * pools[m].length)];
        assign.push(row);
      }
      let cur = evaluateAssignment(ctx, assign, costW);
      for (let it = 0; it < 2500; it++) {
        const d = Math.floor(rand() * days);
        const m = meals[Math.floor(rand() * meals.length)];
        const pool = pools[m];
        const cand = pool[Math.floor(rand() * pool.length)];
        const old = assign[d][m];
        if (cand === old) continue;
        assign[d][m] = cand;
        const ev = evaluateAssignment(ctx, assign, costW);
        if (ev.score < cur.score - 1e-9) cur = ev; else assign[d][m] = old;
      }
      if (!best || cur.score < best.ev.score || (best.ev.cost > ctx.settings.budget && cur.cost < best.ev.cost && cur.cost <= ctx.settings.budget)) {
        best = { ev: cur, assign: assign.map((r) => ({ ...r })) };
      }
    }
    if (best.ev.cost <= ctx.settings.budget) break;
  }
  const slots = [];
  for (let d = 0; d < days; d++) for (const m of meals) {
    const rid = best.assign[d][m];
    slots.push({ day: d, meal: m, recipeId: rid, scale: round2(ctx.slotData(rid, m).scale) });
  }
  return {
    slots,
    seed,
    summary: { cost: best.ev.cost, budget: ctx.settings.budget, budgetMet: best.ev.cost <= ctx.settings.budget, avgDay: best.ev.avg, score: best.ev.score },
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

/** Nutrition of one planned slot or logged recipe. */
export function slotNutrition(info, recipeId, scale) {
  const base = info.get(recipeId).base.n;
  const out = {};
  for (const k of NUTRIENT_KEYS) out[k] = base[k] * scale;
  return out;
}

/** Totals for each day and the weekly average from a stored plan. */
export function planTotals(ctx, plan) {
  const days = [];
  for (let d = 0; d < ctx.days; d++) days.push(emptyTotals());
  let cost = 0;
  for (const s of plan.slots) {
    if (s.day >= days.length) continue;
    sumInto(days[s.day], slotNutrition(ctx.info, s.recipeId, s.scale));
    for (const ing of ctx.info.get(s.recipeId).recipe.ingredients) {
      if (ctx.have.has(ing.id)) continue;
      cost += (ing.g * s.scale / 1000) * ctx.priceOf(ing.id).sek_per_kg;
    }
  }
  const avg = emptyTotals();
  for (const t of days) sumInto(avg, t, 1 / days.length);
  return { days, avg, cost };
}

/** Shopping list for a plan: grams per ingredient with cost and price source. */
export function shoppingList(ctx, plan, ingredientMeta) {
  const grams = new Map();
  for (const s of plan.slots) {
    const r = ctx.info.get(s.recipeId).recipe;
    for (const ing of r.ingredients) grams.set(ing.id, (grams.get(ing.id) || 0) + ing.g * s.scale);
  }
  const rows = [];
  for (const [id, g] of grams) {
    const p = ctx.priceOf(id);
    const meta = ingredientMeta[id] || { category: 'other', name_sv: id, name: id };
    rows.push({ id, grams: g, cost: (g / 1000) * p.sek_per_kg, price: p, category: meta.category, name_sv: meta.name_sv, name: meta.name, have: ctx.have.has(id) });
  }
  rows.sort((a, b) => a.category.localeCompare(b.category) || a.name_sv.localeCompare(b.name_sv, 'sv'));
  return rows;
}
