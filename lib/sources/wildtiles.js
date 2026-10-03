// Layers 1+2 bound to the wildtiles cube (the original proof of concept).
//
// The bucket cannot be listed; it describes itself through three well-known
// keys instead:
//   index/inventory.parquet   what exists: tile_id x band x solarday
//   registry/tiles.parquet    where tiles are: tile_id, region_id, zone_epsg,
//                             res, xmin, xmax, ymin, ymax
//   registry/BANDS.txt        the band axis, one key per line
// Space comes from the registry (any zone, any region); if it is missing,
// from arithmetic on the aatgrid id: (zone, res, col, row) <-> UTM south
// extent on the 720-pixel lattice. URLs are deterministic:
// cube/<tile>/<band>/<day>.tif, and a 403 means that (tile, band, day) does
// not exist. Same Catalog interface as stac.js, so the page and the
// pixel/render layers do not know which is behind them.

import { bboxIntersects, boxPolygon, transformBbox, utmCode, utmZoneOf } from "../geo.js";

export var WILDTILES_BUCKET = "https://projects.pawsey.org.au/wildtiles";
var OX = 140000, OY = 20000, NPIX = 720;
var BANDS = ["visual", "red", "green", "blue", "nir", "nir08", "nir09", "coastal",
             "rededge1", "rededge2", "rededge3", "swir16", "swir22", "aot", "wvp"];
var HYPARQUET = "https://cdn.jsdelivr.net/npm/hyparquet@1/+esm";

export function parseTileId(id) {
  var m = /^(\d{2})S_R(\d{4})_(\d{4})_(\d{4})$/.exec(String(id).trim());
  if (!m) throw new Error("bad tile id: " + id);
  return { zone: +m[1], res: +m[2], col: +m[3], row: +m[4] };
}
export function makeTileId(t) {
  var p = function (n) { return String(n).padStart(4, "0"); };
  return String(t.zone).padStart(2, "0") + "S_R" + p(t.res) + "_" + p(t.col) + "_" + p(t.row);
}
export function tileExtent(t) {
  var ts = NPIX * t.res;
  return [OX + t.col * ts, OY + t.row * ts, OX + (t.col + 1) * ts, OY + (t.row + 1) * ts];
}
// lon/lat bbox of a tile (or of a block of tiles around it)
export function tileLonLatBbox(t, pad) {
  pad = pad || 0;
  var e = tileExtent(t), ts = NPIX * t.res;
  return transformBbox([e[0] - pad * ts, e[1] - pad * ts, e[2] + pad * ts, e[3] + pad * ts],
                       utmCode(t.zone, true), "EPSG:4326");
}

// Tiles of one zone and resolution that cover a lon/lat bbox.
export function tilesForBbox(bbox, res, maxTiles) {
  var lon = (bbox[0] + bbox[2]) / 2;
  var zone = utmZoneOf(lon);
  var e = transformBbox(bbox, "EPSG:4326", utmCode(zone, true));
  var ts = NPIX * res;
  var ca = Math.floor((e[0] - OX) / ts), cb = Math.floor((e[2] - OX) / ts);
  var ra = Math.floor((e[1] - OY) / ts), rb = Math.floor((e[3] - OY) / ts);
  var n = (cb - ca + 1) * (rb - ra + 1);
  if (n > (maxTiles || 400)) throw new Error("region covers " + n + " wildtiles; draw a smaller one");
  var out = [];
  for (var c = ca; c <= cb; c++) for (var r = ra; r <= rb; r++) {
    if (c >= 0 && r >= 0) out.push({ zone: zone, res: res, col: c, row: r });
  }
  return out;
}

export function wildtilesCatalog(opts) {
  opts = opts || {};
  var bucket = (opts.bucket || WILDTILES_BUCKET).replace(/\/+$/, "");
  var res = opts.res || 10;
  var inventory = null;   // Promise<Map tile_id -> Map day -> Set band>
  var registry = null;    // Promise<Map tile_id -> Tile> or null when absent
  var bandList = null;    // Promise<string[]>

  function once(make) {
    var p = null;
    return function () {
      if (!p) { p = make(); p.catch(function () { p = null; }); }
      return p;
    };
  }

  var loadInventory = once(async function () {
    var hp = await import(HYPARQUET);
    var file = await hp.asyncBufferFromUrl({ url: bucket + "/index/inventory.parquet" });
    var rows = await hp.parquetReadObjects({ file: file, columns: ["tile_id", "band", "solarday"] });
    var idx = new Map();
    rows.forEach(function (row) {
      var d = row.solarday instanceof Date ? row.solarday.toISOString().slice(0, 10)
                                           : String(row.solarday).slice(0, 10);
      var t = idx.get(row.tile_id);
      if (!t) { t = new Map(); idx.set(row.tile_id, t); }
      var s = t.get(d);
      if (!s) { s = new Set(); t.set(d, s); }
      s.add(row.band);
    });
    return idx;
  });

  // Tile = { id, region, crs, res, extent: [xmin, ymin, xmax, ymax], bbox (lon/lat) }
  var loadRegistry = once(async function () {
    var hp = await import(HYPARQUET);
    var file;
    try { file = await hp.asyncBufferFromUrl({ url: bucket + "/registry/tiles.parquet" }); }
    catch (e) { return null; }   // older bucket: fall back to id arithmetic
    var rows = await hp.parquetReadObjects({ file: file });
    var m = new Map();
    rows.forEach(function (r) {
      var epsg = String(r.zone_epsg || r.epsg || "").replace(/^EPSG:/i, "");
      var t;
      try { t = parseTileId(r.tile_id); } catch (e) { t = null; }
      var ext = [r.xmin, r.ymin, r.xmax, r.ymax].map(Number);
      if (!ext.every(isFinite) && t) ext = tileExtent(t);
      var crs = epsg ? "EPSG:" + epsg : (t ? utmCode(t.zone, true) : null);
      if (!crs || !ext.every(isFinite)) return;
      m.set(r.tile_id, { id: r.tile_id, region: r.region_id || null, crs: crs,
                         res: Number(r.res) || (t && t.res) || null, extent: ext, bbox: null });
    });
    return m;
  });

  var loadBands = once(async function () {
    var r = await fetch(bucket + "/registry/BANDS.txt");
    if (!r.ok) return BANDS;
    var b = (await r.text()).split(/\r?\n/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x && x[0] !== "#"; });
    return b.length ? b : BANDS;
  });

  function lonlat(t) {
    if (!t.bbox) t.bbox = transformBbox(t.extent, t.crs, "EPSG:4326", 4);
    return t.bbox;
  }

  // registry tiles of this resolution over a lon/lat bbox (null: no registry)
  async function registryTiles(bbox, maxTiles) {
    var reg = await loadRegistry().catch(function () { return null; });
    if (!reg) return null;
    var out = [];
    reg.forEach(function (t) {
      if (t.res === res && bboxIntersects(lonlat(t), bbox)) out.push(t);
    });
    if (out.length > (maxTiles || 400)) {
      throw new Error("region covers " + out.length + " wildtiles; draw a smaller one");
    }
    return out;
  }

  var catalog = {
    kind: "wildtiles",
    label: "wildtiles " + bucket,
    bands: BANDS,

    // Bucket summary for the page: { bands, tiles, days, dayMin, dayMax,
    // regions: [{ id, n, bbox }] (empty without a registry), registry: bool }
    info: async function () {
      var parts = await Promise.all([loadInventory(),
        loadRegistry().catch(function () { return null; }), loadBands()]);
      var idx = parts[0], reg = parts[1], bands = parts[2];
      catalog.bands = bands;
      var days = new Set();
      idx.forEach(function (dm) { dm.forEach(function (b, d) { days.add(d); }); });
      var sorted = Array.from(days).sort();
      var regions = new Map();
      if (reg) reg.forEach(function (t) {
        if (t.res !== res || !idx.has(t.id)) return;
        var k = t.region || "(no region)", bb = lonlat(t), g = regions.get(k);
        if (!g) regions.set(k, { id: k, n: 1, bbox: bb.slice() });
        else {
          g.n++;
          g.bbox = [Math.min(g.bbox[0], bb[0]), Math.min(g.bbox[1], bb[1]),
                    Math.max(g.bbox[2], bb[2]), Math.max(g.bbox[3], bb[3])];
        }
      });
      return { bands: bands, registry: !!reg, tiles: idx.size, days: sorted.length,
               dayMin: sorted[0] || null, dayMax: sorted[sorted.length - 1] || null,
               regions: Array.from(regions.values()).sort(function (a, b) {
                 return a.id < b.id ? -1 : 1; }) };
    },

    search: async function (q) {
      var tiles = await registryTiles(q.bbox);
      if (!tiles) {
        tiles = tilesForBbox(q.bbox, res).map(function (t) {
          return { id: makeTileId(t), region: null, crs: utmCode(t.zone, true), res: res,
                   extent: tileExtent(t), bbox: null };
        });
      }
      var idx = await loadInventory();
      var range = (q.datetime || "../..").split("/");
      if (!range[0] || range[0] === "..") range[0] = "0000-01-01";
      if (!range[1] || range[1] === "..") range[1] = "9999-12-31";
      var scenes = [];
      tiles.forEach(function (t) {
        var days = idx.get(t.id);
        if (!days) return;
        var bb = lonlat(t), geom = boxPolygon(t.extent, t.crs, 2);
        days.forEach(function (bandSet, day) {
          if (day < range[0] || day > range[1]) return;
          var assets = {};
          bandSet.forEach(function (b) { assets[b] = bucket + "/cube/" + t.id + "/" + b + "/" + day + ".tif"; });
          scenes.push({
            id: t.id + "/" + day, day: day, datetime: day + "T12:00:00Z",
            geometry: geom, bbox: bb, cloud: null, crs: t.crs, assets: assets,
            meta: { tile: t.id, grid: t.id, region: t.region }
          });
        });
      });
      return scenes;
    }
  };
  return catalog;
}
