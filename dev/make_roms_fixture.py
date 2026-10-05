"""A real ROMS grid for the curvilinear tests: three hours of NOAA's
Chesapeake Bay model (CBOFS) from the noaa-nos-ofs-pds bucket.

python3 make_roms_fixture.py [YYYYMMDD]   -> fixtures/refs/roms/

Writes, served by dev/server.mjs under /refs/roms/:
  cbofs.fNNN.nc     the model's own NetCDF-4 files (about 60 MB each)
  cbofs.refs.json   Kerchunk references to all three, joined on ocean_time
                    (a "virtual" store; the chunks stay in the .nc files)
  cbofs.zarr/       the same variables copied into a Zarr v2 store (zlib),
                    with consolidated metadata (a "materialized" store)

The bucket does not allow cross-origin reads, so a web page cannot use the
references to the bucket itself; the tests read the local copies.
Needs h5py, numpy and kerchunk (pip install h5py kerchunk); dev only.
"""
import json, os, sys, urllib.request, zlib
import numpy as np
import h5py

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures", "refs", "roms")
BASE = "http://localhost:8765/refs/roms/"
DAY = sys.argv[1] if len(sys.argv) > 1 else "20260901"
HOURS = ["f001", "f002", "f003"]
os.makedirs(OUT, exist_ok=True)

files = []
for h in HOURS:
    name = "cbofs.%s.nc" % h
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        url = ("https://noaa-nos-ofs-pds.s3.amazonaws.com/cbofs/netcdf/%s/%s/%s/cbofs.t00z.%s.fields.%s.nc"
               % (DAY[:4], DAY[4:6], DAY[6:], DAY, h))
        print("fetching", url)
        urllib.request.urlretrieve(url, path + ".part")
        os.replace(path + ".part", path)
    files.append(path)

# --- the virtual store -------------------------------------------------------------
from kerchunk.hdf import SingleHdf5ToZarr
from kerchunk.combine import MultiZarrToZarr

singles = []
for p in files:
    with open(p, "rb") as fh:
        singles.append(SingleHdf5ToZarr(fh, p, inline_threshold=300).translate())
KEEP_REFS = ["temp", "salt", "zeta", "u", "v", "h", "mask_rho", "lon_rho", "lat_rho", "lon_u", "lat_u",
             "lon_v", "lat_v", "lon_psi", "lat_psi", "s_rho", "Cs_r", "hc", "Vtransform", "ocean_time"]
mzz = MultiZarrToZarr(singles, concat_dims=["ocean_time"],
                      identical_dims=[k for k in KEEP_REFS if k not in ("temp", "salt", "zeta", "u", "v", "ocean_time")],
                      preprocess=lambda r: {k: v for k, v in r.items()
                                            if k.startswith(".") or k.split("/")[0] in KEEP_REFS})
refs = mzz.translate()
# combined from the local paths (the combiner reads ocean_time), served over http
for k, v in refs["refs"].items():
    if isinstance(v, list) and v and isinstance(v[0], str) and v[0].startswith(OUT):
        v[0] = BASE + os.path.basename(v[0])
with open(os.path.join(OUT, "cbofs.refs.json"), "w") as fh:
    json.dump(refs, fh)

# --- the materialized store ----------------------------------------------------------
ZOUT = os.path.join(OUT, "cbofs.zarr")
meta = {".zgroup": {"zarr_format": 2},
        ".zattrs": {"title": "CBOFS (ROMS) " + DAY + " " + ",".join(HOURS) + ", copied for rangefinder tests"}}

def text(v):
    if isinstance(v, bytes):
        return v.decode()
    if isinstance(v, np.ndarray):
        return [text(x) for x in v.tolist()] if v.size > 1 else text(v.reshape(-1)[0])
    if isinstance(v, (np.floating, float)):
        return float(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    return v

def write(path, data):
    p = os.path.join(ZOUT, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)

def put(name, data, dims, attrs, chunks=None):
    data = np.asarray(data)
    data = data.astype(data.dtype.newbyteorder("<"))
    chunks = list(chunks or data.shape)
    a = {k: text(v) for k, v in attrs.items()
         if k not in ("DIMENSION_LIST", "REFERENCE_LIST", "CLASS", "NAME", "_Netcdf4Dimid", "_Netcdf4Coordinates")
         and not (isinstance(v, np.ndarray) and v.dtype.kind == "O")}
    fill = a.pop("_FillValue", None)
    meta[name + "/.zarray"] = {"zarr_format": 2, "shape": list(data.shape), "chunks": chunks,
                               "dtype": data.dtype.str, "compressor": {"id": "zlib", "level": 5},
                               "fill_value": fill, "order": "C", "filters": None}
    a["_ARRAY_DIMENSIONS"] = dims
    meta[name + "/.zattrs"] = a
    grid = [range(0, s, c) for s, c in zip(data.shape, chunks)] if data.ndim else [[0]]
    import itertools
    for idx in itertools.product(*grid):
        sl = tuple(slice(i, i + c) for i, c in zip(idx, chunks))
        block = np.zeros(chunks, dtype=data.dtype)
        part = data[sl]
        block[tuple(slice(0, s) for s in part.shape)] = part
        key = ".".join(str(i // c) for i, c in zip(idx, chunks)) if data.ndim else "0"
        write(name + "/" + key, zlib.compress(block.tobytes(), 5))

hs = [h5py.File(p, "r") for p in files]
f0 = hs[0]
def dims_of(v):
    return [os.path.basename(d[0].name) if len(d) else "dim%d" % i for i, d in enumerate(v.dims)]
for name in ["h", "mask_rho", "lon_rho", "lat_rho", "lon_u", "lat_u", "lon_psi", "lat_psi", "s_rho", "Cs_r"]:
    put(name, f0[name][()], dims_of(f0[name]), dict(f0[name].attrs))
for name in ["hc", "Vtransform"]:
    put(name, np.asarray([f0[name][()]]).reshape(()), [], dict(f0[name].attrs))
put("ocean_time", np.concatenate([h["ocean_time"][()] for h in hs]), ["ocean_time"], dict(f0["ocean_time"].attrs))
for name, ch in [("zeta", [1, 291, 332]), ("temp", [1, 10, 146, 166]), ("salt", [1, 10, 146, 166]),
                 ("u", [1, 10, 146, 166])]:
    put(name, np.concatenate([h[name][()] for h in hs]), dims_of(f0[name]), dict(f0[name].attrs), ch)
for k, v in meta.items():
    write(k, json.dumps(v).encode())
write(".zmetadata", json.dumps({"zarr_consolidated_format": 1, "metadata": meta}).encode())
print("wrote", OUT, "(", len(refs["refs"]), "refs )")
