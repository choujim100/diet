import { FoodDB, NUTRIENTS, NUTRIENT_INFO, NUTRIENT_KEYS, dailyTargets, evaluate, emptyTotals, sumInto, recipeNutrition, fmt } from './nutrition.js';
import { labelScanner } from './labelui.js';
import { validBarcode, lookupOff, checkProduct, maxPer100, MACRO_KEYS, canUseCamera, canDecodePhoto, startCamera, decodePhoto } from './product.js';
import { productPer100, pantryItems, addToPantry, takeFromPantry, parsePack } from './pantry.js';
import { scheduleWeek, coverage, averageDays, HORIZON } from './schedule.js';
import { suggestPurchases, allowedByDiet } from './suggest.js';
import { Matcher } from './matcher.js';
import { parseOffers } from './offers.js';
import * as store from './store.js';
import { h, clear, toast, openModal, nutrientTable } from './ui.js';

const TABS = [['schedule', 'Schedule'], ['pantry', 'Pantry'], ['log', 'Food log'], ['offers', 'Offers'], ['settings', 'Settings']];
const CATEGORY_LABEL = { protein: 'Meat, eggs and protein', fish: 'Fish and shellfish', dairy: 'Dairy', dairy_alt: 'Dairy alternatives', plant_protein: 'Plant protein',
  grain: 'Grains, bread and pasta', legume: 'Beans and lentils', vegetable: 'Vegetables', herb: 'Herbs', fruit: 'Fruit', nut_seed: 'Nuts and seeds', fat: 'Oils and fats', pantry: 'Pantry' };
const PRICE_LABEL = { offer: 'offer', yours: 'your price', observed: 'seen on lidl.se', estimate: 'estimate' };
const NOT_TRACKED = 'vitamin K, pantothenic acid, biotin, choline, copper, fluoride, manganese and molybdenum';
const VITMIN = new Set(NUTRIENTS.filter((n) => n[3] === 'vitamin' || n[3] === 'mineral').map((n) => n[0]));

let S, db, recipes, allInfo, nnr, defaultPrices, ingMeta, matcher;
let tab = 'schedule';
let offerDraft = null;      // rows being reviewed on the Offers tab
let offerText = '';
let logDate = store.todayISO();
const view = () => document.getElementById('view');

const persist = () => { if (!store.save(S)) toast('Could not save (browser storage is blocked or full).'); };
const label = (f) => (f.name_sv && f.name_sv !== f.name ? `${f.name_sv} (${f.name})` : f.name);
const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); };
const nname = (k) => NUTRIENT_INFO[k].label;

function priceOf(id) {
  const offers = S.offers.filter((o) => o.id === id);
  if (offers.length) return { sek_per_kg: Math.min(...offers.map((o) => o.sek_per_kg)), source: 'offer' };
  if (S.prices[id] !== undefined && S.prices[id] !== null) return { sek_per_kg: S.prices[id], source: 'yours' };
  const d = defaultPrices[id];
  return { sek_per_kg: d.sek_per_kg, source: d.basis.startsWith('observed') ? 'observed' : 'estimate' };
}
function targets() { return dailyTargets(S.settings, nnr); }
/** The day the schedule starts: today, or tomorrow once today has been marked as eaten. */
const startDate = () => (S.eatenDays[store.todayISO()] ? store.addDays(store.todayISO(), 1) : store.todayISO());

// ---------- boot ----------
async function boot() {
  const names = ['foods', 'recipes', 'nnr2023', 'prices', 'ingredients', 'aliases'];
  const data = await Promise.all(names.map((n) => fetch(`data/${n}.json`).then((r) => { if (!r.ok) throw new Error(`${n}.json: HTTP ${r.status}`); return r.json(); })));
  const [foods, recs, nnrD, prices, meta, aliases] = data;
  db = new FoodDB(foods);
  recipes = recs.recipes; // only to read food-log entries from the earlier recipe version of the app
  allInfo = new Map(recipes.map((r) => [r.id, { recipe: r, base: recipeNutrition(db, r) }]));
  nnr = nnrD; defaultPrices = prices; ingMeta = meta;
  matcher = new Matcher(foods, aliases);
  S = store.load();
  const fromHash = () => { tab = (location.hash || '#schedule').slice(1); if (!TABS.some((t) => t[0] === tab)) tab = 'schedule'; };
  fromHash();
  window.addEventListener('hashchange', () => { fromHash(); render(); });
  render();
  window.__eatBooted = true;
}

function render() {
  const nav = document.getElementById('tabs');
  clear(nav);
  for (const [id, name] of TABS) nav.append(h('button', { 'aria-current': id === tab ? 'page' : null, onclick: () => { location.hash = id; } }, name));
  const root = clear(view());
  try {
    ({ schedule: viewSchedule, pantry: viewPantry, offers: viewOffers, log: viewLog, settings: viewSettings })[tab](root);
  } catch (e) {
    console.error(e);
    root.append(h('div', { class: 'banner bad' }, `Something went wrong: ${e.message}`));
  }
}

// ---------- schedule ----------
/** Notes for a nutrient table: where the numbers come from when they are not plain label or database values. */
function sourceNotes(items) {
  const notes = {};
  for (const k of NUTRIENT_KEYS) {
    const est = items.filter((i) => i.est.includes(k)).length, unk = items.filter((i) => i.unknown.includes(k)).length;
    const parts = [];
    if (est) parts.push(`${est} item${est === 1 ? '' : 's'} estimated from a similar food`);
    if (unk && VITMIN.has(k)) parts.push(`no data for ${unk} item${unk === 1 ? '' : 's'}, counted as 0`);
    if (parts.length) notes[k] = parts.join('; ');
  }
  return notes;
}
function candidates() {
  const dislikes = new Set(S.settings.dislikes);
  const out = [];
  for (const [id, m] of Object.entries(ingMeta)) {
    const f = db.get(id);
    if (!f || dislikes.has(id) || !allowedByDiet(id, m.category, S.settings.diet)) continue;
    out.push({ id, name: m.name, name_sv: m.name_sv, category: m.category, v: Object.fromEntries(NUTRIENT_KEYS.map((k) => [k, f.vals[db.ix[k]] ?? 0])), sekPerKg: priceOf(id).sek_per_kg });
  }
  return out;
}
function markEaten(day, date) {
  for (const l of day.lines) {
    const i = l.id.indexOf(':'), kind = l.id.slice(0, i), ref = l.id.slice(i + 1);
    (S.log[date] = S.log[date] || []).push(kind === 'product' ? { product: ref, g: l.g, name: l.name } : { food: Number(ref), g: l.g, name: l.name });
    takeFromPantry(S.pantry, kind, ref, l.g);
  }
  S.eatenDays[date] = true;
  persist(); render();
  toast('Logged, and taken out of the pantry.');
}

function viewSchedule(root) {
  root.append(h('h2', null, 'Schedule for the next 7 days'));
  const items = pantryItems(S.pantry, S.products, db);
  if (!items.length) {
    root.append(h('div', { class: 'card stack' },
      h('p', null, 'Your pantry is empty, so there is nothing to schedule. This app only schedules food you have told it about: products you scanned and confirmed, and foods you added by name.'),
      h('div', { class: 'row' }, h('a', { class: 'btn primary', href: '#pantry' }, 'Add food to the pantry'))));
    return;
  }
  const tg = targets(), kcal = S.settings.kcal, start = startDate();
  const week = scheduleWeek({ items, targets: tg, kcal });
  const cov = coverage({ items, targets: tg, kcal });
  const { avg, n: usedDays } = averageDays(week.days);
  const notes = sourceNotes(items);
  const dateOf = (i) => fmtDate(store.addDays(start, i));
  root.append(h('p', { class: 'muted' }, 'Built only from the food in your pantry. There are no recipes: for each day the app picks amounts of what you have that get closest to your energy target and the Nordic reference values. What it suggests buying is never counted until you scan or add it.'));

  // food
  const fd = week.foodDays;
  root.append(fd >= HORIZON
    ? h('div', { class: 'banner good' }, `Your pantry holds enough energy for all ${HORIZON} days (${fmt(cov.rows.find((r) => r.key === 'energy_kcal').coverDays, '')} days at ${kcal} kcal).`)
    : h('div', { class: 'banner bad' }, h('b', null, `Your food runs out ${fd < 1 ? 'today' : `on ${dateOf(Math.floor(fd))}`}. `), `The pantry holds ${fd.toFixed(1)} day${fd.toFixed(1) === '1.0' ? '' : 's'} of energy at ${kcal} kcal. Go shopping before then.`));

  // nutrients that run out
  const runs = cov.rows.filter((r) => r.key !== 'energy_kcal' && r.coverDays < HORIZON);
  if (runs.length) {
    root.append(h('div', { class: 'card', style: 'margin-top:.8rem' },
      h('h3', null, 'Nutrients that will run out'),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'How many days the whole pantry covers each nutrient at the full daily reference value for you, and the day it stops. Only nutrients short of 7 days are listed.'),
      h('div', { class: 'scroll-x' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', { class: 'num' }, 'Pantry covers'), h('th', null, 'Runs out'), h('th', { class: 'num' }, 'Daily average if spread over the schedule'))),
        h('tbody', null, runs.map((r) => {
          const pct = r.perDay ? ((avg[r.key] || 0) / r.perDay) : 0;
          return h('tr', null,
            h('td', null, nname(r.key), notes[r.key] ? h('div', { class: 'muted', style: 'font-size:.78rem' }, notes[r.key]) : null),
            h('td', { class: 'num' }, `${r.coverDays.toFixed(1)} days`),
            h('td', null, r.coverDays < 1 ? h('span', { class: 'status low' }, 'not even today') : h('span', { class: `status ${r.coverDays < 3 ? 'low' : 'near'}` }, dateOf(Math.floor(r.coverDays)))),
            h('td', { class: 'num' }, `${Math.round(pct * 100)} %`));
        }))))));
  } else {
    root.append(h('div', { class: 'banner good', style: 'margin-top:.8rem' }, `Every nutrient with a reference value is covered for ${HORIZON} days by what you have, as far as the numbers go. ${Object.keys(notes).length ? 'Some values are estimates (see the table at the bottom).' : ''}`));
  }
  // limits
  const over = ['salt_g', 'sodium_mg', 'saturated_fat_g'].filter((k) => tg[k] && (avg[k] || 0) > tg[k].hi);
  if (over.length) root.append(h('div', { class: 'banner warn', style: 'margin-top:.8rem' }, h('b', null, 'Above the daily limit on this schedule: '), over.map((k) => `${nname(k)} ${fmt(avg[k], NUTRIENT_INFO[k].unit)} of at most ${fmt(tg[k].hi, NUTRIENT_INFO[k].unit)}`).join(' · '), '. The scheduler already tries to stay under; your pantry leaves no better way.'));

  // what to buy
  const coverDays = Object.fromEntries(cov.rows.map((r) => [r.key, r.coverDays]));
  if (runs.length || fd < HORIZON) {
    const sug = suggestPurchases({ supply: cov.supply, targets: tg, kcal, candidates: candidates(), coverDays });
    const total = sug.reduce((s, x) => s + x.cost, 0);
    const qty = (g) => (g >= 1000 ? `${(g / 1000).toFixed(g % 1000 ? 2 : 0)} kg` : `${g} g`);
    root.append(h('div', { class: 'card', style: 'margin-top:.8rem' },
      h('h3', null, 'Suggested shopping'),
      h('p', { class: 'muted', style: 'margin-top:0' }, 'The foods that close the gaps above for the whole week. These are suggestions only. Nothing here counts as food you have: buy it, then scan it or add it in the Pantry, and it will be used in the schedule.'),
      sug.length ? h('div', { class: 'scroll-x' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Buy'), h('th', { class: 'num' }, 'Amount'), h('th', null, 'Why'), h('th', null, 'Needed by'), h('th', { class: 'num' }, 'About'))),
        h('tbody', null, sug.map((s) => h('tr', null,
          h('td', null, s.name_sv, h('div', { class: 'muted', style: 'font-size:.78rem' }, `${s.name} · ${CATEGORY_LABEL[s.category] || s.category}`)),
          h('td', { class: 'num' }, qty(s.g)),
          h('td', null, s.fixes.map((f) => `${nname(f.key)} +${Math.round(f.share * 100)} %`).join(', ')),
          h('td', null, dateOf(s.needBy)),
          h('td', { class: 'num' }, `${Math.round(s.cost)} SEK`)))))) : h('p', { class: 'muted' }, 'No suggestion helps with the foods this app knows for your diet.'),
      sug.length ? h('p', { class: 'muted', style: 'margin-bottom:0' }, `Estimated ${Math.round(total)} SEK in total, by weight (${S.offers.length ? 'your saved offers and ' : ''}estimated prices; real packs are bigger). “Why” is the share of a week’s reference amount each food adds. Variety matters: these are one cheap way to cover the gaps, not the only one.`) : null,
      sug.length ? h('div', { class: 'row', style: 'margin-top:.5rem' }, h('button', { onclick: async () => {
        try { await navigator.clipboard.writeText(sug.map((s) => `${qty(s.g)}  ${s.name_sv}`).join('\n')); toast('List copied.'); } catch { toast('Could not copy. Select the list manually.'); }
      } }, 'Copy list')) : null));
  }

  // the days
  root.append(h('h3', { style: 'margin:1rem 0 .4rem' }, 'Day by day'));
  root.append(h('div', { class: 'grid cols-days' }, week.days.map((d) => {
    const date = store.addDays(start, d.index);
    const pct = Math.round((d.kcal / kcal) * 100);
    return h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h3', null, fmtDate(date)), h('span', { class: d.kcal >= kcal * 0.9 ? 'muted' : 'status low' }, d.kcal ? `${Math.round(d.kcal)} kcal · ${pct} %` : 'no food left')),
      d.lines.length ? h('table', null, h('tbody', null, d.lines.map((l) => h('tr', null, h('td', null, l.name), h('td', { class: 'num' }, `${l.g} g`))))) : h('p', { class: 'muted' }, 'Nothing in the pantry for this day.'),
      d.lines.length ? h('details', { style: 'margin-top:.4rem' }, h('summary', { class: 'muted' }, 'Nutrients this day'), nutrientTable(evaluate(d.totals, tg), { notes })) : null,
      d.index === 0 && d.lines.length ? h('div', { class: 'row', style: 'margin-top:.5rem' }, h('button', { class: 'small', onclick: () => markEaten(d, date) }, 'Mark as eaten (log it, take it out of the pantry)')) : null);
  })));
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' },
    h('h3', null, `Daily average over the ${usedDays} day${usedDays === 1 ? '' : 's'} with food`),
    h('p', { class: 'muted' }, `Against NNR 2023 reference values for ${nnr.profiles[`${S.settings.sex}_${S.settings.age}`].label}, with your own energy target. Amounts come from the label values you confirmed; vitamins and minerals a label does not list come from the similar food you linked, or count as 0 where there is none. The pantry stock only changes when you mark food as eaten or edit an amount.`),
    nutrientTable(evaluate(avg, tg), { notes }),
    h('p', { class: 'muted', style: 'margin-bottom:0;font-size:.85rem' }, `Not tracked, because the Swedish food database has no values for them: ${NOT_TRACKED}.`)));
}

// ---------- pantry ----------
function viewPantry(root) {
  root.append(h('h2', null, 'Pantry'));
  root.append(h('p', { class: 'muted' }, 'Everything the schedule uses comes from here, and only what you have confirmed: scan a product and check its values against the package, or add a food by name. Amounts go down when you mark scheduled food as eaten; you can also change them by hand.'));
  root.append(scanCard('pantry'));
  root.append(foodAddCard());
  const items = S.pantry;
  const card = h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, `What you have (${items.length})`));
  if (!items.length) card.append(h('p', { class: 'muted' }, 'Nothing yet.'));
  else {
    const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
    card.append(h('div', { class: 'scroll-x' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, 'Item'), h('th', { class: 'num' }, 'Left (g or ml)'), h('th', null, 'Where the numbers come from'), h('th', null, ''))),
      h('tbody', null, sorted.map((it) => {
        const isProd = it.kind === 'product';
        const p = isProd ? S.products[it.ref] : null;
        const pp = isProd && p ? productPer100(p, db) : null;
        const chips = [];
        if (isProd) {
          chips.push(h('span', { class: 'chip plain' }, p && p.source === 'openfoodfacts' ? 'label (Open Food Facts), confirmed' : 'label, entered by you'));
          if (pp && pp.est.length) { const f = db.get(p.micro); chips.push(h('span', { class: 'chip warn', title: 'These values belong to a different product. Treat them as rough.' }, `${pp.est.length} nutrients estimated from ${f ? f.name_sv : 'a linked food'}`)); }
          const un = pp ? pp.unknown.filter((k) => VITMIN.has(k)).length : 0;
          if (un) chips.push(h('span', { class: 'chip bad', title: 'Not on the label and no similar food linked, so counted as 0.' }, `${un} vitamins/minerals unknown`));
        } else chips.push(h('span', { class: 'chip' }, 'Livsmedelsverket'));
        return h('tr', null,
          h('td', null, it.name),
          h('td', { class: 'num' }, h('input', { type: 'number', min: '0', step: '10', value: String(Math.round(it.g)), 'aria-label': `Amount of ${it.name} left`, onchange: (e) => {
            const v = parseFloat(e.target.value);
            if (!(v > 0)) { S.pantry = S.pantry.filter((x) => x !== it); } else it.g = v;
            persist(); render();
          } })),
          h('td', null, h('div', { class: 'chips' }, chips)),
          h('td', null, h('div', { class: 'row' },
            isProd && p ? h('button', { class: 'small', onclick: () => productModal(p, { mode: 'pantry', existing: true }) }, 'Details') : null,
            h('button', { class: 'small', onclick: () => { S.pantry = S.pantry.filter((x) => x !== it); persist(); render(); } }, 'Remove'))));
      })))));
  }
  root.append(card);
}

function foodAddCard() {
  const results = h('div', { class: 'results', hidden: true });
  const pick = h('div', { class: 'row', hidden: true });
  const gram = h('input', { type: 'number', min: '1', step: '10', value: '500', 'aria-label': 'Grams' });
  const search = h('input', { type: 'search', placeholder: 'Search foods, e.g. banan, broccoli, havregryn…', style: 'flex:1;min-width:200px', 'aria-label': 'Search foods', oninput: () => {
    clear(results);
    const res = db.search(search.value, 20);
    results.hidden = !res.length;
    for (const f of res) results.append(h('button', { onclick: () => {
      clear(pick); pick.hidden = false; results.hidden = true; search.value = '';
      pick.append(h('b', null, label(f)), gram, 'g', h('button', { class: 'primary', onclick: () => {
        const g = parseFloat(gram.value);
        if (!(g > 0)) { toast('Enter an amount in grams.'); return; }
        addToPantry(S.pantry, { kind: 'food', ref: f.number, name: f.name_sv || f.name, g }); persist(); render();
        toast(`${f.name_sv || f.name} added to the pantry.`);
      } }, 'I have this'));
    } }, label(f), h('span', { class: 'muted' }, ` · ${fmt(db.nutrients(f, 100).n.energy_kcal)} kcal/100 g`)));
  } });
  return h('div', { class: 'card stack', style: 'margin-top:.6rem' }, h('h3', null, 'Add a food without a barcode'),
    h('p', { class: 'muted', style: 'margin:0' }, 'For fruit, vegetables, loose items. The values come from Livsmedelsverket (raw or as sold). Only add what you actually have.'),
    h('div', { class: 'row' }, search), results, pick);
}

// ---------- food log ----------
function entryNutrition(e) {
  if (e.recipe) { const info = allInfo.get(e.recipe); if (!info) return emptyTotals(); const n = {}; for (const k of Object.keys(info.base.n)) n[k] = info.base.n[k] * e.scale; return n; }
  if (e.product) {
    const p = S.products[e.product];
    if (!p) return emptyTotals();
    const { v } = productPer100(p, db), n = {};
    for (const k of NUTRIENT_KEYS) n[k] = (v[k] * e.g) / 100;
    return n;
  }
  const f = db.get(e.food); return f ? db.nutrients(f, e.g).n : emptyTotals();
}
/** Names of scanned products in `entries` that have no vitamin or mineral data at all (they count as 0). */
function understatedProducts(entries) {
  const names = new Set();
  for (const e of entries) {
    const p = e.product && S.products[e.product];
    if (p && productPer100(p, db).unknown.some((k) => VITMIN.has(k))) names.add(p.name || p.code);
  }
  return [...names];
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
  root.append(scanCard('log'));
  root.append(h('div', { class: 'card stack', style: 'margin-top:.6rem' }, h('h3', null, `Add food to ${fmtDate(logDate)}`), h('div', { class: 'row' }, search), resultsBox, pickBox));
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, 'Eaten this day'),
    entries.length ? h('table', null, h('tbody', null, entries.map((e, i) => {
      const n = entryNutrition(e);
      return h('tr', null, h('td', null, e.name),
        h('td', { class: 'num' }, e.recipe ? `${e.scale.toFixed(1)}× portion` : `${Math.round(e.g)} g`), h('td', { class: 'num' }, `${Math.round(n.energy_kcal)} kcal`),
        h('td', null, h('button', { class: 'small', onclick: () => { entries.splice(i, 1); if (!entries.length) delete S.log[logDate]; persist(); render(); } }, 'Remove')));
    }))) : h('p', { class: 'muted' }, 'Nothing logged for this day yet.')));
  const tg = targets();
  const rows = evaluate(dayTotals(logDate), tg);
  const under = understatedProducts(entries);
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, 'This day against your targets'),
    under.length ? h('div', { class: 'banner warn', style: 'margin-bottom:.6rem' }, `No vitamin or mineral data for ${under.join(', ')} (not on the label, no similar food linked), so those totals are understated.`) : null,
    entries.length ? nutrientTable(rows) : h('p', { class: 'muted' }, 'Add something to see how the day compares.')));
  const days = Array.from({ length: 7 }, (_, i) => store.addDays(logDate, -i)).filter((d) => (S.log[d] || []).length);
  if (days.length) {
    const avg = emptyTotals(); for (const d of days) sumInto(avg, dayTotals(d), 1 / days.length);
    root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, `Average of ${days.length} logged day${days.length === 1 ? '' : 's'} in the last 7`),
      h('p', { class: 'muted' }, 'Only days with something logged count, so skipped days do not drag the average down. Incomplete logging makes the average look lower than your real intake.'),
      nutrientTable(evaluate(avg, tg))));
  }
}

// ---------- barcode scanning ----------
let maxesCache = null;
const maxes = () => maxesCache || (maxesCache = maxPer100(db, NUTRIENT_KEYS));

/** mode: 'pantry' (add what you bought) or 'log' (add what you ate). */
function scanCard(mode) {
  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: '14', placeholder: 'Number under the barcode', 'aria-label': 'Barcode number', style: 'flex:1;min-width:180px',
    onkeydown: (e) => { if (e.key === 'Enter') go(code.value); } });
  const go = (c) => {
    c = c.replace(/\s/g, '');
    if (!validBarcode(c)) { toast('That is not a valid barcode number. Check the digits.'); return; }
    lookupAndShow(c, mode);
  };
  const photo = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true, onchange: async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try { const c = await decodePhoto(file); if (c) lookupAndShow(c, mode); else toast('No barcode found in that photo. Try again closer, or type the number.'); }
    catch { toast('Could not read that photo. Type the number instead.'); }
  } });
  let why = null;
  if (!canUseCamera()) why = !window.isSecureContext ? 'Camera scanning needs an https page. Type the number printed under the barcode, or open the app from its https address.' : 'This browser cannot read barcodes itself (Chrome on Android can). Type the number under the barcode.';
  return h('div', { class: 'card stack', style: 'margin-top:.6rem' },
    h('h3', null, mode === 'pantry' ? 'Scan a product you have' : 'Scan a product you ate'),
    h('p', { class: 'muted', style: 'margin:0' }, 'Looks the barcode up in Open Food Facts, a volunteer-run database. Values are checked and you confirm them against the package before anything is saved. Only the barcode number is sent.'),
    h('div', { class: 'row' },
      canUseCamera() ? h('button', { class: 'primary', onclick: () => cameraModal(mode) }, 'Scan with camera') : null,
      canDecodePhoto() ? h('button', { onclick: () => photo.click() }, 'Scan from photo') : null, photo),
    why ? h('p', { class: 'muted', style: 'margin:0' }, why) : null,
    h('div', { class: 'row' }, code, h('button', { onclick: () => go(code.value) }, 'Look up')));
}

function cameraModal(mode) {
  openModal((close) => {
    const video = h('video', { muted: true, playsinline: true, style: 'width:100%;max-height:60vh;background:#000;border-radius:8px' });
    const status = h('p', { class: 'muted' }, 'Starting the camera…');
    setTimeout(async () => {
      try {
        const stop = await startCamera(video, (c) => { close(); lookupAndShow(c, mode); });
        status.textContent = 'Hold the barcode inside the picture, steady and well lit.';
        const iv = setInterval(() => { if (!video.isConnected) { stop(); clearInterval(iv); } }, 300);
      } catch (e) {
        status.textContent = e && e.name === 'NotAllowedError' ? 'The camera is blocked. Allow it for this site in the browser, or type the number instead.' : 'Could not start the camera. Type the number instead.';
      }
    }, 30);
    return h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('h3', null, 'Scan barcode'), h('button', { onclick: close }, 'Cancel')), video, status);
  });
}

async function lookupAndShow(code, mode) {
  const cached = S.products[code];
  if (cached) { productModal(cached, { mode, note: 'Saved on this device from an earlier scan. Check it is still right.' }); return; }
  toast('Looking up the barcode…');
  const res = await lookupOff(code);
  if (res.status === 'found') { productModal(res.product, { mode }); return; }
  const blank = { code, name: '', brand: '', per100: {}, grams: 100, source: 'you', notes: [] };
  productModal(blank, { mode, note: res.status === 'notfound' ? 'Not found in Open Food Facts. Type the values from the package label (per 100 g). They are saved under this barcode.' : `${res.message} You can type the values from the package label instead.`, bad: true });
}

function productModal(prod, { mode = 'log', note = null, bad = false, existing = false } = {}) {
  const cur = { ...prod, per100: { ...prod.per100 }, notes: [...(prod.notes || [])] };
  let edited = !!prod.edited;
  return openModal((close) => {
    const keys = NUTRIENTS.filter(([k]) => (MACRO_KEYS.includes(k) || cur.per100[k] !== undefined) && k !== 'sodium_mg');
    const name = h('input', { type: 'text', value: cur.name, placeholder: 'Product name', style: 'width:100%' });
    const pack = prod.pack || parsePack(prod.quantity);
    const gram = h('input', { type: 'number', min: '1', step: '1', value: mode === 'pantry' ? (existing ? '' : String(pack || '')) : String(Math.round(cur.grams || 100)), placeholder: 'g or ml',
      'aria-label': mode === 'pantry' ? 'Amount to add to the pantry' : 'Amount eaten' });
    const flags = {};
    const inputs = {};
    const issueBox = h('div');
    const verifyBox = h('input', { type: 'checkbox', onchange: () => refresh() });
    const verifyRow = h('label', { class: 'inline' }, verifyBox, 'I compared these numbers with the package.');
    const addBtn = h('button', { class: 'primary', onclick: () => add() }, mode === 'pantry' ? 'Add to pantry' : 'Add to food log');
    const refresh = () => {
      const issues = checkProduct(cur, maxes());
      clear(issueBox);
      if (issues.length) issueBox.append(h('div', { class: 'banner warn' }, h('b', null, 'Check these before using the product'),
        h('ul', { style: 'margin:.3rem 0 0;padding-left:1.1rem' }, issues.map((i) => h('li', null, i.key ? `${nname(i.key)}: ` : '', i.text)))));
      for (const k of keys.map((x) => x[0])) flags[k].textContent = issues.some((i) => i.key === k) ? '⚠' : '';
      verifyRow.hidden = !issues.length;
      if (!issues.length) verifyBox.checked = false;
      const blocked = (issues.length && !verifyBox.checked) || cur.per100.energy_kcal === undefined;
      addBtn.disabled = !!blocked; if (saveBtn) saveBtn.disabled = !!blocked;
      addBtn.title = blocked ? (cur.per100.energy_kcal === undefined ? 'Energy is needed.' : 'Tick the box once you have checked the numbers.') : '';
      refreshMicro();
    };
    const rows = keys.map(([k, lab, unit]) => {
      inputs[k] = h('input', { type: 'number', step: 'any', min: '0', value: cur.per100[k] ?? '', 'aria-label': `${lab} per 100 g`, placeholder: 'not listed', onchange: (e) => {
        edited = true; cur.kj = null; cur.salt_raw = null; cur.sodium_raw = null; cur.notes = [];
        if (e.target.value === '') delete cur.per100[k]; else cur.per100[k] = Math.max(0, parseFloat(e.target.value));
        refresh();
      } });
      flags[k] = h('span', { class: 'status low', title: 'See the notes above' });
      return h('tr', null, h('td', null, lab), h('td', { class: 'num' }, inputs[k]), h('td', null, unit), h('td', null, flags[k]));
    });

    // vitamins and minerals the label does not list: estimate them from a similar generic food, if the user agrees
    const m = cur.name ? matcher.match(cur.name) : null;
    const generic = m && m.match && m.match.confidence !== 'none' ? m.match : null;
    const opts = generic ? [generic, ...m.candidates.slice(0, 4)].filter((o, i, a) => a.findIndex((x) => x.number === o.number) === i) : [];
    if (cur.micro === undefined) cur.micro = generic && (generic.confidence === 'high' || generic.confidence === 'medium') ? generic.number : null;
    const microSel = h('select', { 'aria-label': 'Similar food for vitamins and minerals', onchange: (e) => { cur.micro = e.target.value ? Number(e.target.value) : null; refresh(); } });
    const microNote = h('p', { class: 'muted', style: 'margin:0;font-size:.85rem' });
    const microResults = h('div', { class: 'results', hidden: true });
    const fillSel = () => {
      clear(microSel);
      microSel.append(h('option', { value: '' }, 'None: vitamins and minerals not on the label count as 0'));
      const list = [...opts];
      if (cur.micro != null && !list.some((o) => o.number === cur.micro)) { const f = db.get(cur.micro); if (f) list.push(f); }
      for (const o of list) microSel.append(h('option', { value: String(o.number), selected: o.number === cur.micro }, `${o.name_sv || o.name}`));
    };
    const microSearch = h('input', { type: 'search', placeholder: 'Search another food…', 'aria-label': 'Search a similar food', style: 'width:100%', oninput: () => {
      clear(microResults);
      const res = db.search(microSearch.value, 12);
      microResults.hidden = !res.length;
      for (const f of res) microResults.append(h('button', { onclick: () => { cur.micro = f.number; microSearch.value = ''; microResults.hidden = true; fillSel(); refresh(); } }, label(f)));
    } });
    function refreshMicro() {
      const pp = productPer100(cur, db);
      const f = cur.micro != null ? db.get(cur.micro) : null;
      const un = pp.unknown.filter((k) => VITMIN.has(k)).length;
      microNote.textContent = f
        ? `${pp.est.length} values the label lacks are taken from “${f.name_sv || f.name}”. That is a different product, so treat them as rough; the label values above always win.${un ? ` ${un} vitamins/minerals have no value there either and count as 0.` : ''}`
        : `${un} vitamins and minerals are not on the label and count as 0, so this product will look poorer in them than it is.`;
    }
    fillSel();

    const build = (g) => ({ code: cur.code, name: name.value.trim() || `Product ${cur.code}`, brand: cur.brand, quantity: cur.quantity, pack: cur.pack || pack || null, per100: cur.per100,
      source: edited || prod.source === 'you' ? 'you' : 'openfoodfacts', edited, from: prod.source, micro: cur.micro ?? null, g });
    const add = () => {
      const g = parseFloat(gram.value);
      if (!(g > 0)) { toast(mode === 'pantry' ? 'Enter how much you have (g or ml).' : 'Enter the amount you ate.'); return; }
      const saved = build(g);
      S.products[cur.code] = saved;
      if (mode === 'pantry') addToPantry(S.pantry, { kind: 'product', ref: cur.code, name: saved.name, g });
      else (S.log[logDate] = S.log[logDate] || []).push({ product: cur.code, g, name: saved.name });
      persist(); close(); render();
      toast(mode === 'pantry' ? 'Added to the pantry.' : 'Added to the log.');
    };
    const saveBtn = mode === 'pantry' ? h('button', { onclick: () => {
      S.products[cur.code] = build(null);
      const it = S.pantry.find((x) => x.kind === 'product' && x.ref === cur.code); if (it) it.name = name.value.trim() || it.name;
      persist(); close(); render(); toast('Saved.');
    } }, existing ? 'Save changes' : 'Save product only') : null;
    const srcText = prod.source === 'openfoodfacts' ? 'Source: Open Food Facts (volunteer-entered, not verified by this app).' : 'Entered by you.';
    const body = h('div', { class: 'stack' },
      h('div', { class: 'row between' }, h('h3', null, 'Product'), h('button', { onclick: close }, 'Close')),
      note ? h('div', { class: `banner ${bad ? 'warn' : ''}` }, note) : null,
      h('label', null, `Name${cur.brand ? ` (${cur.brand})` : ''}${cur.quantity ? `, ${cur.quantity}` : ''}`, name),
      h('p', { class: 'muted', style: 'margin:0' }, `Barcode ${cur.code}. ${srcText} Values per 100 g (or 100 ml; 1 ml counts as 1 g).`),
      issueBox,
      h('div', { class: 'scroll-x' }, h('table', null, h('thead', null, h('tr', null, h('th', null, 'Nutrient'), h('th', { class: 'num' }, 'Per 100 g'), h('th', null, 'Unit'), h('th', null, ''))), h('tbody', null, rows))),
      labelScanner({ getPer100: () => cur.per100, apply: (k, v) => {
        edited = true; cur.kj = null; cur.salt_raw = null; cur.sodium_raw = null; cur.notes = [];
        cur.per100[k] = v; inputs[k].value = v; refresh();
      } }),
      h('div', { class: 'card stack' }, h('b', null, 'Vitamins and minerals'),
        h('p', { class: 'muted', style: 'margin:0' }, 'Labels rarely list them, but you need them counted. Pick a similar generic food to estimate what the label lacks, or none.'),
        microSel, microSearch, microResults, microNote),
      verifyRow,
      h('label', null, mode === 'pantry' ? (existing ? 'Amount to add to the pantry (g or ml), leave empty to change nothing' : `Amount you have (g or ml)${pack ? `, package size ${pack}` : ''}`) : 'Amount eaten (g or ml)', gram),
      h('div', { class: 'row' }, addBtn, saveBtn,
        mode === 'log' && generic ? h('button', { onclick: () => {
          const g = parseFloat(gram.value);
          if (!(g > 0)) { toast('Enter the amount you ate.'); return; }
          const f = db.get(generic.number);
          (S.log[logDate] = S.log[logDate] || []).push({ food: f.number, g, name: label(f) }); persist(); close(); render();
        } }, `Log as ${generic.name_sv || generic.name} (Livsmedelsverket) instead`) : null));
    setTimeout(refresh, 0);
    return body;
  });
}

// ---------- offers ----------
function viewOffers(root) {
  root.append(h('h2', null, 'This week’s offers'));
  root.append(h('div', { class: 'card stack' },
    h('p', null, 'Copy the offers from your Lidl app or from lidl.se and paste them below, one product per line (for example “Kycklingfilé 900 g 89,90” or “Bananer 14,90 kr/kg”), or paste whole offer tiles. They only change the prices used in the suggested shopping; they never change what counts as food you have. Lidl does not offer an official way to connect an app to your account, so this app does not log in to Lidl: you paste, it matches.'),
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
    root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', null, 'Offers used for prices in the suggestions'),
      h('table', null, h('tbody', null, S.offers.map((o, i) => h('tr', null,
        h('td', null, ingMeta[o.id] ? ingMeta[o.id].name_sv : o.id, h('div', { class: 'muted', style: 'font-size:.8rem' }, o.label)),
        h('td', { class: 'num' }, `${o.sek_per_kg.toFixed(2)} SEK/kg`),
        h('td', null, h('button', { class: 'small', onclick: () => { S.offers.splice(i, 1); persist(); render(); } }, 'Remove')))))),
      h('div', { class: 'row', style: 'margin-top:.6rem' }, h('a', { class: 'btn', href: '#schedule' }, 'See the schedule'))));
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
      h('p', { class: 'muted' }, 'Only the 138 foods the shopping suggestions can pick from take a price (marked “can be suggested”). Low-confidence matches are guesses: check them or pick another food.'),
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
              ' ', curated ? h('span', { class: 'chip' }, 'can be suggested') : f ? h('span', { class: 'chip plain' }, 'not in the suggestion list') : null,
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
      for (const f of db.search(input.value, 25)) out.append(h('button', { onclick: () => { row.options = [{ number: f.number, curated_id: f.curated_id, name_sv: f.name_sv, name: f.name }, ...row.options.filter((o) => o.number !== f.number)]; row.ref = f.curated_id || String(f.number); row.use = !!(f.curated_id && row.sek_per_kg); close(); done(); } }, label(f), f.curated_id ? '  ✓ can be suggested' : ''));
    } });
    setTimeout(() => input.focus(), 30);
    return h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('h3', null, `Food for “${row.name}”`), h('button', { onclick: close }, 'Close')), input, out);
  });
}

// ---------- settings ----------
function viewSettings(root) {
  const st = S.settings;
  const save = (patch) => { Object.assign(st, patch); S.onboarded = true; persist(); render(); };
  root.append(h('h2', null, 'Settings'));
  root.append(h('div', { class: 'card stack' }, h('h3', null, 'You'),
    h('div', { class: 'field-grid' },
      h('label', null, 'Sex (for reference values)', h('select', { onchange: (e) => save({ sex: e.target.value }) }, [['f', 'Woman'], ['m', 'Man']].map(([v, t]) => h('option', { value: v, selected: st.sex === v }, t)))),
      h('label', null, 'Age group', h('select', { onchange: (e) => save({ age: e.target.value }) }, [['18_24', '18-24'], ['25_50', '25-50'], ['51_70', '51-70']].map(([v, t]) => h('option', { value: v, selected: st.age === v }, t)))),
      h('label', null, 'Energy target (kcal per day)', h('input', { type: 'number', min: '1200', max: '4500', step: '50', value: st.kcal, onchange: (e) => save({ kcal: Math.min(4500, Math.max(1200, parseInt(e.target.value, 10) || 2000)) }) }))),
    h('p', { class: 'muted' }, 'The energy target is yours to set; this app does not estimate it. NNR 2023 gives group averages (for example about 8-9 MJ per day, 1,900-2,250 kcal, for a woman aged 25-50 with low to medium activity). Reference values come from the Nordic Nutrition Recommendations 2023 and apply to healthy adults. Thiamin and niacin scale with your energy target; the others are fixed per age group and sex.')));
  root.append(h('div', { class: 'card stack', style: 'margin-top:1rem' }, h('h3', null, 'Food preferences (for the shopping suggestions)'),
    h('div', { class: 'field-grid' },
      h('label', null, 'Diet', h('select', { onchange: (e) => save({ diet: e.target.value }) }, [['omnivore', 'Everything'], ['pescatarian', 'Pescatarian (fish, no meat)'], ['vegetarian', 'Vegetarian'], ['vegan', 'Vegan']].map(([v, t]) => h('option', { value: v, selected: st.diet === v }, t))))),
    ingredientPicker('Never suggest (dislikes, allergies)', 'dislikes', save),
    h('p', { class: 'muted' }, 'This only filters what the app suggests buying. The schedule uses whatever is in your pantry. Allergies: the app does not check for hidden allergens, so always read labels.')));
  root.append(h('div', { class: 'card stack', style: 'margin-top:1rem' }, h('h3', null, 'What is counted'),
    h('p', { class: 'muted', style: 'margin:0' }, `Tracked against NNR 2023: energy, protein, fat, saturated fat, carbohydrate, fibre, salt and sodium, and vitamins A, D, E, C, B1, B2, B3 (niacin), B6, B12 and folate, and the minerals calcium, iron, zinc, magnesium, potassium, phosphorus, selenium and iodine. Not tracked, because the Swedish food database has no values for them: ${NOT_TRACKED}. Free sugar is not tracked (the database and most labels give total sugars).`)));
  root.append(priceEditor());
  root.append(h('div', { class: 'card stack', style: 'margin-top:1rem' }, h('h3', null, 'Your data'),
    h('p', { class: 'muted' }, 'Everything (settings, pantry, scanned products, offers, food log) is stored only in this browser. Clearing site data deletes it. Export a backup now and then.'),
    h('div', { class: 'row' },
      h('button', { onclick: () => {
        const url = URL.createObjectURL(new Blob([store.exportJSON(S)], { type: 'application/json' }));
        const a = h('a', { href: url, download: `eat-better-backup-${store.todayISO()}.json` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      } }, 'Export backup'),
      h('label', { class: 'btn', style: 'display:inline-block;cursor:pointer' }, 'Import backup', h('input', { type: 'file', accept: 'application/json', style: 'display:none', onchange: async (e) => {
        const file = e.target.files[0]; if (!file) return;
        try { S = store.importJSON(await file.text()); persist(); render(); toast('Backup imported.'); } catch (err) { toast(err.message); }
      } })),
      h('button', { onclick: () => { if (confirm('Delete all your settings, pantry, scanned products, offers and food log from this browser?')) { S = structuredClone(store.DEFAULTS); persist(); offerDraft = null; render(); toast('Everything cleared.'); } } }, 'Delete all my data'))));
}
function ingredientPicker(title, field, save) {
  const st = S.settings;
  const byCat = new Map();
  for (const [id, m] of Object.entries(ingMeta)) { if (!byCat.has(m.category)) byCat.set(m.category, []); byCat.get(m.category).push([id, m]); }
  const sel = h('select', { 'aria-label': title, onchange: (e) => { const v = e.target.value; if (v && !st[field].includes(v)) save({ [field]: [...st[field], v] }); } },
    h('option', { value: '' }, 'Add an ingredient…'),
    [...byCat].map(([cat, items]) => h('optgroup', { label: CATEGORY_LABEL[cat] || cat }, items.sort((a, b) => a[1].name_sv.localeCompare(b[1].name_sv, 'sv')).map(([id, m]) => h('option', { value: id }, `${m.name_sv} (${m.name})`)))));
  return h('div', null, h('div', { style: 'font-size:.9rem;color:var(--muted)' }, title), sel,
    h('div', { class: 'chips' }, st[field].map((id) => h('span', { class: 'chip' }, ingMeta[id] ? ingMeta[id].name_sv : id, h('button', { 'aria-label': `Remove ${id}`, onclick: () => save({ [field]: st[field].filter((x) => x !== id) }) }, '×')))));
}
function priceEditor() {
  const rows = Object.entries(ingMeta).sort((a, b) => a[1].name_sv.localeCompare(b[1].name_sv, 'sv'));
  return h('details', { class: 'card', style: 'margin-top:1rem' }, h('summary', null, h('b', null, 'Ingredient prices (SEK per kg), used for the shopping suggestions')),
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
