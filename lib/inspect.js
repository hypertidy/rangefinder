// The tile inspector: how a tiled source is structured, next to what it shows.
//
// For a tile server: the tile grid of any level over a region (drawn in the
// server's own CRS, so a polar grid shows as the curved lattice it is), what
// each request actually returned (data, partial, empty, missing, error, or a
// repeated "no data" placeholder: many servers answer 200 with the same
// blank tile outside their coverage), a coverage walk that descends only
// into tiles that exist, and an overzoom check that flags a tile which is
// just its parent upsampled (where native resolution really ends).
//
// For COGs: the internal tiles each file was read at, after a load, so read
// amplification is visible.
//
// InspectTile = { level (index), z (level id), col, row, extent (TMS CRS),
//                 polygon (GeoJSON lon/lat), url, status, bytes, ms, type,
//                 hash, kind, note }
// kind: "data" | "partial" | "empty" | "blank" | "missing" | "error" |
//       "placeholder" | "upsampled" | "grid" (not requested)

import { boxPolygon, ensureCrs, transformBbox } from "./geo.js";
import { fetchTile, levelRange, tileExtent, tileUrl } from "./tiles.js";

export var KIND_COLORS = {
  data: "#66bb6a", partial: "#c0ca33", empty: "#78909c", blank: "#90a4ae",
  missing: "#ef5350", error: "#ff7043", placeholder: "#ab47bc", upsampled: "#ffa726",
  grid: "#4fc3f7"
};

// Tiles of one level meeting a lon/lat box (a map view, a region).
// Throws when there are more than max: pick a coarser level or zoom in.
export function tilesInBox(src, index, lonlat, max) {
  var tms = src.tms, L = tms.levels[index];
  var crs = ensureCrs(tms.crs);
  var e = transformBbox(lonlat, "EPSG:4326", crs, 32);
  var tw = L.tileWidth * L.cell, th = L.tileHeight * L.cell;
  var c0 = Math.max(0, Math.floor((e[0] - L.origin[0]) / tw));
  var c1 = Math.min(L.matrixWidth - 1, Math.floor((e[2] - L.origin[0]) / tw));
  var r0 = Math.max(0, Math.floor((L.origin[1] - e[3]) / th));
  var r1 = Math.min(L.matrixHeight - 1, Math.floor((L.origin[1] - e[1]) / th));
  if (L.limits) {
    c0 = Math.max(c0, L.limits[0]); r0 = Math.max(r0, L.limits[1]);
    c1 = Math.min(c1, L.limits[2]); r1 = Math.min(r1, L.limits[3]);
  }
  if (c1 < c0 || r1 < r0) return [];
  var n = (c1 - c0 + 1) * (r1 - r0 + 1);
  if (n > (max || 1024)) {
    throw new Error(n + " tiles at level " + L.id + " in this view: zoom in or pick a coarser level");
  }
  var out = [];
  for (var r = r0; r <= r1; r++) {
    for (var c = c0; c <= c1; c++) out.push(makeTile(src, index, c, r));
  }
  return out;
}

function makeTile(src, index, col, row) {
  var L = src.tms.levels[index], ext = tileExtent(L, col, row);
  return { level: index, z: L.id, col: col, row: row, extent: ext,
           polygon: boxPolygon(ext, ensureCrs(src.tms.crs), 4), url: tileUrl(src, L, col, row),
           kind: "grid" };
}

// What one decoded tile holds: share of transparent pixels, and whether it
// is a single colour.
function look(image) {
  var d = image.data, n = d.length / 4, clear = 0, same = true;
  var r0 = d[0], g0 = d[1], b0 = d[2], a0 = d[3];
  for (var i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) clear++;
    if (same && (d[i] !== r0 || d[i + 1] !== g0 || d[i + 2] !== b0 || d[i + 3] !== a0)) same = false;
  }
  return { clear: clear / n, single: same };
}

function classify(tile, t) {
  tile.status = t.status; tile.bytes = t.bytes; tile.ms = t.ms; tile.type = t.type;
  tile.hash = t.hash; tile.image = t.image; tile.blob = t.blob;
  if (t.ok) {
    var lk = look(t.image);
    tile.clear = lk.clear;
    tile.kind = lk.clear === 1 ? "empty" : lk.single ? "blank" : lk.clear > 0 ? "partial" : "data";
    tile.note = lk.single && lk.clear < 1 ? "one colour: rgba(" +
      Array.prototype.slice.call(t.image.data, 0, 4).join(",") + ")" : null;
  } else if (t.error && !t.status) {
    tile.kind = "error"; tile.note = t.error;
  } else if (t.error) {
    tile.kind = "error"; tile.note = t.error;
  } else {
    tile.kind = "missing";
  }
  return tile;
}

// Identical bytes many times over is a server's placeholder (or genuinely
// uniform ground, like open ocean on a basemap): flag hashes seen at least
// three times among tiles that are not plainly data.
export function markRepeats(tiles) {
  var count = new Map();
  tiles.forEach(function (t) { if (t.hash) count.set(t.hash, (count.get(t.hash) || 0) + 1); });
  tiles.forEach(function (t) {
    var n = t.hash ? count.get(t.hash) : 0;
    if (n >= 3 && t.kind !== "upsampled" && (t.kind !== "data" || n >= Math.max(3, tiles.length * 0.2))) {
      t.repeats = n;
      t.note = (t.note ? t.note + "; " : "") + "same bytes as " + (n - 1) + " other tile(s)";
      t.kind = "placeholder";
    }
  });
  return tiles;
}

async function pool(items, n, fn) {
  var next = 0;
  async function worker() { while (next < items.length) { var i = next++; await fn(items[i], i); } }
  var ws = [];
  for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
  await Promise.all(ws);
}

// Request every tile of a level in a lon/lat box and say what came back.
//   opts.max (default 400), opts.signal, opts.onProgress(done, of)
export async function probeTiles(src, index, lonlat, opts) {
  opts = opts || {};
  var tiles = tilesInBox(src, index, lonlat, opts.max || 400), done = 0;
  await pool(tiles, opts.concurrency || 8, async function (tile) {
    classify(tile, await fetchTile(tile.url, opts.signal));
    done++;
    if (opts.onProgress) opts.onProgress(done, tiles.length);
  });
  return markRepeats(tiles);
}

// Mean absolute RGB difference between a tile and the part of its parent
// that covers it, upsampled nearest-neighbour; NaN when they share no
// opaque pixels. Small means the server is upsampling the parent.
export function parentDiff(child, parent) {
  var ci = child.image, pi = parent.image;
  if (!ci || !pi) return NaN;
  var ce = child.extent, pe = parent.extent;
  var pw = (pe[2] - pe[0]) / pi.width, ph = (pe[3] - pe[1]) / pi.height;
  var cw = (ce[2] - ce[0]) / ci.width, chh = (ce[3] - ce[1]) / ci.height;
  var sum = 0, n = 0, step = Math.max(1, Math.floor(ci.width / 128));
  for (var y = 0; y < ci.height; y += step) {
    var Y = ce[3] - (y + 0.5) * chh, py = Math.floor((pe[3] - Y) / ph);
    if (py < 0 || py >= pi.height) continue;
    for (var x = 0; x < ci.width; x += step) {
      var X = ce[0] + (x + 0.5) * cw, px = Math.floor((X - pe[0]) / pw);
      if (px < 0 || px >= pi.width) continue;
      var a = (y * ci.width + x) * 4, b = (py * pi.width + px) * 4;
      if (!ci.data[a + 3] || !pi.data[b + 3]) continue;
      sum += Math.abs(ci.data[a] - pi.data[b]) + Math.abs(ci.data[a + 1] - pi.data[b + 1]) +
             Math.abs(ci.data[a + 2] - pi.data[b + 2]);
      n += 3;
    }
  }
  return n ? sum / n : NaN;
}

// Children of a tile at the next level (any nesting ratio), within a box
// given in the TMS CRS.
function children(src, tile, box) {
  var next = tile.level + 1, L = src.tms.levels[next];
  if (!L) return [];
  var e = tile.extent, tw = L.tileWidth * L.cell, th = L.tileHeight * L.cell, eps = L.cell * 0.5;
  var lo = [Math.max(e[0], box[0]), Math.max(e[1], box[1])], hi = [Math.min(e[2], box[2]), Math.min(e[3], box[3])];
  if (hi[0] <= lo[0] || hi[1] <= lo[1]) return [];
  var c0 = Math.floor((lo[0] + eps - L.origin[0]) / tw), c1 = Math.floor((hi[0] - eps - L.origin[0]) / tw);
  var r0 = Math.floor((L.origin[1] - hi[1] + eps) / th), r1 = Math.floor((L.origin[1] - lo[1] - eps) / th);
  if (L.limits) {
    c0 = Math.max(c0, L.limits[0]); r0 = Math.max(r0, L.limits[1]);
    c1 = Math.min(c1, L.limits[2]); r1 = Math.min(r1, L.limits[3]);
  }
  var out = [];
  for (var r = Math.max(0, r0); r <= Math.min(L.matrixHeight - 1, r1); r++) {
    for (var c = Math.max(0, c0); c <= Math.min(L.matrixWidth - 1, c1); c++) {
      var t = makeTile(src, next, c, r);
      t.parent = tile;
      out.push(t);
    }
  }
  return out;
}

// Walk down from a level over a lon/lat box, requesting only the children
// of tiles that came back with data, until the budget is spent or the
// finest level is reached. A child that is its parent upsampled (mean RGB
// difference under opts.tolerance, default 2 of 255) is marked "upsampled" and not
// descended. -> { tiles: [InspectTile], requests, deepest: { levelIndex: n },
//                 nativeMax (deepest level with non-upsampled data), stopped }
export async function coverageWalk(src, startIndex, lonlat, opts) {
  opts = opts || {};
  var budget = opts.budget || 300, tol = opts.tolerance === undefined ? 2 : opts.tolerance;
  var box = transformBbox(lonlat, "EPSG:4326", ensureCrs(src.tms.crs), 32);
  var maxLevel = levelRange(src)[1];
  var frontier = tilesInBox(src, startIndex, lonlat, budget), all = [], requests = 0, stopped = null;
  while (frontier.length) {
    if (requests + frontier.length > budget) {
      frontier = frontier.slice(0, Math.max(0, budget - requests));
      stopped = "budget";
      if (!frontier.length) break;
    }
    await pool(frontier, opts.concurrency || 8, async function (tile) {
      classify(tile, await fetchTile(tile.url, opts.signal));
      if (tile.parent && (tile.kind === "data" || tile.kind === "partial") && tile.parent.image) {
        var d = parentDiff(tile, tile.parent);
        tile.parentDiff = d;
        if (d === d && d < tol) { tile.kind = "upsampled"; tile.note = "parent upsampled (mean diff " + d.toFixed(2) + ")"; }
      }
    });
    requests += frontier.length;
    all = all.concat(frontier);
    if (opts.onProgress) opts.onProgress(requests, budget, frontier[0] && frontier[0].z);
    if (stopped) break;
    var next = [];
    frontier.forEach(function (t) {
      if ((t.kind === "data" || t.kind === "partial") && t.level < maxLevel) next = next.concat(children(src, t, box));
    });
    // keep the decoded parents only as long as their children need them
    all.forEach(function (t) { if (t.level < (frontier[0] ? frontier[0].level : 0)) t.image = null; });
    frontier = next;
  }
  markRepeats(all);
  var deepest = {}, nativeMax = -1;
  all.forEach(function (t) {
    deepest[t.z] = (deepest[t.z] || 0) + 1;
    if ((t.kind === "data" || t.kind === "partial") && t.level > nativeMax) nativeMax = t.level;
  });
  return { tiles: all, requests: requests, deepest: deepest, nativeMax: nativeMax, stopped: stopped };
}

// The COG tiles a load read: one entry per file from loadComposite's log
// ({ href, level, window, tileSize, origin, res, crs }), expanded to the
// internal tiles of that level the window touched.
export function cogReadTiles(log, max) {
  var out = [];
  (log || []).forEach(function (e) {
    if (!e.window || !e.tileSize) return;
    var tw = e.tileSize[0], th = e.tileSize[1], w = e.window;
    for (var r = Math.floor(w[1] / th); r <= Math.floor((w[3] - 1) / th); r++) {
      for (var c = Math.floor(w[0] / tw); c <= Math.floor((w[2] - 1) / tw); c++) {
        if (out.length >= (max || 4000)) return;
        var x0 = e.origin[0] + c * tw * e.res[0], y0 = e.origin[1] + r * th * e.res[1];
        var x1 = x0 + tw * e.res[0], y1 = y0 + th * e.res[1];
        var ext = [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
        out.push({ z: e.level, col: c, row: r, extent: ext, url: e.href, kind: "data",
                   polygon: boxPolygon(ext, ensureCrs(e.crs), 4),
                   note: (e.href.split("/").pop()) + ", overview " + e.level + ", tile " + tw + "x" + th });
      }
    }
  });
  return out;
}
