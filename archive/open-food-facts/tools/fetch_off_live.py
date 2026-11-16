"""Fetch the live Open Food Facts record for every product in data/raw/off_lidl_se.json.

Why: the bulk CSV export puts OFF's ingredient-based *estimates* in the same *_100g
columns as values typed in from the label. The live API keeps them apart
(`nutriments` = entered, `nutriments_estimated` = computed). We only trust the former.

Results are cached one file per barcode in data/raw/off_live/. Safe to rerun; it resumes.
The API often answers 5xx/503 under load, so requests are retried with backoff.
Usage: python tools/fetch_off_live.py
"""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "off_live"
OUT.mkdir(parents=True, exist_ok=True)
FIELDS = "code,product_name,brands_tags,categories_tags,nutriments,nutrition_data_per,serving_size,last_editor,last_modified_t"
UA = "eat-nutrition-dataset-builder"


def fetch(code):
    url = f"https://world.openfoodfacts.org/api/v2/product/{code}?fields={FIELDS}"
    for attempt in range(8):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
                d = json.loads(r.read().decode("utf-8"))
            if d.get("product") is not None:
                return d["product"]
            return {"code": code, "_missing": True}
        except Exception:
            time.sleep(3 * (attempt + 1))
    return None


def main():
    codes = [p["code"] for p in json.loads((ROOT / "data" / "raw" / "off_lidl_se.json").read_text(encoding="utf-8"))]
    done = failed = 0
    for i, c in enumerate(codes, 1):
        f = OUT / f"{c}.json"
        if f.exists():
            done += 1
            continue
        p = fetch(c)
        if p is None:
            failed += 1
            print("FAILED", c, flush=True)
        else:
            f.write_text(json.dumps(p, ensure_ascii=False), encoding="utf-8")
            done += 1
        if i % 25 == 0:
            print(f"{i}/{len(codes)} done={done} failed={failed}", flush=True)
        time.sleep(1.2)
    print(f"FINISHED done={done} failed={failed}", flush=True)


if __name__ == "__main__":
    main()
