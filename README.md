# Eat Better

A web app that schedules the food you actually have for the next 7 days, tells you when each nutrient will run out, and suggests what to buy (at Lidl, in Stockholm). Nutrition comes first: energy, macronutrients, and the vitamins and minerals in the Nordic Nutrition Recommendations 2023.

Nutrient values come from Livsmedelsverket (Swedish Food Agency) and from the product labels you confirm. Targets come from NNR 2023. Your data stays in your browser.

## Run it

Needs Python 3 (any recent version). From this folder:

```bash
python tools/serve.py
```

Then open http://localhost:8765. Opening `web/index.html` by double-click will not work, because the app loads its data with `fetch`; the page says so if you try. `serve.py` turns browser caching off so you never get an old copy of the scripts. If the page ever stays on "Loading", press Ctrl+F5.

## How it works

The one rule: **only food you have confirmed counts.** The schedule is built from your pantry and nothing else. What the app suggests buying is never counted until you buy it, scan it (or add it by name) and confirm it.

| Tab | What |
|---|---|
| Schedule | Eats your pantry over the next 7 days. For every day it picks amounts (in grams) of the foods you have; there are no recipes. It shows when the food runs out, **which nutrients run out and on which day**, any limit you would exceed (salt, saturated fat), a list of suggested purchases with the reason and a "needed by" date, every day's nutrients, and the weekly average against your targets. "Mark as eaten" logs the day and takes it out of the pantry. |
| Pantry | What you have. Scan a product's barcode (Chrome on Android) or type the number; the values are looked up in Open Food Facts, checked, and you confirm them against the package. Photograph the nutrition label to compare it with the recorded values. Foods without a barcode (fruit, vegetables) are added by name from Livsmedelsverket. |
| Food log | What you ate, compared with your targets for the day and the last 7 days. |
| Offers | Paste offers from your Lidl app or lidl.se. They only change the prices used in the shopping suggestions. |
| Settings | Sex and age group, energy target, diet and dislikes (for the suggestions only), your own prices, backup and restore. |

### Which nutrients are counted

Energy, protein, fat, saturated fat, carbohydrate, fibre, salt and sodium, vitamins A, D, E, C, B1 (thiamin), B2 (riboflavin), B3 (niacin), B6, B12 and folate, and the minerals calcium, iron, zinc, magnesium, potassium, phosphorus, selenium and iodine.

NNR 2023 also has reference values for vitamin K, pantothenic acid, biotin, choline, copper, fluoride, manganese and molybdenum. The Swedish food database has no values for those, so they **cannot be counted** and the app says so. Free sugar is not tracked either (the database and most labels give total sugars).

### Vitamins and minerals on packaged products

EU law only requires energy, fat, saturated fat, carbohydrate, sugars, protein and salt on a label. Vitamins and minerals appear only when the maker chooses to list them, so most products show none. To still count them, a scanned product can be linked to a similar generic food (the app suggests one from the name; you can change it or choose none). The label values always win; only what the label lacks is filled in from the linked food, and every such number is marked as an estimate, in the pantry and in the nutrient tables. Without a link, what is missing counts as 0 and the app says so.

### How the schedule is made

For each day the scheduler adds small amounts of foods from the pantry, always choosing the one that most improves the day per kcal: more of a missing nutrient, less of anything over a limit, energy up to your target. A food is limited to what is left, to an even share of the stock over the days (so the iron-rich food is not eaten on day one), to at most 35% of the day's energy and 500 g. If the pantry holds fewer than 7 days of energy, full days are scheduled until it is gone and the later days are empty.

"Pantry covers N days" for a nutrient is the total in the pantry divided by your daily reference value. That, not the schedule, is the "runs out" date: it is the day you could no longer reach the full value from what you have.

### Shopping suggestions

For the nutrients (and energy) that fall short over the week, the app picks the foods that close the most of the gap per krona (price counts for little; health comes first), at most 9 foods, at most 35% of the week's energy from one food, with a discount for a second food from the same group. Candidates are the 138 curated foods; your diet and dislikes filter them. Prices are mostly estimates; saved offers and your own prices override them.

## Using it on the phone (https)

Phone browsers only allow the camera on https pages, so the app is published as a static site with GitHub Pages. It has no server part: your pantry, log and settings stay in the phone's browser, and the published site holds only the app code and the Livsmedelsverket data. `.github/workflows/pages.yml` publishes the `web/` folder on every push to `main`.

One-time setup: create an empty **public** GitHub repository (free accounts need public for Pages), then from this folder:

```bash
git init -b main
git add .
git commit -m "Eat Better"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

In the repository settings, under Pages, set Source to "GitHub Actions". The address will be `https://<you>.github.io/<repo>/`. The PC and the phone keep separate data; use Settings, Export backup and Import backup to move it.

## Project layout

```
web/                 the app (static files, no build step)
  index.html  css/app.css
  js/app.js          views and wiring (Schedule, Pantry, Food log, Offers, Settings)
  js/pantry.js       the pantry: per-100 g values of an item (label first, estimates marked), package sizes
  js/schedule.js     the 7-day scheduler and the "runs out" analysis
  js/suggest.js      shopping suggestions
  js/nutrition.js    nutrient list, NNR targets, food search
  js/matcher.js      Swedish product name -> food (also used to propose the similar food for a product)
  js/offers.js       reads pasted offer text
  js/product.js      barcode look-up (Open Food Facts), unit conversion, sanity checks, camera scan
  js/label.js        nutrition-label OCR, number repair and comparison with the recorded values
  js/labelui.js      the "Scan nutrition label" block and compare table
  vendor/tesseract/  bundled OCR engine and Swedish/English models (17 MB, loaded only when used; see its README.txt)
  js/store.js        saving to the browser
  data/              generated JSON (foods, targets, prices); recipes.json is only read for old food-log entries
data/                source datasets and how they are built (see data/README.md)
tools/               build and test scripts
docs/data-sources.md why these data sources, and what was found about Lidl
archive/             Open Food Facts work, evaluated and rejected, kept for reference
```

`web/js/planner.js`, `web/data/recipes.json` and `tools/test_planner.mjs` belong to the earlier recipe-based version of the app. The app no longer uses them (old food-log entries from that version can still be shown).

## Rebuilding the data

```bash
python tools/build_dataset.py --all     # fetch Livsmedelsverket foods (first run, a few minutes; cached in data/raw)
python tools/build_web_data.py          # write web/data/*.json
```

## Tests

```bash
node tools/test_schedule.mjs                                    # pantry, scheduler, run-out analysis, shopping suggestions
node tools/test_product.mjs                                     # barcode check digits, Open Food Facts conversion, sanity checks
node tools/test_label.mjs                                       # label text parsing and repair (OCR itself is tested in the browser)
python tools/eval_matching.py                                   # matcher accuracy on test names
python tools/dump_py_matches.py > matches.json && node tools/check_js_matcher.mjs matches.json   # JS matcher == Python matcher
```

## Honest limits

- **Only what you tell it counts.** If the pantry is out of date (you ate something without marking it, or forgot to add a purchase) the schedule and the "runs out" dates are wrong. Stock only changes when you mark food as eaten or edit an amount.
- **It uses everything you have.** The scheduler does not skip crisps or sweets in the pantry when there is enough healthier food; it spreads the stock over the days and picks by nutrients. Keep out of the pantry what you do not want scheduled.
- **No cooking, no shelf life, no taste.** It schedules amounts of ingredients, not meals. It does not know that fresh fish should be eaten first, and does not model cooking losses (raw and dry values are used where the database has them).
- **Estimated vitamins and minerals are rough.** A snack linked to "potato crisps" gets crisps' values. Check the link, and trust the label values over the estimate.
- **Eight reference values cannot be counted** (vitamin K, pantothenic acid, biotin, choline, copper, fluoride, manganese, molybdenum) because the Swedish food database has no values for them. A diet can look complete here and still lack those.
- **Targets are population reference values** for healthy adults (NNR 2023), not personal or medical advice. The energy target is yours to set. Upper limits for vitamins and minerals are not modelled beyond a soft penalty for amounts far above the reference value; the scheduler does not know about supplements.
- **Some targets are hard to reach** on some diets (vitamin D, B12 and iodine on a vegan diet, for example). The app shows the gap instead of hiding it.
- **Prices are mostly estimates.** Lidl publishes no price list. The starting prices are rough guesses, with three regular prices seen on lidl.se on 2026-11-16. Enter your real prices in Settings.
- **Offer matching is imperfect.** On 42 real Lidl offer names the first run was 38% correct; after fixes tuned on those names 62%, none confidently wrong. The app asks you to confirm anything uncertain.
- **Allergies:** the suggestions only exclude foods you list. The app does not check for hidden allergens. Read labels.
- **Scanned products come from Open Food Facts**, which volunteers fill in and which can contain mistakes. The app checks the numbers and makes you confirm anything suspicious, but a wrong value that looks plausible gets through, so compare with the package when it matters. Not every Lidl product is in the database; then you type the label values once. The camera scan itself was not tested on a real phone here (the build environment has no camera); the lookup, checks and logging were.
- **Label reading is imperfect.** The scan never settles a doubt silently: a row it could not read is marked "not read", a number it could not settle is marked "unsure" (with the other readings it could have been), a repaired number is marked "repaired", and lines with an amount that match no tracked nutrient are listed. None of these is applied unless you choose it. Rows are matched in Swedish, Finnish, Danish, English, German and Norwegian, including the three-language rows on Nordic packs. When a label has a per 100 g and a per portion column, only the per 100 g column is used; a row whose per 100 g amount was not read is reported as not found. Measured on 16 synthetic Swedish/Finnish/Danish labels (random values, one and two columns, wrapped rows, six fonts, blur; 128 numbers): 119 correct (28 of them flagged), 9 wrong but flagged, none wrong without a flag, none missing. The images were synthetic, and the rules were adjusted after seeing the failures of the first run on the same set, so real photos of curved, glossy packaging will do worse. It was not tested on a real phone photo. Vitamins and minerals are not read from labels. Comparing with the recorded values uses the label's own rounding (0.1 g, salt 0.05 g, energy 3 kcal or 3 %).
- **Single user, one browser.** No accounts and no sync. Use Export backup in Settings.

## Credits and licences

- Food composition data: Livsmedelsverket, Livsmedelsdatabasen, CC BY 4.0. The app credits the source in its footer.
- Nutrient reference values: Nordic Nutrition Recommendations 2023, as summarised by Livsmedelsverket (tables read from the PDF, see `data/nnr2023.json`).
- Product data: Open Food Facts (ODbL), looked up one barcode at a time.
- Code: written for this project.
