"""Score the matcher on tests/matching_cases.csv.

    python tools/eval_matching.py [--verbose]

Columns: name, expected (curated id, or "none" for non-food), split (dev = used while writing
aliases, test = held out). "Confidently wrong" = wrong match with high/medium confidence,
the dangerous case because the app would not ask the user to check it.
"""
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from match_foods import Matcher  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main():
    verbose = "--verbose" in sys.argv
    m = Matcher()
    rows = list(csv.DictReader(open(ROOT / "tests" / "matching_cases.csv", encoding="utf-8", newline="")))
    splits = [a for a in sys.argv[1:] if not a.startswith("--")] or ["dev", "test", "test2"]
    for split in splits:
        cases = [r for r in rows if r["split"] == split]
        ok = wrong_conf = wrong_low = 0
        fails = []
        for r in cases:
            res = m.match(r["name"])
            got = res["match"]
            gid = None if got is None else (got["curated_id"] or str(got["number"]))
            exp = None if r["expected"] == "none" else r["expected"]
            if gid == exp:
                ok += 1
                continue
            conf = got["confidence"] if got else "none"
            if got is None:
                wrong_low += 1  # missed, but nothing wrong was asserted
            elif conf in ("high", "medium"):
                wrong_conf += 1
            else:
                wrong_low += 1
            alts = [c["curated_id"] or c["number"] for c in res["candidates"]]
            fails.append((r["name"], r["expected"], gid, conf, alts))
        n = len(cases)
        print(f"[{split}] {ok}/{n} correct ({100 * ok / n:.0f}%) | confidently wrong: {wrong_conf} "
              f"| wrong or missed but low confidence/none: {wrong_low}")
        if verbose or split != "dev":
            for f in fails:
                print(f"    {f[0]!r}: expected {f[1]}, got {f[2]} [{f[3]}] alts={f[4]}")


if __name__ == "__main__":
    main()
