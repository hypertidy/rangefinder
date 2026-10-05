"""Write a tiny rectilinear Zarr v2 store (unevenly spaced latitude) for the tests.

python3 make_rect_fixture.py   -> fixtures/rect/ (uncompressed, consolidated)

lat[y] runs from -44.95 by 0.1 to -40.05, then by 0.5 from -39.75 to -36.25
(like HYCOM's GLBv0.08, whose spacing changes at 40S and 40N); lon 140..150
by 0.1. v[lat, lon] = the cell's own latitude, so a read shows directly
whether each pixel came from the right row. No third-party modules.
"""
import json, os, struct

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "rect")
lat = [-44.95 + 0.1 * j for j in range(50)] + [-39.75 + 0.5 * j for j in range(8)]
lon = [140.05 + 0.1 * i for i in range(100)]
NY, NX = len(lat), len(lon)
meta = {".zgroup": {"zarr_format": 2}, ".zattrs": {"title": "rangefinder rectilinear fixture"}}
def arr(name, shape, chunks, attrs):
    meta[name + "/.zarray"] = {"zarr_format": 2, "shape": shape, "chunks": chunks, "dtype": "<f8",
                               "compressor": None, "fill_value": None, "order": "C", "filters": None}
    meta[name + "/.zattrs"] = attrs
def write(path, data):
    p = os.path.join(OUT, path); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(data)
f8 = lambda vals: struct.pack("<%dd" % len(vals), *vals)
arr("lon", [NX], [NX], {"_ARRAY_DIMENSIONS": ["lon"], "units": "degrees_east"})
arr("lat", [NY], [NY], {"_ARRAY_DIMENSIONS": ["lat"], "units": "degrees_north"})
arr("v", [NY, NX], [20, 50], {"_ARRAY_DIMENSIONS": ["lat", "lon"], "units": "degrees_north", "long_name": "cell latitude"})
write("lon/0", f8(lon)); write("lat/0", f8(lat))
for cj in range(0, NY, 20):
    for ci in range(0, NX, 50):
        vals = [lat[j] if j < NY and i < NX else 0.0 for j in range(cj, cj + 20) for i in range(ci, ci + 50)]
        write("v/%d.%d" % (cj // 20, ci // 50), f8(vals))
for k, m in meta.items():
    write(k, json.dumps(m).encode())
write(".zmetadata", json.dumps({"zarr_consolidated_format": 1, "metadata": meta}).encode())
print("wrote", OUT)
