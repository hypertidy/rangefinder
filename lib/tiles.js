// Layer 3 (and 1): map tile servers, XYZ and WMTS.
//
// A tile pyramid is a COG whose internal tiles happen to be separate URLs:
// a TileMatrixSet gives, per level, an origin, a cell size and a tile size,
// which is the same affine-plus-overviews that cog.js warps from. So tiles go
// through the same lattice warp onto the OutputGrid, and a polar (EPSG:3031)
// or lon/lat (EPSG:4326) pyramid mosaics onto the Web Mercator map like a
// UTM scene does.
//
// TileSource = { kind: "tiles", template, tms, format, subdomains, time,
//                minzoom, maxzoom, label }
//   template  URL with {z} {x} {y} {-y} {q} {s}, or the WMTS names
//             {TileMatrix} {TileRow} {TileCol} {TileMatrixSet} {Time} {Style}
//   tms       TileMatrixSet = { id, crs, levels: [Level] } (see webMercatorQuad)
//   format    "rgb" (as served), "terrarium" or "mapbox" (elevation packed in
//             RGB, decoded to metres)
// Level = { id, cell, origin: [x, y] (top-left), tileWidth, tileHeight,
//           matrixWidth, matrixHeight, limits?: [minCol, minRow, maxCol, maxRow] }
//
// Pixels need CORS: without Access-Control-Allow-Origin a page can show a
// tile in an <img> but not read it, and every read here fails loudly.

import { ensureCrs, crsCode } from "./geo.js";
import { gridLattice, latticeScale, latticeWindow, resampleWindow } from "./cog.js";

var MERC = 20037508.342789244;
var DEG_M = 2 * Math.PI * 6378137 / 360;   // metres per degree, for WMTS scale denominators

// --- tile matrix sets ----------------------------------------------------------

export function webMercatorQuad(maxzoom, tileSize) {
  maxzoom = maxzoom == null ? 22 : maxzoom;
  tileSize = tileSize || 256;
  var levels = [];
  for (var z = 0; z <= maxzoom; z++) {
    levels.push({ id: String(z), z: z, cell: 2 * MERC / tileSize / Math.pow(2, z),
                  origin: [-MERC, MERC], tileWidth: tileSize, tileHeight: tileSize,
                  matrixWidth: Math.pow(2, z), matrixHeight: Math.pow(2, z) });
  }
  return { id: "WebMercatorQuad", crs: "EPSG:3857", levels: levels };
}

// Lon/lat bounds of one tile's extent corners, and its extent in the TMS CRS.
export function tileExtent(level, col, row) {
  var w = level.tileWidth * level.cell, h = level.tileHeight * level.cell;
  var x0 = level.origin[0] + col * w, y1 = level.origin[1] - row * h;
  return [x0, y1 - h, x0 + w, y1];
}

// --- URLs -----------------------------------------------------------------------

function quadkey(z, x, y) {
  var q = "";
  for (var i = z; i > 0; i--) {
    var d = 0, m = 1 << (i - 1);
    if (x & m) d += 1;
    if (y & m) d += 2;
    q += d;
  }
  return q;
}

export function tileUrl(src, level, col, row) {
  var z = level.z !== undefined ? level.z : level.id;
  var subs = src.subdomains || "abc";
  var s = typeof subs === "string" ? subs[(col + row) % subs.length] : subs[(col + row) % subs.length];
  return src.template
    .replace(/\{z\}/g, z).replace(/\{x\}/g, col).replace(/\{y\}/g, row)
    .replace(/\{-y\}/g, level.matrixHeight - 1 - row)
    .replace(/\{q\}/g, quadkey(+z, col, row)).replace(/\{s\}/g, s)
    .replace(/\{TileMatrix\}/gi, level.id).replace(/\{TileRow\}/gi, row).replace(/\{TileCol\}/gi, col)
    .replace(/\{TileMatrixSet\}/gi, src.tms.id).replace(/\{Time\}/gi, src.time || "")
    .replace(/\{Style\}/gi, src.style || "default");
}

// --- fetching and decoding -----------------------------------------------------
//
// Tile = { url, status, ok, bytes, type, ms, hash, image (ImageData) | null,
//          error }   ok means a decodable image came back.

var tileCache = new Map(), TILE_CACHE_MAX = 1024;

// FNV-1a over the bytes: cheap, and enough to spot a server's one
// "no data" tile repeated across an area.
function fnv(buf) {
  var h = 0x811c9dc5, b = new Uint8Array(buf);
  for (var i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

async function decode(blob) {
  var bmp = await createImageBitmap(blob);
  var cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(bmp.width, bmp.height)
                                                  : Object.assign(document.createElement("canvas"),
                                                                  { width: bmp.width, height: bmp.height });
  var g = cv.getContext("2d");
  g.drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return g.getImageData(0, 0, cv.width, cv.height);
}

export function fetchTile(url, signal) {
  var hit = tileCache.get(url);
  if (hit) { tileCache.delete(url); tileCache.set(url, hit); return hit; }
  var p = (async function () {
    var t0 = performance.now(), out = { url: url, status: 0, ok: false, bytes: 0, type: "",
                                        ms: 0, hash: null, image: null, error: null };
    try {
      var r = await fetch(url, { signal: signal, mode: "cors" });
      out.status = r.status;
      out.type = r.headers.get("content-type") || "";
      var buf = await r.arrayBuffer();
      out.bytes = buf.byteLength;
      out.ms = Math.round(performance.now() - t0);
      if (r.ok && buf.byteLength) {
        out.hash = fnv(buf);
        out.blob = new Blob([buf], { type: out.type || "image/png" });
        try { out.image = await decode(out.blob); out.ok = true; }
        catch (e) { out.error = "not an image (" + (out.type || "unknown type") + ")"; }
      }
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      out.ms = Math.round(performance.now() - t0);
      // a CORS refusal and a network failure look the same from here
      out.error = "network or CORS failure";
    }
    return out;
  })();
  p.catch(function () { tileCache.delete(url); });
  tileCache.set(url, p);
  if (tileCache.size > TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  return p;
}

// Elevation packed into RGB, to metres.
export var DECODERS = {
  terrarium: function (r, g, b) { return r * 256 + g + b / 256 - 32768; },
  mapbox: function (r, g, b) { return -10000 + (r * 65536 + g * 256 + b) * 0.1; }
};

async function pool(items, n, fn) {
  var next = 0, out = new Array(items.length);
  async function worker() {
    while (next < items.length) { var i = next++; out[i] = await fn(items[i], i); }
  }
  var ws = [];
  for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
  await Promise.all(ws);
  return out;
}

// --- level choice and tile ranges ------------------------------------------------

export function levelRange(src) {
  var n = src.tms.levels.length;
  var lo = Math.max(0, src.minzoom || 0);
  var hi = Math.min(n - 1, src.maxzoom === undefined || src.maxzoom === null ? n - 1 : src.maxzoom);
  return [lo, hi];
}

// The level whose cells are the coarsest still no larger than a grid pixel
// (the same rule as COG overviews); the finest level when even that is too
// coarse (the page then upsamples, and says so).
export function chooseLevel(src, grid) {
  var tms = src.tms, L0 = tms.levels[0];
  var toSrc = globalThis.proj4(ensureCrs(grid.crs), ensureCrs(tms.crs));
  var lat = gridLattice(grid, toSrc, L0.origin, [L0.cell, -L0.cell]);
  var gridCell = latticeScale(lat) * L0.cell;    // a grid pixel, in TMS units
  var r = levelRange(src), pick = r[1];
  for (var i = r[0]; i <= r[1]; i++) {
    if (tms.levels[i].cell <= gridCell * 1.05) { pick = i; break; }
  }
  return { index: pick, gridCell: gridCell, overzoom: tms.levels[pick].cell > gridCell * 1.05 };
}

// Tiles of one level covering the grid: { level, cols: [c0, c1], rows: [r0, r1],
// lat, window } or null when the grid misses the pyramid.
export function gridTiles(src, grid, index) {
  var L = src.tms.levels[index];
  var toSrc = globalThis.proj4(ensureCrs(grid.crs), ensureCrs(src.tms.crs));
  var lat = gridLattice(grid, toSrc, L.origin, [L.cell, -L.cell]);
  var win = latticeWindow(lat, L.matrixWidth * L.tileWidth, L.matrixHeight * L.tileHeight);
  if (!win) return null;
  var c0 = Math.floor(win[0] / L.tileWidth), c1 = Math.ceil(win[2] / L.tileWidth) - 1;
  var r0 = Math.floor(win[1] / L.tileHeight), r1 = Math.ceil(win[3] / L.tileHeight) - 1;
  if (L.limits) {
    c0 = Math.max(c0, L.limits[0]); r0 = Math.max(r0, L.limits[1]);
    c1 = Math.min(c1, L.limits[2]); r1 = Math.min(r1, L.limits[3]);
    if (c1 < c0 || r1 < r0) return null;
  }
  return { level: L, index: index, cols: [c0, c1], rows: [r0, r1], lat: lat };
}

// --- the read ------------------------------------------------------------------------

// Read a tile source warped onto the grid.
//   opts.maxTiles  cap on tiles per read (default 300): above it, a coarser level
//   opts.signal    AbortSignal
// Resolves to null when nothing came back, otherwise
//   { bands: [R, G, B] (Uint8) or [elevation] (Float32), valid, level,
//     levelId, overzoom, log: [Tile summary] }
export async function readTilesWarped(src, grid, opts) {
  opts = opts || {};
  var maxTiles = opts.maxTiles || 300;
  var ch = chooseLevel(src, grid), idx = ch.index, gt = null;
  for (; idx >= levelRange(src)[0]; idx--) {
    gt = gridTiles(src, grid, idx);
    if (!gt) return null;
    var n = (gt.cols[1] - gt.cols[0] + 1) * (gt.rows[1] - gt.rows[0] + 1);
    if (n <= maxTiles) break;
  }
  if (!gt) return null;
  var L = gt.level, tw = L.tileWidth, th = L.tileHeight;
  var nx = gt.cols[1] - gt.cols[0] + 1, ny = gt.rows[1] - gt.rows[0] + 1;
  var ww = nx * tw, wh = ny * th;
  var R = new Uint8Array(ww * wh), G = new Uint8Array(ww * wh), B = new Uint8Array(ww * wh);
  var A = new Uint8Array(ww * wh);
  var jobs = [];
  for (var r = gt.rows[0]; r <= gt.rows[1]; r++) {
    for (var c = gt.cols[0]; c <= gt.cols[1]; c++) jobs.push([c, r]);
  }
  var log = [];
  await pool(jobs, opts.concurrency || 8, async function (j) {
    var url = tileUrl(src, L, j[0], j[1]);
    var t = await fetchTile(url, opts.signal);
    log.push({ z: L.id, x: j[0], y: j[1], url: url, status: t.status, bytes: t.bytes,
               ms: t.ms, hash: t.hash, ok: t.ok, error: t.error });
    if (!t.ok) return;
    var im = t.image, ox = (j[0] - gt.cols[0]) * tw, oy = (j[1] - gt.rows[0]) * th;
    var w = Math.min(im.width, tw), h = Math.min(im.height, th), d = im.data;
    for (var y = 0; y < h; y++) {
      var so = y * im.width * 4, dp = (oy + y) * ww + ox;
      for (var x = 0; x < w; x++, so += 4, dp++) {
        R[dp] = d[so]; G[dp] = d[so + 1]; B[dp] = d[so + 2]; A[dp] = d[so + 3];
      }
    }
  });
  var bands = [R, G, B];
  var dec = DECODERS[src.format];
  if (dec) {
    var E = new Float32Array(ww * wh);
    for (var i = 0; i < E.length; i++) E[i] = A[i] ? dec(R[i], G[i], B[i]) : NaN;
    bands = [E];
  }
  var res = resampleWindow(gt.lat, grid, bands, ww, wh, gt.cols[0] * tw, gt.rows[0] * th, 1, 1,
                           dec ? NaN : null, A);
  if (!res.any) {
    var bad = log.filter(function (t) { return t.error; })[0];
    if (bad && log.every(function (t) { return !t.ok; })) {
      throw new Error("no tile could be read (" + bad.error + "), e.g. " + bad.url);
    }
    return null;
  }
  return { bands: res.bands, valid: res.valid, level: gt.index, levelId: L.id,
           overzoom: ch.overzoom && gt.index === ch.index, log: log };
}

// --- WMTS capabilities ---------------------------------------------------------------

function kids(el, name) {
  return Array.prototype.filter.call(el.children, function (c) { return c.localName === name; });
}
function kid(el, name) { return kids(el, name)[0] || null; }
function text(el, name) { var k = el && kid(el, name); return k ? k.textContent.trim() : null; }

// Some CRSs put latitude first in a WMTS TopLeftCorner (EPSG:4326 in its URN
// forms); CRS84 and projected CRSs are x, y.
function latFirst(crsText) {
  return /EPSG(::|:|\/0\/)4326$/i.test(crsText) && !/CRS84/i.test(crsText);
}

// Capabilities XML -> { title, layers: [Layer], sets: { id: TileMatrixSet } }
// Layer = { id, title, formats, styles: [{ id, isDefault }], bbox (lon/lat),
//           templates: [{ format, template }], kvp (GetTile URL or null),
//           links: [{ set, limits: { matrixId: [minCol, minRow, maxCol, maxRow] } }],
//           times: [..] | null, timeDefault }
export function parseWmtsCapabilities(xml, url) {
  var doc = typeof xml === "string" ? new DOMParser().parseFromString(xml, "application/xml") : xml;
  var root = doc.documentElement;
  if (!root || root.localName !== "Capabilities") throw new Error("not WMTS capabilities");
  var contents = kid(root, "Contents");
  if (!contents) throw new Error("WMTS capabilities without Contents");
  var sets = {};
  kids(contents, "TileMatrixSet").forEach(function (s) {
    var id = text(s, "Identifier"), crsText = text(s, "SupportedCRS") || "";
    var crs = crsCode(crsText), swap = latFirst(crsText);
    var mpu = crs === "EPSG:4326" || /longlat/.test(crs) ? DEG_M : 1;
    var levels = kids(s, "TileMatrix").map(function (m) {
      var tl = text(m, "TopLeftCorner").split(/\s+/).map(Number);
      if (swap) tl = [tl[1], tl[0]];
      return { id: text(m, "Identifier"), cell: +text(m, "ScaleDenominator") * 0.00028 / mpu,
               origin: tl, tileWidth: +text(m, "TileWidth"), tileHeight: +text(m, "TileHeight"),
               matrixWidth: +text(m, "MatrixWidth"), matrixHeight: +text(m, "MatrixHeight") };
    });
    levels.sort(function (a, b) { return b.cell - a.cell; });   // coarse to fine
    sets[id] = { id: id, crs: crs, crsText: crsText, levels: levels };
  });
  var kvp = null;
  Array.prototype.forEach.call(root.getElementsByTagNameNS("*", "Operation"), function (op) {
    if (op.getAttribute("name") !== "GetTile") return;
    Array.prototype.forEach.call(op.getElementsByTagNameNS("*", "Get"), function (g) {
      var href = g.getAttributeNS("http://www.w3.org/1999/xlink", "href") || g.getAttribute("xlink:href");
      var enc = g.getElementsByTagNameNS("*", "Value")[0];
      if (href && (!enc || /KVP/i.test(enc.textContent)) && !kvp) kvp = href;
    });
  });
  var layers = kids(contents, "Layer").map(function (l) {
    var wb = kid(l, "WGS84BoundingBox"), bbox = null;
    if (wb) {
      var lc = text(wb, "LowerCorner").split(/\s+/).map(Number);
      var uc = text(wb, "UpperCorner").split(/\s+/).map(Number);
      bbox = [lc[0], lc[1], uc[0], uc[1]];
    }
    var times = null, timeDefault = null;
    kids(l, "Dimension").forEach(function (d) {
      if (!/^time$/i.test(text(d, "Identifier") || "")) return;
      timeDefault = text(d, "Default");
      times = expandTimes(kids(d, "Value").map(function (v) { return v.textContent.trim(); }));
    });
    var links = kids(l, "TileMatrixSetLink").map(function (k) {
      var lim = {};
      var limsEl = kid(k, "TileMatrixSetLimits");
      if (limsEl) kids(limsEl, "TileMatrixLimits").forEach(function (m) {
        lim[text(m, "TileMatrix")] = [+text(m, "MinTileCol"), +text(m, "MinTileRow"),
                                      +text(m, "MaxTileCol"), +text(m, "MaxTileRow")];
      });
      return { set: text(k, "TileMatrixSet"), limits: lim };
    });
    return {
      id: text(l, "Identifier"), title: text(l, "Title") || text(l, "Identifier"),
      formats: kids(l, "Format").map(function (f) { return f.textContent.trim(); }),
      styles: kids(l, "Style").map(function (st) {
        return { id: text(st, "Identifier"), isDefault: st.getAttribute("isDefault") === "true" };
      }),
      bbox: bbox, links: links, times: times, timeDefault: timeDefault, kvp: kvp,
      templates: kids(l, "ResourceURL").filter(function (r) {
        return (r.getAttribute("resourceType") || "tile") === "tile";
      }).map(function (r) {
        return { format: r.getAttribute("format"), template: absTemplate(r.getAttribute("template"), url) };
      })
    };
  });
  return { title: text(kid(root, "ServiceIdentification") || root, "Title"), layers: layers, sets: sets };
}

// Resolve a relative template against the capabilities URL without
// percent-encoding its {placeholders}.
function absTemplate(t, base) {
  if (/^https?:\/\//i.test(t) || !base) return t;
  return new URL(t, base).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}");
}

// WMTS time values may be lists or ISO intervals "start/end/P1D": expand
// day periods (capped), keep the rest as given.
function expandTimes(vals) {
  var out = [];
  vals.forEach(function (v) {
    v.split(",").forEach(function (one) {
      var m = /^(\d{4}-\d\d-\d\d)[^/]*\/(\d{4}-\d\d-\d\d)[^/]*\/P(\d+)D$/.exec(one.trim());
      if (!m) { if (one.trim()) out.push(one.trim()); return; }
      var t = Date.parse(m[1] + "T00:00:00Z"), t1 = Date.parse(m[2] + "T00:00:00Z"), step = +m[3] * 864e5;
      // keep the most recent end of very long series
      var n = Math.floor((t1 - t) / step);
      if (n > 4000) t += (n - 4000) * step;
      for (; t <= t1; t += step) out.push(new Date(t).toISOString().slice(0, 10));
    });
  });
  return out;
}

// One layer of parsed capabilities -> a TileSource.
//   o.set, o.style, o.format (MIME), o.time
export function wmtsSource(caps, layerId, o) {
  o = o || {};
  var layer = caps.layers.filter(function (l) { return l.id === layerId; })[0];
  if (!layer) throw new Error("no layer " + layerId);
  var link = layer.links.filter(function (k) { return !o.set || k.set === o.set; })[0];
  if (!link) throw new Error("layer " + layerId + " has no tile matrix set " + o.set);
  var base = caps.sets[link.set];
  if (!base) throw new Error("unknown tile matrix set " + link.set);
  var tms = { id: base.id, crs: base.crs, levels: base.levels.map(function (L) {
    return Object.assign({}, L, link.limits[L.id] ? { limits: link.limits[L.id] } : {});
  }) };
  var fmt = o.format || (layer.templates[0] && layer.templates[0].format) || layer.formats[0] || "image/png";
  var t = layer.templates.filter(function (x) { return x.format === fmt; })[0] || layer.templates[0];
  var style = o.style || ((layer.styles.filter(function (s) { return s.isDefault; })[0] || layer.styles[0] || {}).id) || "default";
  var template;
  if (t) template = t.template;
  else if (layer.kvp) {
    template = layer.kvp + (layer.kvp.indexOf("?") >= 0 ? "&" : "?") +
      "SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=" + encodeURIComponent(layer.id) +
      "&STYLE={Style}&FORMAT=" + encodeURIComponent(fmt) + "&TILEMATRIXSET={TileMatrixSet}" +
      "&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}" + (layer.times ? "&TIME={Time}" : "");
  } else throw new Error("layer " + layerId + " has neither a ResourceURL nor a KVP GetTile");
  return { kind: "tiles", template: template, tms: tms, style: style, format: o.decode || "rgb",
           time: o.time || layer.timeDefault || "", label: layer.title, bbox: layer.bbox };
}
