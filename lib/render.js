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
//   transfer: "linear"                         key into TRANSFERS; "log10" maps
//                                              log10(value) between log10(limits)
//   ramp: "viridis"                            key into RAMPS (kind single)
//   reverse: false                             run the ramp backwards (kind single)
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
  log: function (x) { return Math.log(1 + LOG_K * x) / Math.log(1 + LOG_K); },
  // a log10 scale of the values themselves: the work is in scaler(), so the
  // curve after it is the identity
  log10: function (x) { return x; }
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

// Fabio Crameri's Scientific colour maps (perceptually uniform, readable
// in colour-vision deficiency and in grey), 17 evenly spaced stops of each
// 256-entry map. Crameri, F. (2018), Scientific colour maps, Zenodo,
// doi:10.5281/zenodo.1243862, MIT licence; taken from the ncview .ncmap
// set that bbakernoaa/ncview-rs ships.
export var CRAMERI = {
  acton: ["#2e214c", "#3e2f5b", "#4f3e6a", "#624c78", "#775985", "#8c618e",
          "#9f6592", "#b06795", "#c36d9a", "#d17ca5", "#d48bb0", "#d398ba",
          "#d3a6c4", "#d5b5ce", "#d9c4d9", "#dfd4e4", "#e5e5ef"],
  bamako: ["#003f4c", "#0b4546", "#154c40", "#1f533a", "#2a5a33", "#36622c",
           "#436a25", "#51731c", "#617d13", "#72870a", "#878e02", "#9d940b",
           "#b9a524", "#d1b843", "#e2c961", "#f1d77d", "#fee598"],
  batlow: ["#001959", "#09295c", "#0f3a5e", "#164b60", "#235c5f", "#376958",
           "#4e724c", "#667a3e", "#808132", "#9d882d", "#bf8f38", "#dd9650",
           "#f39e71", "#fca893", "#fdb4b4", "#fcbfd6", "#faccfa"],
  berlin: ["#9eaffe", "#78abed", "#519fd3", "#3585ac", "#276785", "#1d4a60",
           "#13303e", "#10191f", "#190b08", "#290d00", "#3f1100", "#591b06",
           "#7b321c", "#9c4f3c", "#bb6d60", "#dc8c86", "#feadad"],
  bilbao: ["#fffffe", "#eaeae9", "#d7d6d3", "#c9c6bb", "#c1bba6", "#bbb291",
           "#b4a57c", "#ae956d", "#a98665", "#a5795f", "#a16b59", "#9c5c52",
           "#934b47", "#843837", "#722626", "#5f1415", "#4c0001"],
  broc: ["#2b194c", "#293164", "#284a7d", "#396694", "#5a82a8", "#7f9ebb",
         "#a4bacf", "#cbd7e3", "#ebeeeb", "#e7e6cf", "#d4d4a9", "#bbbb82",
         "#9b9b61", "#7b7b46", "#5c5c2d", "#3f4016", "#262600"],
  buda: ["#b200b2", "#b21ca5", "#b32e9c", "#b63f95", "#bb4e90", "#c05c8b",
         "#c46a86", "#c97782", "#cd857e", "#d0927a", "#d4a077", "#d7ae73",
         "#dbbc70", "#dfcb6c", "#e3da69", "#edeb66", "#ffff66"],
  cork: ["#2b194c", "#2a3063", "#2a487b", "#386392", "#567ea5", "#7899b8",
         "#9cb4cb", "#c0cfde", "#dae6e4", "#cae0cd", "#aacdad", "#8aba8e",
         "#6ba76f", "#4e914e", "#40762d", "#415f16", "#424c02"],
  davos: ["#00054a", "#081c61", "#143176", "#204689", "#2f5a96", "#3e6b9c",
          "#4d789c", "#5d8398", "#6c8d92", "#7a978c", "#8ba288", "#9fb288",
          "#bbc793", "#d9dead", "#eff0cb", "#f9f9e6", "#fefefe"],
  devon: ["#2b194c", "#2a285b", "#28376a", "#26477a", "#28578f", "#3165a5",
          "#4271bc", "#5e80cf", "#7e8edd", "#999be7", "#afa9ee", "#bdb7f1",
          "#cac5f4", "#d7d3f6", "#e4e1f9", "#f1f0fc", "#fefefe"],
  grayc: ["#fefefe", "#ececec", "#dbdbdb", "#c9c9c9", "#b8b8b8", "#a7a7a7",
          "#969696", "#868686", "#767676", "#676767", "#585858", "#494949",
          "#3b3b3b", "#2d2d2d", "#202020", "#131313", "#000000"],
  hawaii: ["#8c0173", "#8f1c63", "#922e55", "#943e48", "#964d3d", "#985d32",
           "#9a6e28", "#9c811e", "#9b961c", "#96aa2b", "#89bb48", "#7ac869",
           "#6bd38c", "#60deaf", "#65e8d2", "#87efed", "#b3f1fd"],
  imola: ["#1933b2", "#203eac", "#2548a7", "#2a53a2", "#305d9c", "#366796",
          "#3f708d", "#487a85", "#53867e", "#60937a", "#70a276", "#7fb272",
          "#90c36e", "#a3d46a", "#bce567", "#ddf366", "#fffe66"],
  lajolla: ["#fefecb", "#fdf4af", "#fae892", "#f6d875", "#f1c25f", "#edad55",
            "#e99a52", "#e48751", "#dd744f", "#d0604c", "#b84f47", "#9b433f",
            "#7f3b34", "#633227", "#482a1b", "#2f220f", "#191900"],
  lapaz: ["#1a0c64", "#1f2071", "#23317d", "#274289", "#2c5292", "#33629a",
          "#3d71a0", "#4a7fa3", "#5c8ca3", "#6f96a0", "#849e9b", "#9aa496",
          "#b3ac95", "#cfb9a0", "#e9cdb8", "#f8e1d6", "#fef2f2"],
  lisbon: ["#e5e5fe", "#bac6e5", "#90a7cc", "#6788b3", "#406996", "#234b73",
           "#15324f", "#111e2d", "#161819", "#28261a", "#423e28", "#5f5a39",
           "#7f774c", "#a09764", "#c1b986", "#e0dcae", "#fefed8"],
  nuuk: ["#04598c", "#1c5d86", "#2d6382", "#3f6c81", "#537684", "#68828a",
         "#7d8f91", "#909b96", "#a0a597", "#acad95", "#b4b491", "#bbbb8b",
         "#c2c285", "#cccc83", "#dbdb89", "#eded9b", "#fefeb2"],
  oleron: ["#192659", "#323e71", "#4b588b", "#6773a6", "#8390c3", "#a0addf",
           "#bbc8f3", "#d1defa", "#194c00", "#3e5600", "#606308", "#857729",
           "#a78e4e", "#cca972", "#ebc79a", "#f7e2c0", "#fcfce5"],
  oslo: ["#000100", "#0a111a", "#0d1d2e", "#102a43", "#15385b", "#1c4773",
         "#26568c", "#3767a5", "#4f7abc", "#668bc7", "#7b98c9", "#8ea4c9",
         "#a1b0c9", "#b6becc", "#cdd0d6", "#e6e7e8", "#fefffe"],
  roma: ["#7e1900", "#90400d", "#a1601b", "#b08029", "#c0a13c", "#d3c55e",
         "#e1df8b", "#dfe9af", "#caebc9", "#a6e3d5", "#79cfd6", "#59b4cf",
         "#4798c4", "#3c7db9", "#3163ae", "#274ba3", "#1a3398"],
  tofino: ["#ddd8fe", "#b2baec", "#889cd9", "#5e7dc0", "#3e5d9a", "#2b4371",
           "#1d2c4a", "#121a28", "#0c1513", "#122314", "#1b3b1e", "#28562c",
           "#36733b", "#4f934f", "#7bb269", "#abcc82", "#dbe59b"],
  tokyo: ["#1a0e33", "#321741", "#4b224f", "#62335f", "#75466c", "#825875",
          "#88697c", "#8c7881", "#8f8785", "#919489", "#94a38d", "#98b392",
          "#a0c498", "#b2d9a4", "#ceedb7", "#e8f9c9", "#fefed8"],
  turku: ["#000000", "#171716", "#282723", "#38382f", "#494939", "#595941",
          "#6a6949", "#7c7a51", "#928b5a", "#aa9966", "#c1a272", "#d4a67f",
          "#e4aa8f", "#f1b3a4", "#fac2bd", "#fed4d2", "#ffe5e5"],
  vik: ["#001160", "#022b70", "#024380", "#0c5e91", "#307ca6", "#609dbc",
        "#93bdd2", "#c6dbe5", "#ece4e0", "#e9cbba", "#dcab90", "#cf8e68",
        "#c37143", "#b3531e", "#932e06", "#741506", "#590007"]

};
Object.keys(CRAMERI).forEach(function (k) { RAMPS[k] = CRAMERI[k]; });

// Absolute palettes: colours pinned to data values rather than spread
// between the stretch limits, so the same value has the same colour in
// every view. Anchors are [value, colour], ascending; colours are linear
// between anchors and values beyond the ends take the end colours.
// dirty: the AAD underway (DiRT) bathymetry palette, -8000 to 1000 m, from
// palr (github.com/AustralianAntarcticDivision/palr, R/dirty.R).
export var ABSOLUTE = {
  dirty: { label: "DiRT bathymetry and topography (AAD)", units: "m", anchors: [
    [-8000, "#7e0202"], [-7000, "#7e023e"], [-6000, "#7e0276"], [-5000, "#4b027e"],
    [-4000, "#1e0188"], [-3500, "#011992"], [-3000, "#01549c"], [-2500, "#0198a7"],
    [-2000, "#01b17f"], [-1500, "#01bb40"], [-1000, "#08c600"], [-750, "#56d000"],
    [-500, "#acda00"], [-250, "#e5c000"], [0, "#ffffff"], [500, "#ecfefb"], [1000, "#cff6ef"]] }
};

// Parse an absolute palette written one anchor per line, as for GDAL's
// gdaldem color-relief: "value colour", the colour as #rrggbb or "r g b"
// (0-255), separated by spaces, commas or tabs. "nv" lines and blank or
// "#" comment lines are skipped. Throws on a line it cannot read.
export function parseAbsolute(text) {
  var out = [];
  String(text || "").split(/\r?\n/).forEach(function (line, i) {
    line = line.trim();
    if (!line || /^(#\s|#$|nv\b)/i.test(line)) return;
    var f = line.split(/[\s,;]+/);
    var v = +f[0], c;
    if (/^#?[0-9a-f]{6}$/i.test(f[1] || "") && f.length === 2) c = "#" + f[1].replace("#", "");
    else if (f.length >= 4 && f.slice(1, 4).every(function (x) { return x !== "" && +x >= 0 && +x <= 255; })) {
      c = "#" + f.slice(1, 4).map(function (x) { return ("0" + Math.round(+x).toString(16)).slice(-2); }).join("");
    }
    if (!isFinite(v) || !c) throw new Error("palette line " + (i + 1) + " is not 'value #rrggbb' or 'value r g b': " + line);
    out.push([v, c]);
  });
  if (out.length < 2) throw new Error("an absolute palette needs at least two lines of 'value colour'");
  return out.sort(function (a, b) { return a[0] - b[0]; });
}
export function absoluteText(anchors) {
  return anchors.map(function (a) { return a[0] + " " + a[1]; }).join("\n");
}

// value -> colour lookup for anchors: N bins over the anchors' range
function absoluteTable(anchors, N) {
  var lo = anchors[0][0], hi = anchors[anchors.length - 1][0];
  var rgb = anchors.map(function (a) { return hexRgb(a[1]); });
  var t = new Uint8ClampedArray((N + 1) * 3), k = 0;
  for (var i = 0; i <= N; i++) {
    var v = lo + (hi - lo) * i / N;
    while (k < anchors.length - 2 && v > anchors[k + 1][0]) k++;
    var a = anchors[k][0], b = anchors[k + 1][0], f = b > a ? (v - a) / (b - a) : 0;
    f = f < 0 ? 0 : (f > 1 ? 1 : f);
    for (var c = 0; c < 3; c++) t[i * 3 + c] = Math.round(rgb[k][c] + (rgb[k + 1][c] - rgb[k][c]) * f);
  }
  return { table: t, lo: lo, hi: hi };
}

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
  if (params.transfer === "log10") {
    var sc = [0, 1, 2].map(function (c) { return scaler(st[c][0], st[c][1], off[c], N, "log10"); });
    for (var jl = 0; jl < npx; jl++) {
      var pl = jl * 4;
      if (!valid[jl]) { out[pl + 3] = 0; continue; }
      for (var cl = 0; cl < 3; cl++) out[pl + cl] = lut[Math.round(sc[cl](ch[cl][jl]))];
      out[pl + 3] = 255;
    }
    return out;
  }
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

// v (stored) -> position 0..N between the limits: linear, or for the
// "log10" transfer the log of the corrected value between log10(lo) and
// log10(hi) (a true log colour scale; values at or below zero clamp to the
// low end, and a limit at or below zero is raised to hi / 1e4).
function scaler(lo, hi, off, N, transfer) {
  if (transfer === "log10") {
    if (!(hi > 0)) hi = 1;
    if (!(lo > 0) || lo >= hi) lo = hi / 1e4;
    var l0 = Math.log10(lo), k = N / (Math.log10(hi) - l0);
    return function (v) {
      var y = v + off;
      var x = y > 0 ? (Math.log10(y) - l0) * k : 0;
      return x < 0 ? 0 : (x > N ? N : x);
    };
  }
  var span = hi - lo || 1, A = N / span, B = (off - lo) * N / span;
  return function (v) {
    var x = v * A + B;
    return x < 0 ? 0 : (x > N ? N : x);
  };
}

function renderSingle(comp, params, out) {
  var ch = comp.channels[0], valid = comp.valid, npx = ch.length;
  if (params.absolute) return renderAbsolute(comp, params, out);
  var st = (params.stretch && params.stretch[0]) || [0, 1];
  var off = offsets3(params.offset)[0];
  var inv = 1 / (params.gamma || 1);
  var tf = TRANSFERS[params.transfer || "linear"] || TRANSFERS.linear;
  var ramp = rampTable(params.ramp || "greys");
  var N = 4096, lut = new Uint8ClampedArray(N + 1);
  for (var k = 0; k <= N; k++) lut[k] = Math.round(255 * Math.pow(tf(k / N), inv));
  if (params.reverse) for (var q = 0; q <= N; q++) lut[q] = 255 - lut[q];
  var toX = scaler(st[0], st[1], off, N, params.transfer);
  var hs = params.hillshade ? params.shade : null, hw = params.hillshade || 0;
  for (var j = 0; j < npx; j++) {
    var p = j * 4;
    if (!valid[j]) continue;
    var r = lut[Math.round(toX(ch[j]))] * 3;
    var m = hs ? (1 - hw) + hw * hs[j] * 1.25 : 1;
    out[p] = ramp[r] * m; out[p + 1] = ramp[r + 1] * m; out[p + 2] = ramp[r + 2] * m;
    out[p + 3] = 255;
  }
  return out;
}

// A single band through an absolute palette: corrected values (stored +
// offset) straight to colours; limits, curve, gamma and reverse do not apply.
function renderAbsolute(comp, params, out) {
  var ch = comp.channels[0], valid = comp.valid, npx = ch.length;
  var off = offsets3(params.offset)[0], N = 4096;
  var at = absoluteTable(params.absolute, N), t = at.table;
  var k = N / ((at.hi - at.lo) || 1), base = off - at.lo;
  var hs = params.hillshade ? params.shade : null, hw = params.hillshade || 0;
  for (var j = 0; j < npx; j++) {
    var p = j * 4;
    if (!valid[j]) continue;
    var x = Math.round((ch[j] + base) * k);
    var r = (x < 0 ? 0 : (x > N ? N : x)) * 3;
    var m = hs ? (1 - hw) + hw * hs[j] * 1.25 : 1;
    out[p] = t[r] * m; out[p + 1] = t[r + 1] * m; out[p + 2] = t[r + 2] * m;
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
