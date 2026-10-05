// Discrete global grids (DGGS) for the Zarr source: HEALPix for now.
//
// A HEALPix variable has one spatial dimension and no coordinate arrays
// worth reading: a cell's place is implied by its index, the refinement
// level and the indexing scheme (nested or ring). So the geometry is a
// recipe, and it has an inverse: for any lon/lat the cell is a closed
// computation (healpix-geo, wasm, loaded on demand). A read takes each
// output pixel's centre to lon/lat, to a cell id, to an index along the
// cell dimension, and reads the chunks those indices fall in; no
// footprints or rasterising. Footprints (cornersOf) are only for drawing
// a cell's outline and for the check in dev/test-healpix.mjs.
//
// Detection follows three conventions (see docs/healpix.md, section 2):
// xdggs / the Zarr DGGS convention (grid_name / dggs attributes, usually on
// a cell_ids coordinate), a CF grid mapping (grid_mapping_name "healpix",
// healpix_nside, healpix_order) and DKRZ's crs attribute dictionary. A
// store that lists its cells (a cell_ids coordinate that is not simply
// 0 .. 12 nside^2 - 1, as for a regional subset) is read through that list.
//
// The v.dggs object is shaped so another DGGS (S2, H3) is another
// cellsOf / cornersOf, not another source.

import { ensureCrs } from "./geo.js";
import { centresBbox } from "./curvilinear.js";

// healpix-geo is built for bundlers (it imports its .wasm as a module), so
// its two files are loaded by hand: the JS glue as a module, the wasm
// instantiated against it. Pinned to one version, as the two must match.
var HP_BASES = ["https://cdn.jsdelivr.net/npm/healpix-geo@0.3.3/", "https://unpkg.com/healpix-geo@0.3.3/"];
var hpmod = null;
export function healpixGeo() {
  if (!hpmod) {
    hpmod = (async function () {
      var last;
      for (var i = 0; i < HP_BASES.length; i++) {
        try {
          var bg = await import(HP_BASES[i] + "healpix_geo_bg.js");
          var r = await fetch(HP_BASES[i] + "healpix_geo_bg.wasm");
          if (!r.ok) throw new Error("HTTP " + r.status + " for healpix_geo_bg.wasm");
          var inst = (await WebAssembly.instantiate(await r.arrayBuffer(), { "./healpix_geo_bg.js": bg })).instance;
          bg.__wbg_set_wasm(inst.exports);
          inst.exports.__wbindgen_start();
          return bg;
        } catch (e) { last = e; }
      }
      throw new Error("could not load healpix-geo: " + (last && last.message || last));
    })();
    hpmod.catch(function () { hpmod = null; });
  }
  return hpmod;
}

// --- detection ----------------------------------------------------------------------------

var SCHEMES = { nest: "nested", nested: "nested", ring: "ring", zuniq: "zuniq" };
var ELLIPSOIDS = {
  wgs84: { semi_major_axis: 6378137, inverse_flattening: 298.257223563 },
  grs80: { semi_major_axis: 6378137, inverse_flattening: 298.257222101 }
};

function given(x) { return x !== undefined && x !== null && x !== ""; }

// The reference body the attributes name -> { spec (for healpix-geo's Grid,
// null for its default sphere), label, assumed }
function ellipsoidOf(e, cf) {
  if (cf && given(cf.semi_major_axis) && given(cf.inverse_flattening) && +cf.inverse_flattening > 0) {
    e = { semi_major_axis: +cf.semi_major_axis, inverse_flattening: +cf.inverse_flattening };
  } else if (cf && given(cf.earth_radius)) e = { radius: +cf.earth_radius };
  if (typeof e === "string") {
    var k = e.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ELLIPSOIDS[k]) return { spec: ELLIPSOIDS[k], label: "the " + e + " ellipsoid (named in the attributes)", assumed: false };
    if (/sphere/.test(k)) return { spec: null, label: "a sphere (named in the attributes)", assumed: false };
    return { spec: null, label: "a sphere: the attributes name the body \"" + e + "\", which is not recognised", assumed: true };
  }
  if (e && typeof e === "object") {
    var a = +(e.semi_major_axis || e.semimajor_axis || e.a || e.radius);
    if (given(e.radius) && a > 0) return { spec: { radius: a }, label: "a sphere of radius " + a + " m (from the attributes)", assumed: false };
    var nm = e.name ? "the " + e.name + " ellipsoid, " : "an ellipsoid ";
    if (a > 0 && +e.inverse_flattening > 0) {
      return { spec: { semi_major_axis: a, inverse_flattening: +e.inverse_flattening },
               label: nm + "a = " + a + " m, 1/f = " + +e.inverse_flattening + " (from the attributes)", assumed: false };
    }
    if (a > 0 && +e.semi_minor_axis > 0) {
      return { spec: { semi_major_axis: a, semi_minor_axis: +e.semi_minor_axis },
               label: nm + "a = " + a + " m, b = " + +e.semi_minor_axis + " m (from the attributes)", assumed: false };
    }
    if (e.name) return ellipsoidOf(String(e.name));
  }
  return { spec: null, label: "a sphere (none named in the attributes; healpix-geo's default, radius 6370997 m)", assumed: true };
}

// HEALPix parameters in one attribute set -> { level, nside, scheme,
// schemeAssumed, ellipsoid, how, dim, coord } | null
export function healpixAttrs(a) {
  if (!a || typeof a !== "object") return null;
  var c = null, d = a.dggs;
  if (d && typeof d === "object" && /healpix/i.test(String(d.name || d.grid_name || ""))) {
    c = { level: given(d.refinement_level) ? d.refinement_level : d.level, nside: d.nside, order: d.indexing_scheme,
          ell: d.ellipsoid, how: "the dggs attribute (Zarr DGGS convention)", dim: d.spatial_dimension, coord: d.coordinate };
  } else if (/^healpix$/i.test(String(a.grid_name || ""))) {
    c = { level: given(a.level) ? a.level : given(a.refinement_level) ? a.refinement_level : a.resolution,
          nside: a.nside, order: a.indexing_scheme, ell: a.ellipsoid, how: "xdggs attributes (grid_name healpix)" };
  } else if (/^healpix$/i.test(String(a.grid_mapping_name || ""))) {
    c = { nside: a.healpix_nside, level: a.refinement_level, order: a.healpix_order || a.indexing_scheme,
          ell: a.ellipsoid || a.reference_ellipsoid_name, cf: a, how: "a CF grid mapping (grid_mapping_name healpix)" };
  } else if (given(a.healpix_nside)) {
    c = { nside: a.healpix_nside, order: a.healpix_order, ell: a.ellipsoid, how: "healpix_nside / healpix_order attributes" };
  } else if (a.crs && typeof a.crs === "object") {
    var r = healpixAttrs(a.crs);
    if (r) r.how = "the crs attribute dictionary (" + r.how + ")";
    return r;
  }
  if (!c) return null;
  var level = given(c.level) ? +c.level : given(c.nside) ? Math.log2(+c.nside) : NaN;
  if (!(Number.isInteger(level) && level >= 0 && level <= 29)) {
    return { bad: "HEALPix attributes in " + c.how + " give " + (given(c.nside) ? "nside " + c.nside : "level " + c.level) +
                  ", which is not a power of two up to 2^29" };
  }
  var scheme = SCHEMES[String(c.order || "nested").toLowerCase()];
  if (!scheme) return { bad: "HEALPix indexing scheme \"" + c.order + "\" (in " + c.how + ") is not nested, ring or zuniq" };
  return { level: level, nside: Math.pow(2, level), scheme: scheme, schemeAssumed: !given(c.order),
           ellipsoid: ellipsoidOf(c.ell, c.cf), how: c.how, dim: c.dim || null, coord: c.coord || null };
}

// Is this array a HEALPix variable, and along which dimension?
//   at(path) -> Promise<array>   (zarr.js arrayAt for this dataset)
// -> null, or { hp (healpixAttrs), axis, dim, ncell, cellIds (array) | null,
//   on: where the attributes were found }; throws with a specific message
// when the attributes are there but the shape does not fit them.
export async function findHealpix(name, arr, dims, parent, rootAttrs, at) {
  var a = arr.attrs || {};
  function tryAt(p) { return at(p).then(function (x) { return x; }, function () { return null; }); }
  var hp = healpixAttrs(a), on = "the variable";
  var cands = [];
  if (!hp) {
    if (a.grid_mapping) cands.push(String(a.grid_mapping).split(/[\s:]+/)[0]);
    var co = Array.isArray(a.coordinates) ? a.coordinates : String(a.coordinates || "").split(/\s+/);
    co.forEach(function (n) { if (n) cands.push(n); });
    dims.forEach(function (d) { cands.push(d); });
    cands.push("cell_ids", "crs");
    var seen = {};
    for (var i = 0; i < cands.length && !hp; i++) {
      if (seen[cands[i]]) continue;
      seen[cands[i]] = 1;
      var c = await tryAt(parent + "/" + cands[i]);
      if (c && (hp = healpixAttrs(c.attrs))) on = "\"" + cands[i] + "\"";
    }
  }
  if (!hp && (hp = healpixAttrs(rootAttrs))) on = "the root group";
  if (!hp) return null;
  if (hp.bad) throw new Error(name + ": " + hp.bad);
  var ncell = 12 * hp.nside * hp.nside;
  if (ncell > Math.pow(2, 53)) throw new Error(name + ": HEALPix level " + hp.level + " has more cells than a JS number can index");
  // the cell list: the coordinate the attributes name, else cell_ids, else
  // a coordinate named after a dimension, when it is 1D along one of them
  var cellIds = null, axis = -1;
  var names = [hp.coord, "cell_ids", "cell_id"].concat(dims.filter(function (d) { return /cell/i.test(d); }));
  if (/^"/.test(on)) names.push(on.slice(1, -1));
  for (var k = 0; k < names.length && !cellIds; k++) {
    var ca = names[k] && await tryAt(parent + "/" + names[k]);
    var cd = ca && (ca.dimensionNames || (ca.attrs && ca.attrs._ARRAY_DIMENSIONS));
    if (ca && ca.shape.length === 1 && cd && dims.indexOf(cd[0]) >= 0 && /int/.test(ca.dtype)) {
      cellIds = ca; axis = dims.indexOf(cd[0]);
    }
  }
  if (axis < 0 && hp.dim) axis = dims.indexOf(hp.dim);
  if (axis < 0) axis = arr.shape.indexOf(ncell);
  var label = "HEALPix grid (nside " + hp.nside + ", " + hp.scheme + ")";
  if (axis < 0) {
    throw new Error(name + ": " + label + " in " + on + "'s attributes, but none of its dimensions [" + dims.join(", ") +
                    "] has 12 x nside^2 = " + ncell + " cells and no cell_ids coordinate lists them");
  }
  if (!cellIds && arr.shape[axis] !== ncell) {
    throw new Error(name + ": " + label + ", but dimension " + dims[axis] + " has " + arr.shape[axis] +
                    " cells, not 12 x nside^2 = " + ncell + ", and no cell_ids coordinate lists them");
  }
  return { hp: hp, axis: axis, dim: dims[axis], ncell: ncell, cellIds: cellIds, on: on, label: label };
}

// --- the geometry object --------------------------------------------------------------------

// f = findHealpix's result; readIds() -> Promise<typed array of the cell ids>
// (only called when the store lists its cells).
// -> v.dggs: { kind, level, nside, scheme, ncell, n, dim, axis, grid, sparse,
//   cellDeg, bbox, how, ellipsoid, cellsOf, indexOf, cornersOf, centresOf }
export async function healpixGeometry(f, n, readIds) {
  var hg = await healpixGeo();
  var hp = f.hp;
  var opts = { scheme: hp.scheme, level: hp.level };
  if (hp.ellipsoid.spec) opts.ellipsoid = hp.ellipsoid.spec;
  var grid = new hg.Grid(opts);
  var g = {
    kind: "healpix", level: hp.level, nside: hp.nside, scheme: hp.scheme, schemeAssumed: hp.schemeAssumed,
    ncell: f.ncell, n: n, dim: f.dim, axis: f.axis, grid: grid, sparse: false, idsFrom: "",
    // cells of equal area: the side of a square of that area, in degrees
    cellDeg: Math.sqrt(4 * Math.PI / f.ncell) * 180 / Math.PI,
    bbox: [-180, -90, 180, 90],
    how: f.on + " (" + hp.how + ")", ellipsoid: hp.ellipsoid,
    cells: new Map()   // per output grid: the index under each pixel
  };
  // the store's own list of cells: unless it is plainly 0 .. ncell - 1, a
  // sorted copy and its permutation take a cell id to its index
  var sorted = null, perm = null, num = null;
  if (f.cellIds) {
    var full = n === f.ncell && hp.scheme !== "zuniq";
    if (full && n > 3200000) {
      g.idsFrom = "cell_ids taken as 0 .. " + (n - 1) + " (too long to check)";
    } else {
      var ids = await readIds();
      var arange = full;
      for (var i = 0; arange && i < n; i++) if (Number(ids[i]) !== i) arange = false;
      if (arange) g.idsFrom = "cell_ids checked: 0 .. " + (n - 1);
      else {
        num = new Float64Array(n);
        for (var j = 0; j < n; j++) num[j] = Number(ids[j]);
        perm = new Int32Array(n);
        for (var q = 0; q < n; q++) perm[q] = q;
        perm.sort(function (x, y) { return num[x] - num[y]; });
        sorted = new Float64Array(n);
        for (var s = 0; s < n; s++) sorted[s] = num[perm[s]];
        g.sparse = true;
        g.idsFrom = "the cell_ids coordinate lists " + n + " of the " + f.ncell + " cells" +
                    (n < f.ncell ? " (a regional subset)" : "");
        // where the listed cells are: their centres, plus half a cell
        var step = Math.max(1, Math.floor(n / 200000)), m = Math.ceil(n / step);
        var some = new BigUint64Array(m);
        for (var t = 0; t < m; t++) some[t] = BigInt(num[t * step]);
        var ll = grid.healpixToLonLat(some), lo = new Float64Array(m), la = new Float64Array(m);
        for (var u = 0; u < m; u++) { lo[u] = ll[2 * u]; la[u] = ll[2 * u + 1]; }
        var b = centresBbox(lo, la), pad = g.cellDeg;
        g.bbox = [Math.max(-180, b[0] - (b[0] > -180 ? pad : 0)), Math.max(-90, b[1] - pad),
                  Math.min(180, b[2] + (b[2] < 180 ? pad : 0)), Math.min(90, b[3] + pad)];
      }
    }
  }
  // lon/lat pairs (Float64Array, interleaved) -> cell ids (BigUint64Array)
  g.cellsOf = function (lonlats) { return grid.lonLatToHealpix(lonlats); };
  // cell ids -> index along the cell dimension (-1 when not in the store)
  g.indexOf = function (ids) {
    var out = new Float64Array(ids.length);
    for (var k = 0; k < ids.length; k++) {
      var id = Number(ids[k]);
      if (!sorted) { out[k] = id < n ? id : -1; continue; }
      var lo2 = 0, hi = n - 1, at = -1;
      while (lo2 <= hi) {
        var mid = (lo2 + hi) >> 1, v = sorted[mid];
        if (v === id) { at = perm[mid]; break; }
        if (v < id) lo2 = mid + 1; else hi = mid - 1;
      }
      out[k] = at;
    }
    return out;
  };
  // index along the cell dimension -> cell id
  g.idOf = function (index) { return BigInt(num ? num[index] : index); };
  g.centresOf = function (ids) { return grid.healpixToLonLat(ids); };
  // cell ids -> 4 lon/lat corners per cell, going round the cell
  // ([lon, lat] x 4, interleaved: 8 numbers per cell)
  g.cornersOf = function (ids) {
    var out = new Float64Array(8 * ids.length), uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    for (var k = 0; k < ids.length; k++) {
      for (var m = 0; m < 4; m++) {
        var c = grid.vertex(ids[k], uv[m][0], uv[m][1]);
        out[8 * k + 2 * m] = c.lon; out[8 * k + 2 * m + 1] = c.lat;
        c.free();
      }
    }
    return out;
  };
  return g;
}

// The facts line for the inspector:
// "HEALPix nside 128 (level 7), nested, 196608 cells about 0.46 degrees across"
export function dggsLine(g) {
  return "HEALPix nside " + g.nside + " (level " + g.level + "), " + g.scheme +
    (g.schemeAssumed ? " [assumed: no indexing scheme given]" : "") + ", " +
    (g.sparse ? g.n + " of " + g.ncell : g.ncell) + " cells about " + +g.cellDeg.toPrecision(2) + " degrees across";
}

// --- the read ----------------------------------------------------------------------------

// Each output pixel's centre -> lon/lat -> cell -> index along the cell
// dimension (-1: off the globe, or a cell the store does not have). Kept
// per grid, so another day or slice of the same view reuses it.
function pixelIndex(g, grid) {
  var crs = ensureCrs(grid.crs);
  var gk = crs + "|" + grid.bbox.join(",") + "|" + grid.width + "x" + grid.height;
  if (g.cells.has(gk)) return g.cells.get(gk);
  var W = grid.width, H = grid.height, np = W * H;
  var dx = (grid.bbox[2] - grid.bbox[0]) / W, dy = (grid.bbox[3] - grid.bbox[1]) / H;
  var d = globalThis.proj4.defs(crs), geo = !!d && /longlat|lonlat/.test(d.projName || "");
  var tr = geo ? null : globalThis.proj4(crs, "EPSG:4326");
  var ll = new Float64Array(2 * np), ok = new Uint8Array(np);
  for (var r = 0; r < H; r++) {
    var Y = grid.bbox[3] - (r + 0.5) * dy;
    for (var c = 0; c < W; c++) {
      var X = grid.bbox[0] + (c + 0.5) * dx, p = r * W + c, lo = X, la = Y;
      if (tr) {
        var s;
        try { s = tr.forward([X, Y]); } catch (e) { s = null; }
        if (!s) continue;
        lo = s[0]; la = s[1];
      }
      if (!isFinite(lo) || !isFinite(la) || la < -90 || la > 90) continue;
      ll[2 * p] = lo; ll[2 * p + 1] = la; ok[p] = 1;
    }
  }
  var idx = g.indexOf(g.cellsOf(ll));
  for (var q = 0; q < np; q++) if (!ok[q]) idx[q] = -1;
  if (g.cells.size > 8) g.cells.delete(g.cells.keys().next().value);
  var out = { idx: idx, lonlat: ll };
  g.cells.set(gk, out);
  return out;
}

// The lon/lat box of a run of cells, from a sample of their centres plus
// half a cell (the whole longitude range when the run crosses the antimeridian).
function runBbox(g, i0, i1) {
  var n = i1 - i0, step = Math.max(1, Math.floor(n / 512)), m = Math.ceil(n / step);
  var ids = new BigUint64Array(m);
  for (var k = 0; k < m; k++) ids[k] = g.sparse ? g.idOf(i0 + k * step) : BigInt(i0 + k * step);
  var ll = g.centresOf(ids), lo = new Float64Array(m), la = new Float64Array(m);
  for (var j = 0; j < m; j++) { lo[j] = ll[2 * j]; la[j] = ll[2 * j + 1]; }
  var b = centresBbox(lo, la), pad = g.cellDeg;
  return [Math.max(-180, b[0] - pad), Math.max(-90, b[1] - pad), Math.min(180, b[2] + pad), Math.min(90, b[3] + pad)];
}

// readZarrWarped for a variable with v.dggs. h = zarr.js's helpers
// { cached, chunkKey, shardKey, meterShards, selection, pool }. Chunks are
// read most-used first; past the chunk cap the rest are skipped, their
// pixels left empty and logged as "not read", so the inspector shows where.
export async function readDggs(a, grid, opts, ds, v, maxChunks, maxMB, h) {
  var g = v.dggs, pi = pixelIndex(g, grid), idx = pi.idx, np = idx.length;
  var cl = v.arr.chunks[g.axis];
  var count = new Map();
  for (var p = 0; p < np; p++) {
    if (idx[p] < 0) continue;
    var k = Math.floor(idx[p] / cl);
    count.set(k, (count.get(k) || 0) + 1);
  }
  if (!count.size) return null;
  var chunkMB = v.arr.chunks.reduce(function (s, c) { return s * c; }, 1) *
    (v.arr.dtype.match(/\d+/) ? +v.arr.dtype.match(/\d+/)[0] / 8 : 4) / 1048576;
  var cap = Math.max(1, Math.min(maxChunks, Math.floor(maxMB / chunkMB)));
  var order = Array.from(count.keys()).sort(function (x, y) { return count.get(y) - count.get(x); });
  var use = order.slice(0, cap), skipped = order.slice(cap);
  var at = h.selection(v, a.sel);
  if (v.ti >= 0) at[v.ti] = Math.max(0, a.index || 0);
  var log = [], got = new Map();
  var scale = v.scale, offset = v.offset, fill = v.fill, missing = v.missing;
  var before = v.shard ? new Map(ds.counting.bytes) : null;
  function coordsOf(k) {
    return v.dims.map(function (d, i) { return i === g.axis ? k : Math.floor((at[i] || 0) / v.arr.chunks[i]); });
  }
  function entry(k, coords) {
    return { kind: "chunk", z: v.path.slice(1), x: k, y: 0, url: a.url + h.chunkKey(v, coords)[0],
             crs: "EPSG:4326", ok: false, status: null, bytes: 0, ms: 0, cached: false,
             extent: runBbox(g, k * cl, Math.min(g.n, (k + 1) * cl)) };
  }
  await h.pool(use, 4, async function (k) {
    var coords = coordsOf(k);
    var key = a.url + "|" + v.path + "|" + coords.join(".");
    var t0 = performance.now();
    var c = h.cached(key, function (sig) { return v.arr.getChunk(coords, { signal: sig }); }, opts.signal);
    var e = entry(k, coords);
    e.cached = c.hit;
    log.push(e);
    var chunk;
    try { chunk = await c.p; }
    catch (err) {
      if (err && err.name === "AbortError") throw err;
      e.error = String(err && err.message || err); e.status = 404;
      return;
    }
    e.ms = Math.round(performance.now() - t0);
    e.ok = true; e.status = c.hit ? "cache" : 200;
    if (!c.hit) {
      var keys = h.chunkKey(v, coords);
      for (var q = 0; q < keys.length; q++) {
        if (ds.counting.bytes.has(keys[q])) { e.bytes = ds.counting.bytes.get(keys[q]); break; }
      }
      if (v.shard) e.shard = h.shardKey(v, coords);
    }
    var base = 0;
    for (var d = 0; d < coords.length; d++) {
      if (d === g.axis) continue;
      base += ((at[d] || 0) - coords[d] * v.arr.chunks[d]) * chunk.stride[d];
    }
    got.set(k, { data: chunk.data, base: base, st: chunk.stride[g.axis], big: typeof chunk.data[0] === "bigint" });
  });
  skipped.forEach(function (k) {
    var e = entry(k, coordsOf(k));
    e.status = "capped";
    e.error = "not read: this view needs " + order.length + " chunks of " + v.path.slice(1) + " (" +
              v.arr.chunks.join("x") + ", " + chunkMB.toFixed(chunkMB < 10 ? 1 : 0) + " MB each decoded), " +
              "the cap is " + cap + "; zoom in, or draw a smaller region";
    log.push(e);
  });
  if (before) h.meterShards(ds.counting.bytes, log, before);
  var out = new Float32Array(np).fill(NaN), valid = new Uint8Array(np), any = false;
  for (var i = 0; i < np; i++) {
    if (idx[i] < 0) continue;
    var kk = Math.floor(idx[i] / cl), ch = got.get(kk);
    if (!ch) continue;
    var raw = ch.data[ch.base + (idx[i] - kk * cl) * ch.st];
    if (ch.big) raw = Number(raw);
    if (raw === fill || raw === missing || raw !== raw) continue;
    out[i] = raw * scale + offset; valid[i] = 1; any = true;
  }
  if (!any) {
    var bad = log.filter(function (t) { return t.error && t.status !== "capped"; })[0];
    if (bad && log.every(function (t) { return !t.ok; })) throw new Error("no chunk could be read (" + bad.error + ")");
    return null;
  }
  return { bands: [out], valid: valid, nodata: NaN, level: 1, log: log };
}

// The cell under one lon/lat: { id (BigInt), index (-1: not a cell the
// store has), dim, centre [lon, lat], corners [[lon, lat] x 4], outline
// (the corners with points along each edge, which is curved in lon/lat,
// longitudes kept on the side of the first corner) }
export function dggsCellAt(g, lon, lat) {
  var ids = g.cellsOf(new Float64Array([lon, lat]));
  var index = g.indexOf(ids)[0];
  var cen = g.centresOf(ids), cr = g.cornersOf(ids), corners = [];
  for (var m = 0; m < 4; m++) corners.push([cr[2 * m], cr[2 * m + 1]]);
  var uv = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], outline = [], STEPS = 8, l0 = null;
  for (var e = 0; e < 4; e++) {
    for (var k = 0; k < STEPS; k++) {
      var t = k / STEPS, u = uv[e][0] + (uv[e + 1][0] - uv[e][0]) * t, v = uv[e][1] + (uv[e + 1][1] - uv[e][1]) * t;
      var c = g.grid.vertex(ids[0], u, v), x = c.lon, y = c.lat;
      c.free();
      if (l0 === null) { x = ((x + 180) % 360 + 360) % 360 - 180; l0 = x; }
      else x = l0 + (((x - l0 + 180) % 360 + 360) % 360 - 180);
      outline.push([x, y]);
    }
  }
  outline.push(outline[0]);
  return { id: ids[0], index: index, dim: g.dim, centre: [((cen[0] + 180) % 360 + 360) % 360 - 180, cen[1]],
           corners: corners, outline: outline };
}
