// Layers 1+2 bound to a published starc store (hypertidy/starc): an
// append-only Parquet cache of STAC discovery results with four tables,
//
//   queries       one row per STAC request issued (query_id, region_id, ...)
//   acquisitions  one row per physical scene: acquisition_id, platform,
//                 datetime, solarday, centroid_lon/lat, tile (MGRS code)
//   products      one row per item per provider: product_id, acquisition_id,
//                 collection, item_id, epsg, cloud_cover, baseline, query_id
//   assets        long form: product_id, asset_key, href, media_type
//
// so days AND hrefs come straight from the store, with no catalogue round
// trip and no scene-id guessing. Duplicates across overlapping harvests are
// expected: rows are deduplicated here, at read, by each table's key.
//
// Static hosting cannot list a directory, so the binding finds the Parquet
// files in this order:
//   1. <store>/manifest.json: ["acquisitions/x.parquet", ...] or { files: [...] },
//      paths relative to the store (absolute URLs also work);
//   2. an S3 ListObjectsV2 of the store prefix (buckets that allow listing);
//   3. consolidated single files <store>/{acquisitions,products,assets}.parquet.
// The first path segment names the table; key=value segments (hive
// partitions such as products/collection=sentinel-2-c1-l2a/) fill columns the
// files leave out.
//
// Footprints come from footprint_wkb when the store has it (the item
// geometry: the data area, so partial-swath scenes drop out of a region they
// only nominally touch), else from the MGRS tile code (geo.js mgrsExtent,
// the full 110 km tile). Same Catalog interface as stac.js.

import { bboxIntersects, boxPolygon, geometryBbox, mgrsExtent, transformBbox } from "../geo.js";
import { BAND_ALIASES, resolveAssets } from "./stac.js";

var HYPARQUET = "https://cdn.jsdelivr.net/npm/hyparquet@1/+esm";
var TABLES = ["acquisitions", "products", "assets", "queries"];
var COLUMNS = {
  acquisitions: ["acquisition_id", "platform", "datetime", "solarday", "centroid_lon",
                 "centroid_lat", "tile", "footprint_wkb"],
  products: ["product_id", "acquisition_id", "collection", "item_id", "epsg", "cloud_cover",
             "baseline", "query_id"],
  assets: ["product_id", "asset_key", "href", "media_type"]
};

var hpPromise = null;
function hyparquet() {
  if (!hpPromise) {
    hpPromise = import(HYPARQUET);
    hpPromise.catch(function () { hpPromise = null; });
  }
  return hpPromise;
}

function trimSlash(u) { return String(u).trim().replace(/\/+$/, ""); }
function cached(cache, key, make) {
  if (!cache.has(key)) {
    var p = make();
    cache.set(key, p);
    p.catch(function () { cache.delete(key); });
  }
  return cache.get(key);
}

async function pool(items, n, fn) {
  var out = new Array(items.length), next = 0;
  async function worker() {
    while (next < items.length) { var i = next++; out[i] = await fn(items[i], i); }
  }
  var ws = [];
  for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

// --- finding the files ---------------------------------------------------------

// relative path -> { url, table, part: { key: value }, base } or null
function classify(root, path) {
  var url = /^https?:\/\//.test(path) ? path : root + "/" + path.replace(/^\/+/, "");
  var rel = url.indexOf(root + "/") === 0 ? url.slice(root.length + 1) : path;
  if (!/\.parquet$/i.test(rel)) return null;
  var segs = rel.split("/");
  var table = segs[0].replace(/\.parquet$/i, "");
  if (TABLES.indexOf(table) < 0) return null;
  var part = {};
  segs.slice(1, -1).forEach(function (s) {
    var m = /^([^=]+)=(.*)$/.exec(s);
    if (m) part[m[1]] = decodeURIComponent(m[2]);
  });
  return { url: url, table: table, part: part,
           base: segs[segs.length - 1].replace(/\.parquet$/i, "") };
}

async function fromManifest(root) {
  var r = await fetch(root + "/manifest.json", { cache: "no-cache" });
  if (!r.ok) return null;
  var j = await r.json();
  var files = Array.isArray(j) ? j : (j.files || []);
  return files.map(function (f) { return typeof f === "string" ? f : f.path; });
}

// S3 ListObjectsV2 of the store prefix. Path-style (host/bucket/prefix) unless
// the host is a virtual-hosted bucket (bucket.s3.region.amazonaws.com).
async function fromListing(root) {
  var u = new URL(root + "/");
  var segs = u.pathname.split("/").filter(Boolean);
  var virtual = /^[^.]+\.s3[.-]/.test(u.hostname);
  var bucketUrl = u.origin + (virtual ? "" : "/" + segs[0]);
  var prefix = (virtual ? segs : segs.slice(1)).join("/");
  if (!virtual && !segs.length) return null;
  if (prefix) prefix += "/";
  var keys = [], token = null, pages = 0;
  do {
    var q = "?list-type=2&prefix=" + encodeURIComponent(prefix) +
            (token ? "&continuation-token=" + encodeURIComponent(token) : "");
    var r = await fetch(bucketUrl + "/" + q);
    if (!r.ok) return null;
    var xml = await r.text();
    if (!/<ListBucketResult/.test(xml)) return null;
    xml.replace(/<Key>([^<]*)<\/Key>/g, function (m, k) {
      keys.push(k.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    });
    var t = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) && t ? t[1] : null;
  } while (token && ++pages < 200);
  return keys.map(function (k) { return k.slice(prefix.length); });
}

async function findFiles(root) {
  var how = "manifest.json", list = null;
  try { list = await fromManifest(root); } catch (e) { list = null; }
  if (!list) {
    how = "bucket listing";
    try { list = await fromListing(root); } catch (e) { list = null; }
  }
  if (!list || !list.length) {
    how = "consolidated tables";
    list = ["acquisitions.parquet", "products.parquet", "assets.parquet"];
  }
  var byTable = { acquisitions: [], products: [], assets: [], queries: [] };
  list.forEach(function (p) {
    var f = classify(root, p);
    if (f) byTable[f.table].push(f);
  });
  if (!byTable.acquisitions.length || !byTable.products.length) {
    throw new Error("starc store " + root + ": no acquisitions/products files found " +
                    "(tried manifest.json, a bucket listing and consolidated tables)");
  }
  return { how: how, files: byTable };
}

// --- reading tables --------------------------------------------------------------

var fileCache = new Map();    // url -> Promise<rows>
var storeCache = new Map();   // root -> Promise<{ how, files }>
var tableCache = new Map();   // root|table -> Promise<...>

function dayString(v) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return new Date(v * 864e5).toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function isoString(v) {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return new Date(Number(v / 1000n)).toISOString();
  return v === null || v === undefined ? null : String(v);
}
function num(v) {
  if (v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) ? n : null;
}

function readFile(f, want) {
  return cached(fileCache, f.url + "|" + want.join(","), async function () {
    var hp = await hyparquet();
    var file = await hp.asyncBufferFromUrl({ url: f.url });
    var md = await hp.parquetMetadataAsync(file);
    var have = md.schema.slice(1).map(function (s) { return s.name; });
    var cols = want.filter(function (c) { return have.indexOf(c) >= 0; });
    // utf8: false keeps footprint_wkb as bytes; text columns written without
    // a STRING annotation are decoded here instead
    var rows = await hp.parquetReadObjects({ file: file, metadata: md, columns: cols, utf8: false });
    var text = cols.filter(function (c) { return c !== "footprint_wkb"; });
    var dec = new TextDecoder();
    rows.forEach(function (r) {
      for (var i = 0; i < text.length; i++) {
        var v = r[text[i]];
        if (v instanceof Uint8Array) r[text[i]] = dec.decode(v);
      }
    });
    Object.keys(f.part).forEach(function (k) {
      if (want.indexOf(k) >= 0 && have.indexOf(k) < 0) rows.forEach(function (r) { r[k] = f.part[k]; });
    });
    return rows;
  });
}

async function readAll(files, want, onFile) {
  var done = 0;
  var parts = await pool(files, 6, async function (f) {
    var rows = await readFile(f, want);
    done++;
    if (onFile) onFile(done, files.length);
    return rows;
  });
  return [].concat.apply([], parts);
}

// Minimal WKB reader: Polygon / MultiPolygon (ISO or EWKB, 2D/Z/M) ->
// GeoJSON, or null for anything else.
function wkbGeometry(bytes) {
  if (!bytes || !bytes.length) return null;
  if (typeof bytes === "string") return null;
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), o = 0;
  function geom() {
    var le = dv.getUint8(o) === 1; o += 1;
    var t = dv.getUint32(o, le); o += 4;
    var dims = 2;
    if (t & 0x20000000) o += 4;                               // EWKB SRID
    if (t & 0x80000000) dims++;
    if (t & 0x40000000) dims++;
    t = t & 0xffff;
    if (t > 3000) { dims = 4; t -= 3000; } else if (t > 2000) { dims = 3; t -= 2000; }
    else if (t > 1000) { dims = 3; t -= 1000; }
    function ring() {
      var n = dv.getUint32(o, le), pts = []; o += 4;
      for (var i = 0; i < n; i++) {
        pts.push([dv.getFloat64(o, le), dv.getFloat64(o + 8, le)]);
        o += 8 * dims;
      }
      return pts;
    }
    function poly() {
      var n = dv.getUint32(o, le), rs = []; o += 4;
      for (var i = 0; i < n; i++) rs.push(ring());
      return rs;
    }
    if (t === 3) return { type: "Polygon", coordinates: poly() };
    if (t === 6) {
      var n = dv.getUint32(o, le), ps = []; o += 4;
      for (var i = 0; i < n; i++) { var g = geom(); if (g) ps.push(g.coordinates); }
      return { type: "MultiPolygon", coordinates: ps };
    }
    return null;
  }
  try { return geom(); } catch (e) { return null; }
}

// Approximate footprint when a row has no usable tile code: a 110 km box on
// the centroid.
function centroidBox(lon, lat) {
  var dlat = 0.5, dlon = 0.5 / Math.max(0.05, Math.cos(lat * Math.PI / 180));
  return [lon - dlon, lat - dlat, lon + dlon, lat + dlat];
}

var footCache = new Map();
function footprint(a) {
  if (a.geometry) {
    if (!a.fp) a.fp = { bbox: geometryBbox(a.geometry), geometry: a.geometry, crs: null };
    return a.fp;
  }
  return tileFootprint(a);
}
function tileFootprint(a) {
  if (a.tile && footCache.has(a.tile)) return footCache.get(a.tile);
  var fp = null;
  if (a.tile) {
    try {
      var m = mgrsExtent(a.tile);
      fp = { bbox: transformBbox(m.extent, m.crs, "EPSG:4326"), geometry: boxPolygon(m.extent, m.crs),
             crs: m.crs };
    } catch (e) { fp = null; }
    if (fp) { footCache.set(a.tile, fp); return fp; }
  }
  if (a.lon === null || a.lat === null) return null;
  var bb = centroidBox(a.lon, a.lat);
  return { bbox: bb, crs: null, geometry: { type: "Polygon", coordinates: [[[bb[0], bb[1]],
    [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]] } };
}

function loadAcquisitions(root, store, onFile) {
  return cached(tableCache, root + "|acquisitions", async function () {
    var rows = await readAll(store.files.acquisitions, COLUMNS.acquisitions, onFile);
    var m = new Map();
    rows.forEach(function (r) {
      if (m.has(r.acquisition_id)) return;
      var lon = num(r.centroid_lon);
      var dt = isoString(r.datetime);
      m.set(r.acquisition_id, {
        id: r.acquisition_id, platform: r.platform || null, datetime: dt,
        day: r.solarday !== null && r.solarday !== undefined ? dayString(r.solarday)
                                                             : (dt ? dt.slice(0, 10) : null),
        tile: r.tile || null, lon: lon, lat: num(r.centroid_lat),
        geometry: wkbGeometry(r.footprint_wkb)
      });
    });
    return Array.from(m.values());
  });
}

function loadProducts(root, store, onFile) {
  return cached(tableCache, root + "|products", async function () {
    var rows = await readAll(store.files.products, COLUMNS.products, onFile);
    var seen = new Set(), byAcq = new Map(), collections = new Map();
    rows.forEach(function (r) {
      if (seen.has(r.product_id)) return;
      seen.add(r.product_id);
      var p = { id: r.product_id, acq: r.acquisition_id, collection: r.collection || null,
                item: r.item_id || r.product_id, epsg: num(r.epsg), cloud: num(r.cloud_cover),
                baseline: r.baseline || null, query: r.query_id || null };
      if (!byAcq.has(p.acq)) byAcq.set(p.acq, []);
      byAcq.get(p.acq).push(p);
      collections.set(p.collection, (collections.get(p.collection) || 0) + 1);
    });
    return { byAcq: byAcq, collections: collections, n: seen.size };
  });
}

// Asset rows for a set of products. starc writes one asset file per query,
// named by query_id, so when products carry query_id only those files are
// read; otherwise (consolidated or renamed files) every asset file is.
async function loadAssets(store, products) {
  var files = store.files.assets;
  var byBase = new Map();
  files.forEach(function (f) {
    if (!byBase.has(f.base)) byBase.set(f.base, []);
    byBase.get(f.base).push(f);
  });
  var need = new Set(), use = new Set(), all = false;
  products.forEach(function (p) {
    need.add(p.id);
    var fs = p.query && byBase.get(p.query);
    if (fs) fs.forEach(function (f) { use.add(f); }); else all = true;
  });
  var list = all ? files : Array.from(use);
  var rows = await readAll(list, COLUMNS.assets);
  var out = new Map();
  rows.forEach(function (r) {
    if (!need.has(r.product_id)) return;
    if (!out.has(r.product_id)) out.set(r.product_id, {});
    var d = out.get(r.product_id);
    if (!d[r.asset_key]) d[r.asset_key] = { href: r.href, type: r.media_type || undefined };
  });
  return { assets: out, files: list.length };
}

function baselineOf(p) {
  var n = parseFloat(p.baseline);
  return isFinite(n) ? n : -1;
}

// --- the catalog -----------------------------------------------------------------

// opts.url         the store root (the directory holding acquisitions/, products/, ...)
// opts.collection  optional: only products of this collection (default: any,
//                  preferring the collections in opts.prefer, then the
//                  highest processing baseline)
export function starcCatalog(opts) {
  var root = trimSlash(opts.url);
  var collection = (opts.collection || "").trim();
  var prefer = opts.prefer || ["sentinel-2-c1-l2a", "sentinel-2-l2a"];
  function store() { return cached(storeCache, root, function () { return findFiles(root); }); }

  function pickProduct(list) {
    if (collection) list = list.filter(function (p) { return p.collection === collection; });
    if (!list.length) return null;
    return list.slice().sort(function (a, b) {
      var ra = prefer.indexOf(a.collection), rb = prefer.indexOf(b.collection);
      ra = ra < 0 ? 99 : ra; rb = rb < 0 ? 99 : rb;
      return ra - rb || baselineOf(b) - baselineOf(a);
    })[0];
  }

  return {
    kind: "starc",
    label: "starc " + root + (collection ? " : " + collection : ""),
    bands: Object.keys(BAND_ALIASES),

    // Store summary for the page: { how, files, acquisitions, products,
    // collections: [[id, n]], dayMin, dayMax, tiles: [{ tile, n, geometry, bbox }] }
    info: async function (onProgress) {
      var st = await store();
      var acqs = await loadAcquisitions(root, st, onProgress && function (n, of) { onProgress("acquisitions", n, of); });
      var prods = await loadProducts(root, st, onProgress && function (n, of) { onProgress("products", n, of); });
      var days = acqs.map(function (a) { return a.day; }).filter(Boolean).sort();
      var tiles = new Map();
      acqs.forEach(function (a) {
        var k = a.tile || (a.lon !== null ? a.lon.toFixed(1) + "," + (a.lat || 0).toFixed(1) : null);
        if (!k) return;
        var t = tiles.get(k);
        if (!t) { var fp = tileFootprint(a); if (!fp) return; t = { tile: k, n: 0, geometry: fp.geometry, bbox: fp.bbox }; tiles.set(k, t); }
        t.n++;
      });
      return {
        how: st.how,
        files: TABLES.reduce(function (o, t) { o[t] = st.files[t].length; return o; }, {}),
        acquisitions: acqs.length, products: prods.n,
        collections: Array.from(prods.collections.entries()),
        dayMin: days[0] || null, dayMax: days[days.length - 1] || null,
        tiles: Array.from(tiles.values())
      };
    },

    search: async function (q) {
      var st = await store();
      var acqs = await loadAcquisitions(root, st);
      var prods = await loadProducts(root, st);
      var range = (q.datetime || "../..").split("/");
      var d0 = range[0] && range[0] !== ".." ? range[0].slice(0, 10) : "0000-01-01";
      var d1 = range[1] && range[1] !== ".." ? range[1].slice(0, 10) : "9999-12-31";
      var cloudMax = q.cloudMax !== undefined && q.cloudMax < 100 ? q.cloudMax : null;
      var hits = [];
      acqs.forEach(function (a) {
        if (!a.day || a.day < d0 || a.day > d1) return;
        var fp = footprint(a);
        if (q.bbox && fp && !bboxIntersects(fp.bbox, q.bbox)) return;
        var p = pickProduct(prods.byAcq.get(a.id) || []);
        if (!p) return;
        if (cloudMax !== null && p.cloud !== null && p.cloud > cloudMax) return;
        hits.push({ a: a, p: p, fp: fp });
      });
      // newest first, like a STAC search, so maxItems keeps the recent end
      hits.sort(function (x, y) { return x.a.day < y.a.day ? 1 : x.a.day > y.a.day ? -1 : 0; });
      hits = hits.slice(0, q.maxItems || 500);
      var got = await loadAssets(st, hits.map(function (h) { return h.p; }));
      return hits.map(function (h) {
        var a = h.a, p = h.p, fp = h.fp;
        return {
          id: p.item, day: a.day, datetime: a.datetime || a.day + "T12:00:00Z",
          geometry: fp ? fp.geometry : null, bbox: fp ? fp.bbox : null,
          cloud: p.cloud,
          crs: p.epsg ? "EPSG:" + p.epsg : (tileFootprint(a) || {}).crs || null,
          assets: resolveAssets(got.assets.get(p.id)),
          meta: { collection: p.collection, platform: a.platform, grid: a.tile,
                  processingBaseline: p.baseline, acquisitionId: a.id, productId: p.id }
        };
      });
    }
  };
}
