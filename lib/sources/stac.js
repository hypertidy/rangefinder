// Layers 1+2 bound to a live STAC API: footprints and days are discovered
// by item search over a bbox and date range, not named in advance.
//
// Catalog interface (shared by every source):
//   catalog.label                 display name
//   catalog.bands                 logical band keys this source can offer
//   catalog.search(query) -> Promise<Scene[]>
//     query = { bbox: [w, s, e, n] lon/lat, datetime: "YYYY-MM-DD/YYYY-MM-DD",
//               cloudMax (percent, optional), maxItems, signal }
//
// Scene = { id, day, datetime, geometry (GeoJSON lon/lat), bbox, cloud,
//           crs ("EPSG:xxxx" or null), assets: { logicalKey: href },
//           meta: { source item properties worth keeping } }

import { geometryBbox, solarDay } from "../geo.js";

// Logical band keys and the asset names / common names they go by in
// different catalogues (Earth Search uses the common names directly).
export var BAND_ALIASES = {
  visual:   ["visual", "TCI", "tci", "visual_10m"],
  coastal:  ["coastal", "B01"],
  blue:     ["blue", "B02"],
  green:    ["green", "B03"],
  red:      ["red", "B04"],
  rededge1: ["rededge1", "B05"],
  rededge2: ["rededge2", "B06"],
  rededge3: ["rededge3", "B07"],
  nir:      ["nir", "B08"],
  nir08:    ["nir08", "B8A"],
  nir09:    ["nir09", "B09"],
  swir16:   ["swir16", "B11"],
  swir22:   ["swir22", "B12"],
  scl:      ["scl", "SCL"],
  aot:      ["aot", "AOT"],
  wvp:      ["wvp", "WVP"]
};

function commonName(asset) {
  var b = asset["eo:bands"] || asset.bands;
  if (b && b.length === 1) return b[0].common_name || b[0]["eo:common_name"] || b[0].name;
  return null;
}

// { assetName: { href, type } } -> { logicalKey: href }, public COGs only.
// Shared with the starc binding, whose assets table holds the same names.
export function resolveAssets(assets) {
  var out = {};
  assets = assets || {};
  var lower = {};
  Object.keys(assets).forEach(function (k) { lower[k.toLowerCase()] = k; });
  Object.keys(BAND_ALIASES).forEach(function (key) {
    var names = BAND_ALIASES[key];
    for (var i = 0; i < names.length; i++) {
      var hit = assets[names[i]] ? names[i] : lower[names[i].toLowerCase()];
      if (hit && /tiff|tif/i.test(assets[hit].type || "image/tiff")) {
        out[key] = assets[hit].href; return;
      }
    }
    // fall back to eo:bands common_name (skipping preview/jp2 duplicates)
    Object.keys(assets).forEach(function (k) {
      var a = assets[k];
      if (!out[key] && commonName(a) === key && /tiff/i.test(a.type || "")) out[key] = a.href;
    });
  });
  return out;
}

function itemToScene(item) {
  var p = item.properties || {};
  var bbox = item.bbox || (item.geometry ? geometryBbox(item.geometry) : null);
  var lon = bbox ? (bbox[0] + bbox[2]) / 2 : 0;
  var epsg = p["proj:epsg"] ? "EPSG:" + p["proj:epsg"] : (p["proj:code"] || null);
  return {
    id: item.id,
    datetime: p.datetime,
    day: solarDay(p.datetime, lon),
    geometry: item.geometry,
    bbox: bbox,
    cloud: p["eo:cloud_cover"] !== undefined ? p["eo:cloud_cover"] : null,
    crs: epsg,
    assets: resolveAssets(item.assets),
    meta: {
      collection: item.collection,
      platform: p.platform,
      grid: p["grid:code"] || p["s2:mgrs_tile"] || null,
      processingBaseline: p["s2:processing_baseline"] || null,
      boaOffsetApplied: p["earthsearch:boa_offset_applied"],
      nodataPct: p["s2:nodata_pixel_percentage"]
    }
  };
}

function trimSlash(u) { return u.replace(/\/+$/, ""); }

export function stacCatalog(opts) {
  var root = trimSlash(opts.url);
  var collection = opts.collection;
  return {
    kind: "stac",
    label: root + " : " + collection,
    bands: Object.keys(BAND_ALIASES),
    search: async function (q) {
      var maxItems = q.maxItems || 500;
      var body = { collections: [collection], bbox: q.bbox, limit: Math.min(100, maxItems) };
      if (q.datetime) body.datetime = q.datetime.split("/").map(function (d, i) {
        return d.length === 10 ? d + (i === 0 ? "T00:00:00Z" : "T23:59:59Z") : d;
      }).join("/");
      if (q.cloudMax !== undefined && q.cloudMax < 100) {
        body.query = { "eo:cloud_cover": { lte: q.cloudMax } };
      }
      var req = { url: root + "/search", method: "POST", body: body };
      var items = [];
      while (req && items.length < maxItems) {
        var r = await fetch(req.url, req.method === "GET"
          ? { signal: q.signal, headers: { Accept: "application/geo+json" } }
          : { method: "POST", signal: q.signal,
              headers: { "Content-Type": "application/json", Accept: "application/geo+json" },
              body: JSON.stringify(req.body) });
        if (!r.ok && req.body && req.body.query && r.status === 400) {
          // API without the query extension: drop it, filter client side
          delete req.body.query; delete body.query;
          continue;
        }
        if (!r.ok) throw new Error("STAC search " + r.status + " " + (await r.text()).slice(0, 200));
        var fc = await r.json();
        items = items.concat(fc.features || []);
        var next = (fc.links || []).filter(function (l) { return l.rel === "next"; })[0];
        req = next ? { url: next.href, method: (next.method || "GET").toUpperCase(),
                       body: next.body ? (next.merge ? Object.assign({}, req.body, next.body)
                                                     : next.body) : null } : null;
        if (req && req.method === "POST" && !req.body) req.body = body;
      }
      var scenes = items.slice(0, maxItems).map(itemToScene);
      if (q.cloudMax !== undefined && q.cloudMax < 100) {
        scenes = scenes.filter(function (s) { return s.cloud === null || s.cloud <= q.cloudMax; });
      }
      return scenes;
    }
  };
}

// Collections a STAC API offers, for a picker.
export async function listCollections(url, signal) {
  var r = await fetch(trimSlash(url) + "/collections", { signal: signal });
  if (!r.ok) throw new Error("collections " + r.status);
  var j = await r.json();
  return (j.collections || []).map(function (c) { return { id: c.id, title: c.title || c.id }; });
}
