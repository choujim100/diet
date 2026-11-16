import { FoodDB, NUTRIENTS, NUTRIENT_INFO, NUTRIENT_KEYS, dailyTargets, evaluate, emptyTotals, sumInto, recipeNutrition, fmt } from './nutrition.js';
import { validBarcode, lookupOff, checkProduct, maxPer100, productNutrients, MACRO_KEYS, canUseCamera, canDecodePhoto, startCamera, decodePhoto } from './product.js';
import { buildContext, generatePlan, planTotals, shoppingList, slotNutrition, MEAL_ORDER } from './planner.js';
import { Matcher } from './matcher.js';
import { parseOffers } from './offers.js';
import * as store from './store.js';
import { h, clear, toast, openModal, nutrientTable } from './ui.js';

const TABS = [['plan', 'Plan'], ['shopping', 'Shopping list'], ['offers', 'Offers'], ['log', 'Food log'], ['settings', 'Settings']];
const CATEGORY_LABEL = { protein: 'Meat, eggs and protein', fish: 'Fish and shellfish', dairy: 'Dairy', dairy_alt: 'Dairy alternatives', plant_protein: 'Plant protein',
  grain: 'Grains, bread and pasta', legume: 'Beans and lentils', vegetable: 'Vegetables', herb: 'Herbs', fruit: 'Fruit', nut_seed: 'Nuts and seeds', fat: 'Oils and fats', pantry: 'Pantry' };
const MEAL_LABEL = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
const PRICE_LABEL = { offer: 'offer', yours: 'your price', observed: 'seen on lidl.se', estimate: 'estimate' };

let S, db, recipes, recipeById, allInfo, nnr, defaultPrices, ingMeta, matcher;
let tab = 'plan';
let offerDraft = null;      // rows being reviewed on the Offers tab
let offerText = '';
let logDate = store.todayISO();
const view = () => document.getElementById('view');

const persist = () => { if (!store.save(S)) toast('Could not save (browser storage is blocked or full).'); };
const label = (f) => (f.name_sv && f.name_sv !== f.name ? `${f.name_sv} (${f.name})` : f.name);
const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };

function priceOf(id) {
  const offers = S.offers.filter((o) => o.id === id);
  if (offers.length) return { sek_per_kg: Math.min(...offers.map((o) => o.sek_per_kg)), source: 'offer' };
  if (S.prices[id] !== undefined && S.prices[id] !== null) return { sek_per_kg: S.prices[id], source: 'yours' };
  const d = defaultPrices[id];
  return { sek_per_kg: d.sek_per_kg, source: d.basis.startsWith('observed') ? 'observed' : 'estimate' };
}
function targets() { return dailyTargets(S.settings, nnr); }
function makeCtx() {
  return buildContext({ db, recipes, settings: S.settings, targets: targets(), priceOf, have: new Set(S.have) });
}
/** Context for displaying an existing plan: all recipes known, even ones the current filters exclude. */
function viewCtx() {
  const days = S.plan ? Math.max(1, ...S.plan.slots.map((s) => s.day + 1)) : S.settings.days;
  return { days, info: allInfo, have: new Set(S.have), priceOf };
}

// ---------- boot ----------
async function boot() {
  const names = ['foods', 'recipes', 'nnr2023', 'prices', 'ingredients', 'aliases'];
  const data = await Promise.all(names.map((n) => fetch(`data/${n}.json`).then((r) => { if (!r.ok) throw new Error(`${n}.json: HTTP ${r.status}`); return r.json(); })));
  const [foods, recs, nnrD, prices, meta, aliases] = data;
  db = new FoodDB(foods);
  recipes = recs.recipes;
  recipeById = new Map(recipes.map((r) => [r.id, r]));
  allInfo = new Map(recipes.map((r) => [r.id, { recipe: r, base: recipeNutrition(db, r) }]));
  nnr = nnrD; defaultPrices = prices; ingMeta = meta;
  matcher = new Matcher(foods, aliases);
  S = store.load();
  tab = (location.hash || '#plan').slice(1);
  if (!TABS.some((t) => t[0] === tab)) tab = 'plan';
  window.addEventListener('hashchange', () => { tab = (location.hash || '#plan').slice(1); if (!TABS.some((t) => t[0] === tab)) tab = 'plan'; render(); });
  render();
  window.__eatBooted = true;
}

function render() {
  const nav = document.getElementById('tabs');
  clear(nav);
  for (const [id, name] of TABS) nav.append(h('button', { 'aria-current': id === tab ? 'page' : null, onclick: () => { location.hash = id; } }, name));
  const root = clear(view());
  try {
    ({ plan: viewPlan, shopping: viewShopping, offers: viewOffers, log: viewLog, settings: viewSettings })[tab](root);
  } catch (e) {
    console.error(e);
    root.append(h('div', { class: 'banner bad' }, `Something went wrong: ${e.message}`));
  }
}

// ---------- shared pieces ----------
function recipeModal(recipe, scale, extra = null) {
  const base = allInfo.get(recipe.id).base;
  const n = {}; for (const k of Object.keys(base.n)) n[k] = base.n[k] * scale;
  const rows = evaluate(n, {});
  let cost = 0;
  for (const i of recipe.ingredients) cost += (i.g * scale / 1000) * priceOf(i.id).sek_per_kg;
  openModal((close) => h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', null, recipe.name), h('button', { onclick: close }, 'Close')),
    h('div', { class: 'muted' }, `${recipe.name_sv} · ${recipe.minutes} min · ${scale.toFixed(2)}× portion · about ${Math.round(cost)} SEK`),
    h('div', { class: 'row' }, ...['vegetarian', 'vegan', 'pescatarian'].filter((t) => recipe.tags && recipe.tags[t]).map((t) => h('span', { class: 'chip' }, t))),
    h('h3', null, 'Ingredients (raw / dry weights)'),
    h('table', null, h('tbody', null, recipe.ingredients.map((i) => {
      const f = ingMeta[i.id];
      return h('tr', null, h('td', null, `${f.name_sv} `, h('span', { class: 'muted' }, `(${f.name})`)), h('td', { class: 'num' }, `${Math.round(i.g * scale)} g`));
    }))),
    h('h3', null, 'Method'),
    h('ol', { class: 'steps' }, recipe.steps.map((s) => h('li', null, s))),
    h('h3', null, 'Nutrition for this portion'),
    h('dl', { class: 'kv' }, ['energy_kcal', 'protein_g', 'fat_g', 'carbs_g', 'fibre_g', 'salt_g'].flatMap((k) => [h('dt', null, NUTRIENT_INFO[k].label), h('dd', null, fmt(n[k], NUTRIENT_INFO[k].unit))])),
    base.missing.length ? h('p', { class: 'muted', style: 'font-size:.85rem' }, `Not in the food database for some ingredients: ${base.missing.map((k) => NUTRIENT_INFO[k].label).join(', ')} (counted as 0).`) : null,
    extra && extra(close)));
}

function nutrientAdvice(rows) {
  const lows = rows.filter((r) => r.target && (r.status === 'low' || r.status === 'near') && r.target.kind === 'min');
  const highs = rows.filter((r) => r.status === 'high');
  const out = [];
  if (lows.length) out.push(h('div', null, h('b', null, 'Below target: '), lows.map((r) => `${r.label} ${fmt(r.value)} of ${fmt(r.target.lo)} ${r.unit}`).join(' · ')));
  if (highs.length) out.push(h('div', null, h('b', null, 'Above limit or range: '), highs.map((r) => r.label).join(', ')));
  return out;
}
const HARD = new Set(['vitamin_d_ug', 'vitamin_b12_ug', 'iodine_ug', 'selenium_ug', 'iron_mg', 'calcium_mg']);

// ---------- plan ----------
function makePlan(newSeed) {
  let ctx;
  try { ctx = makeCtx(); } catch (e) { toast(e.message); return; }
  const seed = newSeed || !S.plan ? Math.floor(Math.random() * 1e6) + 1 : S.plan.seed;
  const btn = document.getElementById('gen');
  if (btn) { btn.disabled = true; btn.textContent = 'Planning…'; }
  setTimeout(() => {
    const p = generatePlan(ctx, seed);
    S.plan = { slots: p.slots, seed: p.seed, startDate: (S.plan && S.plan.startDate) || store.todayISO(), createdAt: Date.now() };
    persist(); render();
    toast(p.summary.budgetMet ? 'New plan ready.' : 'Plan ready, but it is over budget. See the notes.');
  }, 30);
}

function viewPlan(root) {
  const head = h('div', { class: 'row between' }, h('h2', null, 'Weekly plan'),
    h('div', { class: 'row' },
      h('button', { id: 'gen', class: 'primary', onclick: () => makePlan(true) }, S.plan ? 'New plan' : 'Make my plan'),
      S.plan ? h('button', { onclick: () => makePlan(false) }, 'Redo with current settings/offers') : null));
  root.append(head);
  if (!S.onboarded) root.append(h('div', { class: 'banner warn', style: 'margin:.6rem 0' }, 'Check ', h('a', { href: '#settings' }, 'Settings'), ' first: your energy target, weekly budget and diet drive the plan. The defaults are a placeholder.'));
  if (!S.plan) {
    root.append(h('div', { class: 'card', style: 'margin-top:.8rem' }, h('p', null, 'The plan picks breakfast, lunch and dinner for 7 days from simple recipes (30 minutes or less), scales the portions to your energy target, and tries to meet the Nordic Nutrition Recommendations first and your budget second.'),
      h('p', { class: 'muted' }, 'Prices start as estimates. Paste this week’s Lidl offers on the Offers tab and edit prices in Settings for more accurate costs.')));
    return;
  }
  const vctx = viewCtx();
  const valid = S.plan.slots.filter((s) => allInfo.has(s.recipeId));
  const plan = { ...S.plan, slots: valid };
  const totals = planTotals(vctx, plan);
  const tg = targets();
  const rows = evaluate(totals.avg, tg);
  const budget = S.settings.budget;
  const over = totals.cost > budget;
  const metCount = rows.filter((r) => r.target && r.status === 'ok').length, tracked = rows.filter((r) => r.target).length;
  root.append(h('div', { class: 'grid cols-2', style: 'margin:.8rem 0' },
    h('div', { class: 'card row', style: 'gap:1.6rem' },
      h('div', { class: 'stat' }, h('b', null, `${Math.round(totals.cost)} SEK`), h('span', null, `estimated cost, budget ${budget}`)),
      h('div', { class: 'stat' }, h('b', null, `${Math.round(totals.avg.energy_kcal)}`), h('span', null, `kcal per day, target ${S.settings.kcal}`)),
      h('div', { class: 'stat' }, h('b', null, `${metCount}/${tracked}`), h('span', null, 'nutrient targets met'))),
    h('div', { class: `banner ${over ? 'warn' : 'good'}` }, over
      ? `Over budget by about ${Math.round(totals.cost - budget)} SEK. Mark things you already have in the shopping list, add offers, or raise the budget. The tightest plans trade nutrition for price.`
      : `Within budget by about ${Math.round(budget - totals.cost)} SEK (using ${Object.values(S.prices).length ? 'some of your own prices and ' : ''}estimated prices where none are known).`)));
  const advice = nutrientAdvice(rows);
  if (advice.length) {
    const hard = rows.some((r) => HARD.has(r.key) && (r.status === 'low' || r.status === 'near'));
    root.append(h('div', { class: 'banner warn', style: 'margin-bottom:.8rem' }, advice,
      hard ? h('div', { class: 'muted', style: 'margin-top:.4rem' }, 'Some of these are hard to reach from food alone on certain diets. This is reference information, not medical advice. Look at Livsmedelsverket’s guidance or ask a health professional before changing supplements.') : null));
  }
  root.append(h('div', { class: 'grid cols-days' }, Array.from({ length: vctx.days }, (_, d) => {
    const date = store.addDays(S.plan.startDate, d);
    const dayTot = totals.days[d];
    return h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', null, fmtDate(date)), h('span', { class: 'muted' }, `${Math.round(dayTot.energy_kcal)} kcal`)),
      MEAL_ORDER.map((m) => {
        const s = plan.slots.find((x) => x.day === d && x.meal === m);
        if (!s) return null;
        const r = recipeById.get(s.recipeId);
        const kcal = allInfo.get(r.id).base.n.energy_kcal * s.scale;
        const logged = (S.log[date] || []).some((e) => e.recipe === r.id && e.slot === m);
        return h('div', { class: 'meal' },
          h('div', { class: 'kind' }, MEAL_LABEL[m]),
          h('div', { class: 'name' }, r.name),
          h('div', { class: 'sub' }, `${r.minutes} min · ${s.scale.toFixed(1)}× portion · ${Math.round(kcal)} kcal`),
          h('div', { class: 'row', style: 'margin-top:.3rem' },
            h('button', { class: 'small', onclick: () => recipeModal(r, s.scale) }, 'Recipe'),
            h('button', { class: 'small', onclick: () => swapModal(s) }, 'Swap'),
            h('button', { class: 'small', disabled: logged, onclick: () => { logRecipe(date, r, s.scale, m); render(); } }, logged ? 'Logged ✓' : 'Log as eaten')));
      }));
  })));
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' },
    h('div', { class: 'row between' }, h('h2', null, 'Daily average for this plan'),
      h('label', null, 'Plan starts on', h('input', { type: 'date', value: S.plan.startDate, onchange: (e) => { if (e.target.value) { S.plan.startDate = e.target.value; persist(); render(); } } }))),
    h('p', { class: 'muted' }, `Average of the 7 days against NNR 2023 reference values for ${nnr.profiles[`${S.settings.sex}_${S.settings.age}`].label}. A single day can be lower or higher; the weekly average is what the planner optimises.`),
    nutrientTable(rows)));
}

function swapModal(slot) {
  let ctx;
  try { ctx = makeCtx(); } catch (e) { toast(e.message); return; }
  const pool = ctx.pools[slot.meal];
  openModal((close) => h('div', { class: 'stack' },
    h('div', { class: 'row between' }, h('h2', null, `Swap ${MEAL_LABEL[slot.meal].toLowerCase()}, ${fmtDate(store.addDays(S.plan.startDate, slot.day))}`), h('button', { onclick: close }, 'Cancel')),
    h('div', { class: 'scroll-x' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Recipe'), h('th', { class: 'num' }, 'Min'), h('th', { class: 'num' }, 'Protein'), h('th', { class: 'num' }, 'Fibre'), h('th', { class: 'num' }, 'SEK'), h('th', null, ''))),
      h('tbody', null, pool.map((rid) => {
        const sd = ctx.slotData(rid, slot.meal);
        const r = recipeById.get(rid);
        return h('tr', null,
          h('td', null, rid === slot.recipeId ? h('b', null, r.name) : r.name),
          h('td', { class: 'num' }, r.minutes),
          h('td', { class: 'num' }, `${Math.round(sd.n.protein_g * sd.scale)} g`),
          h('td', { class: 'num' }, `${Math.round(sd.n.fibre_g * sd.scale)} g`),
          h('td', { class: 'num' }, Math.round(sd.cost)),
          h('td', null, rid === slot.recipeId ? h('span', { class: 'muted' }, 'current') : h('button', { class: 'small', onclick: () => {
            const target = S.plan.slots.find((x) => x.day === slot.day && x.meal === slot.meal);
            target.recipeId = rid; target.scale = Math.round(sd.scale * 100) / 100; persist(); close(); render();
          } }, 'Use')));
      })))),
    h('p', { class: 'muted' }, 'Swapping does not re-optimise the rest of the week. Check the nutrient panel afterwards.')));
}

// ---------- shopping ----------
function viewShopping(root) {
  root.append(h('h2', null, 'Shopping list'));
  if (!S.plan) { root.append(h('p', { class: 'muted' }, 'Make a plan first.')); return; }
  const vctx = viewCtx();
  const plan = { ...S.plan, slots: S.plan.slots.filter((s) => allInfo.has(s.recipeId)) };
  const list = shoppingList(vctx, plan, ingMeta);
  const total = list.filter((r) => !r.have).reduce((s, r) => s + r.cost, 0);
  const budget = S.settings.budget;
  root.append(h('div', { class: `banner ${total > budget ? 'warn' : 'good'}`, style: 'margin-bottom:.8rem' },
    `To buy: about ${Math.round(total)} SEK of your ${budget} SEK budget. Costs are by weight; real packs are bigger, so expect some leftovers. Tick what you already have.`));
  const groups = new Map();
  for (const r of list) { if (!groups.has(r.category)) groups.set(r.category, []); groups.get(r.category).push(r); }
  const qty = (g) => (g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${Math.max(5, Math.round(g / 5) * 5)} g`);
  for (const [cat, items] of groups) {
    root.append(h('div', { class: 'card', style: 'margin-bottom:.8rem' }, h('h3', null, CATEGORY_LABEL[cat] || cat),
      h('table', null, h('tbody', null, items.map((r) => h('tr', null,
        h('td', { style: 'width:2rem' }, h('input', { type: 'checkbox', checked: r.have, title: 'I already have this', 'aria-label': `I already have ${r.name}`, onchange: (e) => {
          const set = new Set(S.have); if (e.target.checked) set.add(r.id); else set.delete(r.id);
          S.have = [...set]; persist(); render();
        } })),
        h('td', { style: r.have ? 'text-decoration:line-through;opacity:.6' : '' }, `${r.name_sv} `, h('span', { class: 'muted' }, `(${r.name})`)),
        h('td', { class: 'num' }, qty(r.grams)),
        h('td', { class: 'num' }, r.have ? '' : `${Math.round(r.cost)} SEK`),
        h('td', null, h('span', { class: `chip ${r.price.source === 'offer' ? '' : r.price.source === 'estimate' ? 'plain' : 'warn'}` }, PRICE_LABEL[r.price.source]))))))));
  }
  root.append(h('div', { class: 'row' },
    h('button', { onclick: async () => {
      const text = list.filter((r) => !r.have).map((r) => `${qty(r.grams)}  ${r.name_sv}`).join('\n');
      try { await navigator.clipboard.writeText(text); toast('List copied.'); } catch { toast('Could not copy. Select the list manually.'); }
    } }, 'Copy list'),
    h('button', { onclick: () => { S.have = []; persist(); render(); } }, 'Clear "have at home"')));
}

// ---------- offers ----------
function viewOffers(root) {
  root.append(h('h2', null, 'This week’s offers'));
  root.append(h('div', { class: 'card stack' },
    h('p', null, 'Copy the offers from your Lidl app or from lidl.se and paste them below, one product per line (for example “Kycklingfilé 900 g 89,90” or “Bananer 14,90 kr/kg”), or paste whole offer tiles. Lidl does not offer an official way to connect an app to your account, so this app does not log in to Lidl: you paste, it matches.'),
    h('textarea', { id: 'offer-text', placeholder: 'Bananer\n18.90\nMed Lidl Plus\n14.90*\n/kg\n\nKycklingfilé 900 g 89,90', oninput: (e) => { offerText = e.target.value; } }, offerText),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: () => {
        offerText = document.getElementById('offer-text').value;
        offerDraft = parseOffers(offerText).map((o) => ({ ...o, res: matcher.match(o.name) })).map(initRow);
        render();
      } }, 'Read offers'),
      S.offers.length ? h('button', { onclick: () => { S.offers = []; persist(); render(); toast('Offers cleared.'); } }, 'Clear saved offers') : null)));
  if (offerDraft) {
    if (!offerDraft.length) root.append(h('div', { class: 'banner warn', style: 'margin-top:.8rem' }, 'Nothing recognisable found. Try one product per line with a price.'));
    else root.append(offerTable());
  }
  if (S.offers.length) {
    root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, 'Offers in use by the planner'),
      h('table', null, h('tbody', null, S.offers.map((o, i) => h('tr', null,
        h('td', null, ingMeta[o.id] ? ingMeta[o.id].name_sv : o.id, h('div', { class: 'muted', style: 'font-size:.8rem' }, o.label)),
        h('td', { class: 'num' }, `${o.sek_per_kg.toFixed(2)} SEK/kg`),
        h('td', null, h('button', { class: 'small', onclick: () => { S.offers.splice(i, 1); persist(); render(); } }, 'Remove')))))),
      h('div', { class: 'row', style: 'margin-top:.6rem' }, h('a', { class: 'btn', href: '#plan', onclick: () => { setTimeout(() => makePlan(false), 50); } }, 'Re-plan with these offers'))));
  }
}
function initRow(r) {
  const m = r.res.match;
  r.ref = m ? (m.curated_id || String(m.number)) : null;
  r.options = m ? [m, ...r.res.candidates] : [];
  r.use = !!(m && m.curated_id && r.sek_per_kg && (m.confidence === 'high' || m.confidence === 'medium'));
  return r;
}
function offerTable() {
  const card = h('div', { class: 'card', style: 'margin-top:1rem' });
  const sync = () => {
    clear(card);
    card.append(h('h3', null, 'Check the matches'),
      h('p', { class: 'muted' }, 'Only foods that the recipes use can change your plan (marked “used in recipes”). Low-confidence matches are guesses: check them or pick another food.'),
      h('div', { class: 'scroll-x' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Use'), h('th', null, 'Offer'), h('th', null, 'Matched food'), h('th', { class: 'num' }, 'SEK/kg'))),
        h('tbody', null, offerDraft.map((r) => {
          const f = r.ref ? db.get(r.ref) : null;
          const curated = !!(f && f.curated_id);
          return h('tr', null,
            h('td', null, h('input', { type: 'checkbox', checked: r.use && curated, disabled: !curated || !r.sek_per_kg, 'aria-label': `Use offer ${r.name}`, onchange: (e) => { r.use = e.target.checked; } })),
            h('td', null, r.name, h('div', { class: 'muted', style: 'font-size:.78rem' }, r.line.length > 70 ? r.line.slice(0, 70) + '…' : r.line)),
            h('td', null,
              r.options.length || f ? h('select', { 'aria-label': `Food for ${r.name}`, onchange: (e) => { r.ref = e.target.value; const nf = db.get(r.ref); r.use = !!(nf && nf.curated_id && r.sek_per_kg); sync(); } },
                (r.options.length ? r.options : []).map((o) => h('option', { value: o.curated_id || String(o.number), selected: (o.curated_id || String(o.number)) === r.ref }, `${o.name_sv}`)),
                r.options.every((o) => (o.curated_id || String(o.number)) !== r.ref) && f ? h('option', { value: r.ref, selected: true }, f.name_sv) : null) : h('span', { class: 'muted' }, 'no match'),
              ' ', r.res.match && r.ref === (r.res.match.curated_id || String(r.res.match.number)) ? h('span', { class: `chip ${r.res.match.confidence === 'high' ? '' : r.res.match.confidence === 'medium' ? 'warn' : 'bad'}` }, r.res.match.confidence) : h('span', { class: 'chip plain' }, 'chosen'),
              ' ', curated ? h('span', { class: 'chip' }, 'used in recipes') : f ? h('span', { class: 'chip plain' }, 'not used in recipes') : null,
              h('div', null, h('button', { class: 'link', onclick: () => searchFood(r, sync) }, 'search another food'))),
            h('td', { class: 'num' }, h('input', { type: 'number', step: '0.1', min: '0', value: r.sek_per_kg ?? '', placeholder: 'needs price', 'aria-label': `Price per kg for ${r.name}`, onchange: (e) => { r.sek_per_kg = e.target.value ? parseFloat(e.target.value) : null; if (!r.sek_per_kg) r.use = false; sync(); } })));
        })))),
      h('div', { class: 'row', style: 'margin-top:.6rem' }, h('button', { class: 'primary', onclick: () => {
        const chosen = offerDraft.filter((r) => r.use && r.ref && db.get(r.ref) && db.get(r.ref).curated_id && r.sek_per_kg);
        const byId = new Map(S.offers.map((o) => [o.id, o]));
        for (const r of chosen) { const id = db.get(r.ref).curated_id; byId.set(id, { id, sek_per_kg: r.sek_per_kg, label: r.name, line: r.line, saved: store.todayISO() }); }
        S.offers = [...byId.values()]; persist(); offerDraft = null; render();
        toast(`${chosen.length} offer${chosen.length === 1 ? '' : 's'} saved.`);
      } }, 'Save selected offers')));
  };
  sync();
  return card;
}
function searchFood(row, done) {
  openModal((close) => {
    const out = h('div', { class: 'results' });
    const input = h('input', { type: 'search', placeholder: 'Search 2,606 foods (Swedish or English)', style: 'width:100%', oninput: () => {
      clear(out);
      for (const f of db.search(input.value, 25)) out.append(h('button', { onclick: () => { row.options = [{ number: f.number, curated_id: f.curated_id, name_sv: f.name_sv, name: f.name }, ...row.options.filter((o) => o.number !== f.number)]; row.ref = f.curated_id || String(f.number); row.use = !!(f.curated_id && row.sek_per_kg); close(); done(); } }, label(f), f.curated_id ? '  ✓ used in recipes' : ''));
    } });
    setTimeout(() => input.focus(), 30);
    return h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('h3', null, `Food for “${row.name}”`), h('button', { onclick: close }, 'Close')), input, out);
  });
}

// ---------- food log ----------
function logRecipe(date, r, scale, slot) {
  (S.log[date] = S.log[date] || []).push({ recipe: r.id, scale, name: r.name, slot });
  persist();
}
function entryNutrition(e) {
  if (e.recipe) { const info = allInfo.get(e.recipe); if (!info) return emptyTotals(); const n = {}; for (const k of Object.keys(info.base.n)) n[k] = info.base.n[k] * e.scale; return n; }
  if (e.product) { const p = S.products[e.product]; return p ? productNutrients(p, e.g, NUTRIENT_KEYS).n : emptyTotals(); }
  const f = db.get(e.food); return f ? db.nutrients(f, e.g).n : emptyTotals();
}
/** Names of scanned products in `entries` whose label lists no vitamins or minerals (they count as 0 in the totals). */
function understatedProducts(entries) {
  const names = new Set();
  for (const e of entries) {
    const p = e.product && S.products[e.product];
    if (p && productNutrients(p, 100, NUTRIENT_KEYS).missing.some((k) => !MACRO_KEYS.includes(k))) names.add(p.name || p.code);
  }
  return [...names];
}

// ---------- barcode scanning ----------
let maxesCache = null;
const maxes = () => maxesCache || (maxesCache = maxPer100(db, NUTRIENT_KEYS));

function scanCard() {
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '14', placeholder: 'Number under the barcode', 'aria-label': 'Barcode number', style: 'flex:1;min-width:180px',
    onkeydown: (e) => { if (e.key === 'Enter') go(code.value); } });
  const go = (c) => {
    c = c.replace(/\s/g, '');
    if (!validBarcode(c)) { toast('That is not a valid barcode number. Check the digits.'); return; }
    lookupAndShow(c);
  };
  const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try { const c = await decodePhoto(file); if (c) lookupAndShow(c); else toast('No barcode found in that photo. Try again closer, or type the number.'); }
    catch { toast('Could not read that photo. Type the number instead.'); }
  } });
  let why = null;
  if (!canUseCamera()) why = !window.isSecureContext ? 'Camera scanning needs an https page. Type the number printed under the barcode, or open the app from its https address.' : 'This browser cannot read barcodes itself (Chrome on Android can). Type the number under the barcode.';
  return h('div', { class: 'card stack', style: 'margin-top:.6rem' },
    h('h3', null, 'Scan a product'),
    h('p', { class: 'muted', style: 'margin:0' }, 'Looks the barcode up in Open Food Facts, a volunteer-run database. Values are checked and you confirm them before anything is logged. Only the barcode number is sent.'),
    h('div', { class: 'row' },
      canUseCamera() ? h('button', { class: 'primary', onclick: cameraModal }, 'Scan with camera') : null,
      canDecodePhoto() ? h('button', { onclick: () => photo.click() }, 'Scan from photo') : null, photo),
    why ? h('p', { class: 'muted', style: 'margin:0' }, why) : null,
    h('div', { class: 'row' }, code, h('button', { onclick: () => go(code.value) }, 'Look up')));
}

function cameraModal() {
  openModal((close) => {
    const video = h('video', { muted: true, playsinline: true, style: 'width:100%;max-height:60vh;background:#000;border-radius:8px' });
    const status = h('p', { class: 'muted' }, 'Starting the camera…');
    setTimeout(async () => {
      try {
        const stop = await startCamera(video, (c) => { close(); lookupAndShow(c); });
        status.textContent = 'Hold the barcode inside the picture, steady and well lit.';
        const iv = setInterval(() => { if (!video.isConnected) { stop(); clearInterval(iv); } }, 300);
      } catch (e) {
        status.textContent = e && e.name === 'NotAllowedError' ? 'The camera is blocked. Allow it for this site in the browser, or type the number instead.' : 'Could not start the camera. Type the number instead.';
      }
    }, 30);
    return h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('h3', null, 'Scan barcode'), h('button', { onclick: close }, 'Cancel')), video, status);
  });
}

async function lookupAndShow(code) {
  const cached = S.products[code];
  if (cached) { productModal(cached, { note: 'Saved on this device from an earlier scan.' }); return; }
  toast('Looking up the barcode…');
  const res = await lookupOff(code);
  if (res.status === 'found') { productModal(res.product, {}); return; }
  const blank = { code, name: '', brand: '', per100: {}, grams: 100, source: 'you', notes: [] };
  productModal(blank, { note: res.status === 'notfound' ? 'Not found in Open Food Facts. Type the values from the package label (per 100 g). They are saved under this barcode.' : `${res.message} You can type the values from the package label instead.`, bad: true });
}

function productModal(prod, { note = null, bad = false } = {}) {
  const cur = { ...prod, per100: { ...prod.per100 }, notes: [...(prod.notes || [])] };
  let edited = !!prod.edited;
  return openModal((close) => {
    const keys = NUTRIENTS.filter(([k]) => MACRO_KEYS.includes(k) || cur.per100[k] !== undefined);
    const name = h('input', { type: 'text', value: cur.name, placeholder: 'Product name', style: 'width:100%' });
    const gram = h('input', { type: 'number', min: '1', step: '1', value: String(Math.round(cur.grams || 100)), 'aria-label': 'Amount eaten' });
    const flags = {};
    const inputs = {};
    const issueBox = h('div');
    const verifyBox = h('input', { type: 'checkbox', onchange: () => refresh() });
    const verifyRow = h('label', { class: 'inline' }, verifyBox, 'I compared these numbers with the package.');
    const addBtn = h('button', { class: 'primary', onclick: () => add() }, 'Add to food log');
    const refresh = () => {
      const issues = checkProduct(cur, maxes());
      clear(issueBox);
      if (issues.length) issueBox.append(h('div', { class: 'banner warn' }, h('b', null, 'Check these before using the product'),
        h('ul', { style: 'margin:.3rem 0 0;padding-left:1.1rem' }, issues.map((i) => h('li', null, i.key ? `${NUTRIENT_INFO[i.key].label}: ` : '', i.text)))));
      for (const k of keys.map((x) => x[0])) flags[k].textContent = issues.some((i) => i.key === k) ? '⚠' : '';
      verifyRow.hidden = !issues.length;
      if (!issues.length) verifyBox.checked = false;
      const blocked = (issues.length && !verifyBox.checked) || cur.per100.energy_kcal === undefined;
      addBtn.disabled = !!blocked;
      addBtn.title = blocked ? (cur.per100.energy_kcal === undefined ? 'Energy is needed.' : 'Tick the box once you have checked the numbers.') : '';
    };
    const rows = keys.map(([k, label, unit]) => {
      inputs[k] = h('input', { type: 'number', step: 'any', min: '0', value: cur.per100[k] ?? '', 'aria-label': `${label} per 100 g`, placeholder: 'not listed', onchange: (e) => {
        edited = true; cur.kj = null; cur.salt_raw = null; cur.sodium_raw = null; cur.notes = [];
        if (e.target.value === '') delete cur.per100[k]; else cur.per100[k] = Math.max(0, parseFloat(e.target.value));
        refresh();
      } });
      flags[k] = h('span', { class: 'status low', title: 'See the notes above' });
      return h('tr', null, h('td', null, label), h('td', { class: 'num' }, inputs[k]), h('td', null, unit), h('td', null, flags[k]));
    });
    const add = () => {
      const g = parseFloat(gram.value);
      if (!(g > 0)) { toast('Enter the amount you ate.'); return; }
      const saved = { code: cur.code, name: name.value.trim() || `Product ${cur.code}`, brand: cur.brand, quantity: cur.quantity, per100: cur.per100, source: edited || prod.source === 'you' ? 'you' : 'openfoodfacts', edited, from: prod.source };
      S.products[cur.code] = saved;
      (S.log[logDate] = S.log[logDate] || []).push({ product: cur.code, g, name: saved.name });
      persist(); close(); render();
      toast('Added to the log.');
    };
    // closest generic food, as an alternative with Livsmedelsverket values
    const m = cur.name ? matcher.match(cur.name) : null;
    const generic = m && m.match && m.match.confidence !== 'none' ? m.match : null;
    const srcText = prod.source === 'openfoodfacts' ? 'Source: Open Food Facts (volunteer-entered, not verified by this app).' : 'Entered by you.';
    const body = h('div', { class: 'stack' },
      h('div', { class: 'row between' }, h('h3', null, 'Product'), h('button', { onclick: close }, 'Close')),
      note ? h('div', { class: `banner ${bad ? 'warn' : ''}` }, note) : null,
      h('label', null, `Name${cur.brand ? ` (${cur.brand})` : ''}${cur.quantity ? `, ${cur.quantity}` : ''}`, name),
      h('p', { class: 'muted', style: 'margin:0' }, `Barcode ${cur.code}. ${srcText} Values per 100 g (or 100 ml; 1 ml counts as 1 g).`),
      issueBox,
      h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', { class: 'num' }, 'Per 100 g'), h('th', null, 'Unit'), h('th', null, ''))), h('tbody', null, rows))),
      h('p', { class: 'muted', style: 'margin:0' }, 'Only what is on the label is listed. Vitamins and minerals the label does not show count as 0 in your totals. Change a value if it is wrong; it is saved on this device.'),
      verifyRow,
      h('label', null, 'Amount eaten (g or ml)', gram),
      h('div', { class: 'row' }, addBtn,
        generic ? h('button', { onclick: () => {
          const g = parseFloat(gram.value);
          if (!(g > 0)) { toast('Enter the amount you ate.'); return; }
          const f = db.get(generic.number);
          (S.log[logDate] = S.log[logDate] || []).push({ food: f.number, g, name: label(f) }); persist(); close(); render();
        } }, `Log as ${generic.name_sv || generic.name} (Livsmedelsverket) instead`) : null));
    setTimeout(refresh, 0);
    return body;
  });
}
function dayTotals(date) { const t = emptyTotals(); for (const e of S.log[date] || []) sumInto(t, entryNutrition(e)); return t; }

function viewLog(root) {
  root.append(h('div', { class: 'row between' }, h('h2', null, 'Food log'),
    h('div', { class: 'row' },
      h('button', { onclick: () => { logDate = store.addDays(logDate, -1); render(); } }, '←'),
      h('input', { type: 'date', value: logDate, 'aria-label': 'Date', onchange: (e) => { if (e.target.value) { logDate = e.target.value; render(); } } }),
      h('button', { onclick: () => { logDate = store.addDays(logDate, 1); render(); } }, '→'),
      h('button', { onclick: () => { logDate = store.todayISO(); render(); } }, 'Today'))));
  const entries = S.log[logDate] || [];
  const picked = { food: null };
  const resultsBox = h('div', { class: 'results', hidden: true });
  const pickBox = h('div', { class: 'row', hidden: true });
  const gram = h('input', { type: 'number', min: '1', step: '1', value: '100', 'aria-label': 'Grams' });
  const search = h('input', { type: 'search', placeholder: 'Search foods, e.g. havregryn, lax, banan…', style: 'flex:1;min-width:200px', oninput: () => {
    clear(resultsBox);
    const res = db.search(search.value, 20);
    resultsBox.hidden = !res.length;
    for (const f of res) resultsBox.append(h('button', { onclick: () => {
      picked.food = f; clear(pickBox); pickBox.hidden = false; resultsBox.hidden = true; search.value = '';
      pickBox.append(h('b', null, label(f)), gram, 'g', h('button', { class: 'primary', onclick: () => {
        const g = parseFloat(gram.value);
        if (!(g > 0)) { toast('Enter an amount in grams.'); return; }
        (S.log[logDate] = S.log[logDate] || []).push({ food: f.number, g, name: label(f) }); persist(); render();
      } }, 'Add'));
    } }, label(f), h('span', { class: 'muted' }, ` · ${fmt(db.nutrients(f, 100).n.energy_kcal)} kcal/100 g`)));
  } });
  root.append(scanCard());
  root.append(h('div', { class: 'card stack', style: 'margin-top:.6rem' }, h('h3', null, `Add food to ${fmtDate(logDate)}`), h('div', { class: 'row' }, search), resultsBox, pickBox,
    planOptionsFor(logDate)));
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, 'Eaten this day'),
    entries.length ? h('table', null, h('tbody', null, entries.map((e, i) => {
      const n = entryNutrition(e);
      return h('tr', null, h('td', null, e.name, e.slot ? h('span', { class: 'muted' }, ` · ${MEAL_LABEL[e.slot]}`) : null),
        h('td', { class: 'num' }, e.recipe ? `${e.scale.toFixed(1)}× portion` : `${Math.round(e.g)} g`), h('td', { class: 'num' }, `${Math.round(n.energy_kcal)} kcal`),
        h('td', null, h('button', { class: 'small', onclick: () => { entries.splice(i, 1); if (!entries.length) delete S.log[logDate]; persist(); render(); } }, 'Remove')));
    }))) : h('p', { class: 'muted' }, 'Nothing logged for this day yet.')));
  const tg = targets();
  const rows = evaluate(dayTotals(logDate), tg);
  const under = understatedProducts(entries);
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, 'This day against your targets'),
    under.length ? h('div', { class: 'banner warn', style: 'margin-bottom:.6rem' }, `Scanned products list only what is on the label (${under.join(', ')}), so vitamins and minerals they do not show are counted as 0 and those totals are understated.`) : null,
    entries.length ? nutrientTable(rows) : h('p', { class: 'muted' }, 'Add something to see how the day compares.')));
  // last 7 days
  const days = Array.from({ length: 7 }, (_, i) => store.addDays(logDate, -i)).filter((d) => (S.log[d] || []).length);
  if (days.length) {
    const avg = emptyTotals(); for (const d of days) sumInto(avg, dayTotals(d), 1 / days.length);
    root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, `Average of ${days.length} logged day${days.length === 1 ? '' : 's'} in the last 7`),
      h('p', { class: 'muted' }, 'Only days with something logged count, so skipped days do not drag the average down. Incomplete logging makes the average look lower than your real intake.'),
      nutrientTable(evaluate(avg, tg))));
  }
}
function planOptionsFor(date) {
  if (!S.plan) return null;
  const d = [...Array(7).keys()].find((i) => store.addDays(S.plan.startDate, i) === date);
  if (d === undefined) return null;
  const slots = S.plan.slots.filter((s) => s.day === d && allInfo.has(s.recipeId));
  if (!slots.length) return null;
  return h('div', null, h('h3', null, 'From your plan'), h('div', { class: 'row' }, slots.map((s) => {
    const r = recipeById.get(s.recipeId);
    const done = (S.log[date] || []).some((e) => e.recipe === r.id && e.slot === s.meal);
    return h('button', { class: 'small', disabled: done, onclick: () => { logRecipe(date, r, s.scale, s.meal); render(); } }, `${MEAL_LABEL[s.meal]}: ${r.name}${done ? ' ✓' : ''}`);
  })));
}

// ---------- settings ----------
function viewSettings(root) {
  const st = S.settings;
  const save = (patch, replan) => { Object.assign(st, patch); S.onboarded = true; persist(); render(); if (replan) toast('Saved. Press “Redo with current settings” on the Plan tab to use it.'); };
  root.append(h('h2', null, 'Settings'));
  root.append(h('div', { class: 'card stack' }, h('h3', null, 'You'),
    h('div', { class: 'field-grid' },
      h('label', null, 'Sex (for reference values)', h('select', { onchange: (e) => save({ sex: e.target.value }, true) }, [['f', 'Woman'], ['m', 'Man']].map(([v, t]) => h('option', { value: v, selected: st.sex === v }, t)))),
      h('label', null, 'Age group', h('select', { onchange: (e) => save({ age: e.target.value }, true) }, [['18_24', '18-24'], ['25_50', '25-50'], ['51_70', '51-70']].map(([v, t]) => h('option', { value: v, selected: st.age === v }, t)))),
      h('label', null, 'Energy target (kcal per day)', h('input', { type: 'number', min: '1200', max: '4500', step: '50', value: st.kcal, onchange: (e) => save({ kcal: Math.min(4500, Math.max(1200, parseInt(e.target.value, 10) || 2000)) }, true) })),
      h('label', null, 'Weekly food budget (SEK)', h('input', { type: 'number', min: '100', step: '10', value: st.budget, onchange: (e) => save({ budget: Math.max(100, parseInt(e.target.value, 10) || 700) }, true) }))),
    h('p', { class: 'muted' }, 'The energy target is yours to set; this app does not estimate it. NNR 2023 gives group averages (for example about 8-9 MJ per day, 1,900-2,250 kcal, for a woman aged 25-50 with low to medium activity). Reference values come from the Nordic Nutrition Recommendations 2023 and apply to healthy adults.')));
  root.append(h('div', { class: 'card stack', style: 'margin-top:1rem' }, h('h3', null, 'Food preferences'),
    h('div', { class: 'field-grid' },
      h('label', null, 'Diet', h('select', { onchange: (e) => save({ diet: e.target.value }, true) }, [['omnivore', 'Everything'], ['pescatarian', 'Pescatarian (fish, no meat)'], ['vegetarian', 'Vegetarian'], ['vegan', 'Vegan']].map(([v, t]) => h('option', { value: v, selected: st.diet === v }, t)))),
      h('div', null, h('div', { style: 'font-size:.9rem;color:var(--muted)' }, 'Meals to plan'),
        h('div', { class: 'row' }, MEAL_ORDER.map((m) => h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: st.meals[m], onchange: (e) => { const meals = { ...st.meals, [m]: e.target.checked }; if (!Object.values(meals).some(Boolean)) { toast('Keep at least one meal.'); render(); return; } save({ meals }, true); } }), MEAL_LABEL[m]))))),
    ingredientPicker('Never include (dislikes, allergies)', 'dislikes', save), ingredientPicker('Prefer (the planner favours recipes with these)', 'likes', save),
    h('p', { class: 'muted' }, 'Allergies: the planner only excludes the ingredients you list. It does not check recipes for hidden allergens, so always read labels.')));
  root.append(priceEditor());
  root.append(h('div', { class: 'card stack', style: 'margin-top:1rem' }, h('h3', null, 'Your data'),
    h('p', { class: 'muted' }, 'Everything (settings, plan, offers, food log) is stored only in this browser. Clearing site data deletes it. Export a backup now and then.'),
    h('div', { class: 'row' },
      h('button', { onclick: () => {
        const url = URL.createObjectURL(new Blob([store.exportJSON(S)], { type: 'application/json' }));
        const a = h('a', { href: url, download: `eat-better-backup-${store.todayISO()}.json` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }, 'Export backup'),
      h('label', { class: 'btn', style: 'display:inline-block;cursor:pointer' }, 'Import backup', h('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try { S = store.importJSON(await file.text()); persist(); render(); toast('Backup imported.'); } catch (err) { toast(err.message); }
      } })),
      h('button', { onclick: () => { if (confirm('Delete all your settings, plan, offers and food log from this browser?')) { S = structuredClone(store.DEFAULTS); persist(); offerDraft = null; render(); toast('Everything cleared.'); } } }, 'Delete all my data'))));
}
function ingredientPicker(title, field, save) {
  const st = S.settings;
  const byCat = new Map();
  for (const [id, m] of Object.entries(ingMeta)) { if (!byCat.has(m.category)) byCat.set(m.category, []); byCat.get(m.category).push([id, m]); }
  const sel = h('select', { 'aria-label': title, onchange: (e) => { const v = e.target.value; if (v && !st[field].includes(v)) save({ [field]: [...st[field], v] }, true); } },
    h('option', { value: '' }, 'Add an ingredient…'),
    [...byCat].map(([cat, items]) => h('optgroup', { label: CATEGORY_LABEL[cat] || cat }, items.sort((a, b) => a[1].name_sv.localeCompare(b[1].name_sv, 'sv')).map(([id, m]) => h('option', { value: id }, `${m.name_sv} (${m.name})`)))));
  return h('div', null, h('div', { style: 'font-size:.9rem;color:var(--muted)' }, title), sel,
    h('div', { class: 'chips' }, st[field].map((id) => h('span', { class: 'chip' }, ingMeta[id] ? ingMeta[id].name_sv : id, h('button', { 'aria-label': `Remove ${id}`, onclick: () => save({ [field]: st[field].filter((x) => x !== id) }, true) }, '×')))));
}
function priceEditor() {
  const rows = Object.entries(ingMeta).sort((a, b) => a[1].name_sv.localeCompare(b[1].name_sv, 'sv'));
  return h('details', { class: 'card', style: 'margin-top:1rem' }, h('summary', null, h('b', null, 'Ingredient prices (SEK per kg)')),
    h('p', { class: 'muted' }, 'Starting prices are rough estimates (a few are regular prices seen on lidl.se on 2026-11-16). Enter your real Lidl prices to make costs trustworthy. Offers override these during their week.'),
    h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Ingredient'), h('th', null, 'Source'), h('th', { class: 'num' }, 'SEK/kg'))),
      h('tbody', null, rows.map(([id, m]) => {
        const p = priceOf(id);
        return h('tr', null, h('td', null, m.name_sv, h('span', { class: 'muted' }, ` (${m.name})`)),
          h('td', null, h('span', { class: `chip ${p.source === 'estimate' ? 'plain' : p.source === 'offer' ? '' : 'warn'}` }, PRICE_LABEL[p.source])),
          h('td', { class: 'num' }, h('input', { type: 'number', min: '0', step: '0.5', value: S.prices[id] ?? '', placeholder: String(defaultPrices[id].sek_per_kg), 'aria-label': `Price per kg for ${m.name}`,
            onchange: (e) => { if (e.target.value === '') delete S.prices[id]; else S.prices[id] = Math.max(0, parseFloat(e.target.value)); persist(); toast('Price saved.'); } })));
      })))));
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('view').replaceChildren(h('div', { class: 'banner bad' }, `Could not start: ${e.message}. Open this app through a web server (see README), not by double-clicking the file.`));
});
