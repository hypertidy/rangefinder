"""Write a small NetCDF-4 style HDF5 file and its Kerchunk references.

python3 make_refs_fixture.py   -> fixtures/refs/sst.h5, sst.refs.json
Needs h5py and kerchunk (pip install h5py kerchunk); dev only.

sst[time=4, lat=30, lon=40] int16, chunked 1x15x20, shuffle + gzip,
scale_factor 0.01, add_offset 273.15, _FillValue -32768 over a "land"
corner. Value = 273.15 + 0.01 * (100 * t + lon index), so a read says which
slice and column it came from. lon 147..151, lat -41..-44 (north first),
days 2025-01-01..04. The references point at
http://localhost:8765/refs/sst.h5 (dev/server.mjs serves it with ranges).
"""
import json, os
import numpy as np
import h5py
from kerchunk.hdf import SingleHdf5ToZarr

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "refs")
os.makedirs(OUT, exist_ok=True)
path = os.path.join(OUT, "sst.h5")
NT, NY, NX = 4, 30, 40
with h5py.File(path, "w") as f:
    lon = f.create_dataset("lon", data=147 + (np.arange(NX) + 0.5) * 0.1)
    lon.attrs["units"] = "degrees_east"; lon.attrs["standard_name"] = "longitude"
    lat = f.create_dataset("lat", data=-41 - (np.arange(NY) + 0.5) * 0.1)
    lat.attrs["units"] = "degrees_north"; lat.attrs["standard_name"] = "latitude"
    tim = f.create_dataset("time", data=np.arange(NT, dtype="f8"))
    tim.attrs["units"] = "days since 2025-01-01"; tim.attrs["calendar"] = "standard"
    for d in (lon, lat, tim):
        d.make_scale(d.name.strip("/"))
    v = np.zeros((NT, NY, NX), dtype="i2")
    for t in range(NT):
        v[t] = (100 * t + np.arange(NX))[None, :]
    v[:, 20:, 30:] = -32768   # "land"
    sst = f.create_dataset("sst", data=v, chunks=(1, 15, 20), shuffle=True, compression="gzip",
                           fillvalue=-32768)
    sst.attrs["scale_factor"] = np.float32(0.01); sst.attrs["add_offset"] = np.float32(273.15)
    sst.attrs["_FillValue"] = np.int16(-32768); sst.attrs["units"] = "kelvin"
    sst.attrs["long_name"] = "test sea surface temperature"
    sst.dims[0].attach_scale(tim); sst.dims[1].attach_scale(lat); sst.dims[2].attach_scale(lon)
with open(path, "rb") as fh:
    refs = SingleHdf5ToZarr(fh, "http://localhost:8765/refs/sst.h5", inline_threshold=20).translate()
with open(os.path.join(OUT, "sst.refs.json"), "w") as fh:
    json.dump(refs, fh)
print("wrote", path, "and sst.refs.json:", len(refs["refs"]), "refs")
