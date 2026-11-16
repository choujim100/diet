"""Build the ingredient dataset from Livsmedelsverket (the only nutrition source).

Inputs
  data/curated_ingredients.csv   hand-edited list: id, category, slv_number, note
Outputs
  data/ingredients.json          generic ingredients from Livsmedelsverket, per 100 g
  data/raw/slv/<number>.json     cached API responses (delete to refetch)

Open Food Facts was evaluated and rejected (see docs/data-sources.md); its code and data
are kept in archive/open-food-facts/.

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
    time.sleep(0.1)
    return rows


def slv_food_names_sv():
    """Swedish names (sprak=1), useful because Lidl's flyers are in Swedish."""
    cache = DATA / "raw" / "slv" / "_foods_sv.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    foods = get_json(f"{SLV_BASE}/livsmedel?offset=0&limit=3000&sprak=1")["livsmedel"]
    names = {f["nummer"]: f["namn"].strip() for f in foods}
    cache.write_text(json.dumps(names, ensure_ascii=False), encoding="utf-8")
    return {str(k): v for k, v in names.items()}


def norm_unit(u):
    u = (u or "").replace("µ", "u").replace("μ", "u")
    return u


def build_ingredient(row, foods_by_no, strict=True):
    number = int(row["slv_number"])
    food = foods_by_no.get(number)
    if food is None:
        raise KeyError(f"SLV number {number} not in food list ({row['id']})")
    raw = slv_nutrients(number)
    nutrients, value_types = {}, {}
    waste = None
    unit_flags = []
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
                elif strict:
                    raise ValueError(f"{row['id']} {code}: unit {unit!r} != {expected!r}")
                else:
                    unit_flags.append(f"unexpected_unit:{code}={unit}")
                    continue
        else:
            key = None
        if key is None or n["varde"] is None:
            continue
        nutrients[key] = {"value": n["varde"], "type": n.get("vardetypkod")}
        if n.get("vardetypkod"):
            value_types[n["vardetypkod"]] = n.get("vardetyp")
    flags = list(unit_flags)
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


def build_all_foods(workers=5):
    """Every food in the database -> data/foods.json (compact). Fetches missing nutrient files."""
    from concurrent.futures import ThreadPoolExecutor
    foods = slv_food_list()
    names_sv = slv_food_names_sv()
    foods_by_no = {f["nummer"]: f for f in foods}
    numbers = sorted(foods_by_no)
    with open(DATA / "curated_ingredients.csv", encoding="utf-8", newline="") as f:
        curated = {int(r["slv_number"]): r["id"] for r in csv.DictReader(f)}

    def one(no):
        return build_ingredient({"id": f"slv_{no}", "category": None, "note": None, "slv_number": no},
                                foods_by_no, strict=False)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        built = list(ex.map(one, numbers))
    out, legend = [], {}
    for no, b in zip(numbers, built):
        legend.update(b.pop("_value_types"))
        fd = foods_by_no[no]
        out.append({
            "number": no,
            "name": b["name"],
            "name_sv": names_sv.get(str(no)),
            "scientific_name": fd.get("vetenskapligtNamn"),
            "type": b["source"]["food_type"],  # Analysed or Calculated (dishes are mostly Calculated)
            "version": b["source"]["version"],
            "curated_id": curated.get(no),
            "waste_pct": b["waste_pct"],
            "nutrients": {k: [v["value"], v["type"]] for k, v in b["nutrients"].items()},
            "missing": b["missing"],
            "flags": b["flags"],
        })
    meta = {
        "generated": datetime.date.today().isoformat(),
        "source": "Livsmedelsverket Livsmedelsdatabasen (CC BY 4.0). Credit: Swedish Food Agency.",
        "basis": "per 100 g edible portion",
        "units": "energy_kcal, energy_kj; *_g grams; *_mg milligrams; *_ug micrograms",
        "nutrients_format": "key: [value, value_type_code]",
        "value_type_legend": legend,
        "count": len(out),
    }
    (DATA / "foods.json").write_text(
        json.dumps({"meta": meta, "foods": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return out


if __name__ == "__main__":
    ings = build_ingredients()
    print(f"curated ingredients: {len(ings)}")
    if "--all" in sys.argv:
        foods = build_all_foods()
        print(f"all foods: {len(foods)}")
