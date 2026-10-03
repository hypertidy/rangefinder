"""Build a mock starc store from fixtures/items.json, laid out the way
hypertidy/starc's harvest() writes one:

  starc/queries/<qid>.parquet
  starc/acquisitions/<qid>.parquet
  starc/products/collection=<c>/<qid>.parquet
  starc/assets/collection=<c>/<qid>.parquet
  starc/manifest.json            (the file list a static host needs)

Rows follow starc's extract_item() (R/mappers.R). Three "queries": the
Tasmania squares, the Victoria seam squares, and an overlapping re-harvest
of 55GEN so the reader's dedup is exercised. starc-flat/ holds the same
rows as three consolidated files and no manifest, plus the optional
footprint_wkb column (the item geometry) that the sharded store lacks.

Needs: pip install pyarrow
"""
import datetime, hashlib, json, os, shutil, struct
import pyarrow as pa, pyarrow.parquet as pq

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
PROVIDER = "https://earth-search.aws.element84.com/v1/search"
items = json.load(open(os.path.join(HERE, "items.json")))

def sha16(s): return hashlib.sha1(s.encode()).hexdigest()[:16]

def wkb(g):
    def ring(r): return struct.pack("<I", len(r)) + b"".join(struct.pack("<dd", *pt[:2]) for pt in r)
    def poly(p): return struct.pack("<BII", 1, 3, len(p)) + b"".join(ring(r) for r in p)
    if g["type"] == "Polygon": return poly(g["coordinates"])
    return struct.pack("<BII", 1, 6, len(g["coordinates"])) + b"".join(poly(p) for p in g["coordinates"])

def solarday(dt, lon):
    t = datetime.datetime.strptime(dt[:19], "%Y-%m-%dT%H:%M:%S")
    t = t + datetime.timedelta(hours=lon / 15)
    if t.hour >= 12: t = t + datetime.timedelta(days=1)   # R rounds to the nearest day
    return t.date()

def extract(it):
    p = it["properties"]
    tile = "%s%s%s" % (p["mgrs:utm_zone"], p["mgrs:latitude_band"], p["mgrs:grid_square"])
    plat = p["platform"].lower()
    dt = p["datetime"]
    acq = "_".join([plat, tile, dt.split(".")[0].replace("-", "").replace(":", "")])
    cen = p.get("proj:centroid") or {"lon": (it["bbox"][0] + it["bbox"][2]) / 2,
                                     "lat": (it["bbox"][1] + it["bbox"][3]) / 2}
    pid = "p_" + sha16(":".join([PROVIDER, it["collection"], it["id"]]))
    a = dict(acquisition_id=acq, platform=plat, instrument="msi", mode=None, datetime=dt,
             solarday=solarday(dt, cen["lon"]), centroid_lon=cen["lon"], centroid_lat=cen["lat"],
             tile=tile, footprint_wkb=wkb(it["geometry"]))
    pr = dict(product_id=pid, acquisition_id=acq, provider=PROVIDER, collection=it["collection"],
              item_id=it["id"], product_family="l2a", polarisations=None,
              epsg=p.get("proj:epsg"), cloud_cover=p.get("eo:cloud_cover"),
              baseline=p.get("s2:processing_baseline"))
    assets = [dict(product_id=pid, asset_key=k, href=v.get("href"), media_type=v.get("type"))
              for k, v in it["assets"].items()]
    return a, pr, assets

SCHEMA = {
    "acquisitions": pa.schema([("acquisition_id", pa.string()), ("platform", pa.string()),
        ("instrument", pa.string()), ("mode", pa.string()), ("datetime", pa.string()),
        ("solarday", pa.date32()), ("centroid_lon", pa.float64()), ("centroid_lat", pa.float64()),
        ("tile", pa.string()), ("footprint_wkb", pa.binary())]),
    "products": pa.schema([("product_id", pa.string()), ("acquisition_id", pa.string()),
        ("provider", pa.string()), ("collection", pa.string()), ("item_id", pa.string()),
        ("product_family", pa.string()), ("polarisations", pa.string()), ("epsg", pa.int32()),
        ("cloud_cover", pa.float64()), ("baseline", pa.string()), ("query_id", pa.string())]),
    "assets": pa.schema([("product_id", pa.string()), ("asset_key", pa.string()),
        ("href", pa.string()), ("media_type", pa.string())]),
}

def table(rows, name, drop=()):
    s = SCHEMA[name]
    s = pa.schema([f for f in s if f.name not in drop])
    return pa.Table.from_pylist([{k: r.get(k) for k in s.names} for r in rows], schema=s)

def main():
    out, flat = os.path.join(HERE, "starc"), os.path.join(HERE, "starc-flat")
    for d in (out, flat): shutil.rmtree(d, ignore_errors=True)
    tas = [i for i in items if i["properties"]["mgrs:utm_zone"] == 55 and
           i["properties"]["mgrs:latitude_band"] == "G"]
    vic = [i for i in items if i not in tas]
    regen = [i for i in tas if i["properties"]["grid:code"] == "MGRS-55GEN"][:6]
    files, allrows = [], {"acquisitions": [], "products": [], "assets": []}
    for region, its in [("se_tasmania", tas), ("vic_seam", vic), ("se_tasmania", regen)]:
        fetched = "2026-10-0%dT00:00:00Z" % (len(files) // 5 + 1)
        qid = sha16("|".join([region, PROVIDER, "sentinel-2-l2a", fetched, str(len(its))]))
        ex = [extract(i) for i in its]
        acqs = [e[0] for e in ex]
        prods = [dict(e[1], query_id=qid) for e in ex]
        assets = [a for e in ex for a in e[2]]
        coll = "sentinel-2-l2a"
        paths = {"acquisitions/%s.parquet" % qid: table(acqs, "acquisitions", drop=["footprint_wkb"]),
                 "products/collection=%s/%s.parquet" % (coll, qid): table(prods, "products"),
                 "assets/collection=%s/%s.parquet" % (coll, qid): table(assets, "assets")}
        q = pa.Table.from_pylist([dict(query_id=qid, region_id=region, provider=PROVIDER,
             collection=coll, t0="2025-01-01T00:00:00Z", t1="2025-02-28T23:59:59Z",
             fetched_at=fetched, n_items=len(its), n_pages=1, status="ok", error=None, url=None)])
        paths["queries/%s.parquet" % qid] = q
        for rel, t in paths.items():
            os.makedirs(os.path.dirname(os.path.join(out, rel)), exist_ok=True)
            pq.write_table(t, os.path.join(out, rel))
            files.append(rel)
        allrows["acquisitions"] += acqs; allrows["products"] += prods; allrows["assets"] += assets
    json.dump({"starc": 1, "files": sorted(files)}, open(os.path.join(out, "manifest.json"), "w"),
              indent=1)
    os.makedirs(flat)
    for name, rows in allrows.items():
        # consolidated: duplicates kept on purpose (dedup is the reader's job)
        pq.write_table(table(rows, name), os.path.join(flat, name + ".parquet"))
    print(len(files), "store files;", len(allrows["acquisitions"]), "acquisition rows")

if __name__ == "__main__":
    main()
