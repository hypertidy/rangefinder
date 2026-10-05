# Real Sentinel-2 c1 items for the clear-day scan validation case
# (docs/clear-day-scan.md): Tasmania to Brisbane, Apr to Jul 2026.
# Earth Search's API is not reachable from every sandbox, but the item JSON
# sits next to the COGs in the public bucket, so this walks the bucket by
# MGRS square and month instead. Items are trimmed (a few assets) and
# written as one FeatureCollection; dev/server.mjs serves it at
# /scan/search when present.
#   python3 make_scan_fixture.py [out.json]
import json, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

B = "https://e84-earth-search-sentinel-data.s3.us-west-2.amazonaws.com"
P = "sentinel-2-c1-l2a"
BBOX = [145.283, -44.269, 155.566, -22.999]
START, END = "20260403", "20260705"
MONTHS = [4, 5, 6, 7]
KEEP = ["visual", "thumbnail", "red", "green", "blue", "nir", "scl"]
OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures/scan-items.json"

def get(u):
    for k in range(4):
        try:
            return urllib.request.urlopen(u, timeout=60).read()
        except Exception:
            if k == 3: raise

def prefixes(prefix):
    x = get(B + "/?list-type=2&delimiter=/&prefix=" + prefix).decode()
    return re.findall(r"<Prefix>([^<]+/)</Prefix>", x)[1:]

def inter(a, b):
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]

with ThreadPoolExecutor(32) as ex:
    bands = ["%s/%d/%s/" % (P, z, b) for z in (55, 56) for b in "GHJK"]
    squares = [s for ss in ex.map(prefixes, bands) for s in ss]
    months = [s + "2026/%d/" % m for s in squares for m in MONTHS]
    scenes = [s for ss in ex.map(prefixes, months) for s in ss]
    def dated(s):
        m = re.search(r"_(\d{8})T", s)
        return m and START <= m.group(1) <= END
    scenes = [s for s in scenes if dated(s)]
    print(len(squares), "squares,", len(scenes), "scenes in the date range", file=sys.stderr)
    def item(s):
        name = s.rstrip("/").split("/")[-1]
        j = json.loads(get(B + "/" + s + name + ".json"))
        if not inter(j["bbox"], BBOX): return None
        j["assets"] = {k: v for k, v in j["assets"].items() if k in KEEP}
        j["links"] = []
        return j
    items = [i for i in ex.map(item, scenes) if i]

items.sort(key=lambda i: i["properties"]["datetime"])
json.dump({"type": "FeatureCollection", "features": items}, open(OUT, "w"), separators=(",", ":"))
print(len(items), "items ->", OUT, file=sys.stderr)
