// Curvilinear grids: cells located by 2-D longitude / latitude arrays (ROMS,
// NEMO, MOM tripolar, rotated-pole models) instead of an affine transform.
//
// Each cell is drawn as its footprint, a quadrilateral in lon/lat: the CF
// cell bounds when the coordinates name them, otherwise corners half way
// between neighbouring centres (on the sphere, so the poles and the
// antimeridian need no special cases). The footprints are projected to the
// output grid's CRS and every output pixel takes the one cell whose
// footprint contains the pixel centre. Nothing is interpolated and there is
// no lattice: the cell under each pixel is found exactly.
//
// No imports: proj4 comes from the page (globalThis.proj4), so this file also
// runs under node for the tests.

var D2R = Math.PI / 180, R2D = 180 / Math.PI;

function normLon(x) { return ((x + 180) % 360 + 360) % 360 - 180; }

function toLonLat(x, y, z) {
  var r = Math.sqrt(x * x + y * y + z * z);
  if (!(r > 0)) return [NaN, NaN];
  return [Math.atan2(y, x) * R2D, Math.asin(Math.max(-1, Math.min(1, z / r))) * R2D];
}

// ROMS psi points are the corners between rho cells, (H-1) x (W-1): the
// (H+1) x (W+1) corners of the rho cells, the outer ring extrapolated.
export function psiCorners(plon, plat, W, H) {
  var CW = W + 1, CH = H + 1, n = CW * CH;
  var x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  var j, i, k;
  for (j = 1; j < H; j++) {
    for (i = 1; i < W; i++) {
      var q = (j - 1) * (W - 1) + (i - 1), a = plon[q] * D2R, b = plat[q] * D2R, cb = Math.cos(b);
      k = j * CW + i;
      x[k] = cb * Math.cos(a); y[k] = cb * Math.sin(a); z[k] = Math.sin(b);
    }
  }
  function ext(k0, k1, k2) { x[k0] = 2 * x[k1] - x[k2]; y[k0] = 2 * y[k1] - y[k2]; z[k0] = 2 * z[k1] - z[k2]; }
  for (j = 1; j < H; j++) { ext(j * CW, j * CW + 1, j * CW + 2); ext(j * CW + W, j * CW + W - 1, j * CW + W - 2); }
  for (i = 0; i < CW; i++) { ext(i, CW + i, 2 * CW + i); ext(H * CW + i, (H - 1) * CW + i, (H - 2) * CW + i); }
  var clon = new Float64Array(n), clat = new Float64Array(n);
  for (k = 0; k < n; k++) { var ll = toLonLat(x[k], y[k], z[k]); clon[k] = ll[0]; clat[k] = ll[1]; }
  return { lon: clon, lat: clat };
}

// Corners half way between centres: lon/lat of the (H+1) x (W+1) corner
// points, from H x W centres (row-major). Done with unit vectors: the mean of
// the four surrounding centres, the outer ring extrapolated one cell.
export function centreCorners(lon, lat, W, H) {
  var PW = W + 2, PH = H + 2;
  var px = new Float64Array(PW * PH), py = new Float64Array(PW * PH), pz = new Float64Array(PW * PH);
  var j, i, k, q;
  for (j = 0; j < H; j++) {
    for (i = 0; i < W; i++) {
      var a = lon[j * W + i] * D2R, b = lat[j * W + i] * D2R, cb = Math.cos(b);
      k = (j + 1) * PW + i + 1;
      px[k] = cb * Math.cos(a); py[k] = cb * Math.sin(a); pz[k] = Math.sin(b);
    }
  }
  function ext(k0, k1, k2) {   // k0 = 2 * k1 - k2
    px[k0] = 2 * px[k1] - px[k2]; py[k0] = 2 * py[k1] - py[k2]; pz[k0] = 2 * pz[k1] - pz[k2];
  }
  for (j = 1; j <= H; j++) {
    ext(j * PW, j * PW + 1, j * PW + 2);
    ext(j * PW + W + 1, j * PW + W, j * PW + W - 1);
  }
  for (i = 0; i < PW; i++) {
    ext(i, PW + i, 2 * PW + i);
    ext((H + 1) * PW + i, H * PW + i, (H - 1) * PW + i);
  }
  var CW = W + 1, CH = H + 1;
  var clon = new Float64Array(CW * CH), clat = new Float64Array(CW * CH);
  for (j = 0; j < CH; j++) {
    for (i = 0; i < CW; i++) {
      var k00 = j * PW + i, k10 = k00 + 1, k01 = k00 + PW, k11 = k01 + 1;
      var x = px[k00] + px[k10] + px[k01] + px[k11];
      var y = py[k00] + py[k10] + py[k01] + py[k11];
      var z = pz[k00] + pz[k10] + pz[k01] + pz[k11];
      var r = Math.sqrt(x * x + y * y + z * z);
      q = j * CW + i;
      if (!(r > 0)) { clon[q] = NaN; clat[q] = NaN; continue; }
      clon[q] = Math.atan2(y, x) * R2D;
      clat[q] = Math.asin(Math.max(-1, Math.min(1, z / r))) * R2D;
    }
  }
  return { lon: clon, lat: clat };
}

// The footprints of a W x H curvilinear grid, as 4 lon/lat corners per cell
// (Float64Array, 4 per cell, row-major cells).
//   lon, lat    centres (H x W)
//   corners     optional: { bounds: [blon, blat] } CF bounds (H x W x 4),
//               used as they are, or { psi: [plon, plat] } ROMS psi points
export function footprints(lon, lat, W, H, corners) {
  var n = W * H, flon = new Float64Array(4 * n), flat = new Float64Array(4 * n);
  corners = corners || {};
  var bd = corners.bounds;
  if (bd && bd[0].length === 4 * n && bd[1].length === 4 * n) {
    for (var k = 0; k < 4 * n; k++) { flon[k] = bd[0][k]; flat[k] = bd[1][k]; }
    return { W: W, H: H, lon: flon, lat: flat, from: "bounds" };
  }
  var ps = corners.psi;
  var usePsi = ps && ps[0].length === (W - 1) * (H - 1) && W > 2 && H > 2;
  var c = usePsi ? psiCorners(ps[0], ps[1], W, H) : centreCorners(lon, lat, W, H), CW = W + 1;
  for (var j = 0; j < H; j++) {
    for (var i = 0; i < W; i++) {
      var o = 4 * (j * W + i), a = j * CW + i;
      var idx = [a, a + 1, a + CW + 1, a + CW];   // around the cell
      for (var m = 0; m < 4; m++) { flon[o + m] = c.lon[idx[m]]; flat[o + m] = c.lat[idx[m]]; }
    }
  }
  return { W: W, H: H, lon: flon, lat: flat, from: usePsi ? "psi" : "centres" };
}

// How far apart the same place is drawn when a CRS repeats round the globe
// (longlat: 360 degrees; Mercator: the equator's length), or 0.
export function crsPeriod(crs) {
  var d = globalThis.proj4.defs(crs);
  if (!d) return 0;
  if (/longlat|lonlat/.test(d.projName || "")) return 360;
  if (d.projName === "merc" && !d.lat_ts) return 2 * Math.PI * (d.a || 6378137) * (d.k0 || d.k || 1);
  return 0;
}

// Footprints projected to a CRS: { W, H, x, y (4 per cell), period }.
// A cell's corners are first put on the same side of the antimeridian as
// its first corner, so a cell that crosses it stays one small quad.
export function projectFootprints(fp, crs) {
  var tr = globalThis.proj4("EPSG:4326", crs);
  var n = fp.lon.length, x = new Float64Array(n), y = new Float64Array(n);
  for (var c = 0; c < n; c += 4) {
    var l0 = normLon(fp.lon[c]);
    for (var m = 0; m < 4; m++) {
      var lo = fp.lon[c + m], la = fp.lat[c + m];
      if (!isFinite(lo) || !isFinite(la)) { x[c + m] = NaN; y[c + m] = NaN; continue; }
      lo = l0 + normLon(lo - l0);
      la = Math.max(-90, Math.min(90, la));
      var p;
      try { p = tr.forward([lo, la]); } catch (e) { p = [NaN, NaN]; }
      x[c + m] = p[0]; y[c + m] = p[1];
    }
  }
  return { W: fp.W, H: fp.H, x: x, y: y, period: crsPeriod(crs) };
}

function cross(ax, ay, bx, by, px, py) { return (bx - ax) * (py - ay) - (by - ay) * (px - ax); }
function inTri(ax, ay, bx, by, cx, cy, px, py) {
  var d1 = cross(ax, ay, bx, by, px, py), d2 = cross(bx, by, cx, cy, px, py), d3 = cross(cx, cy, ax, ay, px, py);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// The cell under each pixel centre of the grid.
// -> { cell: Int32Array (grid size; row * W + col of the source, -1 for
//      none), window: [c0, r0, c1, r1] (exclusive ends) | null, skipped }
//   opts.window  only look at the cells in this window
//   opts.keep    function (cell) -> false to leave a cell out
// Footprints can overlap: ROMS grids give land cells made-up coordinates
// that may lie over water, and CBOFS has water over water near the bay
// mouth. The reader therefore draws twice: once for the window, then again
// over the window with keep() leaving out the cells that have no data, so
// a cell with data always wins (the last drawn of those that remain).
// skipped counts footprints dropped as projection artefacts: in a CRS that
// does not repeat, a cell torn across the projection's edge comes out
// enormous, and one more than 100 times the median size is left out.
export function rasterCells(pf, grid, opts) {
  opts = opts || {};
  var GW = grid.width, GH = grid.height, b = grid.bbox;
  var dx = (b[2] - b[0]) / GW, dy = (b[3] - b[1]) / GH;
  var per = pf.period ? pf.period / Math.abs(dx) : 0;
  var cell = new Int32Array(GW * GH).fill(-1);
  var n = pf.W * pf.H;
  var qx = new Float64Array(4), qy = new Float64Array(4);
  var limit = Infinity;
  if (!per) {
    var sizes = [], step = Math.max(1, Math.floor(n / 20000));
    for (var s = 0; s < n; s += step) {
      var o = 4 * s, d = Math.hypot(pf.x[o + 2] - pf.x[o], pf.y[o + 2] - pf.y[o]);
      if (isFinite(d)) sizes.push(d);
    }
    sizes.sort(function (p, q) { return p - q; });
    if (sizes.length) limit = Math.max(100 * sizes[sizes.length >> 1], 8 * Math.max(Math.abs(dx), Math.abs(dy)));
  }
  var c0 = Infinity, r0 = Infinity, c1 = -Infinity, r1 = -Infinity, skipped = 0;
  var win = opts.window || [0, 0, pf.W, pf.H], keep = opts.keep;
  for (var c = 0; c < n; c++) {
    var ci0 = c % pf.W;
    if (ci0 < win[0] || ci0 >= win[2]) continue;
    if (c < win[1] * pf.W) { c = win[1] * pf.W - 1; continue; }
    if (c >= win[3] * pf.W) break;
    if (keep && !keep(c)) continue;
    var o4 = 4 * c, ok = true;
    for (var m = 0; m < 4; m++) {
      qx[m] = (pf.x[o4 + m] - b[0]) / dx;
      qy[m] = (b[3] - pf.y[o4 + m]) / dy;
      if (!isFinite(qx[m]) || !isFinite(qy[m])) { ok = false; break; }
    }
    if (!ok) continue;
    if (per) {
      for (m = 1; m < 4; m++) qx[m] -= per * Math.round((qx[m] - qx[0]) / per);
    } else if (Math.hypot(pf.x[o4 + 2] - pf.x[o4], pf.y[o4 + 2] - pf.y[o4]) > limit ||
               Math.hypot(pf.x[o4 + 3] - pf.x[o4 + 1], pf.y[o4 + 3] - pf.y[o4 + 1]) > limit) {
      skipped++; continue;
    }
    var xmin = Math.min(qx[0], qx[1], qx[2], qx[3]), xmax = Math.max(qx[0], qx[1], qx[2], qx[3]);
    var ymin = Math.min(qy[0], qy[1], qy[2], qy[3]), ymax = Math.max(qy[0], qy[1], qy[2], qy[3]);
    var Y0 = Math.max(0, Math.ceil(ymin - 0.5)), Y1 = Math.min(GH - 1, Math.floor(ymax - 0.5));
    if (Y1 < Y0) continue;
    var shifts = per ? [0, -per, per] : [0];
    var hit = false;
    for (var si = 0; si < shifts.length; si++) {
      var sh = shifts[si];
      var X0 = Math.max(0, Math.ceil(xmin + sh - 0.5)), X1 = Math.min(GW - 1, Math.floor(xmax + sh - 0.5));
      if (X1 < X0) continue;
      for (var Y = Y0; Y <= Y1; Y++) {
        var py = Y + 0.5, row = Y * GW;
        for (var X = X0; X <= X1; X++) {
          var px = X + 0.5 - sh;
          if (inTri(qx[0], qy[0], qx[1], qy[1], qx[2], qy[2], px, py) ||
              inTri(qx[0], qy[0], qx[2], qy[2], qx[3], qy[3], px, py)) {
            cell[row + X] = c; hit = true;
          }
        }
      }
    }
    if (hit) {
      var ci = c % pf.W, ri = (c - ci) / pf.W;
      if (ci < c0) c0 = ci; if (ci > c1) c1 = ci;
      if (ri < r0) r0 = ri; if (ri > r1) r1 = ri;
    }
  }
  return { cell: cell, window: c1 >= c0 ? [c0, r0, c1 + 1, r1 + 1] : null, skipped: skipped };
}

// lon/lat bbox of centres, [w, s, e, n]; a grid that wraps the globe (or
// crosses the antimeridian) gets the full longitude range.
export function centresBbox(lon, lat) {
  var w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  var w2 = Infinity, e2 = -Infinity;   // in 0..360, for a grid across the antimeridian
  for (var k = 0; k < lon.length; k++) {
    var lo = lon[k], la = lat[k];
    if (!isFinite(lo) || !isFinite(la)) continue;
    lo = normLon(lo);
    var l2 = lo < 0 ? lo + 360 : lo;
    if (lo < w) w = lo; if (lo > e) e = lo;
    if (l2 < w2) w2 = l2; if (l2 > e2) e2 = l2;
    if (la < s) s = la; if (la > n) n = la;
  }
  if (e2 - w2 < e - w - 1e-9 && e2 - w2 < 180) {
    // narrower when seen from 0..360: it crosses the antimeridian; Leaflet
    // boxes cannot, so take the whole longitude range
    return [-180, s, 180, n];
  }
  return [w, s, e, n];
}

// Typical spacing between neighbouring centres, in degrees of arc, as
// [along a row, along a column] (medians of a sample).
export function centreSpacing(lon, lat, W, H) {
  function arc(k1, k2) {
    var a1 = lat[k1] * D2R, a2 = lat[k2] * D2R, dl = (lon[k2] - lon[k1]) * D2R;
    var c = Math.sin(a1) * Math.sin(a2) + Math.cos(a1) * Math.cos(a2) * Math.cos(dl);
    return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
  }
  var xs = [], ys = [], step = Math.max(1, Math.floor(W * H / 5000));
  for (var k = 0; k < W * H; k += step) {
    var i = k % W, j = (k - i) / W;
    if (i + 1 < W) { var dx = arc(k, k + 1); if (isFinite(dx)) xs.push(dx); }
    if (j + 1 < H) { var dy = arc(k, k + W); if (isFinite(dy)) ys.push(dy); }
  }
  function med(v) { v.sort(function (p, q) { return p - q; }); return v.length ? v[v.length >> 1] : NaN; }
  return [med(xs), med(ys)];
}
