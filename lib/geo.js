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

// CRSs worth knowing without a lookup (table and zone families from
// ortho-cog-viewer's crs.ts, which checks them against PROJ's EPSG
// database). proj4 already knows 4326 and 3857. Datum shifts are the
// identity for the GRS80 datums (GDA94, GDA2020, NAD83, ETRS89): a metre or
// two, well inside a pixel here.
var GRS80 = "+ellps=GRS80 +towgs84=0,0,0,0,0,0,0";
export var KNOWN_CRS = {
  // geographic
  "EPSG:4269": "+proj=longlat " + GRS80 + " +no_defs",
  "EPSG:4283": "+proj=longlat " + GRS80 + " +no_defs",
  "EPSG:7844": "+proj=longlat " + GRS80 + " +no_defs",
  "EPSG:3395": "+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  // polar
  "EPSG:3031": "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:3995": "+proj=stere +lat_0=90 +lat_ts=71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:9354": "+proj=stere +lat_0=-90 +lat_ts=-65 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:3032": "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=70 +k=1 +x_0=6000000 +y_0=6000000 +datum=WGS84 +units=m +no_defs",
  "EPSG:3033": "+proj=lcc +lat_0=-50 +lon_0=70 +lat_1=-68.5 +lat_2=-74.5 +x_0=6000000 +y_0=6000000 +datum=WGS84 +units=m +no_defs",
  "EPSG:3413": "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:3976": "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:3411": "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs",
  "EPSG:3412": "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +k=1 +x_0=0 +y_0=0 +a=6378273 +b=6356889.449 +units=m +no_defs",
  "EPSG:5041": "+proj=stere +lat_0=90 +lat_ts=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs",
  "EPSG:5042": "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs",
  "EPSG:32661": "+proj=stere +lat_0=90 +lat_ts=90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs",
  "EPSG:32761": "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +k=0.994 +x_0=2000000 +y_0=2000000 +datum=WGS84 +units=m +no_defs",
  // EASE-Grid 2.0
  "EPSG:6931": "+proj=laea +lat_0=90 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:6932": "+proj=laea +lat_0=-90 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:6933": "+proj=cea +lat_ts=30 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  // Australia
  "EPSG:3577": "+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 " + GRS80 + " +units=m +no_defs",
  "EPSG:9473": "+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 " + GRS80 + " +units=m +no_defs",
  "EPSG:3112": "+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 " + GRS80 + " +units=m +no_defs",
  "EPSG:7845": "+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 " + GRS80 + " +units=m +no_defs",
  "EPSG:7899": "+proj=lcc +lat_0=-37 +lon_0=145 +lat_1=-36 +lat_2=-38 +x_0=2500000 +y_0=2500000 " + GRS80 + " +units=m +no_defs",
  // elsewhere
  // WGS 84 / PDC Mercator, Digital Earth Pacific's grid (spans the antimeridian)
  "EPSG:3832": "+proj=merc +lon_0=150 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs",
  "EPSG:2193": "+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 " + GRS80 + " +units=m +no_defs",
  "EPSG:27700": "+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs",
  "EPSG:3035": "+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 " + GRS80 + " +units=m +no_defs"
};

// Families where the EPSG code is a base plus the UTM zone.
var ZONE_FAMILIES = [
  [32601, 32660, 32600, false, "+datum=WGS84"],      // WGS 84 / UTM north
  [32701, 32760, 32700, true, "+datum=WGS84"],       // WGS 84 / UTM south
  [28348, 28358, 28300, true, GRS80],                // GDA94 / MGA
  [7846, 7859, 7800, true, GRS80],                   // GDA2020 / MGA
  [26901, 26923, 26900, false, GRS80],               // NAD83 / UTM north
  [25828, 25838, 25800, false, GRS80]                // ETRS89 / UTM north
];
function zoneDef(code) {
  var m = /^EPSG:(\d+)$/.exec(code);
  if (!m) return null;
  var n = +m[1];
  for (var i = 0; i < ZONE_FAMILIES.length; i++) {
    var f = ZONE_FAMILIES[i];
    if (n >= f[0] && n <= f[1]) {
      return "+proj=utm +zone=" + (n - f[2]) + (f[3] ? " +south" : "") + " " + f[4] + " +units=m +no_defs";
    }
  }
  return null;
}

// Normalise the many spellings of a CRS to "EPSG:n" where possible:
// "urn:ogc:def:crs:EPSG::3031", "http://www.opengis.net/def/crs/EPSG/0/3031",
// "EPSG:3031", 3031, OGC CRS84 (lon/lat 4326).
export function crsCode(c) {
  if (c === null || c === undefined) return null;
  var s = String(c).trim();
  if (/^\d+$/.test(s)) return "EPSG:" + s;
  if (/CRS:?84$/i.test(s)) return "EPSG:4326";
  var m = /EPSG(?:::|:|\/\d+\/|\/)(\d+)$/i.exec(s);
  if (m) return "EPSG:" + m[1];
  m = /^EPSG:(\d+)$/i.exec(s);
  return m ? "EPSG:" + m[1] : s;
}

// "EPSG:n" from a WKT string's last AUTHORITY (or ID) clause, else null.
export function wktEpsg(wkt) {
  var re = /(?:AUTHORITY|ID)\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi, m, last = null;
  while ((m = re.exec(wkt || ""))) last = m[1];
  return last ? "EPSG:" + last : null;
}

// Make sure proj4 knows a CRS. KNOWN_CRS and the UTM-style zone families
// are registered on demand, and a "+proj=..." string is registered under
// itself; anything else must be registered already (resolveCrs can fetch
// it first).
// How each CRS definition was obtained, for the page to show: a
// definition from a table or arithmetic is a claim about what the code
// means, and the user should be able to see which claim was made.
var how = new Map();
export function crsProvenance(code) {
  code = crsCode(code);
  if (how.has(code)) return how.get(code);
  return proj().defs(code) ? "proj4's own definition" : "unknown";
}

export function ensureCrs(code) {
  var p = proj();
  code = crsCode(code);
  if (p.defs(code)) return code;
  var def = KNOWN_CRS[code], from = "rangefinder's built-in table";
  if (!def && (def = zoneDef(code))) from = "UTM zone arithmetic from the code";
  if (!def && /^\s*\+proj=/.test(code)) { def = code; from = "a proj string as given"; }
  if (def) { p.defs(code, def); how.set(code, from); return code; }
  throw new Error("unknown CRS " + code + " (not built in, and not looked up yet)");
}

// ensureCrs, falling back to spatialreference.org (PROJ's own database,
// published as static files) for an EPSG code nothing built in covers. Resolves to the code proj4
// now knows, or rejects with the reason.
var looked = new Map();
export function resolveCrs(code) {
  try { return Promise.resolve(ensureCrs(code)); } catch (e) { /* look it up */ }
  code = crsCode(code);
  var m = /^EPSG:(\d+)$/.exec(code);
  if (!m) return Promise.reject(new Error("unknown CRS " + code));
  if (!looked.has(code)) {
    var p = (async function () {
      var base = "https://spatialreference.org/ref/epsg/" + m[1] + "/";
      var forms = [base + "proj4.txt", base + "ogcwkt.txt"];
      for (var i = 0; i < forms.length; i++) {
        try {
          var r = await fetch(forms[i]);
          if (!r.ok) continue;
          var t = (await r.text()).trim();
          if (!t || /<html/i.test(t)) continue;
          proj().defs(code, t);
          proj()(code, "EPSG:4326");
          how.set(code, "looked up on spatialreference.org");
          return code;
        } catch (e) { /* the next form, then give up */ }
      }
      throw new Error("unknown CRS " + code + " (not built in, and spatialreference.org did not answer)");
    })();
    p.catch(function () { looked.delete(code); });
    looked.set(code, p);
  }
  return looked.get(code);
}

// Register a CRS given as WKT (a VRT's SRS, a TIFF without EPSG keys) and
// return a code proj4 knows: its EPSG code when that is already known,
// else the WKT itself under a synthetic name.
var wktCount = 0;
export function crsFromWkt(wkt) {
  var e = wktEpsg(wkt);
  if (e) { try { return ensureCrs(e); } catch (err) { /* fall through to the WKT */ } }
  var name = "WKT:" + (++wktCount);
  proj().defs(name, wkt);
  how.set(name, "the WKT itself (no EPSG code in it)");
  return name;
}

// A page served over https cannot fetch http:// URLs (mixed content), and
// nearly every public server answers https as well, so ask for that;
// localhost and pages opened over http or from disk keep the URL as given.
// GitHub "raw" links on github.com redirect without CORS headers; the
// raw.githubusercontent.com address they redirect to has them (and ranges).
export function secureUrl(u) {
  u = String(u || "").trim();
  var gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/.exec(u);
  if (gh) u = "https://raw.githubusercontent.com/" + gh[1] + "/" + gh[2] + "/" + gh[3].replace(/\?raw=true$/, "");
  if (typeof location !== "undefined" && location.protocol === "https:" &&
      /^http:\/\//i.test(u) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(u)) {
    return "https://" + u.slice(7);
  }
  return u;
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
  var crs = ensureCrs(opts.crs || "EPSG:3857");
  var bb = opts.extent || transformBbox(lonlatBbox, "EPSG:4326", crs, 16);
  var w = bb[2] - bb[0], h = bb[3] - bb[1];
  var maxDim = opts.maxDim || 1536;
  var size = Math.max(opts.pixelSize || 0, Math.max(w, h) / maxDim);
  if (opts.minGroundRes) {   // no finer than the data, in ground metres
    var lat = (lonlatBbox[1] + lonlatBbox[3]) / 2 * Math.PI / 180;
    var perUnit = crs === "EPSG:3857" ? Math.cos(lat) : isGeographic(crs) ? 111320 * Math.cos(lat) : 1;
    size = Math.max(size, opts.minGroundRes / perUnit);
  }
  return { crs: crs, bbox: bb,
           width: Math.max(1, Math.round(w / size)),
           height: Math.max(1, Math.round(h / size)) };
}

export function isGeographic(crs) {
  var d = proj().defs(ensureCrs(crs));
  return !!d && (d.projName === "longlat" || d.projName === "lonlat" || /longlat|lonlat/.test(d.projName || ""));
}

// Lon/lat bounds of a box in any CRS. A box holding a pole reaches that
// pole and every longitude, which sampling its edges alone would miss.
export function lonLatBounds(extent, crs) {
  crs = ensureCrs(crs);
  if (crs === "EPSG:4326") return extent.slice();
  var b = transformBbox(extent, crs, "EPSG:4326", 32);
  var f = proj()("EPSG:4326", crs);
  [[0, -90], [0, 90]].forEach(function (pole) {
    var p = f.forward(pole);
    if (isFinite(p[0]) && isFinite(p[1]) && p[0] > extent[0] && p[0] < extent[2] &&
        p[1] > extent[1] && p[1] < extent[3]) {
      b = [-180, pole[1] < 0 ? -90 : b[1], 180, pole[1] > 0 ? 90 : b[3]];
    }
  });
  return [Math.max(-180, b[0]), Math.max(-90, b[1]), Math.min(180, b[2]), Math.min(90, b[3])];
}

export function gridLonLatBounds(grid) {
  return lonLatBounds(grid.bbox, grid.crs);
}

// Ground size of one grid pixel in metres at the grid centre (Mercator
// stretches by 1/cos(lat), so divide that back out; degrees are about
// 111 km times cos(lat) across).
export function gridGroundRes(grid) {
  var c = gridLonLatBounds(grid);
  var lat = (c[1] + c[3]) / 2 * Math.PI / 180;
  var px = (grid.bbox[2] - grid.bbox[0]) / grid.width;
  if (grid.crs === "EPSG:3857") return px * Math.cos(lat);
  if (isGeographic(grid.crs)) return px * 111320 * Math.cos(lat);
  return px;
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
