// HEALPix Zarr v2 stores for the tests, uncompressed and consolidated.
//
// node make_healpix_fixture.mjs   -> fixtures/healpix/ (served at /hp/)
//
// Every value is its own cell id (plus 1000 x the time index), so a read
// says exactly which cell each pixel came from, with no tolerance.
//   l3-crs.zarr       pr[time=2, cell=768] f4, chunks 1 x 256: level 3
//                     nested, described only by a scalar "crs" variable
//                     (grid_mapping_name healpix, healpix_nside 8,
//                     healpix_order nest), the DKRZ / easy.gems layout;
//                     no coordinate for "cell"
//   l3-ring.zarr      tas[cells=768] f4, chunks 256: level 3 ring, xdggs
//                     style (cell_ids 0..767 with grid_name / level /
//                     indexing_scheme); no time axis
//   l7-root.zarr      pr[time=1, cell=196608] f4, chunks 1 x 4096: level 7
//                     nested (EERIE's size), described only by a crs
//                     attribute dictionary on the root group
//   l8-regional.zarr  sst[cells=n] f8, chunks 500: level 8 nested on the
//                     WGS84 ellipsoid, only the cells whose centres are in
//                     lon 140..150, lat -45..-38, listed in cell_ids in
//                     descending order (so index != id)
// Needs healpix-geo (npm install in dev/).
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
import * as bg from "healpix-geo/healpix_geo_bg.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "fixtures", "healpix");
const wasm = fs.readFileSync(path.join(HERE, "node_modules/healpix-geo/healpix_geo_bg.wasm"));
const { instance } = await WebAssembly.instantiate(wasm, { "./healpix_geo_bg.js": bg });
bg.__wbg_set_wasm(instance.exports); instance.exports.__wbindgen_start();

function store(name, arrays, rootAttrs) {
  const dir = path.join(OUT, name), meta = { ".zgroup": { zarr_format: 2 }, ".zattrs": rootAttrs || {} };
  fs.rmSync(dir, { recursive: true, force: true });
  for (const a of arrays) {
    meta[a.name + "/.zarray"] = { zarr_format: 2, shape: a.shape, chunks: a.chunks, dtype: a.dtype,
      compressor: null, fill_value: a.fill === undefined ? null : a.fill, order: "C", filters: null };
    meta[a.name + "/.zattrs"] = Object.assign({ _ARRAY_DIMENSIONS: a.dims }, a.attrs || {});
    fs.mkdirSync(path.join(dir, a.name), { recursive: true });
    // chunks: 0-d, 1-d or 2-d with the last dimension chunked
    const T = a.shape.length === 2 ? a.shape[0] : 1, n = a.shape[a.shape.length - 1] || 1;
    const c = a.chunks[a.chunks.length - 1] || 1, Ctor = { "<f4": Float32Array, "<f8": Float64Array, "<i8": BigInt64Array }[a.dtype];
    for (let t = 0; t < T; t++) {
      for (let k = 0; k * c < n; k++) {
        const buf = new Ctor(c);
        for (let i = 0; i < c; i++) {
          const j = k * c + i, x = j < n ? a.value(t, j) : 0;
          buf[i] = Ctor === BigInt64Array ? BigInt(x) : x;
        }
        const key = a.shape.length === 0 ? "0" : a.shape.length === 1 ? String(k) : t + "." + k;
        fs.writeFileSync(path.join(dir, a.name, key), Buffer.from(buf.buffer));
      }
    }
    fs.writeFileSync(path.join(dir, a.name, ".zarray"), JSON.stringify(meta[a.name + "/.zarray"]));
    fs.writeFileSync(path.join(dir, a.name, ".zattrs"), JSON.stringify(meta[a.name + "/.zattrs"]));
  }
  fs.writeFileSync(path.join(dir, ".zgroup"), JSON.stringify(meta[".zgroup"]));
  fs.writeFileSync(path.join(dir, ".zattrs"), JSON.stringify(meta[".zattrs"]));
  fs.writeFileSync(path.join(dir, ".zmetadata"), JSON.stringify({ zarr_consolidated_format: 1, metadata: meta }));
}

store("l3-crs.zarr", [
  { name: "crs", shape: [], chunks: [], dtype: "<f4", dims: [], value: () => 0,
    attrs: { grid_mapping_name: "healpix", healpix_nside: 8, healpix_order: "nest" } },
  { name: "time", shape: [2], chunks: [2], dtype: "<f8", dims: ["time"], value: (t, j) => j,
    attrs: { units: "days since 2020-01-15", calendar: "standard" } },
  { name: "pr", shape: [2, 768], chunks: [1, 256], dtype: "<f4", dims: ["time", "cell"], fill: "NaN",
    value: (t, j) => j + 1000 * t, attrs: { units: "kg m-2 s-1", long_name: "precipitation (cell id + 1000 t)" } }
], { title: "rangefinder HEALPix fixture, DKRZ style" });

store("l3-ring.zarr", [
  { name: "cell_ids", shape: [768], chunks: [768], dtype: "<i8", dims: ["cells"], value: (t, j) => j,
    attrs: { grid_name: "healpix", level: 3, indexing_scheme: "ring" } },
  { name: "tas", shape: [768], chunks: [256], dtype: "<f4", dims: ["cells"], value: (t, j) => j,
    attrs: { units: "1", long_name: "cell id" } }
]);

store("l7-root.zarr", [
  { name: "time", shape: [1], chunks: [1], dtype: "<f8", dims: ["time"], value: () => 0,
    attrs: { units: "days since 2020-01-15", calendar: "standard" } },
  { name: "pr", shape: [1, 196608], chunks: [1, 4096], dtype: "<f4", dims: ["time", "cell"], fill: "NaN",
    value: (t, j) => j, attrs: { units: "1", long_name: "cell id" } }
], { crs: { healpix_nside: 128, healpix_order: "nest" } });

const WGS84 = { semi_major_axis: 6378137, inverse_flattening: 298.257223563 };
const g6 = new bg.Grid({ scheme: "nested", level: 8, ellipsoid: WGS84 });
const all = new BigUint64Array(12 * 256 * 256);
for (let i = 0; i < all.length; i++) all[i] = BigInt(i);
const cen = g6.healpixToLonLat(all), ids = [];
for (let i = 0; i < all.length; i++) {
  const lo = cen[2 * i], la = cen[2 * i + 1];
  if (lo >= 140 && lo <= 150 && la >= -45 && la <= -38) ids.push(i);
}
ids.reverse();
store("l8-regional.zarr", [
  { name: "cell_ids", shape: [ids.length], chunks: [ids.length], dtype: "<i8", dims: ["cells"], value: (t, j) => ids[j],
    attrs: { grid_name: "healpix", level: 8, indexing_scheme: "nested", ellipsoid: Object.assign({ name: "WGS84" }, WGS84) } },
  { name: "sst", shape: [ids.length], chunks: [500], dtype: "<f8", dims: ["cells"], value: (t, j) => ids[j],
    attrs: { units: "1", long_name: "cell id" } }
]);
console.log("wrote", OUT, "regional cells:", ids.length);
