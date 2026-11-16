"""Match a Swedish retail product name (e.g. a Lidl flyer line) to a Livsmedelsverket food.

    python tools/match_foods.py "Svensk kycklingbröstfilé 900 g"

Layers, in order:
  1. alias    data/aliases.csv: hand-written retail words -> curated ingredient ids.
              Compounds are matched by their last word (kycklingfilé, körsbärstomater).
              If several targets exist (milk, cheese, mince...), the fat % in the name picks
              the closest one; "lätt" picks the lowest fat; otherwise the first (confidence "low").
              "på burk"/"konserv" and "fryst" switch to canned/frozen targets when defined.
  2. fuzzy    similarity against all 2,606 Swedish food names. Never "high": the app should
              ask the user to confirm.
  3. none     nothing close enough (non-food items, unknown words).

Confidence: high (alias, unambiguous) | medium (alias, defaulted among variants, or a very
close fuzzy hit) | low (fuzzy, needs confirmation) | none.
Standard library only.
"""
import csv
import difflib
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

NOISE = set("""
svensk svenska sverige ekologisk ekologiska eko krav frigaende farsk farska fryst frysta frysvara
djupfryst kyld klass extra stor store liten premium original classic pack forpackning
lidl milbona pilos dulano freshona culinea chef select vemondo kania eridanous deluxe bonduelle
nixe favorina cien sondey
""".split())
DISH = set("""
soppa gratang sas pizza paj kaka bulle gryta pudding smorgas sandwich wrap pastej mousse glass kex
bakelse tarta pannkakor plattar bullar dessert drink lask lasagne
""".split())
# Lidl flyers are full of non-food. Words (accent-stripped) that mark a line as non-food.
# Stems of 7+ letters match anywhere in a word; shorter ones must be the whole word or its ending.
NONFOOD = set("""
diskmedel disktabletter tvattmedel tvattmedel sköljmedel skoljmedel schampo balsam tval tandkram
tandborste toalettpapper hushallspapper batteri batterier blojor hundmat kattmat djurmat rengoring
sopsackar sopsack deodorant rakhyvel rakskum plastpase folie bakplatspapper glodlampa lampa
ljus tidning leksak verktyg skruv troja byxor strumpor handskar sangklader handduk kudde filt
stekpanna vattenflaska parasoll tvattlappar vattpinnar bindor tamponger plastfickor
""".split())
SUFFIXES = ("er", "ar", "n", "en", "et", "or", "na", "ter")
# Short words that can end a compound ("linfrobrod"). If a query word ends with one of these,
# the matched food must contain that head word too (bread vs seeds, soup vs vegetable).
SHORT_HEADS = {"brod", "olja", "kaka", "korv", "ost", "deg", "sas", "gryn", "saft", "paj", "file"}
HEADS = SHORT_HEADS | {"soppa", "glass", "kakor", "sylt", "juice", "pizza", "grot", "smor"}
STEM_ENDINGS = ("arna", "orna", "erna", "ar", "or", "er", "na", "n", "a", "e", "t")
FAT_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*%")
QTY_RE = re.compile(r"\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|ml|cl|dl|l|st|pack|-pack|knippe|kruka)\b|\b\d+-pack\b|\bx\d+\b")


def norm(s):
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


def parse_fat(s):
    m = FAT_RE.search(s)
    return float(m.group(1).replace(",", ".")) if m else None


def clean_query(raw):
    s = norm(raw)
    fat = parse_fat(s)
    s = FAT_RE.sub(" ", s)
    s = QTY_RE.sub(" ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    toks = [t for t in s.split() if not t.isdigit() and t not in NOISE]
    return toks, fat


def stem(t):
    for e in STEM_ENDINGS:
        if t.endswith(e) and len(t) - len(e) >= 3:
            return t[: -len(e)]
    return t


def is_nonfood(toks):
    for t in toks:
        for w in NONFOOD:
            if (len(w) >= 7 and w in t) or t == w or (len(w) < 7 and t.endswith(w)):
                return True
    return False


def trigrams(s):
    s = f"  {s} "
    return {s[i:i + 3] for i in range(len(s) - 2)}


def dice(a, b):
    ta, tb = trigrams(a), trigrams(b)
    return 2 * len(ta & tb) / (len(ta) + len(tb)) if ta and tb else 0.0


class Matcher:
    def __init__(self):
        d = json.loads((DATA / "foods.json").read_text(encoding="utf-8"))
        self.foods = {f["number"]: f for f in d["foods"]}
        self.by_curated = {f["curated_id"]: f for f in d["foods"] if f["curated_id"]}
        self.index = []
        for f in d["foods"]:
            name = re.sub(r"[^a-z0-9 ]", " ", norm(f["name_sv"] or f["name"]))
            name = FAT_RE.sub(" ", name)
            self.index.append((f["number"], name, set(name.split())))
        self.aliases = []  # (alias_regex, alias_len, targets, canned, frozen, alias_text)
        with open(DATA / "aliases.csv", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                split = lambda x: [t for t in (x or "").split("|") if t]
                for a in row["aliases"].split(";"):
                    a = norm(a.strip())
                    suf = "(?:" + "|".join(SUFFIXES) + ")?"
                    # long aliases may end a compound word; short ones must be a whole word
                    rx = re.compile((r"" if len(a) >= 5 else r"\b") + re.escape(a) + suf + r"\b")
                    self.aliases.append((rx, len(a), split(row["targets"]), split(row["canned"]),
                                         split(row["frozen"]), a))
        self.aliases.sort(key=lambda x: -x[1])

    def _food(self, target):
        f = self.by_curated.get(target)
        if f is None and target.startswith("n:"):
            f = self.foods.get(int(target[2:]))
        if f is None:
            raise KeyError(f"alias target not found: {target}")
        return f

    def _pack(self, f, via, confidence, note=None, score=None):
        return {"number": f["number"], "curated_id": f["curated_id"], "name_sv": f["name_sv"], "name": f["name"],
                "type": f["type"], "via": via, "confidence": confidence, "score": score, "note": note}

    def match(self, raw, top=3):
        toks, fat = clean_query(raw)
        if is_nonfood(toks):
            return {"query": raw, "match": None, "candidates": [], "note": "non-food"}
        text = " ".join(toks)
        whole = norm(raw)
        canned = bool(re.search(r"\b(burk|konserv\w*|tetra)\b", whole))
        frozen = bool(re.search(r"\b(fryst|frysta|frysvara|djupfryst)\b", whole))
        light = bool(re.search(r"\blatt\b", whole))
        # 1. alias. Retail lines put the product first and descriptors after ("Hummus kikärtor"),
        # so the alias that starts earliest wins; ties go to the longer alias.
        hits = []
        for entry in self.aliases:
            mo = entry[0].search(text)
            if mo:
                hits.append((mo.start(), -entry[1], entry))
        hits.sort(key=lambda h: h[:2])
        if hits:
            _, _, (rx, _, targets, canned_t, frozen_t, alias) = hits[0]
            if canned and canned_t:
                targets = canned_t
            elif frozen and frozen_t:
                targets = frozen_t
            foods = [self._food(t) for t in targets]
            if len(foods) == 1:
                return {"query": raw, "match": self._pack(foods[0], f"alias:{alias}", "high"), "candidates": []}
            fatval = lambda f: f["nutrients"]["fat_g"][0]
            if fat is not None:
                best = min(foods, key=lambda f: abs(fatval(f) - fat))
                gap = abs(fatval(best) - fat)
                conf, note = ("high", None) if gap <= 1 else (
                    "medium", f"nearest variant is {fatval(best):g}% fat, label says {fat:g}%")
                return {"query": raw, "match": self._pack(best, f"alias:{alias}+fat", conf, note), "candidates": []}
            if light:
                best = min(foods, key=fatval)
                return {"query": raw, "match": self._pack(best, f"alias:{alias}+light", "medium"), "candidates": []}
            alts = [self._pack(f, f"alias:{alias}", "low") for f in foods[1:]]
            # guessing between variants (cheese is 10-38% fat) must not look certain
            return {"query": raw, "match": self._pack(foods[0], f"alias:{alias}", "low",
                                                      "several variants; fat % not given"), "candidates": alts}
        # 2. fuzzy
        if not toks:
            return {"query": raw, "match": None, "candidates": []}
        longest = max(toks, key=len)

        def credit(q, f):
            """Characters of query word q explained by food word f (0 = no match)."""
            if q == f:
                return len(q)
            if len(q) >= 5 and len(f) >= 5:
                if stem(q) == stem(f):  # plural: rodbetor / rodbeta
                    return len(q)
                if difflib.SequenceMatcher(None, q, f).ratio() >= 0.88:  # spelling: sallad / sallat
                    return len(q)
            # Compounds: head last (linfrobrod = linfro + brod), modifier first (kalkon + brostfile).
            # Only the matching part earns credit, so ananassplit is not "ananas".
            if len(q) > len(f) and len(q) - len(f) >= 3:
                if q.endswith(f) and (len(f) >= 5 or f in SHORT_HEADS):
                    return len(f)
                if q.startswith(f) and len(f) >= 5:
                    return len(f)
            if len(q) > len(f) and q.startswith(f) and len(f) >= 5 and q[len(f):] in SUFFIXES:
                return len(q)  # plain plural / definite form
            if len(f) > len(q) and len(q) >= 5 and f.endswith(q) and len(f) - len(q) >= 3:
                return len(q)  # query is the head of a longer food word (druvor in vindruvor)
            return 0

        def credit_word(q, ftoks):
            return min(len(q), sum(c for c in (credit(q, f) for f in ftoks) if c))

        heads = {h for q in toks for h in HEADS if q.endswith(h) and len(q) > len(h)}
        scored = []
        for number, name, ftoks in self.index:
            if heads and not all(any(f.endswith(h) or stem(f) == stem(h) for f in ftoks) for h in heads):
                continue
            credits = {q: credit_word(q, ftoks) for q in toks}
            if credits[longest] == 0:
                continue
            total = sum(len(q) for q in toks)
            coverage = sum(credits.values()) / total
            if coverage < 0.3:
                continue
            f = self.foods[number]
            score = 0.6 * coverage + 0.4 * dice(text, name)
            if ftoks & DISH:
                score -= 0.15
            if " m " in f" {name} " or " med " in f" {name} ":
                score -= 0.05
            if f["curated_id"]:
                score += 0.08
            if f["type"] == "Analysed":
                score += 0.03
            if fat is not None and "fat_g" in f["nutrients"]:
                score += 0.05 if abs(f["nutrients"]["fat_g"][0] - fat) <= 1 else -0.02
            scored.append((score, number))
        scored.sort(reverse=True)
        if not scored or scored[0][0] < 0.5:
            return {"query": raw, "match": None, "candidates": []}
        cands = [self._pack(self.foods[n], "fuzzy", "low", score=round(s, 3)) for s, n in scored[:top]]
        best = cands[0]
        # a very close hit is "medium" only if nothing else is nearly as close (e.g. fortified vs not)
        if best["score"] >= 0.9 and (len(cands) == 1 or cands[1]["score"] < best["score"] - 0.05):
            best["confidence"] = "medium"
        return {"query": raw, "match": best, "candidates": cands[1:]}


if __name__ == "__main__":
    m = Matcher()
    for q in sys.argv[1:]:
        r = m.match(q)
        x = r["match"]
        if x is None:
            print(f"{q!r}: no match")
        else:
            print(f"{q!r}: {x['curated_id'] or x['number']} | {x['name_sv']} | {x['via']} | {x['confidence']}")
            for c in r["candidates"]:
                print(f"      alt: {c['curated_id'] or c['number']} | {c['name_sv']} | {c['score']}")
