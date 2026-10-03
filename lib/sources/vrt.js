// Layers 1+2 bound to a GDAL VRT mosaic: one XML file that lists every
// source file of a mosaic with its place in a common grid (e.g. the REMA
// and ArcticDEM mosaics publish <res>_dem_tiles.vrt next to the tiles).
//
// The VRT is the index: its SRS and GeoTransform give the grid, each
// <*Source> gives a file and its DstRect, so every file's extent is known
// without opening it. Each file becomes one scene; a search keeps the files
// whose extent meets the region (tested in the VRT's own CRS, so polar
// tiles are not inflated by a lon/lat box). GDAL paints sources in order
// with the last on top, so scenes come back last first, which is the
// order loadComposite mosaics in. There is no time axis.
//
// Filenames: relativeToVRT="1" resolves against the VRT URL; /vsicurl/ is
// stripped; /vsis3/bucket/key becomes that bucket's https endpoint (the
// VRT's own host when it lives in the same bucket); /vsigs/ becomes
// storage.googleapis.com.

import { boxPolygon, crsCode, crsFromWkt, ensureCrs, transformBbox, secureUrl, crsProvenance } from "../geo.js";
import { UNDATED } from "./cog.js";

export function vsiToHttps(name, vrtUrl, relative) {
  var n = String(name).trim();
  if (relative) return new URL(n, vrtUrl).href;
  var m;
  if ((m = /^\/vsicurl(?:_streaming)?\/(.*)$/.exec(n))) return m[1];
  if ((m = /^\/vsis3(?:_streaming)?\/([^/]+)\/(.*)$/.exec(n))) {
    var u = new URL(vrtUrl, location.href);
    if (u.hostname.indexOf(m[1] + ".s3") === 0) return u.origin + "/" + m[2];
    if (u.hostname.indexOf("s3") >= 0 && u.pathname.indexOf("/" + m[1] + "/") === 0) {
      return u.origin + "/" + m[1] + "/" + m[2];
    }
    return "https://" + m[1] + ".s3.amazonaws.com/" + m[2];
  }
  if ((m = /^\/vsigs\/(.*)$/.exec(n))) return "https://storage.googleapis.com/" + m[1];
  if (/^https?:\/\//.test(n)) return n;
  return new URL(n, vrtUrl).href;   // a bare path: relative to the VRT
}

function num(el, name, dflt) {
  var v = el && el.getAttribute(name);
  return v === null || v === undefined || v === "" ? dflt : +v;
}

// VRT text -> { crs, gt, width, height, bands: [{ band, dataType, nodata }],
//               files: [{ href, extent, bands: { vrtBand: srcBand } }] }
export function parseVrt(text, vrtUrl) {
  var doc = new DOMParser().parseFromString(text, "application/xml");
  var root = doc.documentElement;
  if (!root || root.nodeName !== "VRTDataset") throw new Error("not a GDAL VRT (no VRTDataset)");
  var srs = root.getElementsByTagName("SRS")[0];
  var srsText = srs ? srs.textContent.trim() : "";
  var crs = /^(EPSG:\d+|urn:ogc)/i.test(srsText) ? ensureCrs(crsCode(srsText)) : crsFromWkt(srsText);
  var gtEl = root.getElementsByTagName("GeoTransform")[0];
  if (!gtEl) throw new Error("VRT has no GeoTransform");
  var gt = gtEl.textContent.split(",").map(function (v) { return +v; });
  var files = new Map(), bands = [];
  Array.prototype.forEach.call(root.getElementsByTagName("VRTRasterBand"), function (b) {
    var bandNo = num(b, "band", bands.length + 1);
    var ndEl = b.getElementsByTagName("NoDataValue")[0];
    bands.push({ band: bandNo, dataType: b.getAttribute("dataType") || "Byte",
                 nodata: ndEl ? +ndEl.textContent : null });
    Array.prototype.forEach.call(b.children, function (src) {
      if (!/Source$/.test(src.nodeName)) return;
      var fn = src.getElementsByTagName("SourceFilename")[0];
      var dst = src.getElementsByTagName("DstRect")[0];
      if (!fn || !dst) return;
      var href = vsiToHttps(fn.textContent, vrtUrl, fn.getAttribute("relativeToVRT") === "1");
      var sb = src.getElementsByTagName("SourceBand")[0];
      var x0 = num(dst, "xOff", 0), y0 = num(dst, "yOff", 0);
      var xs = num(dst, "xSize", 0), ys = num(dst, "ySize", 0);
      var ext = [gt[0] + x0 * gt[1], gt[3] + (y0 + ys) * gt[5],
                 gt[0] + (x0 + xs) * gt[1], gt[3] + y0 * gt[5]];
      var f = files.get(href);
      if (!f) { f = { href: href, extent: ext, bands: {}, order: files.size }; files.set(href, f); }
      f.bands[bandNo] = sb ? +sb.textContent : 1;
    });
  });
  return { crs: crs, gt: gt, width: num(root, "rasterXSize", 0), height: num(root, "rasterYSize", 0),
           bands: bands, files: Array.from(files.values()) };
}

function hit(a, b) { return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]; }

export function vrtCatalog(opts) {
  var url = secureUrl(opts.url);
  var parsed = null;
  function read() {
    if (!parsed) {
      parsed = fetch(url).then(function (r) {
        if (!r.ok) throw new Error("VRT " + r.status + " " + url);
        return r.text();
      }).then(function (t) { return parseVrt(t, url); });
      parsed.catch(function () { parsed = null; });
    }
    return parsed;
  }
  function sceneOf(v, f) {
    var assets = {}, meta = {};
    v.bands.forEach(function (b) {
      if (f.bands[b.band] === undefined) return;
      var k = "b" + b.band;
      assets[k] = f.href;
      meta[k] = { band: f.bands[b.band] - 1, dataType: b.dataType };
      if (b.nodata !== null) meta[k].nodata = b.nodata;
    });
    if (v.bands.length >= 3 && v.bands[0].dataType === "Byte" && f.bands[1] === 1 &&
        f.bands[2] === 2 && f.bands[3] === 3) {
      assets.visual = f.href; meta.visual = { rgb: true };
    }
    var geom = boxPolygon(f.extent, v.crs, 4);
    var name = decodeURIComponent(f.href.split("?")[0].split("/").pop());
    return { id: name, day: UNDATED, datetime: null, geometry: geom,
             bbox: transformBbox(f.extent, v.crs, "EPSG:4326"), cloud: null, crs: v.crs,
             assets: assets, assetMeta: meta, meta: { res: Math.abs(v.gt[1]), order: f.order } };
  }
  return {
    kind: "vrt",
    label: url.split("/").pop(),
    capabilities: { cloud: false, time: false },
    // most mosaics need more files than a satellite day has scenes
    maxScenes: 24,
    // { crs, files, bands, dataType, res, bbox, footprints: [GeoJSON] }
    info: async function () {
      var v = await read();
      var all = transformBbox([v.gt[0], v.gt[3] + v.height * v.gt[5], v.gt[0] + v.width * v.gt[1], v.gt[3]],
                              v.crs, "EPSG:4326");
      return { crs: v.crs, crsFrom: "the VRT's SRS; definition: " + crsProvenance(v.crs), files: v.files.length, bands: v.bands.length,
               dataType: v.bands.length ? v.bands[0].dataType : "?",
               res: Math.abs(v.gt[1]), bbox: all,
               footprints: v.files.map(function (f) { return boxPolygon(f.extent, v.crs, 4); }) };
    },
    search: async function (q) {
      var v = await read();
      var roi = q.bbox ? transformBbox(q.bbox, "EPSG:4326", v.crs, 32) : null;
      var keep = v.files.filter(function (f) { return !roi || hit(f.extent, roi); });
      return keep.reverse().map(function (f) { return sceneOf(v, f); });
    }
  };
}
