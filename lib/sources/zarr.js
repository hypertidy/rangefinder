// Layers 1+2 (and 3) for a Zarr store: one variable of a CF-style dataset.
//
// Minimal on purpose. The store is opened with zarrita (loaded on demand),
// through consolidated metadata when there is some. A variable is usable
// when two of its dimensions can be recognised as x and y with regular 1D
// coordinate arrays (lon/lat or projected); a time dimension, when there is
// one, becomes the day list. Any other dimension is read at index 0.
// Values are unpacked with scale_factor / add_offset, and the fill value
// becomes NaN. Curvilinear grids (2D lon/lat) are not supported yet.
//
// A read fetches whole chunks (that is the only unit a Zarr store has), so
// the chunk shape decides what a view costs; reads are capped by chunk
// count, and decoded chunks are kept in a small cache so stepping through
// the days held by one chunk is free. Each chunk read is logged like a map
// tile, so the inspector's "last read" shows the chunk grid.

import { ensureCrs, crsFromWkt, transformBbox, bboxIntersects, secureUrl } from "../geo.js";
import { gridLattice, latticeWindow, latticeScale, resampleWindow } from "../cog.js";
import { UNDATED } from "./cog.js";

var CDNS = ["https://cdn.jsdelivr.net/npm/zarrita@0.7/+esm", "https://esm.sh/zarrita@0.7"];
var zmod = null;
function zarrita() {
  if (!zmod) {
    zmod = (async function () {
      var last;
      for (var i = 0; i < CDNS.length; i++) {
        try { return await import(CDNS[i]); } catch (e) { last = e; }
      }
      throw new Error("could not load zarrita: " + (last && last.message || last));
    })();
    zmod.catch(function () { zmod = null; });
  }
  return zmod;
}

// --- opening ------------------------------------------------------------------------

// A FetchStore that remembers how many bytes each key cost.
function countingStore(z, url) {
  var raw = new z.FetchStore(url);
  var bytes = new Map();
  var s = {
    bytes: bytes,
    get: async function (key, opts) {
      var b = await raw.get(key, opts);
      if (b) bytes.set(key, b.byteLength);
      return b;
    }
  };
  if (raw.getRange) {
    s.getRange = async function (key, range, opts) {
      var b = await raw.getRange(key, range, opts);
      if (b) bytes.set(key, (bytes.get(key) || 0) + b.byteLength);
      return b;
    };
  }
  return s;
}

var datasets = new Map();
function openDataset(url) {
  url = String(url || "").trim().replace(/\/+$/, "");
  if (!datasets.has(url)) {
    var p = (async function () {
      var z = await zarrita();
      var counting = countingStore(z, url);
      var store = await z.withMaybeConsolidatedMetadata(counting);
      var paths = store.contents ? store.contents().filter(function (c) { return c.kind === "array"; })
                                                  .map(function (c) { return c.path; }) : null;
      var rootAttrs = {};
      try { rootAttrs = (await z.open(z.root(store), { kind: "group" })).attrs || {}; } catch (e) { /* no group */ }
      return { z: z, url: url, store: store, counting: counting, paths: paths, rootAttrs: rootAttrs,
               arrays: new Map(), vars: new Map() };
    })();
    p.catch(function () { datasets.delete(url); });
    datasets.set(url, p);
  }
  return datasets.get(url);
}

function arrayAt(ds, path) {
  path = "/" + String(path).replace(/^\/+/, "");
  if (!ds.arrays.has(path)) {
    var p = ds.z.open(ds.z.root(ds.store).resolve(path), { kind: "array" });
    p.catch(function () { ds.arrays.delete(path); });
    ds.arrays.set(path, p);
  }
  return ds.arrays.get(path);
}

function dimNames(arr) {
  return arr.dimensionNames || (arr.attrs && arr.attrs._ARRAY_DIMENSIONS) || null;
}

// --- recognising dimensions ------------------------------------------------------------

var X_NAMES = /^(x|lon|long|longitude|nav_lon|xc|rlon|easting)$/i;
var Y_NAMES = /^(y|lat|latitude|nav_lat|yc|rlat|northing)$/i;
var T_NAMES = /^(time|t|times|date)$/i;

function role(name, attrs) {
  attrs = attrs || {};
  var u = String(attrs.units || ""), sn = String(attrs.standard_name || ""), ax = String(attrs.axis || "");
  if (/ since /.test(u) || ax === "T" || sn === "time" || T_NAMES.test(name)) return "t";
  if (/degrees?_?e(ast)?$/i.test(u) || sn === "longitude" || sn === "projection_x_coordinate" ||
      ax === "X" || X_NAMES.test(name)) return "x";
  if (/degrees?_?n(orth)?$/i.test(u) || sn === "latitude" || sn === "projection_y_coordinate" ||
      ax === "Y" || Y_NAMES.test(name)) return "y";
  return null;
}
function isLonLat(name, attrs) {
  attrs = attrs || {};
  return /^degrees?/i.test(String(attrs.units || "")) || /lon|lat/i.test(name) ||
    /^(longitude|latitude)$/.test(String(attrs.standard_name || ""));
}

function toNumbers(a) {
  var out = new Float64Array(a.length);
  for (var i = 0; i < a.length; i++) out[i] = Number(a[i]);
  return out;
}

// A regular 1D axis -> { first, step, n } (cell centres), or an error.
function regularAxis(v, name) {
  var n = v.length;
  if (n < 2) return { first: v[0], step: 1, n: n };
  var step = (v[n - 1] - v[0]) / (n - 1);
  var tol = Math.abs(step) * 0.01;
  for (var i = 1; i < n; i++) {
    if (Math.abs(v[i] - v[i - 1] - step) > tol) {
      throw new Error(name + " is not regularly spaced (irregular and curvilinear grids are not supported yet)");
    }
  }
  return { first: v[0], step: step, n: n };
}

// CF time units -> function (value) -> epoch ms
var UNIT_MS = { second: 1e3, sec: 1e3, s: 1e3, minute: 6e4, min: 6e4, hour: 36e5, h: 36e5, hr: 36e5,
                day: 864e5, d: 864e5, week: 6048e5, millisecond: 1, msec: 1, ms: 1 };
function timeDecoder(units) {
  var m = /^\s*(\w+?)s?\s+since\s+(.+?)\s*$/i.exec(String(units || ""));
  if (!m) return null;
  var per = UNIT_MS[m[1].toLowerCase()];
  if (!per) return null;
  var ref = m[2].replace(" ", "T").replace(/\s.*$/, "");
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(ref)) ref += "T00:00:00";
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(ref)) ref += "Z";
  var t0 = Date.parse(ref.replace(/^(\d{4})-(\d)-/, "$1-0$2-").replace(/-(\d)T/, "-0$1T"));
  if (!isFinite(t0)) return null;
  return function (v) { return t0 + v * per; };
}

// Time coordinate values without reading thousands of tiny chunks: when the
// first and last chunks agree with a constant step, the rest is arithmetic.
async function timeValues(ds, arr) {
  var n = arr.shape[0], c = arr.chunks[0], nch = Math.ceil(n / c);
  async function chunkVals(i) {
    var ch = await arr.getChunk([i]);
    return toNumbers(ch.data).subarray(0, Math.min(c, n - i * c));
  }
  if (nch <= 64) return toNumbers((await ds.z.get(arr)).data);
  var a = await chunkVals(0), b = await chunkVals(nch - 1);
  if (a.length > 1) {
    var step = a[1] - a[0], last = b[b.length - 1];
    var regular = true;
    for (var i = 1; i < a.length; i++) if (Math.abs(a[i] - a[i - 1] - step) > 1e-9 * Math.abs(step)) regular = false;
    if (regular && Math.abs(a[0] + (n - 1) * step - last) <= 1e-6 * Math.abs(step)) {
      var out = new Float64Array(n);
      for (var k = 0; k < n; k++) out[k] = a[0] + k * step;
      return out;
    }
  }
  var all = new Float64Array(n), next = 0;
  async function worker() {
    while (next < nch) {
      var i = next++, v = await chunkVals(i);
      all.set(v, i * c);
    }
  }
  await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(worker));
  return all;
}

// Where the CRS comes from: lon/lat axes are EPSG:4326; otherwise the
// variable's grid_mapping (crs_wkt / spatial_ref), then a few common attrs.
async function variableCrs(ds, arr, xName, xAttrs, opts) {
  if (opts.crs) return ensureCrs(opts.crs);
  if (isLonLat(xName, xAttrs)) return "EPSG:4326";
  var a = arr.attrs || {};
  var gm = a.grid_mapping && String(a.grid_mapping).split(/[\s:]+/)[0];
  if (gm) {
    try {
      var g = await arrayAt(ds, gm), ga = g.attrs || {};
      var wkt = ga.crs_wkt || ga.spatial_ref;
      if (wkt) return crsFromWkt(wkt);
      if (ga.epsg_code) return ensureCrs(ga.epsg_code);
    } catch (e) { /* fall through */ }
  }
  var cands = [a["proj:code"], a["proj:epsg"], a.crs, ds.rootAttrs["proj:code"], ds.rootAttrs["proj:epsg"],
               ds.rootAttrs.crs, ds.rootAttrs.epsg];
  for (var i = 0; i < cands.length; i++) {
    if (cands[i] !== undefined && cands[i] !== null && cands[i] !== "") {
      var c = String(cands[i]);
      return /^\s*(PROJCS|GEOGCS|PROJCRS|GEOGCRS)/.test(c) ? crsFromWkt(c) : ensureCrs(c);
    }
  }
  throw new Error("no CRS found for " + arr.path + " (no grid_mapping); enter one, e.g. EPSG:3031");
}

// Everything needed to read one variable:
// { path, arr, dims, xi, yi, ti, W, H, origin, res, crs, wrap, scale, offset,
//   fill, missing, times (epoch ms) | null, bbox (lon/lat), units, longName }
function describe(ds, name, opts) {
  opts = opts || {};
  var key = name + "|" + (opts.crs || "");
  if (!ds.vars.has(key)) {
    var p = (async function () {
      var path = "/" + String(name).replace(/^\/+/, "");
      var arr = await arrayAt(ds, path);
      var dims = dimNames(arr);
      if (!dims || dims.length !== arr.shape.length) {
        throw new Error(name + " has no dimension names (_ARRAY_DIMENSIONS or dimension_names)");
      }
      var parent = path.replace(/\/[^/]*$/, "");
      var coords = await Promise.all(dims.map(function (d) {
        return arrayAt(ds, parent + "/" + d).then(function (c) {
          return c.shape.length === 1 ? c : null;
        }, function () { return null; });
      }));
      var roles = dims.map(function (d, i) { return role(d, coords[i] && coords[i].attrs); });
      var xi = roles.lastIndexOf("x"), yi = roles.lastIndexOf("y"), ti = roles.indexOf("t");
      if (xi < 0 || yi < 0) {
        // no names to go on: the last two dimensions, as most writers lay them out
        if (arr.shape.length < 2) throw new Error(name + " is not gridded");
        yi = arr.shape.length - 2; xi = arr.shape.length - 1;
      }
      if (!coords[xi] || !coords[yi]) {
        throw new Error(name + ": no 1D coordinate arrays for " + dims[xi] + " / " + dims[yi]);
      }
      var xv = toNumbers((await ds.z.get(coords[xi])).data);
      var yv = toNumbers((await ds.z.get(coords[yi])).data);
      var xa = regularAxis(xv, dims[xi]), ya = regularAxis(yv, dims[yi]);
      var crs = await variableCrs(ds, arr, dims[xi], coords[xi].attrs, opts);
      var origin = [xa.first - xa.step / 2, ya.first - ya.step / 2];
      var res = [xa.step, ya.step];
      var W = arr.shape[xi], H = arr.shape[yi];
      var x0 = origin[0], x1 = origin[0] + W * res[0], y0 = origin[1], y1 = origin[1] + H * res[1];
      var ext = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
      var geo = crs === "EPSG:4326";
      // 0..360 longitudes: grid longitudes west of the data wrap round by 360
      var wrap = geo && ext[2] > 180.5;
      var bbox = geo ? [wrap ? -180 : Math.max(-180, ext[0]), Math.max(-90, ext[1]),
                        wrap ? 180 : Math.min(180, ext[2]), Math.min(90, ext[3])]
                     : transformBbox(ext, crs, "EPSG:4326");
      var times = null;
      if (ti >= 0 && coords[ti]) {
        var dec = timeDecoder(coords[ti].attrs && coords[ti].attrs.units);
        if (dec) {
          var tv = await timeValues(ds, coords[ti]);
          times = Array.prototype.map.call(tv, dec);
        }
      }
      if (ti >= 0 && !times) ti = -1;   // an undecodable time axis is read at index 0
      var a = arr.attrs || {};
      var fill = a._FillValue !== undefined ? a._FillValue : arr.fillValue;
      return {
        path: path, arr: arr, dims: dims, xi: xi, yi: yi, ti: ti, W: W, H: H,
        origin: origin, res: res, crs: crs, wrap: wrap, extent: ext, bbox: bbox,
        scale: a.scale_factor !== undefined ? +a.scale_factor : 1,
        offset: a.add_offset !== undefined ? +a.add_offset : 0,
        fill: fill === null || fill === undefined || fill === "NaN" ? null : Number(fill),
        missing: a.missing_value !== undefined ? Number(a.missing_value) : null,
        times: times, units: a.units || "", longName: a.long_name || a.standard_name || "",
        flags: a.flag_values && a.flag_meanings ? { values: a.flag_values, meanings: a.flag_meanings } : null
      };
    })();
    p.catch(function () { ds.vars.delete(key); });
    ds.vars.set(key, p);
  }
  return ds.vars.get(key);
}

// --- the read ---------------------------------------------------------------------------

// Decoded chunks, most recent last; kept under CACHE_BYTES of typed arrays.
var CACHE_BYTES = 320 * 1024 * 1024;
var cache = new Map(), cacheSize = 0;
function cached(key, make) {
  if (cache.has(key)) {
    var hit = cache.get(key);
    cache.delete(key); cache.set(key, hit);
    return { p: hit.p, hit: true };
  }
  var e = { p: make(), size: 0 };
  cache.set(key, e);
  e.p.then(function (ch) {
    e.size = ch.data.byteLength || 0; cacheSize += e.size;
    var it = cache.keys();
    while (cacheSize > CACHE_BYTES && cache.size > 1) {
      var k = it.next().value, old = cache.get(k);
      if (old === e) break;
      cache.delete(k); cacheSize -= old.size;
    }
  }, function () { cache.delete(key); });
  return { p: e.p, hit: false };
}

function chunkKey(v, coords) {
  // keys as written in v2 (dot or slash separated) and v3 ("c/...")
  return [v.path + "/" + coords.join("."), v.path + "/" + coords.join("/"),
          v.path + "/c/" + coords.join("/")];
}

async function pool(items, n, fn) {
  var next = 0;
  async function worker() { while (next < items.length) { var i = next++; await fn(items[i], i); } }
  var ws = [];
  for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
  await Promise.all(ws);
}

// Read one asset { kind: "zarr", url, variable, index (time index or -1), crs }
// warped onto the grid. Same contract as readWarped / readTilesWarped.
//   opts.maxChunks  cap on chunks per read (default 64)
//   opts.maxMB      cap on their decoded size (default 400)
export async function readZarrWarped(a, grid, opts) {
  opts = opts || {};
  var maxChunks = opts.maxChunks || a.maxChunks || 64, maxMB = opts.maxMB || 400;
  var ds = await openDataset(a.url);
  var v = await describe(ds, a.variable, { crs: a.crs });
  var proj = globalThis.proj4(ensureCrs(grid.crs), ensureCrs(v.crs));
  var toSrc = proj;
  if (v.wrap) {
    var xmin = v.extent[0];
    toSrc = { forward: function (p) {
      var s = proj.forward(p);
      if (s[0] < xmin) s[0] += 360;
      return s;
    } };
  }
  var lat = gridLattice(grid, toSrc, v.origin, v.res);
  var win = latticeWindow(lat, v.W, v.H);
  if (!win) return null;
  // decimate when a grid pixel spans several cells, like a COG overview
  var f = Math.max(1, Math.floor(latticeScale(lat)));
  var cx = v.arr.chunks[v.xi], cy = v.arr.chunks[v.yi];
  var ch0 = Math.floor(win[0] / cx), ch1 = Math.ceil(win[2] / cx) - 1;
  var cr0 = Math.floor(win[1] / cy), cr1 = Math.ceil(win[3] / cy) - 1;
  var n = (ch1 - ch0 + 1) * (cr1 - cr0 + 1);
  var chunkMB = v.arr.chunks.reduce(function (p, c) { return p * c; }, 1) *
    (v.arr.dtype.match(/\d+/) ? +v.arr.dtype.match(/\d+/)[0] / 8 : 4) / 1048576;
  if (n > maxChunks || n * chunkMB > maxMB) {
    throw new Error("this region needs " + n + " chunks of " + v.path.slice(1) + " (" +
      v.arr.chunks.join("x") + ", " + chunkMB.toFixed(chunkMB < 10 ? 1 : 0) + " MB each decoded); " +
      "draw a smaller one (at most " + Math.min(maxChunks, Math.floor(maxMB / chunkMB)) + " chunks)");
  }
  var wx0 = Math.floor(win[0] / f), wy0 = Math.floor(win[1] / f);
  var wx1 = Math.ceil(win[2] / f), wy1 = Math.ceil(win[3] / f);
  var ww = wx1 - wx0, wh = wy1 - wy0;
  var out = new Float32Array(ww * wh).fill(NaN);
  var ti = v.ti >= 0 ? Math.max(0, a.index || 0) : -1;
  var jobs = [];
  for (var r = cr0; r <= cr1; r++) for (var c = ch0; c <= ch1; c++) jobs.push([c, r]);
  var log = [];
  var scale = v.scale, offset = v.offset, fill = v.fill, missing = v.missing;
  await pool(jobs, 4, async function (j) {
    var coords = v.dims.map(function (d, i) {
      if (i === v.xi) return j[0];
      if (i === v.yi) return j[1];
      if (i === v.ti) return Math.floor(ti / v.arr.chunks[i]);
      return 0;
    });
    var key = a.url + "|" + v.path + "|" + coords.join(".");
    var t0 = performance.now();
    var got = cached(key, function () { return v.arr.getChunk(coords, { signal: opts.signal }); });
    var e = { kind: "chunk", z: v.path.slice(1), x: j[0], y: j[1], url: a.url + chunkKey(v, coords)[0],
              crs: v.crs, ok: false, status: null, bytes: 0, ms: 0, cached: got.hit,
              extent: [v.origin[0] + j[0] * cx * v.res[0], v.origin[1] + j[1] * cy * v.res[1],
                       v.origin[0] + Math.min(v.W, (j[0] + 1) * cx) * v.res[0],
                       v.origin[1] + Math.min(v.H, (j[1] + 1) * cy) * v.res[1]] };
    e.extent = [Math.min(e.extent[0], e.extent[2]), Math.min(e.extent[1], e.extent[3]),
                Math.max(e.extent[0], e.extent[2]), Math.max(e.extent[1], e.extent[3])];
    log.push(e);
    var chunk;
    try { chunk = await got.p; }
    catch (err) {
      if (err && err.name === "AbortError") throw err;
      e.error = String(err && err.message || err); e.status = 404;
      return;
    }
    e.ms = Math.round(performance.now() - t0);
    e.ok = true; e.status = got.hit ? "cache" : 200;
    if (!got.hit) {
      var keys = chunkKey(v, coords);
      for (var q = 0; q < keys.length; q++) {
        if (ds.counting.bytes.has(keys[q])) { e.bytes = ds.counting.bytes.get(keys[q]); break; }
      }
    }
    var data = chunk.data, st = chunk.stride, big = typeof data[0] === "bigint";
    var base = 0;
    for (var d = 0; d < coords.length; d++) {
      if (d === v.xi || d === v.yi) continue;
      var within = d === v.ti ? ti - coords[d] * v.arr.chunks[d] : 0;
      base += within * st[d];
    }
    var sx = st[v.xi], sy = st[v.yi];
    var r0 = j[1] * cy, r1 = Math.min(v.H, r0 + cy), c0 = j[0] * cx, c1 = Math.min(v.W, c0 + cx);
    var Y0 = Math.max(wy0, Math.ceil(r0 / f)), Y1 = Math.min(wy1, Math.ceil(r1 / f));
    var X0 = Math.max(wx0, Math.ceil(c0 / f)), X1 = Math.min(wx1, Math.ceil(c1 / f));
    for (var Y = Y0; Y < Y1; Y++) {
      var so = base + (Y * f - r0) * sy, o = (Y - wy0) * ww - wx0;
      for (var X = X0; X < X1; X++) {
        var raw = data[so + (X * f - c0) * sx];
        if (big) raw = Number(raw);
        if (raw === fill || raw === missing || raw !== raw) continue;
        out[o + X] = raw * scale + offset;
      }
    }
  });
  var res = resampleWindow(lat, grid, [out], ww, wh, wx0, wy0, f, f, NaN, null);
  if (!res.any) {
    var bad = log.filter(function (t) { return t.error; })[0];
    if (bad && log.every(function (t) { return !t.ok; })) throw new Error("no chunk could be read (" + bad.error + ")");
    return null;
  }
  return { bands: res.bands, valid: res.valid, nodata: NaN, level: f, log: log };
}

// --- the catalogue -------------------------------------------------------------------------

function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

// opts = { url, variable (blank: the first usable one), crs (when the store
//          does not say), maxChunks }
export function zarrCatalog(opts) {
  var url = secureUrl(opts.url).replace(/\/+$/, "");
  var chosen = null;
  async function variable() {
    if (chosen) return chosen;
    var ds = await openDataset(url);
    var name = opts.variable;
    if (!name) {
      var inf = await cat.info();
      var ok = inf.variables.filter(function (x) { return !x.error; })[0];
      if (!ok) throw new Error("no gridded variable found in " + url);
      name = ok.name;
    }
    chosen = { ds: ds, v: await describe(ds, name, { crs: opts.crs }) };
    return chosen;
  }
  var infoP = null;
  var cat = {
    kind: "zarr",
    label: "Zarr " + url.split("/").slice(-2).join("/"),
    capabilities: { cloud: false, time: true },
    maxScenes: 1,
    presets: [],
    // The store's arrays: { variables: [{ name, dims, shape, chunks, dtype,
    //   units, longName, error? }], attrs, consolidated }
    info: function () {
      if (!infoP) {
        infoP = (async function () {
          var ds = await openDataset(url);
          var names = ds.paths ? ds.paths.map(function (p) { return p.replace(/^\//, ""); }) : [];
          var arrs = await Promise.all(names.map(function (n) {
            return arrayAt(ds, n).then(function (a) { return a; }, function () { return null; });
          }));
          // coordinates are the arrays some other array names as a dimension
          var dimSet = {};
          arrs.forEach(function (a) { (a && dimNames(a) || []).forEach(function (d) { dimSet[d] = 1; }); });
          var vars = [];
          arrs.forEach(function (a, i) {
            if (!a || a.shape.length < 2 || dimSet[names[i].split("/").pop()]) return;
            var at = a.attrs || {};
            vars.push({ name: names[i], dims: dimNames(a) || [], shape: a.shape, chunks: a.chunks,
                        dtype: a.dtype, units: at.units || "", longName: at.long_name || at.standard_name || "" });
          });
          // biggest first: the data, not the bounds or masks
          vars.sort(function (p, q) { return q.shape.length - p.shape.length; });
          return { variables: vars, attrs: ds.rootAttrs, consolidated: !!ds.paths };
        })();
        infoP.catch(function () { infoP = null; });
      }
      return infoP;
    },
    // Facts about the chosen variable: { name, dims, shape, chunks, dtype, crs,
    //   bbox, res, times: [first, last, n] | null, chunkMB }
    describe: async function () {
      var c = await variable(), v = c.v, a = v.arr;
      var bytes = +(a.dtype.match(/\d+/) || [32])[0] / 8;
      return { name: v.path.slice(1), dims: v.dims, shape: a.shape, chunks: a.chunks, dtype: a.dtype,
               crs: v.crs, bbox: v.bbox, res: v.res, units: v.units, longName: v.longName,
               times: v.times ? [isoDay(Math.min.apply(null, v.times)), isoDay(Math.max.apply(null, v.times)),
                                 v.times.length] : null,
               chunkMB: a.chunks.reduce(function (p, k) { return p * k; }, 1) * bytes / 1048576 };
    },
    search: async function (q) {
      var c = await variable(), v = c.v;
      cat.capabilities = { cloud: false, time: !!v.times };
      var key = v.path.slice(1);
      var label = key + (v.units ? " (" + v.units + ")" : "");
      cat.presets = [{ keys: [key], mode: "single", label: label, ramp: "viridis", hillshade: 0 }];
      if (q.bbox && !bboxIntersects(v.bbox, q.bbox)) return [];
      var idx = [-1];
      if (v.times) {
        var range = (q.datetime || "../..").split("/");
        var lo = range[0] && range[0] !== ".." ? range[0] : "0000";
        var hi = range[1] && range[1] !== ".." ? range[1] : "9999";
        idx = [];
        v.times.forEach(function (t, i) {
          var d = isoDay(t);
          if (d >= lo && d <= hi) idx.push(i);
        });
        // times need not be sorted (ITS_LIVE cubes are not): keep the newest
        idx.sort(function (p, r) { return v.times[p] - v.times[r]; });
        idx = idx.slice(-(q.maxItems || 300));
      }
      var b = v.bbox;
      var groundRes = Math.abs(v.res[0]) * (v.crs === "EPSG:4326" ? 111320 : 1);
      return idx.map(function (i) {
        var assets = {}, meta = {};
        assets[key] = { kind: "zarr", url: url, variable: key, index: i, crs: opts.crs || null,
                        maxChunks: opts.maxChunks || null, href: url + "#" + key + "@" + i };
        meta[key] = {};
        var t = i >= 0 ? new Date(v.times[i]).toISOString() : null;
        return { id: key + (t ? " " + t.slice(0, 16).replace("T", " ") : ""), day: t ? t.slice(0, 10) : UNDATED,
                 datetime: t, bbox: b, cloud: null, crs: v.crs,
                 geometry: { type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]],
                                                             [b[0], b[3]], [b[0], b[1]]]] },
                 assets: assets, assetMeta: meta, meta: { res: groundRes, index: i } };
      });
    }
  };
  return cat;
}
