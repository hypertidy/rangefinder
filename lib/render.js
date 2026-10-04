// Layer 4: render. Mosaic, stretch and colour on the raw numbers.
//
// Drop-in replacement for lib/render.js: everything it exported is still
// here with the same behaviour by default; the additions are the L2A
// offset, joint (all-band) percentile limits, sqrt/log curves and helpers
// to work out the offset from scene metadata.
//
// Source-agnostic: everything here works on grid-sized typed arrays.
//
// Composite = {
//   grid,                    the OutputGrid the arrays are laid out on
//   kind: "rgb8" | "bands" | "single" | "classes",
//                            rgb8 = a baked 3-band Byte product (TCI, map tiles),
//                            bands = three numeric bands to be stretched,
//                            single = one numeric band through a colour ramp,
//                            classes = one band of class codes through a palette
//   channels: [R, G, B] or [V], TypedArray (grid.width * grid.height) each
//   classes: [{ value, color: "#rrggbb", label }]   (kind "classes", optional)
//   valid: Uint8Array,       1 where some scene contributed data
//   keys: [..]               asset keys behind each channel
// }
//
// RenderParams = {
//   stretch: [[lo, hi], [lo, hi], [lo, hi]],  per channel, in corrected units
//                                              (stored value + offset)
//   offset: [o, o, o] or o,                    added to stored values first
//                                              (default 0; see sceneOffset)
//   gamma: 1,                                  applied after the curve
//   transfer: "linear"                         key into TRANSFERS
//   ramp: "viridis"                            key into RAMPS (kind single)
//   hillshade: 0..1                            shade strength (kind single)
// }
//
// Order per pixel: v = stored + offset; x = clamp((v - lo) / (hi - lo));
// out = 255 * transfer(x) ^ (1 / gamma).

// Transfer curves applied to x in [0, 1] after the linear min/max map and
// before gamma. Each maps 0 -> 0 and 1 -> 1.
var LOG_K = 100;
export var TRANSFERS = {
  linear: function (x) { return x; },
  sqrt: function (x) { return Math.sqrt(x); },
  log: function (x) { return Math.log(1 + LOG_K * x) / Math.log(1 + LOG_K); }
};

// --- L2A offset ----------------------------------------------------------------
//
// From processing baseline 04.00 (25 Jan 2022) ESA adds +1000 to Sentinel-2
// L2A digital numbers (BOA_ADD_OFFSET = -1000), so reflectance =
// (DN - 1000) / 10000 and scenes either side of the baseline render
// differently under the same fixed limits unless it is subtracted.
//
// Whether a catalogue's COGs still carry it varies, and the metadata is not
// reliable: Earth Search v1 "sentinel-2-l2a" (sentinel-s2-l2a-cogs bucket)
// has the offset already removed from the pixels, yet its raster:bands say
// offset -0.1; "sentinel-2-c1-l2a" (e84-earth-search-sentinel-data) keeps
// ESA's DN with the +1000 and says the same. Checked 2026-10 by regressing
// B04 against TCI on S2C 55HBU 2025-02-18 in both: TCI = 0 at B04 ~ 0 in
// the legacy archive and ~ 950 in Collection 1. Planetary Computer and CDSE
// also serve ESA's DN as delivered.

export var L2A_OFFSET = -1000;

// hrefs from archives known to have removed the offset from the pixels
export var HARMONISED_ARCHIVES = [/\/sentinel-s2-l2a-cogs\//];

function baselineNumber(b) {
  if (b === null || b === undefined) return null;
  var n = parseFloat(String(b));
  return isFinite(n) ? n : null;
}

// DN offset for one scene: L2A_OFFSET when its pixels carry the +1000, 0
// when they do not, null when the metadata can't tell (e.g. wildtiles).
// A source can decide for itself by setting scene.meta.dnOffset.
export function sceneOffset(scene) {
  var m = (scene && scene.meta) || {};
  if (m.dnOffset !== undefined && m.dnOffset !== null) return m.dnOffset;
  var b = baselineNumber(m.processingBaseline);
  if (b === null) return null;
  if (b < 4) return 0;
  var hrefs = Object.keys(scene.assets || {}).map(function (k) {
    var a = scene.assets[k];
    return typeof a === "string" ? a : (a && (a.href || a.template)) || "";
  });
  var harmonised = hrefs.some(function (h) {
    return HARMONISED_ARCHIVES.some(function (re) { return re.test(h); });
  });
  return harmonised ? 0 : L2A_OFFSET;
}

// One offset for a set of scenes (typically the ones a load used).
// -> { offset, mixed, known } ; mixed when scenes disagree (the majority
// wins; a per-pixel correction would need it applied before the mosaic).
export function scenesOffset(scenes) {
  var counts = new Map(), known = 0;
  (scenes || []).forEach(function (s) {
    var o = sceneOffset(s);
    if (o === null) return;
    known++;
    counts.set(o, (counts.get(o) || 0) + 1);
  });
  var best = 0, n = -1;
  counts.forEach(function (c, o) { if (c > n) { best = o; n = c; } });
  return { offset: best, mixed: counts.size > 1, known: known };
}

function offsets3(o) {
  if (o === undefined || o === null) return [0, 0, 0];
  if (typeof o === "number") return [o, o, o];
  return [o[0] || 0, o[1] || 0, o[2] || 0];
}

// --- mosaic and statistics -----------------------------------------------------

// Mosaic warped layers onto one composite, first layer wins where valid.
// Each layer is { bands: [R, G, B] } or { bands: [RGB-band0, 1, 2] } plus
// valid. Pass layers in priority order (e.g. least cloudy first).
// Kinds "single" and "classes" mosaic one channel, the others three.
export function mosaic(grid, layers, kind, keys) {
  var npx = grid.width * grid.height;
  var first = layers[0];
  var Ctor = first.bands[0].constructor;
  var nc = (kind === "single" || kind === "classes") ? 1 : 3;
  var ch = [];
  for (var c = 0; c < nc; c++) ch.push(new Ctor(npx));
  var valid = new Uint8Array(npx);
  layers.forEach(function (L) {
    var v = L.valid, b = L.bands;
    for (var i = 0; i < npx; i++) {
      if (valid[i] || !v[i]) continue;
      for (var k = 0; k < nc; k++) ch[k][i] = b[k][i];
      valid[i] = 1;
    }
  });
  return { grid: grid, kind: kind, channels: ch, valid: valid, keys: keys || [] };
}

// Sorted sample (~250k values) of the stored values of one or more channels
// over valid pixels, skipping NaN, and 0 too unless allowZero (reflectance
// bands use 0 as nodata; a DEM or SST band has real zeros and negatives).
function sample(channels, valid, allowZero) {
  var n = channels[0].length;
  var stride = Math.max(1, Math.floor(n * channels.length / 250000));
  var buf = new Float64Array(Math.ceil(n / stride) * channels.length);
  var m = 0;
  channels.forEach(function (channel) {
    for (var i = 0; i < n; i += stride) {
      var v = channel[i];
      if (valid[i] && v === v && (allowZero || v > 0) && isFinite(v)) buf[m++] = v;
    }
  });
  return buf.subarray(0, m).sort();
}

function pick(s, lo, hi) {
  var m = s.length;
  if (m === 0) return [0, 1];
  var a = s[Math.floor((m - 1) * lo)], b = s[Math.ceil((m - 1) * hi)];
  if (b <= a) b = a + 1;
  return [a, b];
}

// Percentiles of one channel over valid pixels, in stored units.
export function percentiles(channel, valid, lo, hi, allowZero) {
  return pick(sample([channel], valid, allowZero), lo, hi);
}

// Percentile stretch across the whole composite, so adjacent scenes share
// one stretch and the mosaic is seamless.
//   lo, hi      fractions (default 0.02, 0.98)
//   opts.joint  one [lo, hi] from all three bands pooled (keeps the colour
//               balance of true colour), repeated for each channel
//   opts.offset added to the result, so limits come back in corrected units
export function autoStretch(comp, lo, hi, opts) {
  lo = lo === undefined ? 0.02 : lo;
  hi = hi === undefined ? 0.98 : hi;
  opts = opts || {};
  var off = offsets3(opts.offset);
  var z = comp.kind === "single";
  var st;
  if (opts.joint && comp.channels.length > 1) {
    var j = pick(sample(comp.channels, comp.valid), lo, hi);
    st = [j.slice(), j.slice(), j.slice()];
  } else {
    st = comp.channels.map(function (c) { return percentiles(c, comp.valid, lo, hi, z); });
  }
  return st.map(function (s, c) { return [s[0] + off[c], s[1] + off[c]]; });
}

// --- reading values back -------------------------------------------------------

// The composite's pixel under a point given in the grid's CRS, or null when
// the point is off the grid. -> { col, row, valid, values: [stored, ...] }
// Values are the stored numbers (no offset), one per channel.
export function valueAt(comp, x, y) {
  var g = comp.grid, b = g.bbox;
  var col = Math.floor((x - b[0]) / (b[2] - b[0]) * g.width);
  var row = Math.floor((b[3] - y) / (b[3] - b[1]) * g.height);
  if (!(col >= 0 && col < g.width && row >= 0 && row < g.height)) return null;
  var i = row * g.width + col;
  return { col: col, row: row, valid: !!comp.valid[i],
           values: comp.channels.map(function (c) { return c[i]; }) };
}

// A one-pixel grid on the same lattice as grid, at its pixel (col, row):
// reading it gives exactly that pixel of a full read (same CRS, same pixel
// size, so the same overview or tile level), at the cost of a point.
export function cellGrid(grid, col, row) {
  var b = grid.bbox, dx = (b[2] - b[0]) / grid.width, dy = (b[3] - b[1]) / grid.height;
  return { crs: grid.crs, width: 1, height: 1,
           bbox: [b[0] + col * dx, b[3] - (row + 1) * dy, b[0] + (col + 1) * dx, b[3] - row * dy] };
}

// Statistics of each channel over the valid pixels, finite values only:
// NaN and +/-Inf are counted apart and never enter min, max or mean.
// -> { pixels, valid, channels: [{ min, max, mean, finite, nonFinite }] }
// Kept on the composite, since its arrays never change once built.
export function compStats(comp) {
  if (comp.statsCache) return comp.statsCache;
  var valid = comp.valid, n = valid.length, nv = 0;
  for (var i = 0; i < n; i++) nv += valid[i];
  var chans = comp.channels.map(function (c) {
    var lo = Infinity, hi = -Infinity, sum = 0, fin = 0, bad = 0;
    for (var i = 0; i < n; i++) {
      if (!valid[i]) continue;
      var v = c[i];
      if (v - v !== 0) { bad++; continue; }   // NaN or infinite
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v; fin++;
    }
    return fin ? { min: lo, max: hi, mean: sum / fin, finite: fin, nonFinite: bad }
               : { min: null, max: null, mean: null, finite: 0, nonFinite: bad };
  });
  return (comp.statsCache = { pixels: n, valid: nv, channels: chans });
}

// --- colour --------------------------------------------------------------------

// Colour ramps for single-band composites: control points spread evenly
// from low to high, interpolated to 256 entries.
export var RAMPS = {
  greys:   ["#000000", "#ffffff"],
  viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"],
  magma:   ["#000004", "#3b0f70", "#8c2981", "#de4968", "#fe9f6d", "#fcfdbf"],
  terrain: ["#1a5e35", "#4f9a3c", "#a6c96a", "#e9dd9a", "#c2a179", "#8e6e5a", "#f5f2ee"],
  ice:     ["#04142e", "#16467a", "#3f80b5", "#8cc0dd", "#d8edf6", "#ffffff"],
  bathy:   ["#08104d", "#0f3d82", "#1f73b4", "#4fb0d9", "#a8e1ee", "#e8f8fb"],
  rdbu:    ["#67001f", "#d6604d", "#fddbc7", "#f7f7f7", "#d1e5f0", "#4393c3", "#053061"],
  spectral:["#9e0142", "#f46d43", "#fee08b", "#ffffbf", "#e6f598", "#66c2a5", "#5e4fa2"]
};

function hexRgb(h) {
  var n = parseInt(String(h).replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
var rampCache = {};
export function rampTable(name) {
  if (rampCache[name]) return rampCache[name];
  var stops = (RAMPS[name] || RAMPS.greys).map(hexRgb), n = stops.length - 1;
  var t = new Uint8ClampedArray(256 * 3);
  for (var i = 0; i < 256; i++) {
    var x = i / 255 * n, k = Math.min(n - 1, Math.floor(x)), f = x - k;
    for (var c = 0; c < 3; c++) t[i * 3 + c] = Math.round(stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f);
  }
  return (rampCache[name] = t);
}

// Palette for class codes: the source's colours where given, else a fixed
// spread of hues by code, so the same code keeps its colour across loads.
export function classPalette(classes) {
  var m = new Map();
  (classes || []).forEach(function (c) {
    if (c.color) m.set(+c.value, hexRgb(c.color));
  });
  return function (v) {
    var hit = m.get(v);
    if (hit) return hit;
    var h = (v * 137.508) % 360, s = 0.65, l = 0.55;   // golden-angle hues
    var a = s * Math.min(l, 1 - l);
    var f = function (n) {
      var k = (n + h / 30) % 12;
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    var rgb = [f(0), f(8), f(4)];
    m.set(v, rgb);
    return rgb;
  };
}

// Distinct values of a class composite (up to 64), most common first.
export function classCounts(comp) {
  var m = new Map(), ch = comp.channels[0], valid = comp.valid;
  var stride = Math.max(1, Math.floor(ch.length / 250000));
  for (var i = 0; i < ch.length; i += stride) {
    if (!valid[i]) continue;
    m.set(ch[i], (m.get(ch[i]) || 0) + 1);
  }
  return Array.from(m.entries()).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 64);
}

// Hillshade (sun from the north-west, 45 degrees up) of a single-band
// composite, 0..1 per pixel; z in the band's units, ground pixel size in
// metres. Edges and nodata get 1 (no shade).
export function hillshade(comp, groundRes, zFactor) {
  var W = comp.grid.width, H = comp.grid.height, v = comp.channels[0], ok = comp.valid;
  var out = new Float32Array(W * H).fill(1);
  var zf = (zFactor || 1) / (8 * (groundRes || 1));
  var az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  var cz = Math.cos(Math.PI / 2 - alt), sz = Math.sin(Math.PI / 2 - alt);
  for (var y = 1; y < H - 1; y++) {
    for (var x = 1; x < W - 1; x++) {
      var i = y * W + x;
      if (!ok[i] || !ok[i - W - 1] || !ok[i + W + 1] || !ok[i - W + 1] || !ok[i + W - 1]) continue;
      var a = v[i - W - 1], b = v[i - W], c = v[i - W + 1];
      var d = v[i - 1], f = v[i + 1];
      var g = v[i + W - 1], h = v[i + W], k = v[i + W + 1];
      var dzdx = ((c + 2 * f + k) - (a + 2 * d + g)) * zf;
      var dzdy = ((g + 2 * h + k) - (a + 2 * b + c)) * zf;
      var slope = Math.atan(Math.hypot(dzdx, dzdy));
      var aspect = Math.atan2(dzdy, -dzdx);
      var sh = cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(az - Math.PI / 2 - aspect);
      out[i] = sh < 0 ? 0 : sh;
    }
  }
  return out;
}

// Composite -> RGBA bytes (Uint8ClampedArray, width * height * 4).
export function renderRGBA(comp, params) {
  params = params || {};
  var npx = comp.grid.width * comp.grid.height;
  var out = new Uint8ClampedArray(npx * 4);
  var ch = comp.channels, valid = comp.valid;
  if (comp.kind === "classes") return renderClasses(comp, out);
  if (comp.kind === "single") return renderSingle(comp, params, out);
  if (comp.kind === "rgb8" && !params.stretch) {
    for (var i = 0; i < npx; i++) {
      var o = i * 4;
      out[o] = ch[0][i]; out[o + 1] = ch[1][i]; out[o + 2] = ch[2][i];
      out[o + 3] = valid[i] ? 255 : 0;
    }
    return out;
  }
  var st = params.stretch || [[0, 255], [0, 255], [0, 255]];
  var off = offsets3(params.offset);
  var inv = 1 / (params.gamma || 1);
  var tf = TRANSFERS[params.transfer || "linear"] || TRANSFERS.linear;
  // 4096-entry lookup over [lo, hi] keeps the per-pixel cost flat; curve
  // and gamma are the same for every channel, so one table serves all three
  var N = 4096;
  var lut = new Uint8ClampedArray(N + 1);
  for (var k = 0; k <= N; k++) lut[k] = Math.round(255 * Math.pow(tf(k / N), inv));
  // fold offset and limits into x = v * a + b per channel
  var A = [], B = [];
  for (var c = 0; c < 3; c++) {
    var lo = st[c][0], hi = st[c][1];
    var span = hi - lo || 1;
    A.push(N / span);
    B.push((off[c] - lo) * N / span);
  }
  for (var j = 0; j < npx; j++) {
    var p = j * 4;
    if (!valid[j]) { out[p + 3] = 0; continue; }
    for (var c2 = 0; c2 < 3; c2++) {
      var x = ch[c2][j] * A[c2] + B[c2];
      x = x < 0 ? 0 : (x > N ? N : x);
      out[p + c2] = lut[Math.round(x)];
    }
    out[p + 3] = 255;
  }
  return out;
}

function renderClasses(comp, out) {
  var pal = classPalette(comp.classes), ch = comp.channels[0], valid = comp.valid;
  for (var i = 0; i < ch.length; i++) {
    var o = i * 4;
    if (!valid[i]) continue;
    var c = pal(ch[i]);
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }
  return out;
}

function renderSingle(comp, params, out) {
  var ch = comp.channels[0], valid = comp.valid, npx = ch.length;
  var st = (params.stretch && params.stretch[0]) || [0, 1];
  var off = offsets3(params.offset)[0];
  var inv = 1 / (params.gamma || 1);
  var tf = TRANSFERS[params.transfer || "linear"] || TRANSFERS.linear;
  var ramp = rampTable(params.ramp || "greys");
  var N = 4096, lut = new Uint8ClampedArray(N + 1);
  for (var k = 0; k <= N; k++) lut[k] = Math.round(255 * Math.pow(tf(k / N), inv));
  var span = st[1] - st[0] || 1, A = N / span, B = (off - st[0]) * N / span;
  var hs = params.hillshade ? params.shade : null, hw = params.hillshade || 0;
  for (var j = 0; j < npx; j++) {
    var p = j * 4;
    if (!valid[j]) continue;
    var x = ch[j] * A + B;
    x = x < 0 ? 0 : (x > N ? N : x);
    var r = lut[Math.round(x)] * 3;
    var m = hs ? (1 - hw) + hw * hs[j] * 1.25 : 1;
    out[p] = ramp[r] * m; out[p + 1] = ramp[r + 1] * m; out[p + 2] = ramp[r + 2] * m;
    out[p + 3] = 255;
  }
  return out;
}

export function rgbaToCanvas(rgba, width, height) {
  var cv = document.createElement("canvas");
  cv.width = width; cv.height = height;
  cv.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return cv;
}
