import sys, csv, collections
csv.field_size_limit(10**9)
r = csv.DictReader(open(sys.argv[1], encoding="utf-8", newline=""), delimiter="\t")
rows = list(r)
print("Sweden rows:", len(rows))
def lidl(x):
    return any("lidl" in (x.get(k) or "").lower() for k in ("brands_tags","stores_tags","stores","brands"))
L = [x for x in rows if lidl(x)]
print("Lidl (brand or store) rows:", len(L))
print("by store tag:", sum(1 for x in rows if "lidl" in (x.get("stores_tags") or "").lower()),
      "by brand tag:", sum(1 for x in rows if "lidl" in (x.get("brands_tags") or "").lower()))
b = collections.Counter()
for x in L:
    for t in (x.get("brands_tags") or "").split(","): b[t]+=1
print("top brands:", b.most_common(15))
def has(x,k):
    v=x.get(k); return v not in (None,"")
core = ["energy-kcal_100g","fat_100g","saturated-fat_100g","carbohydrates_100g","sugars_100g","proteins_100g","salt_100g"]
extra = ["fiber_100g","iron_100g","vitamin-b12_100g","vitamin-d_100g","calcium_100g","potassium_100g","vitamin-c_100g","zinc_100g","magnesium_100g"]
n=len(L)
print("\nCompleteness among Lidl rows (n=%d):"%n)
for k in core+extra: print(f"  {k:22s} {sum(has(x,k) for x in L):5d}  {100*sum(has(x,k) for x in L)/n:5.1f}%")
print("  all 7 core:", sum(all(has(x,k) for k in core) for x in L))
print("  has name:", sum(has(x,'product_name') for x in L))
c = collections.Counter()
for x in L:
    for t in (x.get("categories_tags") or "").split(","):
        if t: c[t]+=1
print("\ntop categories:", c.most_common(25))
fresh = [t for t in c if any(w in t for w in ("fresh","vegetables","fruits","meats","fishes","eggs"))]
print("fresh-ish categories count:", [(t,c[t]) for t in fresh][:15])
import json
json.dump([{k:x.get(k) for k in ["code","product_name","brands_tags","categories_tags","last_modified_t"]+core+extra} for x in L], open(sys.argv[2],"w",encoding="utf-8"))
import statistics, time
lm=[int(x["last_modified_t"]) for x in L if x.get("last_modified_t","").isdigit()]
print("\nLidl rows modified in last 12 months:", sum(1 for t in lm if t>time.time()-365*86400), "of", len(lm))
