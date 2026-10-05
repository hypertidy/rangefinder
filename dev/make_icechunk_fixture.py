"""Write small Icechunk repositories for the tests (needs icechunk, zarr, numpy).

python3 make_icechunk_fixture.py   -> fixtures/icechunk/sst/ (served at /ic/sst)

sst[time=3, lat=40, lon=60], float32, Zarr v3 written through Icechunk:
value = 10 * time index + lon index / 100 + lat index / 10000, so a read says
exactly which cell and day it came from. lon 140..152, lat -36..-44 (0.2
degree cell centres, north to south), days 2025-01-01..03. The array is
sharded (shards 1x20x30 of inner chunks 1x10x10) so reads go through
getRange. Two commits on main: the first has day 2 all zeros, the second
fixes it; tag "v1" points at the first, so ?tag=v1 or its snapshot id reads
the old values. The repository name has no ".icechunk", so opening it by
URL exercises the sniff.
"""
import json, os, shutil
import numpy as np
import icechunk, zarr

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "icechunk", "sst")
NT, NY, NX = 3, 40, 60
lon = 140 + (np.arange(NX) + 0.5) * 0.2
lat = -36 - (np.arange(NY) + 0.5) * 0.2

def values():
    t, j, i = np.meshgrid(np.arange(NT), np.arange(NY), np.arange(NX), indexing="ij")
    return (10 * t + i / 100 + j / 10000).astype("float32")

shutil.rmtree(OUT, ignore_errors=True)
repo = icechunk.Repository.create(icechunk.local_filesystem_storage(OUT))
s = repo.writable_session("main")
g = zarr.group(store=s.store, attributes={"title": "rangefinder Icechunk fixture"})
def coord(name, vals, attrs):
    a = g.create_array(name, shape=vals.shape, dtype=vals.dtype, dimension_names=[name])
    a[:] = vals; a.attrs.update(attrs)
coord("lon", lon, {"units": "degrees_east", "standard_name": "longitude"})
coord("lat", lat, {"units": "degrees_north", "standard_name": "latitude"})
coord("time", np.arange(NT, dtype="float64"), {"units": "days since 2025-01-01", "calendar": "standard"})
v = values()
first = v.copy(); first[2] = 0
a = g.create_array("sst", shape=v.shape, dtype="float32", chunks=(1, 10, 10), shards=(1, 20, 30),
                   dimension_names=["time", "lat", "lon"], fill_value=float("nan"))
a.attrs.update({"units": "K", "long_name": "synthetic sst"})
a[:] = first
snap1 = s.commit("first, day 3 zeros")
repo.create_tag("v1", snap1)
s = repo.writable_session("main")
zarr.open_array(store=s.store, path="sst")[2] = v[2]
snap2 = s.commit("fix day 3")
with open(os.path.join(OUT, "..", "snapshots.json"), "w") as f:
    json.dump({"v1": snap1, "main": snap2}, f)
print("wrote", OUT, "v1", snap1, "main", snap2)
