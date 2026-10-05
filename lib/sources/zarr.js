// Layers 1+2 (and 3) for a Zarr store: one variable of a CF-style dataset.
//
// Minimal on purpose. The store is opened with zarrita (loaded on demand),
// through consolidated metadata when there is some. A variable is usable
// when two of its dimensions can be recognised as x and y with regular 1D
// coordinate arrays (lon/lat or projected), or when its coordinates are 2D
// longitude / latitude arrays (a curvilinear grid: ROMS, NEMO, tripolar;
// see ../curvilinear.js); a time dimension, when there is one, becomes the
// day list. Any other dimension (depth, level, ...) is read at the index
// the catalogue's opts.sel gives it, else its default (the surface for an
// ocean s-coordinate, else 0). Values are unpacked with scale_factor /
// add_offset, and the fill value becomes NaN.
//
// A read fetches whole chunks (that is the only unit a Zarr store has), so
// the chunk shape decides what a view costs; reads are capped by chunk
// count, and decoded chunks are kept in the shared chunk cache so stepping through
// the days held by one chunk is free. Each chunk read is logged like a map
// tile, so the inspector's "last read" shows the chunk grid.

import { ensureCrs, resolveCrs, crsProvenance, crsFromWkt, transformBbox, bboxIntersects, secureUrl } from "../geo.js";
import { gridLattice, latticeWindow, latticeScale, resampleWindow } from "../cog.js";
import { UNDATED } from "./cog.js";
import { getChunk } from "../chunks.js";
import { footprints, projectFootprints, rasterCells, centresBbox, centreSpacing } from "../curvilinear.js";
import { findHealpix, healpixAttrs, healpixGeometry, readDggs, dggsLine, dggsCellAt } from "../dggs.js";

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

// --- Icechunk repositories ------------------------------------------------------------
//
// An Icechunk repository (Zarr v3 with snapshots, branches and tags, its
// chunks native or virtual byte ranges of NetCDF/HDF5/GRIB/TIFF elsewhere)
// is read with icechunk-js, loaded on demand like zarrita. Its store has
// the same get() / getRange() as a FetchStore, so everything downstream is
// the same; the snapshot's node list replaces consolidated metadata.
// A URL says it is one by an icechunk+https:// (or icechunk://) prefix, a
// ?icechunk / #icechunk hint, a name ending ".icechunk", or (sniffed when
// the URL has neither .zmetadata nor zarr.json) a v2 "repo" object or a v1
// main branch ref. ?branch=, ?tag= and ?snapshot= pick the version (default
// branch main); the snapshot a branch resolved to is reported so that a
// permalink can pin it. Anonymous reads only.

var ICECHUNK = ["https://cdn.jsdelivr.net/npm/icechunk-js@0.6/+esm", "https://esm.sh/icechunk-js@0.6"];
var icmod = null;
function icechunkJs() {
  if (!icmod) {
    icmod = (async function () {
      var last;
      for (var i = 0; i < ICECHUNK.length; i++) {
        try { return await import(ICECHUNK[i]); } catch (e) { last = e; }
      }
      throw new Error("could not load icechunk-js: " + (last && last.message || last));
    })();
    icmod.catch(function () { icmod = null; });
  }
  return icmod;
}

var IC_KEYS = ["icechunk", "branch", "tag", "snapshot"];
// -> { url (plain https, version keys removed), branch, tag, snapshot, hinted }
export function icechunkParts(url) {
  var u = String(url || "").trim(), hinted = false;
  var m = /^icechunk(\+https?)?:\/\//i.exec(u);
  if (m) { hinted = true; u = (m[1] ? m[1].slice(1) : "https") + "://" + u.slice(m[0].length); }
  var hash = "", hi = u.indexOf("#");
  if (hi >= 0) { hash = u.slice(hi + 1); u = u.slice(0, hi); }
  if (/^icechunk$/i.test(hash)) { hinted = true; hash = ""; }
  var out = { branch: null, tag: null, snapshot: null };
  var qi = u.indexOf("?"), keep = [];
  if (qi >= 0) {
    u.slice(qi + 1).split("&").forEach(function (kv) {
      var k = decodeURIComponent(kv.split("=")[0]), v = decodeURIComponent(kv.slice(k.length + 1));
      if (IC_KEYS.indexOf(k) < 0) { if (kv) keep.push(kv); return; }
      hinted = true;
      if (k !== "icechunk") out[k] = v || null;
    });
    u = u.slice(0, qi) + (keep.length ? "?" + keep.join("&") : "");
  }
  u = u.replace(/\/+$/, "");
  if (/\.icechunk$/i.test(u.split("?")[0])) hinted = true;
  out.url = u; out.hinted = hinted;
  return out;
}
export function isIcechunkUrl(url) { return icechunkParts(url).hinted; }

async function looksLikeIcechunk(url) {
  var probes = ["/repo", "/refs/branch.main/ref.json"];
  for (var i = 0; i < probes.length; i++) {
    try {
      var r = await fetch(url + probes[i], { headers: { Range: "bytes=0-0" } });
      if (r.ok) return true;
    } catch (e) { /* not there */ }
  }
  return false;
}

async function icechunkStore(url, z) {
  var parts = icechunkParts(url);
  var ic = await icechunkJs();
  var o = { withRangeCoalescing: z.withRangeCoalescing };
  if (parts.snapshot) o.snapshot = parts.snapshot;
  else if (parts.tag) o.tag = parts.tag;
  else o.branch = parts.branch || "main";
  var raw;
  try { raw = await ic.IcechunkStore.open(parts.url, o); }
  catch (e) {
    throw new Error("could not open the Icechunk repository " + parts.url + " (" +
      (parts.snapshot ? "snapshot " + parts.snapshot : parts.tag ? "tag " + parts.tag : "branch " + o.branch) +
      "): " + (e && e.message || e) + (/fetch/i.test(String(e && e.message)) ? " (no CORS on the bucket?)" : ""));
  }
  var bytes = new Map();
  function note(key, b, add) { if (b) bytes.set(key, (add && bytes.get(key) || 0) + b.byteLength); return b; }
  // a virtual chunk's bytes live in another bucket, which needs its own
  // CORS: when a chunk read fails, name the repository's virtual chunk
  // containers (metadata reads come from the repository itself)
  var virt = ((raw.session && raw.session.virtualChunkContainers) || []).map(function (c) { return c.urlPrefix; });
  async function guard(key, fn) {
    try { return await fn(); }
    catch (e) {
      if (e && e.name === "AbortError") throw e;
      var msg = e && e.message || String(e);
      if (/\/c[./]|\/c$/.test(key) && virt.length) {
        msg += " (this repository has virtual chunks in " + virt.join(", ") + ": is that CORS-open?)";
      } else if (/failed to fetch|networkerror|load failed/i.test(msg)) msg += " (no CORS?)";
      throw new Error(msg);
    }
  }
  var snap = "";
  try { snap = ic.encodeObjectId12(raw.session.getSnapshotId()); } catch (e) { /* older icechunk-js */ }
  return {
    bytes: bytes, refs: "icechunk", raw: raw,
    icechunk: { url: parts.url, branch: parts.snapshot || parts.tag ? null : o.branch, tag: parts.tag,
                snapshot: snap || parts.snapshot, pinned: !!parts.snapshot },
    paths: raw.listNodes().filter(function (n) { return n.nodeData && n.nodeData.type === "array"; })
                          .map(function (n) { return n.path; }),
    get: function (key, opts) { return guard(key, function () { return raw.get(key, opts); }).then(function (b) { return note(key, b); }); },
    getRange: function (key, range, opts) {
      return guard(key, function () { return raw.getRange(key, range, opts); }).then(function (b) { return note(key, b, true); });
    }
  };
}

// --- Kerchunk / VirtualiZarr references ----------------------------------------------
//
// A reference JSON maps Zarr keys to inline content or byte ranges of other
// files (NetCDF-4/HDF5, GRIB2, TIFF, ...), so those archives read like a
// Zarr store with no server: { key: "json text" | "base64:..." | [url] |
// [url, offset, length] }, either bare (version 0) or under "refs" with
// "templates" (version 1). Relative URLs resolve against the JSON's own;
// s3:// and gs:// become their public https endpoints. "gen" ranges are
// not supported. Without a .zmetadata of its own, one is made from the
// inline metadata keys, so the store can be listed. Kerchunk's Parquet form
// (a directory of refs.<n>.parq files) is read by parquetRefStore below.

export function isReferenceUrl(url) {
  return /\.json(\?|#|$)/i.test(String(url || "")) || isParquetRefs(url);
}
// Kerchunk Parquet references: a directory (".parq" / ".parquet") holding
// .zmetadata and <variable>/refs.<n>.parq
export function isParquetRefs(url) {
  return /\.parq(uet)?\/?(\?|#|$)/i.test(String(url || ""));
}
function httpsOf(u, base) {
  var m = /^s3a?:\/\/([^/]+)\/(.*)$/.exec(u);
  if (m) return "https://" + m[1] + ".s3.amazonaws.com/" + m[2];
  m = /^(gs|gcs):\/\/([^/]+)\/(.*)$/.exec(u);
  if (m) return "https://storage.googleapis.com/" + m[2] + "/" + m[3];
  return secureUrl(new URL(u, base).href);
}
// fetch, saying which host failed when the browser refuses outright (no
// network, or no cross-origin access to that server)
async function fetchRef(target, init) {
  try { return await fetch(target, init); }
  catch (e) {
    if (e && e.name === "AbortError") throw e;
    var host = target;
    try { host = new URL(target).host; } catch (e2) { /* keep */ }
    throw new Error("could not fetch from " + host + " (offline, or the server does not allow cross-origin reads)");
  }
}
function b64bytes(s) {
  var bin = atob(s), out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function referenceStore(url) {
  var r = await fetch(url);
  if (!r.ok) throw new Error("reference JSON: HTTP " + r.status + " for " + url);
  var spec = laxJson(await r.text());
  var refs = spec.refs || spec, templates = spec.templates || {};
  if (spec.gen && spec.gen.length) throw new Error("reference JSON uses \"gen\" ranges, which are not supported");
  delete refs.version;
  var enc = new TextEncoder(), bytes = new Map();
  function fill(u) {
    return String(u).replace(/\{\{\s*(\w+)\s*\}\}/g, function (_, k) { return templates[k] !== undefined ? templates[k] : _; });
  }
  if (!refs[".zmetadata"]) {   // consolidate the inline metadata, so the store lists
    var meta = {};
    Object.keys(refs).forEach(function (k) {
      if (!/(^|\/)\.z(array|attrs|group)$/.test(k) || typeof refs[k] !== "string") return;
      try { meta[k] = JSON.parse(refs[k].indexOf("base64:") === 0 ? new TextDecoder().decode(b64bytes(refs[k].slice(7))) : refs[k]); }
      catch (e) { /* skip */ }
    });
    refs[".zmetadata"] = JSON.stringify({ zarr_consolidated_format: 1, metadata: meta });
  }
  async function get(key0, opts) {
    var key = String(key0).replace(/^\/+/, "");
    var v = refs[key];
    if (v === undefined) return undefined;
    if (typeof v === "string") {
      var b = v.indexOf("base64:") === 0 ? b64bytes(v.slice(7)) : enc.encode(v);
      bytes.set(key0, b.byteLength);
      return b;
    }
    if (typeof v === "object" && !Array.isArray(v)) {   // already-parsed JSON
      return enc.encode(JSON.stringify(v));
    }
    var target = httpsOf(fill(v[0]), url), headers = {};
    if (v.length >= 3) headers.Range = "bytes=" + v[1] + "-" + (v[1] + v[2] - 1);
    var res = await fetchRef(target, { headers: headers, signal: opts && opts.signal });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + target);
    var buf = new Uint8Array(await res.arrayBuffer());
    if (v.length >= 3 && res.status === 200 && buf.byteLength > v[2]) buf = buf.subarray(v[1], v[1] + v[2]);   // no range support
    bytes.set(key0, buf.byteLength);
    return buf;
  }
  return { get: get, bytes: bytes, keys: Object.keys(refs), refs: "kerchunk-json" };
}

// Kerchunk Parquet: .zmetadata = { metadata: { key: object }, record_size };
// a chunk's reference is row (i % record_size) of <var>/refs.<i / record_size>.parq,
// i the chunk's flat C-order index on the chunk grid, with columns path,
// offset, size, raw (raw = inline bytes; no path and no raw = no chunk;
// size 0 = the whole file). Rows of a file are decoded once and kept for
// the most recently used files.
var HYPARQUET = "https://cdn.jsdelivr.net/npm/hyparquet@1/+esm";
// zstd, brotli, gzip and lz4 for hyparquet (fastparquet writes zstd)
var COMPRESSORS = "https://cdn.jsdelivr.net/npm/hyparquet-compressors@1/+esm";
var hpPromise = null;
function hyparquet() {
  if (!hpPromise) {
    hpPromise = Promise.all([import(HYPARQUET), import(COMPRESSORS).catch(function () { return null; })])
      .then(function (m) { return { hp: m[0], compressors: m[1] && m[1].compressors }; });
    hpPromise.catch(function () { hpPromise = null; });
  }
  return hpPromise;
}
// JSON as Python writes it: bare NaN / Infinity become strings.
function laxJson(t) {
  try { return JSON.parse(t); }
  catch (e) {
    return JSON.parse(t.replace(/([:\[,]\s*)(-?Infinity|NaN)(?=\s*[,}\]])/g, '$1"$2"'));
  }
}
async function parquetRefStore(url, zm) {
  var base = url.replace(/\/+$/, "");
  if (!zm) {
    var r = await fetch(base + "/.zmetadata");
    if (!r.ok) throw new Error("Kerchunk Parquet: HTTP " + r.status + " for " + base + "/.zmetadata");
    zm = laxJson(await r.text());
  }
  var meta = zm.metadata || {}, rs = +zm.record_size || 100000;
  Object.keys(meta).forEach(function (k) {   // some writers store the JSON as text
    if (typeof meta[k] === "string") { try { meta[k] = JSON.parse(meta[k]); } catch (e) { /* keep */ } }
    // R writers wrap scalar attributes in one-element arrays: unwrap them
    if (/\.zattrs$/.test(k) && meta[k] && typeof meta[k] === "object") {
      Object.keys(meta[k]).forEach(function (a) {
        var v = meta[k][a];
        if (a !== "_ARRAY_DIMENSIONS" && Array.isArray(v) && v.length === 1 && typeof v[0] !== "object") meta[k][a] = v[0];
      });
    }
  });
  var enc = new TextEncoder(), dec = new TextDecoder(), bytes = new Map();
  var consolidated = enc.encode(JSON.stringify({ zarr_consolidated_format: 1, metadata: meta }));
  var files = new Map(), FILES_KEPT = 12;
  function rowsOf(file) {
    if (files.has(file)) {
      var hit = files.get(file); files.delete(file); files.set(file, hit);
      return hit;
    }
    var p = (async function () {
      var h = await hyparquet();
      var buf = await h.hp.asyncBufferFromUrl({ url: file });
      return h.hp.parquetReadObjects({ file: buf, columns: ["path", "offset", "size", "raw"], utf8: false,
                                       compressors: h.compressors || undefined });
    })();
    p.catch(function () { files.delete(file); });
    files.set(file, p);
    while (files.size > FILES_KEPT) files.delete(files.keys().next().value);
    return p;
  }
  function text(v) { return v === null || v === undefined ? null : typeof v === "string" ? v : dec.decode(v); }
  async function get(key0, opts) {
    var key = String(key0).replace(/^\/+/, "");
    if (key === ".zmetadata") return consolidated;
    if (/(^|\/)\.z(array|attrs|group)$/.test(key)) {
      return meta[key] !== undefined ? enc.encode(JSON.stringify(meta[key])) : undefined;
    }
    var slash = key.lastIndexOf("/"), name = key.slice(0, slash), ck = key.slice(slash + 1);
    var za = meta[name + "/.zarray"];
    if (!za) return undefined;
    var sep = za.dimension_separator || ".";
    var idx = ck === "0" && !za.shape.length ? [] : ck.split(sep).map(Number);
    var flat = 0;
    for (var d = 0; d < za.shape.length; d++) {
      flat = flat * Math.ceil(za.shape[d] / za.chunks[d]) + (idx[d] || 0);
    }
    var rows = await rowsOf(base + "/" + name + "/refs." + Math.floor(flat / rs) + ".parq");
    var row = rows[flat % rs];
    if (!row) return undefined;
    if (row.raw !== null && row.raw !== undefined) {
      var rb = typeof row.raw === "string" ? enc.encode(row.raw) : new Uint8Array(row.raw);
      bytes.set(key0, rb.byteLength);
      return rb;
    }
    var path = text(row.path);
    if (!path) return undefined;
    var target = httpsOf(path, base + "/"), headers = {}, size = Number(row.size), off = Number(row.offset);
    if (size > 0) headers.Range = "bytes=" + off + "-" + (off + size - 1);
    var res = await fetchRef(target, { headers: headers, signal: opts && opts.signal });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + target);
    var b = new Uint8Array(await res.arrayBuffer());
    if (size > 0 && res.status === 200 && b.byteLength > size) b = b.subarray(off, off + size);
    bytes.set(key0, b.byteLength);
    return b;
  }
  return { get: get, bytes: bytes, refs: "kerchunk-parquet" };
}

var datasets = new Map();
function openDataset(url) {
  url = String(url || "").trim().replace(/\/+$/, "");
  if (!datasets.has(url)) {
    var p = (async function () {
      var z = await zarrita();
      var counting = isIcechunkUrl(url) ? await icechunkStore(url, z)
        : isParquetRefs(url) ? await parquetRefStore(url)
        : isReferenceUrl(url) ? await referenceStore(url) : null;
      if (!counting) {   // a Parquet reference directory need not say so in its name
        var zm = null, v3 = false;
        try {
          var zr = await fetch(url + "/.zmetadata");
          if (zr.ok) zm = laxJson(await zr.text());
        } catch (e) { /* not there, or not JSON: an ordinary store */ }
        if (!zm) {
          try { v3 = (await fetch(url + "/zarr.json")).ok; } catch (e) { /* not v3 either */ }
        }
        // neither .zmetadata nor zarr.json: perhaps an Icechunk repository
        counting = zm && zm.record_size ? await parquetRefStore(url, zm)
          : !zm && !v3 && await looksLikeIcechunk(url) ? await icechunkStore(url, z) : countingStore(z, url);
      }
      // (an Icechunk snapshot is its own index: no consolidated metadata needed)
      var store = counting.paths ? counting : await z.withMaybeConsolidatedMetadata(counting);
      var paths = counting.paths ||
        (store.contents ? store.contents().filter(function (c) { return c.kind === "array"; })
                                          .map(function (c) { return c.path; }) : null);
      var rootAttrs = {};
      try { rootAttrs = (await z.open(z.root(store), { kind: "group" })).attrs || {}; } catch (e) { /* no group */ }
      return { z: z, url: url, store: store, counting: counting, paths: paths, rootAttrs: rootAttrs,
               refs: counting.refs || false, icechunk: counting.icechunk || null,
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

// xarray writes a float _FillValue into Zarr v3 attributes as the base64
// of its little-endian bytes ("AAAAAAAA+H8=" is a float64 NaN)
function fillOf(v, dtype) {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(v) || v.length % 4 || /^(NaN|-?Infinity)$/.test(v)) return v;
  var b = b64bytes(v), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length === 8) return dv.getFloat64(0, true);
  if (b.length === 4) return /int/.test(dtype) ? dv.getInt32(0, true) : dv.getFloat32(0, true);
  return v;
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
      throw new Error(name + " is not regularly spaced, and no 2D longitude / latitude coordinates were found (irregular grids are not supported)");
    }
  }
  return { first: v[0], step: step, n: n };
}

// CF time units -> function (value) -> epoch ms
var UNIT_MS = { second: 1e3, sec: 1e3, s: 1e3, minute: 6e4, min: 6e4, hour: 36e5, h: 36e5, hr: 36e5,
                day: 864e5, d: 864e5, week: 6048e5, millisecond: 1, msec: 1, ms: 1 };
// Model calendars without leap years (or with 30-day months) count days
// differently: the offset is turned into that calendar's date and time,
// which is then given as the same date in the ordinary calendar.
var MONTHS = { noleap: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
               all_leap: [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
               "360_day": [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30] };
MONTHS["365_day"] = MONTHS.noleap; MONTHS["366_day"] = MONTHS.all_leap;
function timeDecoder(units, calendar) {
  var m = /^\s*(\w+?)s?\s+since\s+(.+?)\s*$/i.exec(String(units || ""));
  if (!m) return null;
  var per = UNIT_MS[m[1].toLowerCase()];
  if (!per) return null;
  var ref = m[2].replace(" ", "T").replace(/\s.*$/, "");
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(ref)) ref += "T00:00:00";
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(ref)) ref += "Z";
  var t0 = Date.parse(ref.replace(/^(\d{4})-(\d)-/, "$1-0$2-").replace(/-(\d)T/, "-0$1T"));
  if (!isFinite(t0)) return null;
  var mon = MONTHS[String(calendar || "").toLowerCase()];
  if (!mon) return function (v) { return t0 + v * per; };
  var yearDays = mon.reduce(function (a, b) { return a + b; }, 0);
  var d0 = new Date(t0), y0 = d0.getUTCFullYear(), dayOfYear = d0.getUTCDate() - 1;
  for (var k = 0; k < d0.getUTCMonth(); k++) dayOfYear += mon[k];
  var inDay0 = t0 - Date.UTC(y0, d0.getUTCMonth(), d0.getUTCDate());
  return function (v) {
    var ms = dayOfYear * 864e5 + inDay0 + v * per;   // since 1 January of y0, in that calendar
    var days = Math.floor(ms / 864e5), rest = ms - days * 864e5;
    var y = y0 + Math.floor(days / yearDays);
    days -= Math.floor(days / yearDays) * yearDays;
    var mo = 0;
    while (days >= mon[mo]) { days -= mon[mo]; mo++; }
    // 30 February (360_day) has no ordinary date: it is shown as the 28th or 29th
    var last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return Date.UTC(y, mo, Math.min(days + 1, last)) + rest;
  };
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
// -> { crs, from, assumed }
// The variable's grid mapping: its CF grid_mapping attribute, else a
// scalar array among its "coordinates" that carries a WKT (the rioxarray
// "spatial_ref" convention, as dynamical.org's stores use).
async function gridMapping(ds, arr, parent) {
  var a = arr.attrs || {};
  if (a.grid_mapping) return String(a.grid_mapping).split(/[\s:]+/)[0];
  var names = String(a.coordinates || "").split(/\s+/).filter(Boolean);
  for (var i = 0; i < names.length; i++) {
    try {
      var c = await arrayAt(ds, (parent || "") + "/" + names[i]);
      if (c.shape.length === 0 && c.attrs && (c.attrs.crs_wkt || c.attrs.spatial_ref)) return names[i];
    } catch (e) { /* not an array */ }
  }
  return null;
}

async function variableCrs(ds, arr, xName, xAttrs, opts) {
  if (opts.crs) return { crs: await resolveCrs(opts.crs), from: "entered on the page", assumed: true };
  if (isLonLat(xName, xAttrs)) {
    return { crs: "EPSG:4326", assumed: true,
             from: "the lon/lat coordinate " + (xAttrs && xAttrs.units ? "units" : "names") + ", WGS84 taken as the datum" };
  }
  var a = arr.attrs || {};
  var gm = await gridMapping(ds, arr, arr.path.replace(/\/[^/]*$/, ""));
  if (gm) {
    try {
      var g = await arrayAt(ds, gm), ga = g.attrs || {};
      var wkt = ga.crs_wkt || ga.spatial_ref;
      if (wkt) return { crs: crsFromWkt(wkt), from: "grid_mapping \"" + gm + "\" WKT" };
      if (ga.epsg_code) return { crs: await resolveCrs(ga.epsg_code), from: "grid_mapping \"" + gm + "\" epsg_code" };
    } catch (e) { /* fall through */ }
  }
  var cands = [a["proj:code"], a["proj:epsg"], a.crs, ds.rootAttrs["proj:code"], ds.rootAttrs["proj:epsg"],
               ds.rootAttrs.crs, ds.rootAttrs.epsg];
  for (var i = 0; i < cands.length; i++) {
    if (cands[i] !== undefined && cands[i] !== null && cands[i] !== "") {
      var c = String(cands[i]);
      return { crs: /^\s*(PROJCS|GEOGCS|PROJCRS|GEOGCRS)/.test(c) ? crsFromWkt(c) : await resolveCrs(c),
               from: "a CRS attribute (" + (i < 3 ? "variable" : "root group") + ")" };
    }
  }
  throw new Error("no CRS found for " + arr.path + " (no grid_mapping); enter one, e.g. EPSG:3031");
}

// 2D longitude and latitude arrays over two of the variable's dimensions:
// the ones its "coordinates" attribute names, else any in the store.
// -> { lon, lat (arrays), lonName, latName, dims: [ydim, xdim] } | null
async function curvilinearCoords(ds, arr, dims, parent) {
  var a = arr.attrs || {}, names = a.coordinates;
  names = Array.isArray(names) ? names.join(" ") : String(names || "");
  names = names.split(/\s+/).filter(Boolean);
  var fromAttr = names.length > 0;
  if (!fromAttr && ds.paths) names = ds.paths.map(function (q) { return q.replace(/^\//, ""); });
  var lon = null, lat = null;
  for (var k = 0; k < names.length && !(lon && lat); k++) {
    var n = names[k], c = null;
    try { c = await arrayAt(ds, (n.indexOf("/") < 0 ? parent + "/" : "/") + n); }
    catch (e) { try { c = await arrayAt(ds, "/" + n); } catch (e2) { c = null; } }
    if (!c || c.shape.length !== 2) continue;
    var cd = dimNames(c);
    if (!cd || dims.indexOf(cd[0]) < 0 || dims.indexOf(cd[1]) < 0) continue;
    var r = role(n.split("/").pop(), c.attrs);
    var sn = String((c.attrs || {}).standard_name || "");
    if (!lon && (r === "x" || /longitude/.test(sn)) && isLonLat(n, c.attrs)) lon = { arr: c, name: n, dims: cd };
    else if (!lat && (r === "y" || /latitude/.test(sn)) && isLonLat(n, c.attrs)) lat = { arr: c, name: n, dims: cd };
  }
  if (!lon || !lat || lon.dims.join() !== lat.dims.join()) return null;
  return { lon: lon.arr, lat: lat.arr, lonName: lon.name, latName: lat.name, dims: lon.dims, fromAttr: fromAttr };
}

// The CF bounds of a 2D coordinate (H x W x 4), or null.
async function cellBounds(ds, c, parent) {
  var b = c.attrs && c.attrs.bounds;
  if (!b) return null;
  try {
    var ba = await arrayAt(ds, parent + "/" + String(b));
    if (ba.shape.length !== 3 || ba.shape[2] !== 4) return null;
    return toNumbers((await ds.z.get(ba)).data);
  } catch (e) { return null; }
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
      // a HEALPix grid: one cell dimension, its geometry implied (../dggs.js)
      var hpf = await findHealpix(name, arr, dims, parent, ds.rootAttrs, function (q) { return arrayAt(ds, q); });
      var dggs = null;
      if (hpf) {
        try {
          dggs = await healpixGeometry(hpf, arr.shape[hpf.axis], async function () { return (await ds.z.get(hpf.cellIds)).data; });
        } catch (e) {
          throw new Error(name + ": " + hpf.label + " is not supported here yet (" + String(e && e.message || e) + ")");
        }
        xi = yi = hpf.axis;
      }
      // 2D lon/lat win over 1D x/y, which on such grids are often nominal
      // (GFDL's tripolar x and y are "degrees" that are not longitudes);
      // a grid_mapping with 1D coordinates says the grid is regular.
      var cv = dggs || xi >= 0 && yi >= 0 && coords[xi] && coords[yi] && await gridMapping(ds, arr, parent)
        ? null : await curvilinearCoords(ds, arr, dims, parent);
      var curv = null, geom;
      if (cv) {
        xi = dims.indexOf(cv.dims[1]); yi = dims.indexOf(cv.dims[0]);
        if (roles[xi] === "t" || roles[yi] === "t") cv = null;
      }
      if (cv) {
        var Wc = arr.shape[xi], Hc = arr.shape[yi];
        var lonv = toNumbers((await ds.z.get(cv.lon)).data), latv = toNumbers((await ds.z.get(cv.lat)).data);
        // the cells' corners: CF bounds, else ROMS psi points for rho cells
        var blon = await cellBounds(ds, cv.lon, parent), blat = blon ? await cellBounds(ds, cv.lat, parent) : null;
        var corners = null, cornersFrom = "half way between centres";
        if (blon && blat) { corners = { bounds: [blon, blat] }; cornersFrom = "from their CF bounds"; }
        else if (/^lon_rho$/.test(cv.lonName.split("/").pop())) {
          try {
            var pl = await arrayAt(ds, parent + "/lon_psi"), pt = await arrayAt(ds, parent + "/lat_psi");
            if (pl.shape[0] === Hc - 1 && pl.shape[1] === Wc - 1) {
              corners = { psi: [toNumbers((await ds.z.get(pl)).data), toNumbers((await ds.z.get(pt)).data)] };
              cornersFrom = "from the ROMS psi points";
            }
          } catch (e) { /* no psi points */ }
        }
        var bbx = centresBbox(lonv, latv), sp = centreSpacing(lonv, latv, Wc, Hc);
        curv = { lon: lonv, lat: latv, corners: corners, W: Wc, H: Hc,
                 names: [cv.lonName, cv.latName], fp: null, projected: new Map(), cells: new Map() };
        geom = { origin: null, res: [sp[0], -sp[1]], crs: "EPSG:4326", wrap: false, ext: bbx, bbox: bbx,
                 crsFrom: "the 2D coordinates " + cv.lonName + " / " + cv.latName +
                   " (curvilinear; cell corners " + cornersFrom +
                   "), WGS84 taken as the datum", assumed: true };
      } else if (dggs) {
        var el = dggs.ellipsoid;
        geom = { origin: null, res: [dggs.cellDeg, -dggs.cellDeg], crs: "EPSG:4326", wrap: false,
                 ext: dggs.bbox, bbox: dggs.bbox, assumed: el.assumed || dggs.schemeAssumed,
                 crsFrom: "HEALPix attributes on " + dggs.how + "; cells on " + el.label +
                   (el.spec ? "" : ", its latitudes drawn as WGS84 latitudes unchanged") +
                   (dggs.idsFrom ? "; " + dggs.idsFrom : "") };
      } else {
        geom = await regularGeometry();
      }
      async function regularGeometry() {
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
        var cs = await variableCrs(ds, arr, dims[xi], coords[xi].attrs, opts), crs = cs.crs;
        var W = arr.shape[xi], H = arr.shape[yi];
        var origin = [xa.first - xa.step / 2, ya.first - ya.step / 2];
        var res = [xa.step, ya.step];
        var x0 = origin[0], x1 = origin[0] + W * res[0], y0 = origin[1], y1 = origin[1] + H * res[1];
        var ext = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
        var geo = crs === "EPSG:4326";
        // 0..360 longitudes: grid longitudes west of the data wrap round by 360
        var wrap = geo && ext[2] > 180.5;
        var bbox = geo ? [wrap ? -180 : Math.max(-180, ext[0]), Math.max(-90, ext[1]),
                          wrap ? 180 : Math.min(180, ext[2]), Math.min(90, ext[3])]
                       : transformBbox(ext, crs, "EPSG:4326");
        return { origin: origin, res: res, crs: crs, wrap: wrap, ext: ext, bbox: bbox,
                 crsFrom: cs.from, assumed: cs.assumed };
      }
      var W = arr.shape[xi], H = dggs ? 1 : arr.shape[yi];
      var times = null;
      if (ti >= 0 && coords[ti]) {
        var tat = coords[ti].attrs || {};
        var dec = timeDecoder(tat.units, tat.calendar);
        if (dec) {
          var tv = await timeValues(ds, coords[ti]);
          times = Array.prototype.map.call(tv, dec);
        }
      }
      if (ti >= 0 && !times) ti = -1;   // an undecodable time axis is an extra dimension
      // the other dimensions (depth, level, band, ...): picked by index
      var extra = [];
      for (var d = 0; d < dims.length; d++) {
        if (d === xi || d === yi || d === ti) continue;
        var vals = null, ca = (coords[d] && coords[d].attrs) || {};
        if (coords[d] && arr.shape[d] <= 5000) {
          try { vals = Array.prototype.map.call((await ds.z.get(coords[d])).data, Number); } catch (e) { vals = null; }
        }
        // an ocean s-coordinate (ROMS) runs from the bottom (-1) to the
        // surface (0): start at the surface
        var def = 0;
        if (vals && /ocean_s_coordinate|ocean_sigma/.test(String(ca.standard_name || "")) && ca.positive === "up") {
          for (var q = 1; q < vals.length; q++) if (vals[q] > vals[def]) def = q;
        }
        extra.push({ d: d, name: dims[d], n: arr.shape[d], values: vals, units: ca.units || "", def: def,
                     longName: ca.long_name || ca.standard_name || "", positive: ca.positive || "" });
      }
      var shard = null;   // the v3 sharding codec's outer chunk shape
      if (arr.dimensionNames) {
        try {
          var zj = JSON.parse(new TextDecoder().decode(await ds.store.get(path + "/zarr.json")));
          var sc = (zj.codecs || [])[0], kenc = zj.chunk_key_encoding || {};
          if (sc && sc.name === "sharding_indexed") {
            shard = { shape: zj.chunk_grid.configuration.chunk_shape,
                      sep: kenc.configuration && kenc.configuration.separator || "/" };
          }
        } catch (e) { /* not v3, or no metadata object: unsharded */ }
      }
      var a = arr.attrs || {};
      var fill = a._FillValue !== undefined ? fillOf(a._FillValue, arr.dtype) : arr.fillValue;
      return {
        path: path, arr: arr, shard: shard, dims: dims, xi: xi, yi: yi, ti: ti, W: W, H: H, extra: extra, curv: curv, dggs: dggs,
        origin: geom.origin, res: geom.res, crs: geom.crs, crsFrom: geom.crsFrom + "; definition: " + crsProvenance(geom.crs),
        crsAssumed: !!geom.assumed, wrap: geom.wrap, extent: geom.ext, bbox: geom.bbox,
        scale: a.scale_factor !== undefined && a.scale_factor !== null ? +a.scale_factor : 1,
        offset: a.add_offset !== undefined && a.add_offset !== null ? +a.add_offset : 0,
        fill: fill === null || fill === undefined || fill === "NaN" ? null : Number(fill),
        missing: a.missing_value !== undefined && a.missing_value !== null ? Number(a.missing_value) : null,
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

// Decoded chunks live in the shared chunk cache (chunks.js), keyed by
// store, array and chunk coordinates.
function cached(key, make, signal) {
  return getChunk("zarr|" + key, make, { signal: signal, sizeOf: function (ch) {
    return (ch && ch.data && ch.data.byteLength) || 0;
  } });
}

function chunkKey(v, coords) {
  // keys as written in v2 (dot or slash separated) and v3 ("c/...")
  return [v.path + "/" + coords.join("."), v.path + "/" + coords.join("/"),
          v.path + "/c/" + coords.join("/")];
}

// A sharded (v3) array reads its inner chunks as byte ranges of one shard
// object, so a chunk's cost is not a key of its own: the bytes each shard
// cost over a read are shared out among the chunks fetched from it.
function shardKey(v, coords) {
  return v.path + "/c" + v.shard.sep + coords.map(function (c, i) {
    return Math.floor(c * v.arr.chunks[i] / v.shard.shape[i]);
  }).join(v.shard.sep);
}
function meterShards(bytes, log, before) {
  var by = {};
  log.forEach(function (e) { if (e.shard) (by[e.shard] = by[e.shard] || []).push(e); });
  Object.keys(by).forEach(function (k) {
    var got = (bytes.get(k) || 0) - (before.get(k) || 0);
    by[k].forEach(function (e) { e.bytes = Math.round(got / by[k].length); delete e.shard; });
  });
}

async function pool(items, n, fn) {
  var next = 0;
  async function worker() { while (next < items.length) { var i = next++; await fn(items[i], i); } }
  var ws = [];
  for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
  await Promise.all(ws);
}

// { name: index } for the extra dimensions -> index per dimension (0 when
// not given, clamped to the dimension's length).
function selection(v, sel) {
  var at = v.dims.map(function () { return 0; });
  (v.extra || []).forEach(function (e) {
    var k = sel && sel[e.name];
    at[e.d] = k !== undefined && k !== null ? Math.max(0, Math.min(e.n - 1, Math.floor(+k) || 0)) : (e.def || 0);
  });
  return at;
}

// Read one asset { kind: "zarr", url, variable, index (time index or -1), crs,
//   sel ({ dimension: index } for dimensions other than x, y and time) }
// warped onto the grid. Same contract as readWarped / readTilesWarped.
//   opts.maxChunks  cap on chunks per read (default 64)
//   opts.maxMB      cap on their decoded size (default 400)
export async function readZarrWarped(a, grid, opts) {
  opts = opts || {};
  var maxChunks = opts.maxChunks || a.maxChunks || 64, maxMB = opts.maxMB || 400;
  var ds = await openDataset(a.url);
  var v = await describe(ds, a.variable, { crs: a.crs });
  if (v.curv) return readCurvilinear(a, grid, opts, ds, v, maxChunks, maxMB);
  if (v.dggs) {
    return readDggs(a, grid, opts, ds, v, maxChunks, maxMB, { cached: cached, chunkKey: chunkKey, shardKey: shardKey,
                                                               meterShards: meterShards, selection: selection, pool: pool });
  }
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
  var at = selection(v, a.sel);   // index along each dimension other than x and y
  if (ti >= 0) at[v.ti] = ti;
  var jobs = [];
  for (var r = cr0; r <= cr1; r++) for (var c = ch0; c <= ch1; c++) jobs.push([c, r]);
  var log = [];
  var scale = v.scale, offset = v.offset, fill = v.fill, missing = v.missing;
  var before = v.shard ? new Map(ds.counting.bytes) : null;
  await pool(jobs, 4, async function (j) {
    var coords = v.dims.map(function (d, i) {
      if (i === v.xi) return j[0];
      if (i === v.yi) return j[1];
      return Math.floor((at[i] || 0) / v.arr.chunks[i]);
    });
    var key = a.url + "|" + v.path + "|" + coords.join(".");
    var t0 = performance.now();
    var got = cached(key, function (sig) { return v.arr.getChunk(coords, { signal: sig }); }, opts.signal);
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
      if (v.shard) e.shard = shardKey(v, coords);
    }
    var data = chunk.data, st = chunk.stride, big = typeof data[0] === "bigint";
    var base = 0;
    for (var d = 0; d < coords.length; d++) {
      if (d === v.xi || d === v.yi) continue;
      var within = (at[d] || 0) - coords[d] * v.arr.chunks[d];
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
  if (before) meterShards(ds.counting.bytes, log, before);
  var res = resampleWindow(lat, grid, [out], ww, wh, wx0, wy0, f, f, NaN, null);
  if (!res.any) {
    var bad = log.filter(function (t) { return t.error; })[0];
    if (bad && log.every(function (t) { return !t.ok; })) throw new Error("no chunk could be read (" + bad.error + ")");
    return null;
  }
  return { bands: res.bands, valid: res.valid, nodata: NaN, level: f, log: log };
}

// The cell under each grid pixel, for a curvilinear variable: footprints
// built once, projected once per CRS, rasterised once per grid (the same
// region read for another day or slice reuses it).
function curvCells(v, grid) {
  var cv = v.curv, crs = ensureCrs(grid.crs);
  if (!cv.fp) cv.fp = footprints(cv.lon, cv.lat, cv.W, cv.H, cv.corners);
  if (!cv.projected.has(crs)) {
    if (cv.projected.size > 3) cv.projected.clear();
    cv.projected.set(crs, projectFootprints(cv.fp, crs));
  }
  var gk = crs + "|" + grid.bbox.join(",") + "|" + grid.width + "x" + grid.height;
  if (!cv.cells.has(gk)) {
    if (cv.cells.size > 8) cv.cells.delete(cv.cells.keys().next().value);
    cv.cells.set(gk, rasterCells(cv.projected.get(crs), grid));
  }
  return cv.cells.get(gk);
}

async function readCurvilinear(a, grid, opts, ds, v, maxChunks, maxMB) {
  var rc = curvCells(v, grid), win = rc.window;
  if (!win) return null;
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
  // the source cells of the window, unpacked
  var ww = win[2] - win[0], wh = win[3] - win[1];
  var vals = new Float32Array(ww * wh).fill(NaN);
  var at = selection(v, a.sel);
  if (v.ti >= 0) at[v.ti] = Math.max(0, a.index || 0);
  var jobs = [];
  for (var r = cr0; r <= cr1; r++) for (var c = ch0; c <= ch1; c++) jobs.push([c, r]);
  var log = [], cv = v.curv;
  var scale = v.scale, offset = v.offset, fill = v.fill, missing = v.missing;
  var before = v.shard ? new Map(ds.counting.bytes) : null;
  await pool(jobs, 4, async function (j) {
    var coords = v.dims.map(function (d, i) {
      if (i === v.xi) return j[0];
      if (i === v.yi) return j[1];
      return Math.floor((at[i] || 0) / v.arr.chunks[i]);
    });
    var r0 = j[1] * cy, r1 = Math.min(v.H, r0 + cy), c0 = j[0] * cx, c1 = Math.min(v.W, c0 + cx);
    // a chunk's place for the inspector: the lon/lat box of its centres
    var w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
    for (var y = r0; y < r1; y++) {
      for (var x = c0; x < c1; x++) {
        var lo = cv.lon[y * v.W + x], la = cv.lat[y * v.W + x];
        if (lo < w) w = lo; if (lo > e) e = lo; if (la < s) s = la; if (la > nn) nn = la;
      }
    }
    var key = a.url + "|" + v.path + "|" + coords.join(".");
    var t0 = performance.now();
    var got = cached(key, function (sig) { return v.arr.getChunk(coords, { signal: sig }); }, opts.signal);
    var ent = { kind: "chunk", z: v.path.slice(1), x: j[0], y: j[1], url: a.url + chunkKey(v, coords)[0],
                crs: "EPSG:4326", ok: false, status: null, bytes: 0, ms: 0, cached: got.hit,
                extent: e - w < 180 ? [w, s, e, nn] : [-180, s, 180, nn] };
    log.push(ent);
    var chunk;
    try { chunk = await got.p; }
    catch (err) {
      if (err && err.name === "AbortError") throw err;
      ent.error = String(err && err.message || err); ent.status = 404;
      return;
    }
    ent.ms = Math.round(performance.now() - t0);
    ent.ok = true; ent.status = got.hit ? "cache" : 200;
    if (!got.hit) {
      var keys = chunkKey(v, coords);
      for (var q = 0; q < keys.length; q++) {
        if (ds.counting.bytes.has(keys[q])) { ent.bytes = ds.counting.bytes.get(keys[q]); break; }
      }
      if (v.shard) ent.shard = shardKey(v, coords);
    }
    var data = chunk.data, st = chunk.stride, big = typeof data[0] === "bigint";
    var base = 0;
    for (var d = 0; d < coords.length; d++) {
      if (d === v.xi || d === v.yi) continue;
      base += ((at[d] || 0) - coords[d] * v.arr.chunks[d]) * st[d];
    }
    var sx = st[v.xi], sy = st[v.yi];
    var Y0 = Math.max(win[1], r0), Y1 = Math.min(win[3], r1);
    var X0 = Math.max(win[0], c0), X1 = Math.min(win[2], c1);
    for (var Y = Y0; Y < Y1; Y++) {
      var so = base + (Y - r0) * sy, o = (Y - win[1]) * ww - win[0];
      for (var X = X0; X < X1; X++) {
        var raw = data[so + (X - c0) * sx];
        if (big) raw = Number(raw);
        if (raw === fill || raw === missing || raw !== raw) continue;
        vals[o + X] = raw * scale + offset;
      }
    }
  });
  if (before) meterShards(ds.counting.bytes, log, before);
  // each pixel takes the value of the cell under its centre
  var npx = grid.width * grid.height, out = new Float32Array(npx).fill(NaN), valid = new Uint8Array(npx);
  function valueOf(k) {
    var ci = k % v.W, ri = (k - ci) / v.W;
    return vals[(ri - win[1]) * ww + (ci - win[0])];
  }
  // drawn again with only the cells that have data, so where footprints
  // overlap (ROMS land cells over water) a cell with data wins
  var cell = rasterCells(v.curv.projected.get(ensureCrs(grid.crs)), grid, {
    window: win, keep: function (k) { var x = valueOf(k); return x === x; } }).cell;
  var any = false;
  for (var p = 0; p < npx; p++) {
    if (cell[p] < 0) continue;
    var val = valueOf(cell[p]);
    out[p] = val; valid[p] = 1; any = true;
  }
  if (!any) {
    var bad = log.filter(function (t) { return t.error; })[0];
    if (bad && log.every(function (t) { return !t.ok; })) throw new Error("no chunk could be read (" + bad.error + ")");
    return null;
  }
  return { bands: [out], valid: valid, nodata: NaN, level: 1, log: log };
}

// --- a vertical profile at one place -----------------------------------------------------

// The value of one asset at the one pixel of a 1x1 grid (X.cellGrid), or NaN.
async function cellValue(a, grid, opts) {
  var r = await readZarrWarped(a, grid, opts);
  return r && r.valid[0] ? r.bands[0][0] : NaN;
}
// A scalar coordinate (ROMS hc, Vtransform): zarrita hands back a 0-d array's
// value itself, a 1-element array's as { data }.
async function scalarAt(ds, path) {
  var r = await ds.z.get(await arrayAt(ds, path));
  var x = r && r.data !== undefined ? r.data : r;
  return x && x.length !== undefined ? Number(x[0]) : Number(x);
}

// Values of an asset at one pixel along one of its other dimensions (depth,
// level, s-coordinate, ...), every index of it, for the asset's own time.
// The pixel is the 1x1 grid's (X.cellGrid of the pinned pixel), so each
// value is the one the map would show at that pixel for that level.
// -> { dim, n, values: the dimension's coordinate values | null, units,
//      positive, data: [value per index], z: depth per index in metres
//      (positive down) | null, zFrom }
// A ROMS s-coordinate is turned into depth with the model's own stretching
// (Vtransform 1 or 2, Cs_r / Cs_w, hc) and the bathymetry h and free
// surface zeta read at the same pixel; only for variables on rho points,
// where h is.
export async function zarrProfile(a, grid, dimName, opts) {
  opts = opts || {};
  var ds = await openDataset(a.url);
  var v = await describe(ds, a.variable, { crs: a.crs });
  var e = v.extra.filter(function (x) { return x.name === dimName; })[0] || v.extra[0];
  if (!e) throw new Error(a.variable + " has no dimension other than x, y and time");
  var data = new Array(e.n).fill(NaN);
  var idx = [];
  for (var k = 0; k < e.n; k++) idx.push(k);
  await pool(idx, 4, async function (k) {
    var sel = Object.assign({}, a.sel || {});
    sel[e.name] = k;
    data[k] = await cellValue(Object.assign({}, a, { sel: sel }), grid, opts);
  });
  var out = { dim: e.name, n: e.n, values: e.values, units: e.units, positive: e.positive, data: data,
              z: null, zFrom: "" };
  var parent = v.path.replace(/\/[^/]*$/, "");
  var dimArr = await arrayAt(ds, parent + "/" + e.name).catch(function () { return null; });
  var isS = !!dimArr && /ocean_s_coordinate/.test(String((dimArr.attrs || {}).standard_name || ""));
  if (isS && e.values && v.curv && /lon_rho$/.test(v.curv.names[0])) {
    try {
      var cs = await ds.z.get(await arrayAt(ds, parent + "/" + (e.name === "s_w" ? "Cs_w" : "Cs_r")));
      var hc = await scalarAt(ds, parent + "/hc");
      var vt = 1;
      try { vt = await scalarAt(ds, parent + "/Vtransform"); } catch (err) { vt = 1; }
      if (vt !== 2) vt = 1;
      var h = await cellValue(Object.assign({}, a, { variable: "h", sel: null }), grid, opts);
      var zeta = 0, zf = "zeta at this time";
      try { zeta = await cellValue(Object.assign({}, a, { variable: "zeta", sel: null }), grid, opts); }
      catch (err) { zeta = NaN; }
      if (!isFinite(zeta)) { zeta = 0; zf = "zeta taken as 0"; }
      if (isFinite(h) && isFinite(hc)) {
        out.z = e.values.map(function (sv, k) {
          var C = Number(cs.data[k]), z;
          if (vt === 2) { var z0 = (hc * sv + h * C) / (hc + h); z = zeta + (zeta + h) * z0; }
          else { var z1 = hc * sv + (h - hc) * C; z = z1 + zeta * (1 + z1 / h); }
          return -z;
        });
        out.zFrom = "ROMS Vtransform " + vt + ", hc " + hc + ", h " + +h.toFixed(2) + " m, " + zf;
      }
    } catch (err) { out.zFrom = "s-coordinate (no depth: " + String(err && err.message || err) + ")"; }
  } else if (e.values && /^(m|meters?|metres?)$/i.test(e.units)) {
    out.z = e.positive === "up" ? e.values.map(function (x) { return -x; }) : e.values.slice();
    out.zFrom = e.name + " (" + e.units + (e.positive ? ", positive " + e.positive : "") + ")";
    out.zIsCoordinate = true;
  }
  return out;
}

// The HEALPix cell under a lon/lat for a Zarr asset, or null when the
// variable is not on a DGGS (see dggsCellAt in ../dggs.js).
export async function zarrCellAt(a, lon, lat) {
  var v = await describe(await openDataset(a.url), a.variable, { crs: a.crs });
  return v.dggs ? dggsCellAt(v.dggs, lon, lat) : null;
}

// --- the catalogue -------------------------------------------------------------------------

function isoDay(ms) { return new Date(ms).toISOString().slice(0, 10); }

// opts = { url, variable (blank: the first usable one), crs (when the store
//          does not say), maxChunks, sel ({ dimension: index }) }
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
          var cellDims = {};   // dimensions a HEALPix cell_ids coordinate runs along
          arrs.forEach(function (a) { if (a && healpixAttrs(a.attrs)) (dimNames(a) || []).forEach(function (d) { cellDims[d] = 1; }); });
          var vars = [];
          arrs.forEach(function (a, i) {
            var at = a && a.attrs || {}, leaf = names[i].split("/").pop();
            if (!a || dimSet[leaf] || /^cell_ids?$/.test(leaf) || at.grid_name || at.dggs) return;
            // one dimension is enough for a HEALPix field: 12 x 4^level cells
            var lv = a.shape.length === 1 ? Math.log2(a.shape[0] / 12) / 2 : -1;
            if (a.shape.length < 2 && !((Number.isInteger(lv) || cellDims[(dimNames(a) || [])[0]]) && /float|int/.test(a.dtype))) return;
            vars.push({ name: names[i], dims: dimNames(a) || [], shape: a.shape, chunks: a.chunks,
                        dtype: a.dtype, units: at.units || "", longName: at.long_name || at.standard_name || "" });
          });
          // biggest first: the data, not the bounds or masks
          vars.sort(function (p, q) { return q.shape.length - p.shape.length; });
          return { variables: vars, attrs: ds.rootAttrs, consolidated: !!ds.paths, icechunk: ds.icechunk };
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
               crs: v.crs, crsFrom: v.crsFrom, crsAssumed: v.crsAssumed, bbox: v.bbox, res: v.res,
               curvilinear: !!v.curv, units: v.units, longName: v.longName,
               dggs: v.dggs ? dggsLine(v.dggs) : null,
               extra: v.extra.map(function (e) { return { name: e.name, n: e.n, def: e.def, values: e.values, units: e.units,
                                                          longName: e.longName, positive: e.positive }; }),
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
      // a HEALPix cell is a diamond: four pixels across draw it as one
      var groundRes = Math.abs(v.res[0]) * (v.crs === "EPSG:4326" ? 111320 : 1) * (v.dggs ? 0.25 : 1);
      return idx.map(function (i) {
        var assets = {}, meta = {};
        var at = selection(v, opts.sel);
        var selTag = v.extra.map(function (e) { return e.name + "=" + at[e.d]; }).join(",");
        assets[key] = { kind: "zarr", url: url, variable: key, index: i, crs: opts.crs || null,
                        sel: opts.sel || null, maxChunks: opts.maxChunks || null,
                        href: url + "#" + key + "@" + i + (selTag ? "[" + selTag + "]" : "") };
        meta[key] = v.units ? { unit: v.units } : {};
        // how GDAL's Zarr driver names this 2-D slice, and its packing,
        // for the source VRT export (lib/export.js)
        if (c.ds.icechunk) meta[key].noVrt = "Icechunk repositories are not exported as a source VRT (GDAL has no Icechunk driver)";
        else if (c.ds.refs) meta[key].noVrt = "Kerchunk references are not exported as a VRT yet (GDAL reads them from 3.11)";
        else if (v.curv) meta[key].noVrt = "curvilinear grids are not exported as a source VRT yet (use the GeoTIFF)";
        else if (v.dggs) meta[key].noVrt = "HEALPix grids have no source VRT (GDAL cannot place their cells; use the GeoTIFF)";
        else meta[key].gdal = {
          slice: v.dims.map(function (d, j) {
            return j === v.xi || j === v.yi ? null : j === v.ti ? Math.max(0, i) : at[j];
          }).filter(function (x) { return x !== null; }),
          dtype: v.arr.dtype, scale: v.scale, offset: v.offset, fill: v.fill
        };
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
