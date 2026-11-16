"""Build the data files the web app loads, and validate the recipes.

    python tools/build_web_data.py

Reads  data/foods.json, data/aliases.csv, data/prices_estimate.csv, data/nnr2023.json,
       data/curated_ingredients.csv, web/data/recipes.json
Writes web/data/foods.json (slim), aliases.json, prices.json, nnr2023.json
and rewrites recipes.json with computed tags (vegetarian, vegan, pescatarian) and per-portion
nutrition for checking. Exits non-zero if a recipe is invalid. Standard library only.
"""
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_dataset import ALL_KEYS  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WEB = ROOT / "web" / "data"
WEB.mkdir(parents=True, exist_ok=True)

MEAT = {"chicken_breast", "chicken_thigh", "turkey_fillet", "beef_mince_10", "beef_mince_15",
        "pork_mince_8", "pork_tenderloin", "bacon"}


def round_sig(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return round(v, 3)
    return v


def build_foods():
    src = json.loads((DATA / "foods.json").read_text(encoding="utf-8"))["foods"]
    rows = []
    for f in src:
        vals = []
        for k in ALL_KEYS:
            n = f["nutrients"].get(k)
            vals.append(round_sig(n[0]) if n else None)
        rows.append([f["number"], f["name"], f["name_sv"], f["curated_id"], f["type"][0], vals])
    out = {"keys": ALL_KEYS, "foods": rows}
    (WEB / "foods.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {f["curated_id"]: f for f in src if f["curated_id"]}, {f["number"]: f for f in src}


def build_aliases():
    out = []
    with open(DATA / "aliases.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            sp = lambda x: [t for t in (x or "").split("|") if t]
            out.append({"aliases": [a.strip() for a in row["aliases"].split(";")], "targets": sp(row["targets"]),
                        "canned": sp(row["canned"]), "frozen": sp(row["frozen"])})
    (WEB / "aliases.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def build_ingredient_meta(curated):
    out = {}
    with open(DATA / "curated_ingredients.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            f = curated[row["id"]]
            out[row["id"]] = {"category": row["category"], "name": f["name"], "name_sv": f["name_sv"], "note": row["note"]}
    (WEB / "ingredients.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def build_prices(curated):
    out = {}
    with open(DATA / "prices_estimate.csv", encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            out[row["id"]] = {"sek_per_kg": float(row["sek_per_kg"]), "basis": row["basis"]}
    missing = [i for i in curated if i not in out]
    extra = [i for i in out if i not in curated]
    if missing or extra:
        print("PRICE TABLE MISMATCH. missing:", missing, "extra:", extra)
        sys.exit(1)
    (WEB / "prices.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def check_recipes(curated):
    path = WEB / "recipes.json"
    d = json.loads(path.read_text(encoding="utf-8"))
    problems, report = [], []
    for r in d["recipes"]:
        ids = [i["id"] for i in r["ingredients"]]
        for i in ids:
            if i not in curated:
                problems.append(f"{r['id']}: unknown ingredient {i}")
        if r["minutes"] > 30:
            problems.append(f"{r['id']}: {r['minutes']} min > 30")
        if not r.get("steps"):
            problems.append(f"{r['id']}: no steps")
        tot = {"energy_kcal": 0, "protein_g": 0, "fibre_g": 0}
        for i in r["ingredients"]:
            f = curated.get(i["id"])
            if not f:
                continue
            for k in tot:
                tot[k] += f["nutrients"][k][0] * i["g"] / 100
        lo, hi = (230, 600) if "breakfast" in r["meal"] else (450, 900)
        if not lo <= tot["energy_kcal"] <= hi:
            problems.append(f"{r['id']}: {tot['energy_kcal']:.0f} kcal outside {lo}-{hi}")
        is_meat = any(i in MEAT for i in ids)
        is_fish = any(curated[i]["curated_id"] and i in {"salmon", "cod", "alaska_pollock", "mackerel", "herring",
                                                      "tuna_in_water", "sardines_in_oil", "shrimp"} for i in ids if i in curated)
        animal = any(i in {"egg", "milk_1_5", "milk_3", "milk_skimmed", "yoghurt_plain_3", "yoghurt_plain_skimmed",
                           "quark_plain", "cottage_cheese", "lattfil", "cheese_hard_17", "cheese_hard_26", "mozzarella",
                           "feta_proxy", "halloumi", "cream_cheese_15", "sour_cream_12", "creme_fraiche_5", "butter",
                           "ricotta", "parmesan", "honey"} for i in ids)
        r["tags"] = {"vegetarian": not is_meat and not is_fish,
                     "vegan": not is_meat and not is_fish and not animal,
                     "pescatarian": not is_meat}
        r["_check"] = {k: round(v, 1) for k, v in tot.items()}
        report.append((r["id"], r["minutes"], r["_check"]["energy_kcal"], r["_check"]["protein_g"], r["_check"]["fibre_g"]))
    # keep the file hand-editable: store tags but not the check block
    for r in d["recipes"]:
        r.pop("_check", None)
    path.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    return problems, report


if __name__ == "__main__":
    curated, _ = build_foods()
    build_aliases()
    build_prices(curated)
    build_ingredient_meta(curated)
    (WEB / "nnr2023.json").write_text((DATA / "nnr2023.json").read_text(encoding="utf-8"), encoding="utf-8")
    problems, report = check_recipes(curated)
    print(f"foods + aliases + prices + nnr written; {len(report)} recipes checked")
    for p in problems:
        print("PROBLEM:", p)
    if "-v" in sys.argv:
        for r in report:
            print(f"  {r[0]:34s} {r[1]:2d} min  {r[2]:5.0f} kcal  {r[3]:4.0f} g protein  {r[4]:4.1f} g fibre")
    sys.exit(1 if problems else 0)
