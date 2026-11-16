"""Build the ingredient and Lidl product datasets.

Inputs
  data/curated_ingredients.csv   hand-edited list: id, category, slv_number, note
  data/raw/off_lidl_se.json      Open Food Facts rows for Lidl products sold in Sweden
                                 (made by tools/off_filter_se.py + tools/off_extract_lidl.py)
Outputs
  data/ingredients.json          generic ingredients from Livsmedelsverket, per 100 g
  data/lidl_products.json        packaged Lidl products from Open Food Facts, per 100 g
  data/raw/slv/<number>.json     cached API responses (delete to refetch)

Usage: python tools/build_dataset.py
Standard library only.
"""
import csv
import datetime
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SLV_BASE = "https://dataportal.livsmedelsverket.se/livsmedel/api/v1"
UA = "eat-nutrition-dataset-builder"

# EuroFIR code -> (our key, unit). Energy is split by unit below.
NUTRIENTS = {
    "PROT": ("protein_g", "g"), "FAT": ("fat_g", "g"), "FASAT": ("saturated_fat_g", "g"),
    "FAMS": ("monounsaturated_fat_g", "g"), "FAPU": ("polyunsaturated_fat_g", "g"),
    "CHO": ("carbs_g", "g"), "SUGAR": ("sugars_g", "g"), "FIBT": ("fibre_g", "g"),
    "NACL": ("salt_g", "g"), "NA": ("sodium_mg", "mg"), "WATER": ("water_g", "g"),
    "CHORL": ("cholesterol_mg", "mg"),
    "FE": ("iron_mg", "mg"), "CA": ("calcium_mg", "mg"), "K": ("potassium_mg", "mg"),
    "MG": ("magnesium_mg", "mg"), "ZN": ("zinc_mg", "mg"), "P": ("phosphorus_mg", "mg"),
    "SE": ("selenium_ug", "ug"), "ID": ("iodine_ug", "ug"),
    "VITD": ("vitamin_d_ug", "ug"), "VITB12": ("vitamin_b12_ug", "ug"),
    "FOL": ("folate_ug", "ug"), "VITC": ("vitamin_c_mg", "mg"),
    "VITA": ("vitamin_a_re_ug", "ug"), "VITE": ("vitamin_e_mg", "mg"),
    "VITB6": ("vitamin_b6_mg", "mg"), "RIBF": ("riboflavin_mg", "mg"),
    "THIACLHCL": ("thiamin_mg", "mg"), "NIA": ("niacin_mg", "mg"),
    "F20:5": ("epa_g", "g"), "F22:6": ("dha_g", "g"),
}
CORE = ["energy_kcal", "protein_g", "fat_g", "saturated_fat_g", "carbs_g", "sugars_g", "salt_g"]
ALL_KEYS = ["energy_kcal", "energy_kj"] + [v[0] for v in NUTRIENTS.values()]


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    last = None
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # network errors, 5xx
            last = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"fetch failed: {url}: {last}")


def slv_food_list():
    cache = DATA / "raw" / "slv" / "_foods.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    foods = get_json(f"{SLV_BASE}/livsmedel?offset=0&limit=3000&sprak=2")["livsmedel"]
    cache.write_text(json.dumps(foods, ensure_ascii=False), encoding="utf-8")
    return foods


def slv_nutrients(number):
    cache = DATA / "raw" / "slv" / f"{number}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    rows = get_json(f"{SLV_BASE}/livsmedel/{number}/naringsvarden?sprak=2")
    cache.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
    time.sleep(0.2)
    return rows


def norm_unit(u):
    u = (u or "").replace("µ", "u").replace("μ", "u")
    return u


def build_ingredient(row, foods_by_no):
    number = int(row["slv_number"])
    food = foods_by_no.get(number)
    if food is None:
        raise KeyError(f"SLV number {number} not in food list ({row['id']})")
    raw = slv_nutrients(number)
    nutrients, value_types = {}, {}
    waste = None
    for n in raw:
        code, unit = n["euroFIRkod"], norm_unit(n["enhet"])
        if code == "WASTE":
            waste = n["varde"]
            continue
        if n.get("matrisenhetkod") not in ("W", None):
            continue
        if code == "ENERC":
            key = "energy_kcal" if unit == "kcal" else "energy_kj" if unit == "kJ" else None
        elif code in NUTRIENTS:
            key = NUTRIENTS[code][0]
            expected = NUTRIENTS[code][1]
            if unit != expected:
                if code == "VITA":  # reported as "RE/ug"; RE is ug retinol equivalents
                    pass
                else:
                    raise ValueError(f"{row['id']} {code}: unit {unit!r} != {expected!r}")
        else:
            key = None
        if key is None or n["varde"] is None:
            continue
        nutrients[key] = {"value": n["varde"], "type": n.get("vardetypkod")}
        if n.get("vardetypkod"):
            value_types[n["vardetypkod"]] = n.get("vardetyp")
    flags = []
    # Cross-check energy against macros (Atwater-style estimate). Informational only.
    try:
        est = (4 * nutrients["protein_g"]["value"] + 4 * nutrients["carbs_g"]["value"]
               + 9 * nutrients["fat_g"]["value"] + 2 * nutrients.get("fibre_g", {"value": 0})["value"])
        kcal = nutrients["energy_kcal"]["value"]
        if kcal > 20 and abs(est - kcal) / kcal > 0.25:
            flags.append(f"energy_vs_macros_mismatch(kcal={kcal},est={est:.0f})")
    except KeyError:
        flags.append("missing_core_for_energy_check")
    missing = [k for k in ALL_KEYS if k not in nutrients]
    return {
        "id": row["id"],
        "name": food["namn"].strip(),
        "category": row["category"],
        "note": row["note"] or None,
        "basis": "per 100 g edible portion",
        "waste_pct": waste,
        "source": {
            "name": "Livsmedelsverket (Swedish Food Agency), Livsmedelsdatabasen",
            "food_number": number,
            "food_type": food["livsmedelsTyp"],
            "version": food.get("version"),
            "url": f"{SLV_BASE}/livsmedel/{number}/naringsvarden",
            "license": "CC BY 4.0",
        },
        "nutrients": nutrients,
        "missing": missing,
        "flags": flags,
        "_value_types": value_types,
    }


def build_ingredients():
    foods = slv_food_list()
    foods_by_no = {f["nummer"]: f for f in foods}
    with open(DATA / "curated_ingredients.csv", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    ids = [r["id"] for r in rows]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate ids in curated_ingredients.csv")
    out, legend = [], {}
    for r in rows:
        ing = build_ingredient(r, foods_by_no)
        legend.update(ing.pop("_value_types"))
        out.append(ing)
    meta = {
        "generated": datetime.date.today().isoformat(),
        "source": "Livsmedelsverket Livsmedelsdatabasen (CC BY 4.0). Credit: Swedish Food Agency.",
        "basis": "per 100 g edible portion unless stated",
        "units": "energy_kcal, energy_kj; *_g grams; *_mg milligrams; *_ug micrograms",
        "value_type_legend": legend,
        "count": len(out),
    }
    (DATA / "ingredients.json").write_text(
        json.dumps({"meta": meta, "ingredients": out}, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


# --- Open Food Facts (Lidl packaged products) ---
# OFF stores vitamins/minerals in grams per 100 g. Convert to the units used above.
OFF_MAP = {
    "energy-kcal_100g": ("energy_kcal", 1), "proteins_100g": ("protein_g", 1), "fat_100g": ("fat_g", 1),
    "saturated-fat_100g": ("saturated_fat_g", 1), "carbohydrates_100g": ("carbs_g", 1),
    "sugars_100g": ("sugars_g", 1), "fiber_100g": ("fibre_g", 1), "salt_100g": ("salt_g", 1),
    "iron_100g": ("iron_mg", 1e3), "calcium_100g": ("calcium_mg", 1e3), "potassium_100g": ("potassium_mg", 1e3),
    "magnesium_100g": ("magnesium_mg", 1e3), "zinc_100g": ("zinc_mg", 1e3),
    "vitamin-c_100g": ("vitamin_c_mg", 1e3),
    "vitamin-b12_100g": ("vitamin_b12_ug", 1e6), "vitamin-d_100g": ("vitamin_d_ug", 1e6),
}


# Per-100 g upper bounds for real foods. OFF is crowd-sourced and contains unit mistakes
# (e.g. vitamin D of millions of micrograms), so values outside these ranges are dropped.
PLAUSIBLE = {
    "energy_kcal": (0, 900), "protein_g": (0, 100), "fat_g": (0, 100), "saturated_fat_g": (0, 100),
    "carbs_g": (0, 100), "sugars_g": (0, 100), "fibre_g": (0, 80), "salt_g": (0, 40),
    "iron_mg": (0, 15), "calcium_mg": (0, 1500), "potassium_mg": (0, 4000), "magnesium_mg": (0, 800),
    "zinc_mg": (0, 50), "vitamin_c_mg": (0, 1000), "vitamin_b12_ug": (0, 50), "vitamin_d_ug": (0, 30),
}


def num(x):
    try:
        return float(x) if x not in (None, "") else None
    except ValueError:
        return None


def build_lidl_products():
    # The bulk export (off_lidl_se.json) mixes OFF's ingredient-based ESTIMATES into the same
    # *_100g columns as label values. We therefore use the live records (off_live/, made by
    # tools/fetch_off_live.py), whose `nutriments` hold only values typed in from the label.
    export = {p["code"]: p for p in json.loads((DATA / "raw" / "off_lidl_se.json").read_text(encoding="utf-8"))}
    out, seen = [], set()
    for code, exp in export.items():
        lf = DATA / "raw" / "off_live" / f"{code}.json"
        if not lf.exists():
            raise FileNotFoundError(f"{lf} missing: run tools/fetch_off_live.py")
        p = json.loads(lf.read_text(encoding="utf-8"))
        entered = p.get("nutriments") or {}
        if code in seen:
            continue
        seen.add(code)
        nut, flags = {}, []
        ignored_estimates = [k for k in OFF_MAP if exp.get(k) not in (None, "") and entered.get(k) is None]
        for ok, (key, mult) in OFF_MAP.items():
            v = num(entered.get(ok))
            if v is None:
                continue
            v = round(v * mult, 4)
            lo, hi = PLAUSIBLE.get(key, (0, float("inf")))
            if not (lo <= v <= hi):
                flags.append(f"implausible_dropped:{key}={v}")
                continue
            nut[key] = {"value": v, "type": "label"}
        if not (p.get("product_name") or "").strip():
            flags.append("no_name")
        miss_core = [k for k in CORE if k not in nut]
        if miss_core:
            flags.append("missing_core:" + ",".join(miss_core))
        else:
            n = lambda k: nut[k]["value"]
            if n("fat_g") + n("carbs_g") + n("protein_g") > 101:
                flags.append("macros_sum_over_100g")
            if n("energy_kcal") > 900:
                flags.append("energy_over_900kcal")
            if n("sugars_g") > n("carbs_g") + 0.5:
                flags.append("sugars_exceed_carbs")
            if n("saturated_fat_g") > n("fat_g") + 0.5:
                flags.append("satfat_exceeds_fat")
        brands = [b.split(":", 1)[-1] for b in (p.get("brands_tags") or [])]
        cats = [c.split(":", 1)[-1] for c in (p.get("categories_tags") or [])]
        live_name = (p.get("product_name") or "").strip()
        if live_name and (exp.get("product_name") or "").strip() and live_name.lower() != exp["product_name"].strip().lower():
            flags.append(f"name_differs_between_export_and_live:{exp['product_name'].strip()!r}")
        out.append({
            "barcode": code,
            "name": live_name or (exp.get("product_name") or "").strip() or None,
            "last_editor": p.get("last_editor"),
            "estimated_values_ignored": ignored_estimates,
            "brands": brands,
            "categories": cats,
            "basis": "per 100 g (or 100 ml for drinks) as printed on the label",
            "nutrients": nut,
            "core_complete": not miss_core,
            "usable": (not miss_core) and not any(f.startswith(("no_name", "implausible", "macros_sum", "energy_over", "sugars_exceed", "satfat_exceeds")) for f in flags),
            "missing_micros": [k for k in ("fibre_g", "iron_mg", "calcium_mg", "potassium_mg", "magnesium_mg",
                                           "zinc_mg", "vitamin_c_mg", "vitamin_b12_ug", "vitamin_d_ug") if k not in nut],
            "flags": flags,
            "source": {"name": "Open Food Facts", "url": f"https://world.openfoodfacts.org/product/{code}",
                       "license": "ODbL (database), DbCL (contents)"},
        })
    meta = {
        "generated": datetime.date.today().isoformat(),
        "source": "Open Food Facts: product list from the nightly CSV export (rows tagged Sweden with a Lidl brand), values from the live API, entered label values only (OFF's ingredient-based estimates are excluded). ODbL: attribute and share alike if redistributed.",
        "count": len(out),
        "caveat": "Crowd-sourced. Check flags. Not a complete list of Lidl Sweden's range.",
    }
    (DATA / "lidl_products.json").write_text(
        json.dumps({"meta": meta, "products": out}, ensure_ascii=False, indent=1), encoding="utf-8")
    return out


if __name__ == "__main__":
    ings = build_ingredients()
    prods = build_lidl_products()
    print(f"ingredients: {len(ings)}  lidl products: {len(prods)}")
