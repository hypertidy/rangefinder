// rangefinder library: the four layers behind small interfaces.
//
//   1. SPACE   geo.js       CRS helpers, footprints, the shared OutputGrid
//   2. TIME    sources/*    Catalog.search() -> Scene[]; groupByDay() below
//   3. PIXELS  cog.js       readWarped(href, grid): windowed overview reads
//              tiles.js     readTilesWarped(src, grid): XYZ / WMTS tiles
//              sources/zarr.js  readZarrWarped(asset, grid): Zarr chunks
//   4. RENDER  render.js    mosaic, percentile stretch, gamma -> RGBA
//
// A source (STAC API, wildtiles cube, starc store) only implements
// the Catalog interface documented in sources/stac.js. Pixels and render
// never know which source produced a scene.
//
// Dependencies are loaded by the page as globals: proj4, GeoTIFF (geotiff.js).

export * from "./geo.js";
export * from "./render.js";
export { readWarped, openCog, cogInfo } from "./cog.js";
export * from "./tiles.js";
export * from "./inspect.js";
export * from "./mapcrs.js";
export { chunkStats, setChunkBudget, clearChunks } from "./chunks.js";
export { geotiffBytes, sourceVrt, pamXml, download } from "./export.js";
export { tileCatalog, isCapabilitiesUrl, guessDecode } from "./sources/tiles.js";
export { cogCatalog } from "./sources/cog.js";
export { vrtCatalog, parseVrt } from "./sources/vrt.js";
export { zarrCatalog, readZarrWarped } from "./sources/zarr.js";
export { stacCatalog, listCollections, resolveAssets, BAND_ALIASES } from "./sources/stac.js";
export { starcCatalog } from "./sources/starc.js";
export { wildtilesCatalog, parseTileId, makeTileId, tileLonLatBbox, tilesForBbox,
         WILDTILES_BUCKET } from "./sources/wildtiles.js";

import { bboxIntersects, gridLonLatBounds } from "./geo.js";
import { readWarped } from "./cog.js";
import { readTilesWarped } from "./tiles.js";
import { readZarrWarped } from "./sources/zarr.js";
import { mosaic } from "./render.js";

function byCloud(a, b) {
  var ca = a.cloud === null ? 1e9 : a.cloud, cb = b.cloud === null ? 1e9 : b.cloud;
  return ca - cb;
}

// Scenes grouped by solar day, oldest first; each day's scenes least
// cloudy first. [{ day, scenes, cloudMin, cloudMean }]
export function groupByDay(scenes) {
  var m = new Map();
  scenes.forEach(function (s) {
    if (!m.has(s.day)) m.set(s.day, []);
    m.get(s.day).push(s);
  });
  return Array.from(m.keys()).sort().map(function (day) {
    var ss = m.get(day).slice().sort(byCloud);
    var clouds = ss.map(function (s) { return s.cloud; }).filter(function (c) { return c !== null; });
    return { day: day, scenes: ss,
             cloudMin: clouds.length ? Math.min.apply(null, clouds) : null,
             cloudMean: clouds.length ? clouds.reduce(function (a, b) { return a + b; }, 0) / clouds.length : null };
  });
}

async function pool(tasks, n) {
  var out = new Array(tasks.length), next = 0;
  async function worker() {
    while (next < tasks.length) {
      var i = next++;
      try { out[i] = { ok: true, value: await tasks[i]() }; }
      catch (e) { out[i] = { ok: false, error: e }; }
    }
  }
  var ws = [];
  for (var k = 0; k < Math.min(n, tasks.length); k++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

// The href (or tile template) behind an asset value; Scene.assets values are
// an href string (a COG) or an object { kind: "tiles", ... } (tiles.js) or
// { kind: "zarr", ... } (sources/zarr.js).
export function assetHref(a) {
  return typeof a === "string" ? a : (a && (a.href || a.template)) || "";
}
function assetMeta(scene, key) {
  return (scene.assetMeta && scene.assetMeta[key]) || {};
}

// Read one asset onto the grid, whatever kind of source it is.
export function readAsset(a, grid, opts) {
  if (a && typeof a === "object" && a.kind === "tiles") return readTilesWarped(a, grid, opts);
  if (a && typeof a === "object" && a.kind === "zarr") return readZarrWarped(a, grid, opts);
  return readWarped(assetHref(a), grid, opts);
}

// Fetch and mosaic one composite on the grid.
//   keys       ["visual"] for a baked 3-band product, [key] for one band,
//              or [rKey, gKey, bKey]
//   mode       "rgb" | "single" | "classes" for one key (default: rgb when
//              the file has 3+ bands and the key names no band, else single)
//   scenes     candidate scenes (typically one day's), any order
//   maxScenes  fan-out cap: at most this many scenes are read (default 6)
// A key's band within a multi-band file comes from scene.assetMeta[key].band
// (0-based), its nodata from .nodata when the file declares none.
// Resolves to { composite, stats } (composite null when nothing overlapped).
export async function loadComposite(o) {
  var t0 = performance.now();
  var keys = o.keys, grid = o.grid;
  var maxScenes = o.maxScenes || 6;
  var view = gridLonLatBounds(grid);
  var cands = o.scenes.filter(function (s) {
    return (!s.bbox || bboxIntersects(s.bbox, view)) &&
           keys.every(function (k) { return s.assets[k]; });
  }).sort(byCloud);
  var missing = o.scenes.length - cands.length;
  var use = cands.slice(0, maxScenes);
  var done = 0, log = [];
  var tasks = use.map(function (s) {
    return async function () {
      var reads = new Map();   // one read per file, even when keys share it
      var parts = await Promise.all(keys.map(function (k) {
        var a = s.assets[k], m = assetMeta(s, k), id = assetHref(a);
        if (!reads.has(id)) {
          reads.set(id, readAsset(a, grid, { crs: s.crs, signal: o.signal, nodata: m.nodata }));
        }
        return reads.get(id).then(function (p) {
          if (p && p.log) log.push.apply(log, p.log);
          return p;
        });
      }));
      done++;
      if (o.onProgress) o.onProgress(done, use.length, s);
      if (parts.some(function (p) { return p === null; })) return null;
      if (keys.length === 1) {
        var p0 = parts[0], m0 = assetMeta(s, keys[0]);
        var rgb = o.mode === "rgb" || (!o.mode && p0.bands.length >= 3 && m0.band === undefined);
        if (rgb) return { bands: p0.bands.slice(0, 3), valid: p0.valid, level: p0.level, rgb: true };
        return { bands: [p0.bands[m0.band || 0]], valid: p0.valid, level: p0.level };
      }
      var valid = parts[0].valid.slice();
      for (var i = 1; i < parts.length; i++) {
        var v = parts[i].valid;
        for (var j = 0; j < valid.length; j++) valid[j] = valid[j] & v[j];
      }
      return { bands: parts.map(function (p, i) { return p.bands[assetMeta(s, keys[i]).band || 0]; }),
               valid: valid, level: parts[0].level };
    };
  });
  var results = await pool(tasks, o.concurrency || 4);
  var layers = [], errors = [], levels = [], usedScenes = [];
  results.forEach(function (r, i) {
    if (!r.ok) { errors.push({ id: use[i].id, message: String(r.error && r.error.message || r.error) }); return; }
    if (r.value) { layers.push(r.value); levels.push(r.value.level); usedScenes.push(use[i]); }
  });
  var kind = keys.length === 3 ? "bands" : "single";
  if (keys.length === 1 && layers.length && layers[0].rgb) kind = "rgb8";
  if (keys.length === 1 && o.mode === "classes") kind = "classes";
  if (kind === "rgb8" && layers.length && layers[0].bands.length < 3) {
    throw new Error(keys[0] + " is not a 3-band product");
  }
  var comp = null;
  if (layers.length) {
    comp = mosaic(grid, layers, kind, keys);
    comp.scenes = usedScenes;   // in priority order: the first valid one wins each pixel
    if (kind === "classes") {
      var withClasses = use.filter(function (s) { return assetMeta(s, keys[0]).classes; })[0];
      comp.classes = o.classes || (withClasses && assetMeta(withClasses, keys[0]).classes) || null;
    }
  }
  return {
    composite: comp,
    stats: { candidates: cands.length, used: layers.length, read: use.length,
             capped: Math.max(0, cands.length - use.length), lackingAssets: missing,
             files: use.length * keys.length, errors: errors, levels: levels, log: log,
             ms: Math.round(performance.now() - t0) }
  };
}

// --- presets ---------------------------------------------------------------------
//
// What to offer in the composite picker for a source, from what its scenes
// actually carry. Preset = { id, label, keys, mode, ramp?, hillshade? };
// id is "mode:key,key" and is what the permalink stores. A catalog may list
// its own (catalog.presets) and they come first.

var S2_PRESETS = [
  { keys: ["visual"], mode: "rgb", label: "TCI (baked true colour, fast)" },
  { keys: ["red", "green", "blue"], mode: "bands", label: "true colour (raw bands)" },
  { keys: ["nir", "red", "green"], mode: "bands", label: "false colour IR (vegetation)" },
  { keys: ["swir16", "nir", "red"], mode: "bands", label: "SWIR (snow/ice vs cloud)" },
  { keys: ["swir22", "swir16", "nir"], mode: "bands", label: "geology" }
];
var ELEVATION = /^(dem|data|elevation|height|dsm|dtm|bathymetry|topo|z)$/i;

// Class tables for well-known assets whose catalogues don't carry them.
export var KNOWN_CLASSES = {
  // Sentinel-2 L2A scene classification, ESA's colours
  scl: [[0, "no data", "#000000"], [1, "saturated or defective", "#ff0000"],
        [2, "dark area / shadow", "#2f2f2f"], [3, "cloud shadow", "#643200"],
        [4, "vegetation", "#00a000"], [5, "not vegetated", "#ffe65a"], [6, "water", "#0000ff"],
        [7, "unclassified", "#808080"], [8, "cloud, medium probability", "#c0c0c0"],
        [9, "cloud, high probability", "#ffffff"], [10, "thin cirrus", "#64c8ff"],
        [11, "snow or ice", "#ff96ff"]].map(function (c) {
          return { value: c[0], label: c[1], color: c[2] };
        })
};

export function presetId(p) { return p.mode + ":" + p.keys.join(","); }

// Parse a preset id, including the older permalink forms ("visual",
// "red,green,blue", a single key).
export function parsePresetId(id) {
  id = String(id || "");
  var m = /^(rgb|bands|single|classes):(.+)$/.exec(id);
  if (m) return { mode: m[1], keys: m[2].split(",") };
  var keys = id.split(",");
  if (keys.length === 3) return { mode: "bands", keys: keys };
  return { mode: keys[0] === "visual" ? "rgb" : "single", keys: keys };
}

export function presetsFor(catalog, scenes) {
  var have = new Map(), meta = {};
  (scenes || []).forEach(function (s) {
    Object.keys(s.assets || {}).forEach(function (k) {
      have.set(k, (have.get(k) || 0) + 1);
      if (!meta[k] && s.assetMeta && s.assetMeta[k]) meta[k] = s.assetMeta[k];
    });
  });
  var out = [], seen = {};
  function add(p) {
    p.id = presetId(p);
    if (seen[p.id]) return;
    seen[p.id] = 1; out.push(p);
  }
  ((catalog && catalog.presets) || []).forEach(add);
  S2_PRESETS.forEach(function (p) {
    if (p.keys.every(function (k) { return have.has(k); })) add(Object.assign({}, p));
  });
  Array.from(have.keys()).sort().forEach(function (k) {
    if (k === "visual") return;
    var m = meta[k] || {};
    if (m.classes || KNOWN_CLASSES[k]) {
      add({ keys: [k], mode: "classes", label: k + " (classes)", classes: m.classes || KNOWN_CLASSES[k] });
    }
    else if (m.rgb) add({ keys: [k], mode: "rgb", label: k + " (RGB)" });
    else add({ keys: [k], mode: "single", label: k + " (one band)",
               ramp: ELEVATION.test(k) || m.elevation ? "terrain" : "greys",
               hillshade: ELEVATION.test(k) || m.elevation ? 0.6 : 0 });
  });
  return out;
}
