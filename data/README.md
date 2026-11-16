# Nutrition dataset

**Single source of truth: Livsmedelsverket (Swedish Food Agency), Livsmedelsdatabasen. CC BY 4.0. Credit the Swedish Food Agency in the app.**

Open Food Facts was evaluated and rejected: crowd-sourced, contains real unit-entry errors, and has almost no real micronutrient data for Lidl products. Details in `docs/data-sources.md`. Its code and data are kept in `archive/open-food-facts/` and are not used.

| File | What |
|---|---|
| `foods.json` | **All 2,606 foods** in the database (English and Swedish names), about 35 nutrients each, per 100 g edible portion. Compact: `nutrients` is `key: [value, value_type_code]`. `type` is `Analysed` (lab-measured) or `Calculated` (mostly dishes and recipes). `curated_id` links to `ingredients.json`. Value type codes: `AV` average, `BE` best estimate, `LZ` logical zero, `BL` below detection limit, etc. |
| `ingredients.json` | 138 hand-picked raw/dry ingredients with readable ids (e.g. `chicken_breast`), for recipes and the first version of the planner. Same nutrient data as `foods.json`. |
| `curated_ingredients.csv` | The list that drives `ingredients.json`. Edit it to add or swap ingredients (`slv_number` is the Livsmedelsverket food number). |
| `raw/slv/` | Cached API responses (about 2,600 files). Delete a file to refetch it. |

## Matching Swedish product names to foods

```bash
python tools/match_foods.py "Svensk kycklingbröstfilé 900 g" "Mjölk 1.5% 1 L"
python tools/eval_matching.py
```

`tools/match_foods.py` has three layers: (1) `aliases.csv`, hand-written retail words to curated ingredients, with fat % picking between milk/cheese/mince variants and "på burk"/"fryst" switching to canned/frozen targets; (2) fuzzy matching against all 2,606 Swedish names; (3) none, including a non-food stoplist (detergent, nappies, etc.). Each result has a confidence: `high`, `medium` (defaulted between variants, or the fat % is more than 1 point off), `low` (fuzzy: the app must ask the user to confirm) or no match.

Measured on `tests/matching_cases.csv` (my own 177 Lidl-style product names; the app has not seen real flyer data yet):

| Set | Result | Notes |
|---|---|---|
| dev (66) | 100% | Used to write the aliases, so this proves nothing. |
| test (67) | 97% on the final code. 91%, with 2 confidently wrong, on the first run | Failures from the first run were fixed in the code (non-food stoplist, plural and spelling tolerance, near-tie handling), so this set is no longer unbiased. |
| test2 (44) | 95% on the final code. 93%, with 1 confidently wrong, on the first run | Written after the first fixes and run once before changing anything. The confident error ("Hummus kikärtor" matched chickpeas) was then fixed by letting the earliest alias win. |

The first-run figures, not the final ones, are the honest estimate for new data: roughly 90-93% correct, and about 1 confident mistake in 50. The final code has 0 confidently wrong on all sets, but I tuned against these sets, so expect some confident errors on real flyers. Misses left are near-duplicate entries (fortified vs plain soy drink, roasted vs dried peanuts), returned as `low` with the right answer in the alternatives.

**Real Lidl offers (the only non-invented data so far).** On 2026-11-16 I read 42 unique food offer names from Lidl's public weekly offer pages (`tests/real_offers_2026-11-16.txt`) and judged each match by hand (one rater, me):

| | Correct | Wrong | No match |
|---|---|---|---|
| First run, before any fix | 16 (38%) | 15, of which 6 with medium confidence | 11 |
| After fixes | 26 (62%) | 4, all low confidence | 12 |

The first run is the honest number. The fixes were made while looking at these same 42 names (non-food-style word matching, compound-word handling, cheese default, extra aliases for clementines, pork shoulder, hard cheeses, gingerbread, toast bread), so 62% is optimistic. Real flyers are full of bread, ice cream, juice, sweets and ready meals, which my invented tests barely had, and some of those have no good database entry (panettone, juice concentrate). Several of the 62% are low-confidence approximations (e.g. any hard cheese defaults to the 26% fat entry). Conclusion: do not auto-apply matches. The app must show every `low`/`medium` match for confirmation and remember the user's confirmations.

Limits: only the 138 curated ingredients have aliases, so anything else (sausages, ready meals, drinks) relies on fuzzy `low` matches. Matching is name-based only; it cannot tell brands or recipes apart. The non-food stoplist is short, so unknown non-food words can still reach fuzzy matching.

## Rebuild

```bash
python tools/build_dataset.py          # curated ingredients only (fast)
python tools/build_dataset.py --all    # also all 2,606 foods (first run fetches about 2,600 files, a few minutes)
```

Standard library only.

## Known limits

- Packaged Lidl products with no generic equivalent (ready meals, sauces) have no data. Plan to cook from ingredients, or add the closest generic entry.
- `zucchini` maps to the source's "Squash" and `feta_proxy` to a generic sheep/goat cheese. Skyr has no entry; `quark_plain` is the nearest match. Check these against the pack.
- Most entries are raw or dry weight. Cooking changes weights, so the recipe engine needs yield factors (not built yet).
- Values coded `BL` / `LZ` are zeros because of detection limits or logic, not necessarily true zeros.
- `foods.json` contains many cooked dishes and branded-style entries (`type: Calculated`). For planning, prefer raw/dry entries, since the app will cook from ingredients. Matching Swedish Lidl product names to a food number is not built yet.
