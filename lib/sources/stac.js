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
//           thumb (preview image href or null, optional),
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

// s3://bucket/key -> the bucket's public https endpoint (only useful when the
// bucket is public and CORS-enabled; requester-pays buckets still refuse).
export function httpsHref(h) {
  var m = /^s3:\/\/([^/]+)\/(.*)$/.exec(h || "");
  return m ? "https://" + m[1] + ".s3.amazonaws.com/" + m[2] : h;
}

function isCog(a) {
  var t = a.type || "", roles = a.roles || [];
  if (roles.indexOf("thumbnail") >= 0 || roles.indexOf("overview") >= 0) return false;
  return /tiff/i.test(t) || (!t && /\.tiff?(\?|$)/i.test(a.href || ""));
}

// What the render layer needs to know about an asset, from the raster,
// classification and file extensions: nodata, scale/offset, data type,
// class codes and colours.
function assetMetaOf(a) {
  var rb = (a["raster:bands"] || a.bands || [])[0] || {};
  var m = {};
  if (rb.nodata !== undefined && rb.nodata !== null) m.nodata = rb.nodata === "nan" ? NaN : +rb.nodata;
  if (rb.scale !== undefined) m.scale = rb.scale;
  if (rb.offset !== undefined) m.offset = rb.offset;
  if (rb.data_type) m.dataType = rb.data_type;
  if (rb.unit) m.unit = rb.unit;
  var cls = a["classification:classes"] || rb["classification:classes"];
  if (cls && cls.length) {
    m.classes = cls.map(function (c) {
      return { value: c.value, label: c.description || c.name || String(c.value),
               color: c.color_hint ? "#" + String(c.color_hint).replace("#", "") : null };
    });
  }
  if ((a.roles || []).indexOf("visual") >= 0 && (a["eo:bands"] || []).length >= 3) m.rgb = true;
  return m;
}

// Every other COG an item carries, under its own (lower-cased) name, so
// collections beyond Sentinel-2 (DEMs, land cover, SAR) offer their assets.
// -> { assets: { key: href }, meta: { key: {...} } }
export function extraAssets(assets, already) {
  var out = { assets: {}, meta: {} };
  var used = new Set(Object.keys(already || {}).map(function (k) { return already[k]; }));
  Object.keys(assets || {}).forEach(function (name) {
    var a = assets[name];
    if (!a || !isCog(a)) return;
    var href = httpsHref(a.href);
    var key = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    var meta = assetMetaOf(a);
    if (used.has(a.href) || used.has(href)) {
      Object.keys(already).forEach(function (k) {
        if ((already[k] === a.href || already[k] === href) && Object.keys(meta).length) out.meta[k] = meta;
      });
      return;
    }
    if (already && already[key]) return;
    out.assets[key] = href;
    if (Object.keys(meta).length) out.meta[key] = meta;
  });
  return out;
}

// A small browser-ready preview (JPEG/PNG), for hover previews and the
// haze proxy (scan.js); null when the item has none.
function thumbnailOf(assets) {
  var names = Object.keys(assets || {});
  for (var i = 0; i < names.length; i++) {
    var a = assets[names[i]];
    if (((a.roles || []).indexOf("thumbnail") >= 0 || names[i] === "thumbnail") &&
        /jpe?g|png/i.test(a.type || a.href || "")) return httpsHref(a.href);
  }
  return null;
}

function itemToScene(item) {
  var p = item.properties || {};
  var bbox = item.bbox || (item.geometry ? geometryBbox(item.geometry) : null);
  var lon = bbox ? (bbox[0] + bbox[2]) / 2 : 0;
  var epsg = p["proj:epsg"] ? "EPSG:" + p["proj:epsg"] : (p["proj:code"] || null);
  var assets = resolveAssets(item.assets);
  var extra = extraAssets(item.assets, assets);
  Object.keys(extra.assets).forEach(function (k) { assets[k] = extra.assets[k]; });
  return {
    id: item.id,
    datetime: p.datetime,
    day: solarDay(p.datetime, lon),
    geometry: item.geometry,
    bbox: bbox,
    cloud: p["eo:cloud_cover"] !== undefined ? p["eo:cloud_cover"] : null,
    crs: epsg,
    assets: assets,
    assetMeta: extra.meta,
    thumb: thumbnailOf(item.assets),
    meta: {
      res: p.gsd || null,
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

// Planetary Computer hands out anonymous read tokens (SAS) per collection;
// its asset hrefs on blob.core.windows.net need one appended. Tokens last
// about an hour, so they are cached for half that.
var PC_TOKEN = "https://planetarycomputer.microsoft.com/api/sas/v1/token/";
var pcTokens = new Map();
async function pcToken(collection, signal) {
  var hit = pcTokens.get(collection);
  if (hit && hit.until > Date.now()) return hit.token;
  var r = await fetch(PC_TOKEN + encodeURIComponent(collection), { signal: signal });
  if (!r.ok) throw new Error("Planetary Computer token " + r.status);
  var j = await r.json();
  pcTokens.set(collection, { token: j.token, until: Date.now() + 30 * 60e3 });
  return j.token;
}
export function isPlanetaryComputer(url) { return /planetarycomputer\.microsoft\.com/i.test(url || ""); }

async function signScenes(scenes, collection, signal) {
  var token = await pcToken(collection, signal);
  scenes.forEach(function (s) {
    Object.keys(s.assets).forEach(function (k) {
      var h = s.assets[k];
      if (typeof h === "string" && /\.blob\.core\.windows\.net\//.test(h) && h.indexOf("?") < 0) {
        s.assets[k] = h + "?" + token;
      }
    });
  });
  return scenes;
}

export function stacCatalog(opts) {
  var root = trimSlash(opts.url);
  var collection = opts.collection;
  return {
    kind: "stac",
    label: root + " : " + collection,
    bands: Object.keys(BAND_ALIASES),
    capabilities: { cloud: true, time: true },
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
      var items = [], retried = false;
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
        if (!req && !items.length && body.query && !retried) {
          // nothing at all with a cloud filter: the collection may have no
          // eo:cloud_cover (DEMs, land cover), so ask again without it
          retried = true; delete body.query;
          req = { url: root + "/search", method: "POST", body: body };
        }
      }
      var scenes = items.slice(0, maxItems).map(itemToScene);
      if (isPlanetaryComputer(root)) await signScenes(scenes, collection, q.signal);
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
