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

import { ensureCrs, transformBbox } from "./geo.js";

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

// --- the warp, shared with tiles.js ---------------------------------------------
//
// A source raster here is anything with an affine pixel grid: a COG level, or
// a block of map tiles pasted side by side. The grid is reprojected into the
// source CRS on a coarse lattice and interpolated inside each lattice cell.

// Source pixel coordinates (fractional, edge-based) for a lattice of grid
// pixel centres. origin = top-left corner, res = [xres, yres] (yres < 0 for
// north-up rasters).
export function gridLattice(grid, toSrc, origin, res) {
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

// Bounding window [c0, r0, c1, r1] of the lattice, clipped to W x H; null
// when it misses the raster.
export function latticeWindow(lat, W, H) {
  var c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity;
  for (var k = 0; k < lat.col.length; k++) {
    var c = lat.col[k], r = lat.row[k];
    if (!isFinite(c) || !isFinite(r)) continue;
    if (c < c0) c0 = c; if (c > c1) c1 = c;
    if (r < r0) r0 = r; if (r > r1) r1 = r;
  }
  c0 = Math.max(0, Math.floor(c0)); r0 = Math.max(0, Math.floor(r0));
  c1 = Math.min(W, Math.ceil(c1) + 1); r1 = Math.min(H, Math.ceil(r1) + 1);
  return (c1 > c0 && r1 > r0) ? [c0, r0, c1, r1] : null;
}

// Source pixels per grid pixel near the grid centre.
export function latticeScale(lat) {
  var nx = lat.xs.length, ny = lat.ys.length;
  var mi = Math.floor((nx - 1) / 2), mj = Math.floor((ny - 1) / 2);
  if (nx > 1) {
    var a = mj * nx + mi, b = a + 1;
    return Math.hypot(lat.col[b] - lat.col[a], lat.row[b] - lat.row[a]) /
           (lat.xs[mi + 1] - lat.xs[mi]);
  }
  if (ny > 1) {
    var a2 = mj * nx + mi, b2 = a2 + nx;
    return Math.hypot(lat.col[b2] - lat.col[a2], lat.row[b2] - lat.row[a2]) /
           (lat.ys[mj + 1] - lat.ys[mj]);
  }
  return 1;
}

// Nearest-neighbour resample of a source window onto the grid.
//   src     [TypedArray] bands of the window, ww x wh, row-major
//   wx0/wy0 window offset in the (possibly decimated) source level
//   fx/fy   lattice pixels per level pixel (overview decimation, 1 for tiles)
//   nd      nodata value (a pixel is valid when any band differs from it)
//   alpha   optional Uint8 array: valid only where alpha > 0 (map tiles)
// -> { bands: [TypedArray (grid size)], valid, any }
export function resampleWindow(lat, grid, src, ww, wh, wx0, wy0, fx, fy, nd, alpha) {
  var W = grid.width, H = grid.height, npx = W * H;
  var nb = src.length, nx = lat.xs.length, ny = lat.ys.length;
  var Ctor = src[0].constructor;
  var bands = [];
  for (var bi = 0; bi < nb; bi++) {
    var arr = new Ctor(npx);
    if (nd !== 0 && nd !== null && nd !== undefined) arr.fill(nd);
    bands.push(arr);
  }
  var valid = new Uint8Array(npx);
  var any = false;
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
          if (alpha && !alpha[si]) continue;
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
  return { bands: bands, valid: valid, any: any };
}

// --- COGs ------------------------------------------------------------------------

// Read one asset warped onto the grid.
//   opts.crs     CRS of the file if known (else read from GeoKeys)
//   opts.nodata  nodata value if the file does not declare one (default 0)
//   opts.signal  AbortSignal
// Resolves to null when the file does not overlap the grid, otherwise
//   { bands: [TypedArray (width*height)], valid: Uint8Array, level, window,
//     nodata }
export async function readWarped(href, grid, opts) {
  opts = opts || {};
  var tiff = await openCog(href);
  var lv = await levels(tiff);
  var base = lv[0];
  var W0 = base.getWidth(), H0 = base.getHeight();
  var origin = base.getOrigin(), res = base.getResolution();
  var crs = ensureCrs(opts.crs || crsFromKeys(base));
  var toSrc = globalThis.proj4(ensureCrs(grid.crs), crs);
  var lat = gridLattice(grid, toSrc, origin, res);

  // window covered by the grid, in full-res pixels
  var win = latticeWindow(lat, W0, H0);
  if (!win) return null;
  var scale = latticeScale(lat);
  // coarsest level whose pixels are no larger than a grid pixel
  var im = base, fx = 1, fy = 1;
  for (var i = 1; i < lv.length; i++) {
    var sx = W0 / lv[i].getWidth(), sy = H0 / lv[i].getHeight();
    if (sx <= scale * 1.05) { im = lv[i]; fx = sx; fy = sy; }
  }
  var Wl = im.getWidth(), Hl = im.getHeight();
  var wx0 = Math.max(0, Math.floor(win[0] / fx)), wy0 = Math.max(0, Math.floor(win[1] / fy));
  var wx1 = Math.min(Wl, Math.ceil(win[2] / fx)), wy1 = Math.min(Hl, Math.ceil(win[3] / fy));
  if (!(wx1 > wx0 && wy1 > wy0)) return null;

  var src = await im.readRasters({ window: [wx0, wy0, wx1, wy1], interleave: false,
                                   signal: opts.signal });
  var nd = base.getGDALNoData();
  if (nd === null || nd === undefined) nd = opts.nodata !== undefined && opts.nodata !== null ? opts.nodata : 0;
  var r = resampleWindow(lat, grid, Array.prototype.slice.call(src), wx1 - wx0, wy1 - wy0,
                         wx0, wy0, fx, fy, nd, null);
  if (!r.any) return null;
  return { bands: r.bands, valid: r.valid, nodata: nd,
           level: lv.indexOf(im), window: [wx0, wy0, wx1, wy1] };
}

// What a COG is, from its header alone: for the paste-a-COG source.
// -> { href, crs, bbox (lon/lat), extent (file CRS), width, height, bands,
//      dataType, nodata, levels, tileSize, date ("YYYY-MM-DD" or null), res }
export async function cogInfo(href) {
  var tiff = await openCog(href);
  var lv = await levels(tiff);
  var base = lv[0];
  var fd = base.fileDirectory;
  var crs = ensureCrs(crsFromKeys(base));
  var b = base.getBoundingBox();
  var fmt = (fd.SampleFormat && fd.SampleFormat[0]) || 1;
  var bits = (fd.BitsPerSample && fd.BitsPerSample[0]) || 8;
  var dataType = (fmt === 3 ? "Float" : fmt === 2 ? "Int" : "UInt") + bits;
  if (dataType === "UInt8") dataType = "Byte";
  var dt = fd.DateTime ? /^(\d{4}):(\d\d):(\d\d)/.exec(fd.DateTime) : null;
  return {
    href: href, crs: crs, extent: b, bbox: transformBbox(b, crs, "EPSG:4326"),
    width: base.getWidth(), height: base.getHeight(), bands: base.getSamplesPerPixel(),
    dataType: dataType, nodata: base.getGDALNoData(), levels: lv.length,
    tileSize: base.getTileWidth ? [base.getTileWidth(), base.getTileHeight()] : null,
    date: dt ? dt[1] + "-" + dt[2] + "-" + dt[3] : null,
    res: base.getResolution()
  };
}
