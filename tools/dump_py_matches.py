"""Dump the Python matcher's answers for every test name, for tools/check_js_matcher.mjs."""
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from match_foods import Matcher  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
names = [r["name"] for r in csv.DictReader(open(ROOT / "tests" / "matching_cases.csv", encoding="utf-8", newline=""))]
names += [l.strip() for l in open(ROOT / "tests" / "real_offers_2026-11-16.txt", encoding="utf-8") if l.strip()]
names += ["Mjölk 1 L", "Hårdost 28% 700 g", "Mjölk 1.5% 1 L", "Lättmjölk", "Svensk kycklingbröstfilé 900 g",
          "Kikärtor på burk", "Spenat fryst", "Cola Zero 1.5 L", "Falukorv 800 g", "Pyttipanna 600 g", "Ägg 6-pack"]
m = Matcher()
out = []
for q in names:
    r = m.match(q)
    x = r["match"]
    out.append({"query": q, "match": None if x is None else {"number": x["number"], "confidence": x["confidence"]}})
json.dump(out, sys.stdout, ensure_ascii=False)
