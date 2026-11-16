import sys, csv, gzip, io
csv.field_size_limit(10**9)
out_path = sys.argv[1]
raw = gzip.GzipFile(fileobj=sys.stdin.buffer)
text = io.TextIOWrapper(raw, encoding="utf-8", errors="replace", newline="")
r = csv.reader(text, delimiter="\t", quoting=csv.QUOTE_NONE)
hdr = next(r)
ix = {h: i for i, h in enumerate(hdr)}
ci = ix["countries_tags"]
total = kept = 0
with open(out_path, "w", encoding="utf-8", newline="") as f:
    w = csv.writer(f, delimiter="\t", quoting=csv.QUOTE_MINIMAL)
    w.writerow(hdr)
    for row in r:
        total += 1
        if len(row) > ci and "en:sweden" in row[ci]:
            w.writerow(row); kept += 1
        if total % 500000 == 0:
            print(total, kept, file=sys.stderr, flush=True)
print("DONE total", total, "kept", kept, file=sys.stderr, flush=True)
