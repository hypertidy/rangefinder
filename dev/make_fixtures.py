"""Build dev fixtures from the public sentinel-cogs bucket.

items.json: real Earth Search v1 items (stored next to each scene) for a few
MGRS squares in Tasmania (Jan 2025) and across the UTM 54/55 seam in
Victoria (Feb 2025). wt/: a 2x2 block of wildtiles-format tiles cut from two
55GEN scenes plus an inventory.parquet, to exercise the wildtiles binding.

Needs: pip install rasterio pyarrow
"""
import datetime, json, os, re, urllib.request
import pyarrow as pa, pyarrow.parquet as pq
import rasterio
from rasterio.transform import from_origin
from rasterio.warp import transform
from rasterio.windows import from_bounds

B = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/"
HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

def items():
    out = []
    for sq, ym in [("55/G/EN", "2025/1"), ("55/G/DN", "2025/1"), ("55/G/EP", "2025/1"),
                   ("55/G/DP", "2025/1"), ("54/H/YD", "2025/2"), ("55/H/BU", "2025/2"),
                   ("54/H/YE", "2025/2"), ("55/H/BV", "2025/2")]:
        pre = "sentinel-s2-l2a-cogs/%s/%s/" % (sq, ym)
        x = urllib.request.urlopen(B + "?list-type=2&delimiter=/&prefix=" + pre).read().decode()
        for p in re.findall(r"<Prefix>([^<]*L2A/)</Prefix>", x):
            sid = p.rstrip("/").split("/")[-1]
            out.append(json.load(urllib.request.urlopen(B + p + sid + ".json")))
    json.dump(out, open(os.path.join(HERE, "items.json"), "w"))
    print(len(out), "items")

def wildtiles():
    OX, OY, TS = 140000, 20000, 7200
    xs, ys = transform("EPSG:4326", "EPSG:32755", [147.45], [-42.9])
    c0, r0 = int((xs[0] - OX) // TS), int((ys[0] - OY) // TS)
    src_dir = "/vsicurl/" + B + "sentinel-s2-l2a-cogs/55/G/EN/2025/1/"
    scenes = {"2025-01-03": "S2A_55GEN_20250103_0_L2A", "2025-01-08": "S2B_55GEN_20250108_0_L2A"}
    bands = {"visual": "TCI", "red": "B04", "green": "B03", "blue": "B02"}
    rows = []
    for day, sid in scenes.items():
        for key, f in bands.items():
            with rasterio.open(src_dir + sid + "/" + f + ".tif") as src:
                for dc in (0, 1):
                    for dr in (0, 1):
                        c, r = c0 + dc, r0 + dr
                        tid = "55S_R0010_%04d_%04d" % (c, r)
                        xmin, ymin = OX + c * TS, OY + r * TS
                        a = src.read(window=from_bounds(xmin, ymin, xmin + TS, ymin + TS, src.transform),
                                     boundless=True, fill_value=0)
                        d = os.path.join(HERE, "wt/cube", tid, key)
                        os.makedirs(d, exist_ok=True)
                        prof = dict(driver="GTiff", width=720, height=720, count=a.shape[0],
                                    dtype=a.dtype, crs="EPSG:32755", nodata=0,
                                    transform=from_origin(xmin, ymin + TS, 10, 10),
                                    compress="deflate", tiled=True, blockxsize=256, blockysize=256)
                        with rasterio.open(os.path.join(d, day + ".tif"), "w", **prof) as dst:
                            dst.write(a)
                        rows.append((tid, key, day))
    os.makedirs(os.path.join(HERE, "wt/index"), exist_ok=True)
    pq.write_table(pa.table({
        "tile_id": [r[0] for r in rows], "band": [r[1] for r in rows],
        "solarday": pa.array([datetime.date.fromisoformat(r[2]) for r in rows], type=pa.date32())}),
        os.path.join(HERE, "wt/index/inventory.parquet"))
    print(len(rows), "wildtiles files")

if __name__ == "__main__":
    os.makedirs(HERE, exist_ok=True)
    items()
    wildtiles()
