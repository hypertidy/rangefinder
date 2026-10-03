// Layer 1 helpers: coordinate systems, footprints and the output grid.
//
// Everything here is plain arithmetic over proj4 (loaded as a global by the
// page). The output grid is the one shared raster that every source warps
// into: an axis-aligned box in Web Mercator (EPSG:3857) with a pixel size, so
// it overlays a Leaflet map exactly and scenes from different UTM zones
// mosaic without seams.

function proj() {
  var p = globalThis.proj4;
  if (!p) throw new Error("proj4 is not loaded");
  return p;
}

// Make sure proj4 knows a CRS code. UTM (EPSG:326zz north, 327zz south) is
// generated; anything else must already be registered with proj4.defs().
export function ensureCrs(code) {
  var p = proj();
  if (p.defs(code)) return code;
  var m = /^EPSG:(32[67])(\d{2})$/.exec(code);
  if (m) {
    p.defs(code, "+proj=utm +zone=" + (+m[2]) + (m[1] === "327" ? " +south" : "") +
      " +datum=WGS84 +units=m +no_defs");
    return code;
  }
  throw new Error("unknown CRS " + code + " (register it with proj4.defs)");
}

export function utmCode(zone, south) {
  return "EPSG:" + (south ? "327" : "326") + String(zone).padStart(2, "0");
}

export function utmZoneOf(lon) {
  return Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
}

export function transform(from, to, xy) {
  return proj()(ensureCrs(from), ensureCrs(to), xy);
}

// Transform a box by densifying its edges (never corners only), returning
// the bounding box of the result in the target CRS.
export function transformBbox(bbox, from, to, n) {
  n = n || 16;
  var f = proj()(ensureCrs(from), ensureCrs(to));
  var xs = [], ys = [];
  for (var i = 0; i <= n; i++) {
    var fx = bbox[0] + (bbox[2] - bbox[0]) * i / n;
    var fy = bbox[1] + (bbox[3] - bbox[1]) * i / n;
    [[fx, bbox[1]], [fx, bbox[3]], [bbox[0], fy], [bbox[2], fy]].forEach(function (pt) {
      var q = f.forward(pt);
      if (isFinite(q[0]) && isFinite(q[1])) { xs.push(q[0]); ys.push(q[1]); }
    });
  }
  return [Math.min.apply(null, xs), Math.min.apply(null, ys),
          Math.max.apply(null, xs), Math.max.apply(null, ys)];
}

export function bboxIntersects(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

// Lon/lat bbox of a GeoJSON geometry (Polygon or MultiPolygon).
export function geometryBbox(g) {
  var xs = [], ys = [];
  (function walk(c) {
    if (typeof c[0] === "number") { xs.push(c[0]); ys.push(c[1]); return; }
    c.forEach(walk);
  })(g.coordinates);
  return [Math.min.apply(null, xs), Math.min.apply(null, ys),
          Math.max.apply(null, xs), Math.max.apply(null, ys)];
}

// --- the output grid ---------------------------------------------------------
//
// OutputGrid = { crs: "EPSG:3857", bbox: [xmin, ymin, xmax, ymax] (metres),
//                width, height }   pixel (0, 0) is the top-left corner.

// Build a grid covering a lon/lat bbox. maxDim caps the longer side;
// pixelSize (Mercator metres) and minGroundRes (ground metres) set a floor
// on the pixel size, so a small region is not read finer than the data.
export function makeGrid(lonlatBbox, opts) {
  opts = opts || {};
  var bb = transformBbox(lonlatBbox, "EPSG:4326", "EPSG:3857", 8);
  var w = bb[2] - bb[0], h = bb[3] - bb[1];
  var maxDim = opts.maxDim || 1536;
  var size = Math.max(opts.pixelSize || 0, Math.max(w, h) / maxDim);
  if (opts.minGroundRes) {   // no finer than the data: ground metres -> Mercator metres
    var lat = (lonlatBbox[1] + lonlatBbox[3]) / 2 * Math.PI / 180;
    size = Math.max(size, opts.minGroundRes / Math.cos(lat));
  }
  return { crs: "EPSG:3857", bbox: bb,
           width: Math.max(1, Math.round(w / size)),
           height: Math.max(1, Math.round(h / size)) };
}

export function gridLonLatBounds(grid) {
  var sw = transform(grid.crs, "EPSG:4326", [grid.bbox[0], grid.bbox[1]]);
  var ne = transform(grid.crs, "EPSG:4326", [grid.bbox[2], grid.bbox[3]]);
  return [sw[0], sw[1], ne[0], ne[1]];
}

// Ground size of one grid pixel in metres at the grid centre (Mercator
// stretches by 1/cos(lat), so divide that back out).
export function gridGroundRes(grid) {
  var c = gridLonLatBounds(grid);
  var lat = (c[1] + c[3]) / 2 * Math.PI / 180;
  return (grid.bbox[2] - grid.bbox[0]) / grid.width * Math.cos(lat);
}

// Solar day: the local calendar date at the scene centre, so one overpass
// never splits across two UTC dates (matters near the antimeridian).
export function solarDay(datetime, lon) {
  var t = Date.parse(datetime);
  if (!isFinite(t)) return String(datetime).slice(0, 10);
  return new Date(t + (lon || 0) / 15 * 3600e3).toISOString().slice(0, 10);
}

// --- Sentinel-2 MGRS tiles ----------------------------------------------------
//
// A Sentinel-2 tile code ("55GEN") names a 100 km MGRS square; the tile is
// that square's upper-left corner moved about 20 m west and 20 m north,
// extended 109800 m east and south (so neighbours overlap by 9.8 km).
// Against proj:transform of the eight dev fixture tiles the corner is exact
// or 20 m out (55GEN 499980, 5300020; 55GDN 399960; 55HBV 6000040): fine for
// footprints and overlap tests, not for pixel addressing.

var MGRS_COLS = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // 24 letters, no I or O
var MGRS_ROWS = "ABCDEFGHJKLMNPQRSTUV";       // 20 letters
var MGRS_BANDS = "CDEFGHJKLMNPQRSTUVWX";      // 8 degrees each from 80S

// "55GEN" (or "MGRS-55GEN") -> { zone, south, crs, extent: [xmin, ymin, xmax, ymax] }
export function mgrsExtent(code) {
  var m = /^(?:MGRS-)?(\d{1,2})([C-X])([A-Z])([A-V])$/.exec(String(code).trim().toUpperCase());
  if (!m) throw new Error("bad MGRS tile: " + code);
  var zone = +m[1], band = MGRS_BANDS.indexOf(m[2]);
  var col = MGRS_COLS.indexOf(m[3]) - ((zone - 1) % 3) * 8;
  var row = MGRS_ROWS.indexOf(m[4]) - (zone % 2 === 0 ? 5 : 0);
  if (band < 0 || col < 0 || col > 7 || MGRS_ROWS.indexOf(m[4]) < 0) throw new Error("bad MGRS tile: " + code);
  var south = band < 10;
  var crs = utmCode(zone, south);
  var e0 = (col + 1) * 100000;
  var n0 = ((row % 20) + 20) % 20 * 100000;
  // the 2000 km row-letter cycle: take the first square reaching the band's
  // southern edge (measured at the central meridian)
  var lat0 = -80 + band * 8;
  var cm = (zone - 1) * 6 - 180 + 3;
  var nmin = transform("EPSG:4326", crs, [cm, lat0])[1];
  while (n0 + 100000 < nmin - 50000) n0 += 2000000;
  var x0 = e0 - 20, y1 = n0 + 100020;
  return { zone: zone, south: south, crs: crs, extent: [x0, y1 - 109800, x0 + 109800, y1] };
}

// GeoJSON polygon (lon/lat, edges densified) of a projected box.
export function boxPolygon(extent, crs, n) {
  n = n || 8;
  var f = proj()(ensureCrs(crs), "EPSG:4326");
  var e = extent, ring = [];
  for (var i = 0; i < n; i++) ring.push([e[0] + (e[2] - e[0]) * i / n, e[1]]);
  for (i = 0; i < n; i++) ring.push([e[2], e[1] + (e[3] - e[1]) * i / n]);
  for (i = 0; i < n; i++) ring.push([e[2] - (e[2] - e[0]) * i / n, e[3]]);
  for (i = 0; i < n; i++) ring.push([e[0], e[3] - (e[3] - e[1]) * i / n]);
  ring = ring.map(function (p) { return f.forward(p); });
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}
