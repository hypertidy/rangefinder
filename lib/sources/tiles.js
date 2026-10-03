// Layers 1+2 for map tile servers: an XYZ template or a WMTS GetCapabilities.
//
// A tile server is one "scene" covering its bounds (the whole world unless
// the server says otherwise), or one per value of a WMTS time dimension, so
// the day list and the timeline work on GIBS-style daily layers. The asset
// is a TileSource (tiles.js), which loadComposite reads through the same
// warp as a COG.

import { webMercatorQuad, parseWmtsCapabilities, wmtsSource } from "../tiles.js";
import { bboxIntersects, secureUrl, resolveCrs, crsProvenance } from "../geo.js";
import { UNDATED } from "./cog.js";

export function isCapabilitiesUrl(u) {
  return !/\{(z|q|TileMatrix)\}/i.test(u || "") &&
    /request=getcapabilities|capabilities\.xml|\.xml(\?|$)|\/wmts\/?(\?|$)/i.test(u || "");
}

// Packed-elevation tiles by their usual URLs.
export function guessDecode(u) {
  if (/terrarium/i.test(u)) return "terrarium";
  if (/terrain-rgb|terrain-dem/i.test(u)) return "mapbox";
  return "rgb";
}

// opts = { url, layer, set, style, format (MIME), decode ("rgb" | "terrarium" |
//          "mapbox"), minzoom, maxzoom, subdomains }
export function tileCatalog(opts) {
  var url = secureUrl(opts.url);
  var wmts = isCapabilitiesUrl(url);
  var caps = null;
  function readCaps() {
    if (!caps) {
      caps = fetch(url).then(function (r) {
        if (!r.ok) throw new Error("capabilities " + r.status + " " + url);
        return r.text();
      }).then(function (t) { return parseWmtsCapabilities(t, url); });
      caps.catch(function () { caps = null; });
    }
    return caps;
  }
  async function source(time) {
    var src;
    if (wmts) {
      var c = await readCaps();
      var layer = opts.layer || (c.layers[0] && c.layers[0].id);
      src = wmtsSource(c, layer, { set: opts.set, style: opts.style, format: opts.format,
                                   decode: opts.decode, time: time });
    } else {
      if (!/\{z\}|\{q\}/.test(url)) throw new Error("an XYZ template needs {z}/{x}/{y} (or {q})");
      src = { kind: "tiles", template: url, tms: webMercatorQuad(opts.maxzoom == null || opts.maxzoom === "" ? 22 : +opts.maxzoom),
              format: opts.decode || guessDecode(url), label: url, bbox: null };
    }
    src.tms.crs = await resolveCrs(src.tms.crs);
    src.crsFrom = (wmts ? "the TileMatrixSet's SupportedCRS" : "assumed: XYZ templates are Web Mercator by convention") +
      "; definition: " + crsProvenance(src.tms.crs);
    src.crsAssumed = !wmts;
    if (opts.subdomains) src.subdomains = opts.subdomains;
    if (opts.minzoom !== undefined && opts.minzoom !== null && opts.minzoom !== "") src.minzoom = +opts.minzoom;
    if (opts.maxzoom !== undefined && opts.maxzoom !== null && opts.maxzoom !== "") src.maxzoom = +opts.maxzoom;
    return src;
  }
  var elev = function (src) { return src.format === "terrarium" || src.format === "mapbox"; };
  var cat = {
    kind: "tiles",
    label: wmts ? "WMTS " + url.split("?")[0] : url,
    capabilities: { cloud: false, time: wmts },
    maxScenes: 1,
    presets: [],
    // WMTS: the parsed capabilities, for the layer / set / time pickers
    info: async function () { return wmts ? readCaps() : null; },
    // the tile source itself (CRS and where it came from, levels)
    describe: function () { return source(null); },
    source: source,
    search: async function (q) {
      var base = await source(null);
      var key = elev(base) ? "elevation" : "visual";
      cat.presets = elev(base)
        ? [{ keys: [key], mode: "single", label: "elevation (decoded " + base.format + ")",
             ramp: "terrain", hillshade: 0.6 }]
        : [{ keys: [key], mode: "rgb", label: "tiles as served" }];
      var times = [null];
      if (wmts) {
        var c = await readCaps();
        var layer = c.layers.filter(function (l) { return l.id === (opts.layer || c.layers[0].id); })[0];
        if (layer && layer.times && layer.times.length) {
          var range = (q.datetime || "../..").split("/");
          var lo = range[0] && range[0] !== ".." ? range[0] : "0000", hi = range[1] && range[1] !== ".." ? range[1] : "9999";
          times = layer.times.filter(function (t) { return t.slice(0, 10) >= lo && t.slice(0, 10) <= hi; });
          if (!times.length) return [];
          times = times.slice(-(q.maxItems || 300));
        }
      }
      if (base.bbox && q.bbox && !bboxIntersects(base.bbox, q.bbox)) return [];
      return times.map(function (t) {
        var src = Object.assign({}, base, { time: t || base.time });
        var assets = {}, meta = {};
        assets[key] = src;
        meta[key] = elev(base) ? { elevation: true } : { rgb: true };
        var b = base.bbox || [-180, -85.06, 180, 85.06];
        return { id: (base.label || "tiles") + (t ? " " + t : ""), day: t ? t.slice(0, 10) : UNDATED,
                 datetime: t, bbox: base.bbox, cloud: null, crs: base.tms.crs,
                 geometry: base.bbox ? { type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]],
                   [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] } : null,
                 assets: assets, assetMeta: meta, meta: {} };
      });
    }
  };
  return cat;
}
