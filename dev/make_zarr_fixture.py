"""Write a tiny Zarr v2 store with an extra (depth) dimension for the tests.

python3 make_zarr_fixture.py   -> fixtures/zarr4d/ (uncompressed, consolidated)

temp[time=3, depth=4, lat=20, lon=30], float32, chunks 1x2x10x10.
value = 100 * depth index + 10 * time index + lon index / 100, so a read
says exactly which slice it came from. lon 147..150, lat -44..-42 (cell
centres), depth 0/10/50/100 m (positive down), days 2025-01-01..03.
No third-party modules.
"""
import json, os, struct

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "zarr4d")
NT, ND, NY, NX = 3, 4, 20, 30
CH = [1, 2, 10, 10]
lon = [147 + (i + 0.5) * 0.1 for i in range(NX)]
lat = [-42 - (j + 0.5) * 0.1 for j in range(NY)]   # north to south
depth = [0.0, 10.0, 50.0, 100.0]
time = [0.0, 1.0, 2.0]

meta = {".zgroup": {"zarr_format": 2}, ".zattrs": {"title": "rangefinder 4-D fixture"}}

def arr(name, shape, chunks, dtype, attrs):
    meta[name + "/.zarray"] = {"zarr_format": 2, "shape": shape, "chunks": chunks, "dtype": dtype,
                               "compressor": None, "fill_value": None, "order": "C", "filters": None}
    meta[name + "/.zattrs"] = attrs

def write(path, data):
    p = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)

def f8(vals):
    return struct.pack("<%dd" % len(vals), *vals)

arr("lon", [NX], [NX], "<f8", {"_ARRAY_DIMENSIONS": ["lon"], "units": "degrees_east", "standard_name": "longitude"})
arr("lat", [NY], [NY], "<f8", {"_ARRAY_DIMENSIONS": ["lat"], "units": "degrees_north", "standard_name": "latitude"})
arr("depth", [ND], [ND], "<f8", {"_ARRAY_DIMENSIONS": ["depth"], "units": "m", "positive": "down",
                                  "long_name": "depth below surface"})
arr("time", [NT], [NT], "<f8", {"_ARRAY_DIMENSIONS": ["time"], "units": "days since 2025-01-01", "calendar": "standard"})
arr("temp", [NT, ND, NY, NX], CH, "<f4", {"_ARRAY_DIMENSIONS": ["time", "depth", "lat", "lon"],
                                          "units": "degC", "long_name": "test temperature", "_FillValue": "NaN"})
write("lon/0", f8(lon)); write("lat/0", f8(lat)); write("depth/0", f8(depth)); write("time/0", f8(time))
for t in range(NT):
    for dc in range(ND // CH[1]):
        for yc in range(NY // CH[2]):
            for xc in range(NX // CH[3]):
                vals = []
                for d in range(dc * CH[1], (dc + 1) * CH[1]):
                    for y in range(yc * CH[2], (yc + 1) * CH[2]):
                        for x in range(xc * CH[3], (xc + 1) * CH[3]):
                            vals.append(100 * d + 10 * t + x / 100)
                write("temp/%d.%d.%d.%d" % (t, dc, yc, xc), struct.pack("<%df" % len(vals), *vals))
for k, v in meta.items():
    write(k, json.dumps(v).encode())
write(".zmetadata", json.dumps({"zarr_consolidated_format": 1, "metadata": meta}).encode())
print("wrote", OUT)
