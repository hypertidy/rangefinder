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
