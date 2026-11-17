# Eat Better

A web app that plans a week of simple meals (30 minutes or less) around what is on offer at Lidl in Stockholm, and tracks nutrition first, budget second.

Nutrient values come from Livsmedelsverket (Swedish Food Agency). Targets come from the Nordic Nutrition Recommendations 2023. Your data stays in your browser.

## Run it

Needs Python 3 (any recent version). From this folder:

```bash
python tools/serve.py
```

Then open http://localhost:8765. Opening `web/index.html` by double-click will not work, because the app loads its data with `fetch`; the page says so if you try. `serve.py` turns browser caching off so you never get an old copy of the scripts. If the page ever stays on "Loading", press Ctrl+F5.

## What it does

| Tab | What |
|---|---|
| Plan | Picks breakfast, lunch and dinner for 7 days, scales each portion to your energy target, shows cost against your budget and every nutrient against NNR 2023. Swap any meal, view recipes, log meals as eaten. |
| Shopping list | Totals for the week by food group, with an estimated cost. Tick what you already have. |
| Offers | Paste offers from your Lidl app or lidl.se. They are read, matched to foods (you confirm uncertain matches) and used as prices in the next plan. |
| Food log | Log what you eat (all 2,606 foods, or meals from your plan) and compare each day and the last 7 days with your targets. |
| Food log, scanning | "Scan a product" reads a barcode with the phone camera (Chrome on Android) or from a photo, or you type the number. The product is looked up in Open Food Facts, checked (energy against macros, saturated fat against fat, kJ against kcal, values higher than any Livsmedelsverket food, and so on) and shown for you to confirm or correct against the package. It is then logged with its own label values and saved on the device under that barcode. Only the barcode number is sent. "Scan nutrition label" (in the product window) photographs the package's nutrition table, reads it on the device (OCR, nothing uploaded) and shows each value next to the recorded one; for every row you choose to keep the recorded value or use the label's. Works in any browser with a camera or photo picker, including iPhone. |
| Settings | Sex and age group, energy target, weekly budget, diet (everything, pescatarian, vegetarian, vegan), foods to avoid or prefer, your own prices, backup and restore. |

The planner searches for the set of recipes that best covers the nutrient targets (weekly average), stays within budget, and avoids repeats. It cannot connect to your Lidl account: Lidl has no public API and its app terms do not allow others to access your account. See `docs/data-sources.md`.

## Using it on the phone (https)

Phone browsers only allow the camera on https pages, so the app is published as a static site with GitHub Pages. It has no server part: your plan, log and settings stay in the phone's browser, and the published site holds only the app code and the Livsmedelsverket data. `.github/workflows/pages.yml` publishes the `web/` folder on every push to `main`.

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
  js/app.js          views and wiring
  js/planner.js      meal planner (search + scoring)
  js/nutrition.js    nutrient maths, NNR targets, food search
  js/matcher.js      Swedish product name -> food (port of tools/match_foods.py)
  js/offers.js       reads pasted offer text
  js/product.js      barcode look-up (Open Food Facts), unit conversion, sanity checks, camera scan
  js/label.js        nutrition-label OCR, number repair and comparison with the recorded values
  js/labelui.js      the "Scan nutrition label" block and compare table
  vendor/tesseract/  bundled OCR engine and Swedish/English models (17 MB, loaded only when used; see its README.txt)
  js/store.js        saving to the browser
  data/              generated JSON + recipes.json (hand-written)
data/                source datasets and how they are built (see data/README.md)
tools/               build and test scripts
tests/               matching test cases, real offer names
docs/data-sources.md why these data sources, and what was found about Lidl
archive/             Open Food Facts work, evaluated and rejected, kept for reference
```

## Rebuilding the data

```bash
python tools/build_dataset.py --all     # fetch Livsmedelsverket foods (first run, a few minutes)
python tools/build_web_data.py          # write web/data/*.json and validate recipes
```

Add or edit recipes in `web/data/recipes.json` (ingredient ids come from `data/curated_ingredients.csv`; amounts are raw or dry grams per portion), then run `build_web_data.py`, which checks ingredients, cooking time and calories.

## Tests

```bash
python tools/eval_matching.py                                   # matcher accuracy on test names
python tools/dump_py_matches.py > matches.json && node tools/check_js_matcher.mjs matches.json   # JS matcher == Python matcher
node tools/test_planner.mjs 700 omnivore f 2000                 # planner: budget, diet, sex, kcal
node tools/test_product.mjs                                     # barcode check digits, Open Food Facts conversion, sanity checks
node tools/test_label.mjs                                       # label text parsing and repair (OCR itself is tested in the browser)
```

## Honest limits

- **Prices are mostly estimates.** Lidl publishes no price list. The starting prices are rough guesses, with three regular prices seen on lidl.se on 2026-11-16. Enter your real prices in Settings. Costs are by weight; real packs are bigger.
- **Offer matching is imperfect.** On 42 real Lidl offer names the first run was 38% correct. After fixes tuned on those names it was 62%, none confidently wrong. The app asks you to confirm anything uncertain and only offers on foods used by recipes affect the plan.
- **39 recipes.** Written for this app, using 138 curated ingredients. Other foods can be logged but are not planned.
- **Nutrition is from raw and dry weights.** Cooking losses (for example some vitamin C) are not modelled.
- **Targets are population reference values** for healthy adults (NNR 2023), not personal or medical advice. The energy target is yours to set. Free sugar is not tracked (the database has total sugars only).
- **Some targets are hard to reach** on some diets (vitamin D, B12 and iodine on a vegan plan, for example). The app shows the gap and says so instead of hiding it.
- **The plan optimises the weekly average**, not every single day.
- **Allergies:** the planner only excludes ingredients you list. It does not check for hidden allergens. Read labels.
- **Scanned products come from Open Food Facts**, which volunteers fill in and which can contain mistakes. The app checks the numbers and makes you confirm anything suspicious, but a wrong value that looks plausible gets through, so compare with the package when it matters. Most labels list no vitamins or minerals, so those count as 0 for scanned products and the app says so. Not every Lidl product is in the database; then you type the label values once. The camera scan itself was not tested on a real phone here (the build environment has no camera); the lookup, checks and logging were.
- **Label reading is imperfect.** OCR drops decimal commas ("14,1 g" becomes "141g") and reads "g" as "9". The parser uses the label's own arithmetic (energy must equal 4 x protein + 4 x carbohydrate + 9 x fat, saturated fat cannot exceed fat) and two reading passes to repair these, and it marks every repaired or doubtful number ("repaired", "check"). Nothing is applied until you choose it. Rows are matched in Swedish, Finnish, Danish, English, German and Norwegian, including the three-language rows on Nordic packs. When a label has a per 100 g and a per portion column, the numbers are grouped by their position on the photo and only the per 100 g column is used (the one under "100 g", otherwise the leftmost); a row whose per 100 g amount was not read is reported as not found instead of taking the portion amount. Measured on 16 synthetic Swedish/Finnish/Danish labels (random values, one and two columns, wrapped rows, six fonts, blur; 128 numbers): 119 correct (28 of them flagged), 9 wrong but flagged, none wrong without a flag, none missing. The images were synthetic, and the rules were adjusted after seeing the failures of the first run on the same set, so real photos of curved, glossy packaging will do worse. It was not tested on a real phone photo. Vitamins and minerals are not read. Comparing with the recorded values uses the label's own rounding (0.1 g, salt 0.05 g, energy 3 kcal or 3 %), so 0.13 g of salt against 0.03 g is shown as different.
- **Single user, one browser.** No accounts and no sync. Use Export backup in Settings.

## Credits and licences

- Food composition data: Livsmedelsverket, Livsmedelsdatabasen, CC BY 4.0. The app credits the source in its footer.
- Nutrient reference values: Nordic Nutrition Recommendations 2023, as summarised by Livsmedelsverket (tables read from the PDF, see `data/nnr2023.json`).
- Recipes and code: written for this project.
