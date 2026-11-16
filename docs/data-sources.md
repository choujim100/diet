# Nutrition data sources (verified 2026-11-16)

Goal: credible per-ingredient nutrition data for what is bought at Lidl in Stockholm.

## DECISION (2026-11-16): Livsmedelsverket only

Open Food Facts is **not used**. Reasons, all verified against live records:
- Crowd-sourced with real entry errors. Example: a Lidl energy drink label says vitamin B12 is 2.0 µg per 100 ml, but the record says 2 g. 7 of about 2,900 entered values fail basic physical limits.
- The bulk export mixes ingredient-based estimates into the label columns, and many are wildly wrong.
- Real micronutrient data for Lidl Sweden is almost absent (iron for 2 of 419 products, B12 for 6).

Everything below that mentions Open Food Facts is the evidence behind this decision, not the current plan. The Open Food Facts code and data are archived in `archive/open-food-facts/`.

## Recommended stack

| Role | Source | Why | Status |
|---|---|---|---|
| **Primary (generic ingredients)** | [Livsmedelsverket Livsmedelsdatabasen](https://www.livsmedelsverket.se/en/about-us/open-data/food-composition-data/) | Official Swedish government database (EuroFIR-based). Reflects the Swedish food supply. 2,606 entries, 50+ nutrients each, with value type (analysed vs calculated), method and source per value. | **Tested live.** Free REST API, no key. CC BY (credit the Swedish Food Agency). |
| **Secondary (Lidl branded products)** | [Open Food Facts](https://world.openfoodfacts.org/) | Barcode lookup of the exact Lidl product, using label values. Lidl private-label items exist (e.g. Lidl Svenska köttbullar, svensk lättfil). | API works for single barcodes. Search endpoint returned "temporarily unavailable" during the test. Crowd-sourced, so quality varies. ODbL (share-alike if redistributing the data). |
| **Gap filler (not yet tested)** | USDA FoodData Central, Frida (DTU, Denmark) | For ingredients missing from the Swedish DB. | Not tested yet. |

**Rule for the app:** use Livsmedelsverket for every ingredient and show the source on every value. Open Food Facts is not used (see the decision above).

## Open Food Facts coverage of Lidl Sweden (measured 2026-11-16)

Method: streamed the 1.5 GB nightly CSV export (4.9M products worldwide, modified 2026-11-15) and kept rows tagged `en:sweden`. That left 28,855 rows. A row counts as Lidl if its brand or store field mentions "lidl" (store tags were empty everywhere, so I used brand tags, including Lidl's own labels such as Culinea, Milbona, Chef Select, Vemondo, Angens, Matriket).

- **419 Lidl products** found for Sweden. Most were edited in the last 12 months (395 of 419).
- **CORRECTION (verified 2026-11-16 against live records):** the bulk export mixes OFF's ingredient-based *estimates* into the same `_100g` columns as label values. Figures below are for values actually entered from the label.
- **Label basics:** about 91-92% have energy, fat, saturated fat, carbs, sugars, protein and salt entered. 357 of 419 have all seven. 46 of 2,708 export values for these seven were estimates only.
- **Micronutrients are essentially absent:** fibre 156 products, vitamin D 28, calcium 26, B12 6, potassium 5, iron 2, magnesium 1, zinc 1, vitamin C 1. About 95% of the micronutrient values in the export were estimates, many of them wildly wrong (e.g. vitamin D of 2.7 g per 100 ml in an ice cream).
- **Real entry errors found in entered values:** 7 of about 2,900 entered values fail basic physical limits (e.g. salt 98 g and 110 g per 100 g, iron 112 mg per 100 ml of milk, vitamin D 0.95 g in a yoghurt). One was checked against the label photo: a Lidl energy drink lists vitamin B12 as 2.0 µg per 100 ml, but OFF has 2 g. Entered macros were internally consistent (energy matches macros) in all products that have the four values.
- **Skewed to packaged and prepared food:** top categories are meals (81), frozen foods (62), dairy (58), microwave meals (44), meat products (43), snacks (40). Fresh produce is thin: about 6 vegetable and 5 egg entries.
- **Caveats:** this counts only products tagged Sweden with a Lidl brand. Lidl items listed without a brand, or under another country's tag, are missed. I did not compare against Lidl's actual range, so I can't say what share of it this covers.

Conclusion (revised): Livsmedelsverket is the primary source for every nutrient it can cover. Open Food Facts is a secondary source for the label basics (energy, macros, salt) of packaged Lidl items that have no generic equivalent, such as ready meals and sauces, and its values are user-contributed and must be validated. It must not supply micronutrients.

## Lidl access: what the terms and the site actually say (checked 2026-11-16)

- **lidl.se has no general terms of use** that I could find. Its legal page covers privacy, cookies, gift cards and guarantees only. That is the absence of a stated rule, not permission, and it is not legal advice. Catalogue and database content can be protected by law, so keep any automated reading low-volume and personal.
- **Lidl Plus terms (v2.4, October 2026)** say: participation is for private use only and commercial use is excluded; you must not let other people access your account; and use on rooted or jailbroken devices is not allowed. They do not mention third-party apps or scraping. A third-party app that logs in with your Lidl Plus credentials, or an unofficial client, risks breaching "no access for others" and relies on an undocumented API. Not recommended; I did not log in or handle any credentials.
- **The Lidl Plus account is not just a list of offers.** The terms say the account stores purchase history (store, items, prices, receipts) and, if enabled, tokenised payment cards (Lidl Pay). Check what yours holds before connecting it to anything.
- **Offers are personalised.** The terms say customers can get different discounts for the same product category. The public pages show the "Med Lidl Plus" price, but your app may show others.
- **Public weekly offer pages work without logging in.** Product name, price, Lidl Plus discount and dates are in the page text, but the list is incomplete: roughly 16 items per page load, plus the full flyer is a picture-based viewer. I read four pages once as an ordinary visitor. The robots.txt checked earlier does not block these pages.

Options for the app, safest first: (1) you copy or screenshot the week's offers from your own app or the flyer and paste them in (this is what the matcher is built for); (2) a low-volume weekly fetch of the public offer pages for your own use; (3) not recommended: logging into your Lidl Plus account from the app.

## Livsmedelsverket API (tested)

- Base: `https://dataportal.livsmedelsverket.se/livsmedel/api/v1`
- Food list: `GET /livsmedel?offset=0&limit=2700&sprak=2` (`sprak=2` is English, `1` is Swedish). Returned 2,606 foods: 1,717 analysed and 889 calculated.
- Nutrients per food: `GET /livsmedel/{nummer}/naringsvarden?sprak=2`. Values are per 100 g edible portion, with EuroFIR codes, units, value type, method and publication.
- Also: `/klassificeringar` (LanguaL, FoodEx2) and `/ravaror` (raw ingredients).
- OpenAPI spec: `/livsmedel/swagger/v1/swagger.json`
- Examples found: Broccoli (#325), Lentils dried (#884), Chicken breast fillet raw w/o skin (#1173).
- Caveat: many entries are cooked or prepared dishes. We need a curated mapping of "ingredient we buy" to the right entry (raw vs cooked, with or without skin).

## Lidl connection: what is and is not possible

- There is **no official Lidl Sverige API**. I found nothing public for Sweden's offers.
- Unofficial options exist: Lidl Plus libraries (reverse-engineered, unmaintained, may break or breach terms) and third-party scrapers that mostly cover DE/NL/UK. None are confirmed for Sweden.
- `lidl.se/robots.txt` allows general crawling apart from a few paths. Their terms of service still need checking before we scrape.
- **Practical options:**
  1. Phase 1: you enter or paste the weekly offers (or we parse the public weekly flyer on lidl.se, subject to the terms check). The planner works on a price list either way.
  2. Phase 2: an automated offers import, if the terms allow it.
  3. A direct login to your Lidl app is not recommended: it needs your credentials and rests on reverse-engineered, unsupported endpoints.

## Open questions

1. Platform: phone app (React Native/Expo), web/PWA, or desktop first?
2. Which nutrients to track beyond calories and macros (fibre, sodium, saturated fat, iron, B12, vitamin D, etc.)? Do you follow the Nordic Nutrition Recommendations (NNR 2023)?
3. Dietary constraints (vegetarian, allergies, halal)?
