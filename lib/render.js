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
//   kind: "rgb8" | "bands",  rgb8 = a baked 3-band Byte product (TCI),
//                            bands = three numeric bands to be stretched
//   channels: [R, G, B],     TypedArray (grid.width * grid.height) each
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
  var hrefs = Object.keys(scene.assets || {}).map(function (k) { return scene.assets[k]; });
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
export function mosaic(grid, layers, kind, keys) {
  var npx = grid.width * grid.height;
  var first = layers[0];
  var Ctor = first.bands[0].constructor;
  var ch = [new Ctor(npx), new Ctor(npx), new Ctor(npx)];
  var valid = new Uint8Array(npx);
  layers.forEach(function (L) {
    var v = L.valid, b = L.bands;
    for (var i = 0; i < npx; i++) {
      if (valid[i] || !v[i]) continue;
      ch[0][i] = b[0][i]; ch[1][i] = b[1][i]; ch[2][i] = b[2][i];
      valid[i] = 1;
    }
  });
  return { grid: grid, kind: kind, channels: ch, valid: valid, keys: keys || [] };
}

// Sorted sample (~250k values) of the stored values of one or more channels
// over valid pixels, skipping 0 (nodata) and NaN.
function sample(channels, valid) {
  var n = channels[0].length;
  var stride = Math.max(1, Math.floor(n * channels.length / 250000));
  var buf = new Float64Array(Math.ceil(n / stride) * channels.length);
  var m = 0;
  channels.forEach(function (channel) {
    for (var i = 0; i < n; i += stride) {
      var v = channel[i];
      if (valid[i] && v > 0 && v === v) buf[m++] = v;
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
export function percentiles(channel, valid, lo, hi) {
  return pick(sample([channel], valid), lo, hi);
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
  var st;
  if (opts.joint) {
    var j = pick(sample(comp.channels, comp.valid), lo, hi);
    st = [j.slice(), j.slice(), j.slice()];
  } else {
    st = comp.channels.map(function (c) { return percentiles(c, comp.valid, lo, hi); });
  }
  return st.map(function (s, c) { return [s[0] + off[c], s[1] + off[c]]; });
}

// --- colour --------------------------------------------------------------------

// Composite -> RGBA bytes (Uint8ClampedArray, width * height * 4).
export function renderRGBA(comp, params) {
  params = params || {};
  var npx = comp.grid.width * comp.grid.height;
  var out = new Uint8ClampedArray(npx * 4);
  var ch = comp.channels, valid = comp.valid;
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

export function rgbaToCanvas(rgba, width, height) {
  var cv = document.createElement("canvas");
  cv.width = width; cv.height = height;
  cv.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  return cv;
}
