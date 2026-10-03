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
import { cogInfo } from "../cog.js";

export function vsiToHttps(name, vrtUrl, relative) {
  var n = String(name).trim();
  if (relative) return new URL(n, vrtUrl).href;
  var m;
  if ((m = /^\/vsicurl(?:_streaming)?\/(.*)$/.exec(n))) return secureUrl(m[1]);
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
  // GDAL overviews of the mosaic (a coarser VRT or a single raster each),
  // listed under the first band, usually finest first
  var overviews = [];
  var b1 = root.getElementsByTagName("VRTRasterBand")[0];
  if (b1) Array.prototype.forEach.call(b1.children, function (ov) {
    if (ov.nodeName !== "Overview") return;
    var fn = ov.getElementsByTagName("SourceFilename")[0];
    if (fn) overviews.push({ href: vsiToHttps(fn.textContent, vrtUrl, fn.getAttribute("relativeToVRT") === "1") });
  });
  return { crs: crs, gt: gt, width: num(root, "rasterXSize", 0), height: num(root, "rasterYSize", 0),
           bands: bands, files: Array.from(files.values()), overviews: overviews };
}

function hit(a, b) { return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]; }

// Pixel size of an overview, from its width against the mosaic's (same
// extent): a VRT's rasterXSize is in its first bytes, a raster's in its header.
async function overviewRes(v, ov) {
  if (ov.res) return ov.res;
  var w;
  if (/\.vrt(\?|$)/i.test(ov.href)) {
    var r = await fetch(ov.href, { headers: { Range: "bytes=0-4095" } });
    if (!r.ok) throw new Error("overview " + r.status + " " + ov.href);
    var m = /rasterXSize="(\d+)"/.exec(await r.text());
    if (!m) throw new Error("no rasterXSize in " + ov.href);
    w = +m[1];
  } else {
    w = (await cogInfo(ov.href)).width;
  }
  ov.res = Math.abs(v.gt[1]) * v.width / w;
  return ov.res;
}

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
  var cat = {
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
    // q.res (ground metres per output pixel, optional) picks an overview:
    // the coarsest no coarser than the output, the same rule as COG
    // overviews. A VRT overview is searched in turn; a single raster
    // overview is one scene covering the mosaic.
    search: async function (q) {
      var v = await read();
      cat.note = null;
      if (q.res && v.overviews.length && q.res > Math.abs(v.gt[1]) * 1.05) {
        var pick = null, skipped = [];
        for (var i = v.overviews.length - 1; i >= 0; i--) {
          var res;
          try { res = await overviewRes(v, v.overviews[i]); }
          catch (e) {   // unreadable from a page: the next finer one will do
            var nm = decodeURIComponent(v.overviews[i].href.split("/").pop());
            skipped.push(/Git LFS/.test(e.message || "") ? nm + " (in Git LFS, which GitHub does not serve to web pages)" : nm + " (" + (e.message || e) + ")");
            continue;
          }
          if (res <= q.res * 1.05) { pick = v.overviews[i]; break; }
        }
        if (pick) {
          var name = decodeURIComponent(pick.href.split("/").pop());
          cat.note = "read from overview " + name + " (" + +pick.res.toPrecision(3) + " m) for this region's " +
            "pixel size; a smaller region reads finer data";
        }
        if (skipped.length) {
          cat.note = (cat.note ? cat.note + "\n" : "") + "skipped overview(s): " + skipped.join("; ");
        }
        if (pick) {
          if (/\.vrt(\?|$)/i.test(pick.href)) {
            var sub = vrtCatalog({ url: pick.href });
            return sub.search(Object.assign({}, q, { res: null }));
          }
          var b = transformBbox([v.gt[0], v.gt[3] + v.height * v.gt[5], v.gt[0] + v.width * v.gt[1], v.gt[3]],
                                v.crs, "EPSG:4326");
          var meta = { b1: { band: 0, dataType: v.bands.length ? v.bands[0].dataType : "Float32" } };
          if (v.bands.length && v.bands[0].nodata !== null) meta.b1.nodata = v.bands[0].nodata;
          return [{ id: name, day: UNDATED, datetime: null, bbox: b, cloud: null, crs: v.crs,
                    geometry: boxPolygon([v.gt[0], v.gt[3] + v.height * v.gt[5], v.gt[0] + v.width * v.gt[1], v.gt[3]], v.crs, 8),
                    assets: { b1: pick.href }, assetMeta: meta, meta: { res: pick.res } }];
        }
      }
      var roi = q.bbox ? transformBbox(q.bbox, "EPSG:4326", v.crs, 32) : null;
      var keep = v.files.filter(function (f) { return !roi || hit(f.extent, roi); });
      return keep.reverse().map(function (f) { return sceneOf(v, f); });
    }
  };
  return cat;
}
