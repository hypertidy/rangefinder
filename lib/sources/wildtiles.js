// Layers 1+2 bound to the wildtiles cube (the original proof of concept).
//
// Space is arithmetic: tile id <-> (zone, res, col, row) <-> UTM south
// extent. Time is one small parquet inventory read in the browser. URLs are
// deterministic: cube/<tile>/<band>/<day>.tif. Same Catalog interface as
// stac.js, so the page and the pixel/render layers do not know which is
// behind them.

import { transformBbox, utmCode, utmZoneOf } from "../geo.js";

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

  function loadInventory() {
    if (inventory) return inventory;
    inventory = (async function () {
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
    })();
    inventory.catch(function () { inventory = null; });
    return inventory;
  }

  return {
    kind: "wildtiles",
    label: "wildtiles " + bucket,
    bands: BANDS,
    search: async function (q) {
      var tiles = tilesForBbox(q.bbox, res);
      var idx = await loadInventory();
      var range = (q.datetime || "../..").split("/");
      if (!range[0] || range[0] === "..") range[0] = "0000-01-01";
      if (!range[1] || range[1] === "..") range[1] = "9999-12-31";
      var scenes = [];
      tiles.forEach(function (t) {
        var id = makeTileId(t);
        var days = idx.get(id);
        if (!days) return;
        var crs = utmCode(t.zone, true);
        var bb = transformBbox(tileExtent(t), crs, "EPSG:4326");
        days.forEach(function (bandSet, day) {
          if (day < range[0] || day > range[1]) return;
          var assets = {};
          bandSet.forEach(function (b) { assets[b] = bucket + "/cube/" + id + "/" + b + "/" + day + ".tif"; });
          scenes.push({
            id: id + "/" + day, day: day, datetime: day + "T12:00:00Z",
            geometry: { type: "Polygon", coordinates: [[[bb[0], bb[1]], [bb[2], bb[1]],
                        [bb[2], bb[3]], [bb[0], bb[3]], [bb[0], bb[1]]]] },
            bbox: bb, cloud: null, crs: crs, assets: assets,
            meta: { tile: id, grid: id }
          });
        });
      });
      return scenes;
    }
  };
}
