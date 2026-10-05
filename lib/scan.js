// Clear-day scan (docs/clear-day-scan.md): per-day statistics over one
// unfiltered search result, so "which day was clearest over the whole
// region" is a sort, not a re-query.
//
// The region is a coarse grid (about 200 cells on its long side, cells
// roughly square on the ground). Footprints are rasterised onto it by
// scanline, so the union of a day's clear footprints is a cell count and
// needs no polygon library.

function byCloud(a, b) {
  var ca = a.cloud === null ? 1e9 : a.cloud, cb = b.cloud === null ? 1e9 : b.cloud;
  return ca - cb;
}

// lon/lat bbox [w, s, e, n] -> the coarse grid
//   { bbox, nx, ny, x(lon), y(lat) }   x and y in cell units from the NW corner
export function scanFrame(bbox, cells) {
  cells = cells || 200;
  var w = bbox[0], s = bbox[1], e = bbox[2], n = bbox[3];
  if (e < w) e += 360;
  var cx = (w + e) / 2;
  var kx = Math.cos((s + n) / 2 * Math.PI / 180);
  var gw = (e - w) * kx, gh = n - s;              // ground-ish extent, degrees of latitude
  var d = Math.max(gw, gh) / cells;
  var nx = Math.max(1, Math.round(gw / d)), ny = Math.max(1, Math.round(gh / d));
  var dx = (e - w) / nx, dy = (n - s) / ny;
  return {
    bbox: [w, s, e, n], nx: nx, ny: ny,
    // longitudes are taken within 180 degrees of the region centre, so a
    // footprint across the antimeridian stays in one piece
    x: function (lon) {
      while (lon - cx > 180) lon -= 360;
      while (lon - cx < -180) lon += 360;
      return (lon - w) / dx;
    },
    y: function (lat) { return (n - lat) / dy; }
  };
}

function rings(g) {
  if (!g) return [];
  if (g.type === "Polygon") return g.coordinates;
  if (g.type === "MultiPolygon") return [].concat.apply([], g.coordinates);
  return [];
}

// Set mask cells whose centre lies inside the GeoJSON polygon (even-odd over
// all rings, so holes and multipolygons come out right). Returns cells newly set.
export function rasterize(geometry, frame, mask) {
  var rs = rings(geometry).map(function (r) {
    return r.map(function (p) { return [frame.x(p[0]), frame.y(p[1])]; });
  });
  if (!rs.length) return 0;
  var y0 = Infinity, y1 = -Infinity;
  rs.forEach(function (r) { r.forEach(function (p) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }); });
  var j0 = Math.max(0, Math.floor(y0 - 0.5)), j1 = Math.min(frame.ny - 1, Math.ceil(y1 - 0.5));
  var added = 0, xs = [];
  for (var j = j0; j <= j1; j++) {
    var yc = j + 0.5;
    xs.length = 0;
    for (var k = 0; k < rs.length; k++) {
      var r = rs[k];
      for (var i = 0, m = r.length - 1; i < r.length; m = i++) {
        var a = r[m], b = r[i];
        if ((a[1] > yc) !== (b[1] > yc)) xs.push(a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
    }
    xs.sort(function (p, q) { return p - q; });
    for (var t = 0; t + 1 < xs.length; t += 2) {
      var c0 = Math.max(0, Math.ceil(xs[t] - 0.5)), c1 = Math.min(frame.nx - 1, Math.floor(xs[t + 1] - 0.5));
      for (var c = c0; c <= c1; c++) {
        var o = j * frame.nx + c;
        if (!mask[o]) { mask[o] = 1; added++; }
      }
    }
  }
  return added;
}

// --- swath-aligned regions ------------------------------------------------------
//
// A sun-synchronous imager flies its day passes descending, so a swath runs
// south-south-west and a region drawn as a lon/lat box cuts across it. A
// swath-aligned region keeps the box's north and south edges and shears its
// sides along the ground track.
//
// Ground track tilt from north at latitude lat (degrees, positive: going
// north moves east), from the inertial heading (sin A = cos i / cos lat)
// plus the Earth turning under the orbit. Defaults are Sentinel-2's orbit
// (98.56 deg, 100.6 min); Landsat 8/9 (98.2 deg, 98.9 min) is within half
// a degree. Against the edges of real 2026 Sentinel-2 footprints over
// eastern Australia this is 13.0 deg at 25S and 14.7 deg at 44S, where the
// footprints measure 12 to 16 deg.
export function swathTilt(lat, opts) {
  opts = opts || {};
  var inc = (opts.inclination || 98.5621) * Math.PI / 180;
  var T = (opts.period || 100.6) * 60, R = 6371.0, w = 7.2921159e-5;
  var v = 2 * Math.PI * R / T;
  var c = Math.cos(Math.min(80, Math.abs(lat)) * Math.PI / 180);
  var sA = Math.max(-1, Math.min(1, Math.cos(inc) / c));
  var cA = Math.sqrt(1 - sA * sA);
  return Math.atan((Math.abs(v * sA) + w * R * c) / (v * cA)) * 180 / Math.PI;
}

// lon/lat box [w, s, e, n] -> the swath-aligned parallelogram (GeoJSON
// Polygon, sides densified) with the same north and south edges and the
// same width, centred on the box at its middle latitude.
export function swathPolygon(bbox, opts) {
  var w = bbox[0], s = bbox[1], e = bbox[2], n = bbox[3];
  var mid = (s + n) / 2, steps = 24, rad = Math.PI / 180;
  // east offset (degrees of longitude) of the track at lat, relative to mid
  function offset(lat) {
    var k = 16, sum = 0, d = (lat - mid) / k;
    for (var j = 0; j < k; j++) {
      var t = mid + (j + 0.5) * d;
      sum += Math.tan(swathTilt(t, opts) * rad) * d / Math.cos(Math.min(80, Math.abs(t)) * rad);
    }
    return sum;
  }
  var right = [], left = [];
  for (var i = 0; i <= steps; i++) {
    var lat = s + (n - s) * i / steps, o = offset(lat);
    right.push([e + o, lat]);
    left.push([w + o, lat]);
  }
  var ring = right.concat(left.reverse());
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

export function polygonBbox(g) {
  var b = [Infinity, Infinity, -Infinity, -Infinity];
  rings(g).forEach(function (r) {
    r.forEach(function (p) {
      b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]);
      b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
    });
  });
  return b;
}

function mean(v) { return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null; }

// Scenes -> one entry per solar day, oldest first:
//   { day, all, scenes, nAll, nClear, completeness, extent,
//     cloudMin, cloudMax, cloudMean }
// all: every scene acquired that day, least cloudy first
// scenes: those at or under cloudMax (null cloud counts as clear); this is
//   what gets composited, so a day with none is left out
// completeness: nClear / nAll, judged against what was flown that day
// extent: fraction of the region covered by the union of clear footprints
//   (the region is bbox, or opts.region, a GeoJSON polygon inside it such as
//   a swathPolygon)
// cloudMax / cloudMean: over the clear scenes, for display
export function scanDays(scenes, bbox, opts) {
  opts = opts || {};
  var lim = opts.cloudMax === undefined || opts.cloudMax === null ? 100 : +opts.cloudMax;
  var frame = bbox ? scanFrame(bbox, opts.cells) : null;
  var inside = null, nInside = frame ? frame.nx * frame.ny : 0;
  if (frame && opts.region) {
    inside = new Uint8Array(frame.nx * frame.ny);
    nInside = rasterize(opts.region, frame, inside) || 1;
  }
  var by = new Map();
  scenes.forEach(function (s) {
    if (!by.has(s.day)) by.set(s.day, []);
    by.get(s.day).push(s);
  });
  var out = [];
  Array.from(by.keys()).sort().forEach(function (day) {
    var all = by.get(day).slice().sort(byCloud);
    var clear = all.filter(function (s) { return s.cloud === null || s.cloud <= lim; });
    if (!clear.length) return;
    var clouds = clear.map(function (s) { return s.cloud; }).filter(function (c) { return c !== null; });
    var extent = null;
    if (frame) {
      var mask = new Uint8Array(frame.nx * frame.ny), n = 0;
      clear.forEach(function (s) { n += rasterize(s.geometry || bboxPolygon(s.bbox), frame, mask); });
      if (inside) {
        n = 0;
        for (var c = 0; c < mask.length; c++) if (mask[c] && inside[c]) n++;
      }
      extent = n / nInside;
    }
    out.push({ day: day, all: all, scenes: clear, nAll: all.length, nClear: clear.length,
               completeness: clear.length / all.length, extent: extent,
               cloudMin: clouds.length ? Math.min.apply(null, clouds) : null,
               cloudMax: clouds.length ? Math.max.apply(null, clouds) : null,
               cloudMean: mean(clouds) });
  });
  return out;
}

function bboxPolygon(b) {
  if (!b) return null;
  return { type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] };
}

// Sort keys for the day list; every one puts the best first.
var SORTS = {
  date: function (a, b) { return a.day < b.day ? 1 : a.day > b.day ? -1 : 0; },
  scenes: function (a, b) { return b.nClear - a.nClear || SORTS.extent(a, b); },
  extent: function (a, b) { return (b.extent || 0) - (a.extent || 0) || b.completeness - a.completeness || SORTS.date(a, b); },
  completeness: function (a, b) { return b.completeness - a.completeness || (b.extent || 0) - (a.extent || 0) || SORTS.date(a, b); },
  // sharpness from thumbnails (haze proxy); unscored days last
  crisp: function (a, b) {
    var ca = a.crisp === undefined || a.crisp === null ? -1 : a.crisp;
    var cb = b.crisp === undefined || b.crisp === null ? -1 : b.crisp;
    return cb - ca || SORTS.extent(a, b);
  }
};
export var DAY_SORTS = Object.keys(SORTS);

// The day list as shown: filtered, then sorted. Returns entries of `days`
// (same objects), so callers can map back with indexOf.
//   opts = { sort, minScenes, minExtent (0-1) }
export function viewDays(days, opts) {
  opts = opts || {};
  var minN = +opts.minScenes || 0, minE = +opts.minExtent || 0;
  return days.filter(function (d) {
    return d.nClear >= minN && (d.extent === null || d.extent >= minE);
  }).sort(SORTS[opts.sort] || SORTS.date);
}

// --- haze proxy ---------------------------------------------------------------
//
// From a scene thumbnail (TCI JPEG): the variance of the Laplacian of
// luminance over valid (non-black) pixels. Crisp scenes are sharper; haze,
// smoke and thin cloud lower it. Only meaningful between scenes of the same
// place, so a day's score is the mean over its scenes and it is a sort key,
// never a filter. -> number or null (nothing valid)
export function sharpness(rgba, w, h) {
  var L = new Float32Array(w * h), ok = new Uint8Array(w * h);
  for (var i = 0; i < w * h; i++) {
    var r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    ok[i] = r + g + b > 6 ? 1 : 0;
  }
  var s = 0, s2 = 0, n = 0;
  for (var y = 1; y < h - 1; y++) {
    for (var x = 1; x < w - 1; x++) {
      var o = y * w + x;
      if (!(ok[o] && ok[o - 1] && ok[o + 1] && ok[o - w] && ok[o + w])) continue;
      var v = 4 * L[o] - L[o - 1] - L[o + 1] - L[o - w] - L[o + w];
      s += v; s2 += v * v; n++;
    }
  }
  if (n < 100) return null;
  var m = s / n;
  return s2 / n - m * m;
}
