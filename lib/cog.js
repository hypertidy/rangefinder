// Layer 3: pixels. A windowed COG reader that warps into an OutputGrid.
//
// Given an href and the grid, this
//   1. maps a coarse lattice of grid pixel centres into the file's CRS,
//   2. takes the pixel window those points cover (clipped to the file),
//   3. picks the coarsest overview that is still at least as fine as the
//      grid, and reads just that window at that level (HTTP range requests),
//   4. resamples nearest-neighbour onto the grid, interpolating source
//      coordinates bilinearly inside each lattice cell.
// It works the same for a 720 px wildtiles tile and a 10980 px Sentinel-2
// scene; a file that does not overlap the grid costs only its header.
//
// geotiff.js is loaded as a global (GeoTIFF) by the page.

import { ensureCrs } from "./geo.js";

var LATTICE = 16;           // grid pixels between exact reprojections
var tiffCache = new Map();  // href -> Promise<GeoTIFF>, small LRU
var TIFF_CACHE_MAX = 96;

function geotiff() {
  var g = globalThis.GeoTIFF;
  if (!g) throw new Error("geotiff.js is not loaded");
  return g;
}

export function openCog(href) {
  var hit = tiffCache.get(href);
  if (hit) { tiffCache.delete(href); tiffCache.set(href, hit); return hit; }
  var p = geotiff().fromUrl(href, { allowFullFile: false });
  p.catch(function () { tiffCache.delete(href); });
  tiffCache.set(href, p);
  if (tiffCache.size > TIFF_CACHE_MAX) tiffCache.delete(tiffCache.keys().next().value);
  return p;
}

// EPSG code from GeoKeys, when the catalog did not say.
function crsFromKeys(image) {
  var k = image.getGeoKeys() || {};
  if (k.ProjectedCSTypeGeoKey && k.ProjectedCSTypeGeoKey !== 32767) {
    return "EPSG:" + k.ProjectedCSTypeGeoKey;
  }
  if (k.GeographicTypeGeoKey && k.GeographicTypeGeoKey !== 32767) {
    return "EPSG:" + k.GeographicTypeGeoKey;
  }
  throw new Error("no EPSG code in GeoTIFF keys; pass opts.crs");
}

// Full-resolution image plus its overviews (mask IFDs skipped).
async function levels(tiff) {
  var n = await tiff.getImageCount();
  var out = [];
  for (var i = 0; i < n; i++) {
    var im = await tiff.getImage(i);
    var sub = im.fileDirectory.NewSubfileType || 0;
    if (i > 0 && (sub & 4)) continue;
    out.push(im);
  }
  return out;
}

// Source pixel coordinates (full resolution, fractional) for the lattice.
function lattice(grid, toSrc, origin, res) {
  var W = grid.width, H = grid.height;
  var xs = [], ys = [];
  for (var px = 0; ; px += LATTICE) { xs.push(Math.min(px, W - 1)); if (px >= W - 1) break; }
  for (var py = 0; ; py += LATTICE) { ys.push(Math.min(py, H - 1)); if (py >= H - 1) break; }
  var dx = (grid.bbox[2] - grid.bbox[0]) / W, dy = (grid.bbox[3] - grid.bbox[1]) / H;
  var nx = xs.length, ny = ys.length;
  var col = new Float64Array(nx * ny), row = new Float64Array(nx * ny);
  for (var j = 0; j < ny; j++) {
    for (var i = 0; i < nx; i++) {
      var X = grid.bbox[0] + (xs[i] + 0.5) * dx;
      var Y = grid.bbox[3] - (ys[j] + 0.5) * dy;
      var s = toSrc.forward([X, Y]);
      var k = j * nx + i;
      col[k] = (s[0] - origin[0]) / res[0];
      row[k] = (s[1] - origin[1]) / res[1];
    }
  }
  return { xs: xs, ys: ys, col: col, row: row };
}

// Read one asset warped onto the grid.
//   opts.crs     CRS of the file if known (else read from GeoKeys)
//   opts.nodata  nodata value if the file does not declare one (default 0)
//   opts.signal  AbortSignal
// Resolves to null when the file does not overlap the grid, otherwise
//   { bands: [TypedArray (width*height)], valid: Uint8Array, level, window,
//     nodata, bytesHint }
export async function readWarped(href, grid, opts) {
  opts = opts || {};
  var tiff = await openCog(href);
  var lv = await levels(tiff);
  var base = lv[0];
  var W0 = base.getWidth(), H0 = base.getHeight();
  var origin = base.getOrigin(), res = base.getResolution();
  var crs = ensureCrs(opts.crs || crsFromKeys(base));
  var toSrc = globalThis.proj4(ensureCrs(grid.crs), crs);
  var lat = lattice(grid, toSrc, origin, res);

  // window covered by the grid, in full-res pixels
  var c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (var k = 0; k < lat.col.length; k++) {
    var c = lat.col[k], r = lat.row[k];
    if (!isFinite(c) || !isFinite(r)) continue;
    if (c < c0) c0 = c; if (c > c1) c1 = c;
    if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  c0 = Math.max(0, Math.floor(c0)); r0 = Math.max(0, Math.floor(r0));
  c1 = Math.min(W0, Math.ceil(c1) + 1); r1 = Math.min(H0, Math.ceil(r1) + 1);
  if (!(c1 > c0 && r1 > r0)) return null;

  // full-res source pixels per grid pixel, from the lattice spacing
  var nx = lat.xs.length, ny = lat.ys.length;
  var mi = Math.floor((nx - 1) / 2), mj = Math.floor((ny - 1) / 2);
  var scale = 1;
  if (nx > 1) {
    var a = mj * nx + mi, b = a + 1;
    scale = Math.hypot(lat.col[b] - lat.col[a], lat.row[b] - lat.row[a]) /
            (lat.xs[mi + 1] - lat.xs[mi]);
  }
  // coarsest level whose pixels are no larger than a grid pixel
  var im = base, fx = 1, fy = 1;
  for (var i = 1; i < lv.length; i++) {
    var sx = W0 / lv[i].getWidth(), sy = H0 / lv[i].getHeight();
    if (sx <= scale * 1.05) { im = lv[i]; fx = sx; fy = sy; }
  }
  var Wl = im.getWidth(), Hl = im.getHeight();
  var wx0 = Math.max(0, Math.floor(c0 / fx)), wy0 = Math.max(0, Math.floor(r0 / fy));
  var wx1 = Math.min(Wl, Math.ceil(c1 / fx)), wy1 = Math.min(Hl, Math.ceil(r1 / fy));
  if (!(wx1 > wx0 && wy1 > wy0)) return null;
  var ww = wx1 - wx0, wh = wy1 - wy0;

  var src = await im.readRasters({ window: [wx0, wy0, wx1, wy1], interleave: false,
                                   signal: opts.signal });
  var nb = src.length;
  var nd = base.getGDALNoData();
  if (nd === null || nd === undefined) nd = opts.nodata !== undefined ? opts.nodata : 0;

  var W = grid.width, H = grid.height, npx = W * H;
  var Ctor = src[0].constructor;
  var bands = [];
  for (var bi = 0; bi < nb; bi++) {
    var arr = new Ctor(npx);
    if (nd !== 0) arr.fill(nd);
    bands.push(arr);
  }
  var valid = new Uint8Array(npx);
  var any = false;

  // walk lattice cells, interpolating source coords inside each
  for (var j = 0; j < ny - 1 || (ny === 1 && j === 0); j++) {
    var ya = lat.ys[j], yb = ny > 1 ? lat.ys[j + 1] : ya;
    var yEnd = (j + 1 >= ny - 1) ? yb : yb - 1;
    for (var i2 = 0; i2 < nx - 1 || (nx === 1 && i2 === 0); i2++) {
      var xa = lat.xs[i2], xb = nx > 1 ? lat.xs[i2 + 1] : xa;
      var xEnd = (i2 + 1 >= nx - 1) ? xb : xb - 1;
      var k00 = j * nx + i2, k10 = nx > 1 ? k00 + 1 : k00;
      var k01 = ny > 1 ? k00 + nx : k00, k11 = ny > 1 ? k10 + nx : k10;
      var c00 = lat.col[k00], c10 = lat.col[k10], c01 = lat.col[k01], c11 = lat.col[k11];
      var q00 = lat.row[k00], q10 = lat.row[k10], q01 = lat.row[k01], q11 = lat.row[k11];
      if (!(isFinite(c00) && isFinite(c10) && isFinite(c01) && isFinite(c11))) continue;
      var spanx = xb - xa || 1, spany = yb - ya || 1;
      for (var y = ya; y <= yEnd; y++) {
        var ty = (y - ya) / spany;
        var cl = c00 + (c01 - c00) * ty, cr = c10 + (c11 - c10) * ty;
        var ql = q00 + (q01 - q00) * ty, qr = q10 + (q11 - q10) * ty;
        var rowOff = y * W;
        for (var x = xa; x <= xEnd; x++) {
          var tx = (x - xa) / spanx;
          // lattice coords are edge-based (origin = top-left corner)
          var sc = Math.floor((cl + (cr - cl) * tx) / fx) - wx0;
          var sr = Math.floor((ql + (qr - ql) * tx) / fy) - wy0;
          if (sc < 0 || sr < 0 || sc >= ww || sr >= wh) continue;
          var si = sr * ww + sc, o = rowOff + x, ok = false;
          for (var b2 = 0; b2 < nb; b2++) {
            var v = src[b2][si];
            bands[b2][o] = v;
            if (v !== nd && v === v) ok = true;
          }
          if (ok) { valid[o] = 1; any = true; }
        }
      }
    }
  }
  if (!any) return null;
  return { bands: bands, valid: valid, nodata: nd,
           level: lv.indexOf(im), window: [wx0, wy0, wx1, wy1] };
}
