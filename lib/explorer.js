// rangefinder library: the four layers behind small interfaces.
//
//   1. SPACE   geo.js       CRS helpers, footprints, the shared OutputGrid
//   2. TIME    sources/*    Catalog.search() -> Scene[]; groupByDay() below
//   3. PIXELS  cog.js       readWarped(href, grid): windowed overview reads
//   4. RENDER  render.js    mosaic, percentile stretch, gamma -> RGBA
//
// A source (STAC API, wildtiles cube, starc store) only implements
// the Catalog interface documented in sources/stac.js. Pixels and render
// never know which source produced a scene.
//
// Dependencies are loaded by the page as globals: proj4, GeoTIFF (geotiff.js).

export * from "./geo.js";
export * from "./render.js";
export { readWarped, openCog } from "./cog.js";
export { stacCatalog, listCollections, resolveAssets, BAND_ALIASES } from "./sources/stac.js";
export { starcCatalog } from "./sources/starc.js";
export { wildtilesCatalog, parseTileId, makeTileId, tileLonLatBbox, tilesForBbox,
         WILDTILES_BUCKET } from "./sources/wildtiles.js";

import { bboxIntersects, gridLonLatBounds } from "./geo.js";
import { readWarped } from "./cog.js";
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

// Fetch and mosaic one composite on the grid.
//   keys       ["visual"] for a baked 3-band product, or [rKey, gKey, bKey]
//   scenes     candidate scenes (typically one day's), any order
//   maxScenes  fan-out cap: at most this many scenes are read (default 6)
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
  var done = 0;
  var tasks = use.map(function (s) {
    return async function () {
      var parts = await Promise.all(keys.map(function (k) {
        return readWarped(s.assets[k], grid, { crs: s.crs, signal: o.signal });
      }));
      done++;
      if (o.onProgress) o.onProgress(done, use.length, s);
      if (parts.some(function (p) { return p === null; })) return null;
      if (parts.length === 1) return { bands: parts[0].bands.slice(0, 3), valid: parts[0].valid,
                                       level: parts[0].level };
      var valid = parts[0].valid.slice();
      for (var i = 1; i < parts.length; i++) {
        var v = parts[i].valid;
        for (var j = 0; j < valid.length; j++) valid[j] = valid[j] & v[j];
      }
      return { bands: parts.map(function (p) { return p.bands[0]; }), valid: valid,
               level: parts[0].level };
    };
  });
  var results = await pool(tasks, o.concurrency || 4);
  var layers = [], errors = [], levels = [];
  results.forEach(function (r, i) {
    if (!r.ok) { errors.push({ id: use[i].id, message: String(r.error && r.error.message || r.error) }); return; }
    if (r.value) { layers.push(r.value); levels.push(r.value.level); }
  });
  var kind = keys.length === 1 ? "rgb8" : "bands";
  var comp = null;
  if (layers.length) {
    if (kind === "rgb8" && layers[0].bands.length < 3) throw new Error(keys[0] + " is not a 3-band product");
    comp = mosaic(grid, layers, kind, keys);
  }
  return {
    composite: comp,
    stats: { candidates: cands.length, used: layers.length, read: use.length,
             capped: Math.max(0, cands.length - use.length), lackingAssets: missing,
             files: use.length * keys.length, errors: errors, levels: levels,
             ms: Math.round(performance.now() - t0) }
  };
}
