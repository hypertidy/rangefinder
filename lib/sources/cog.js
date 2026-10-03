// Layers 1+2 for files named directly: paste one or more COG URLs.
//
// No catalogue at all: each URL is one scene, its footprint and CRS come
// from the file header (cog.js cogInfo), its day from the TIFF DateTime tag
// when there is one ("undated" otherwise). Every band is offered as b1..bn,
// and a 3-band Byte file also as "visual". The most useful debugging source
// there is: if a file renders here, any catalogue pointing at it will too.

import { bboxIntersects, secureUrl } from "../geo.js";
import { cogInfo } from "../cog.js";

export var UNDATED = "undated";

function sceneOf(info, i) {
  var b = info.bbox, assets = {}, meta = {};
  for (var k = 0; k < info.bands; k++) {
    assets["b" + (k + 1)] = info.href;
    meta["b" + (k + 1)] = { band: k, dataType: info.dataType };
    if (info.nodata !== null && info.nodata !== undefined) meta["b" + (k + 1)].nodata = info.nodata;
  }
  if (info.bands >= 3 && info.dataType === "Byte") {
    assets.visual = info.href;
    meta.visual = { rgb: true };
  }
  var name = decodeURIComponent(info.href.split("?")[0].split("/").pop() || "file " + (i + 1));
  return {
    id: name, day: info.date || UNDATED, datetime: info.date ? info.date + "T00:00:00Z" : null,
    geometry: { type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]],
                                                [b[0], b[3]], [b[0], b[1]]]] },
    bbox: b, cloud: null, crs: info.crs, assets: assets, assetMeta: meta,
    meta: { info: info, res: Math.abs(info.res[0]) }
  };
}

// opts.urls: array of COG URLs (or one string, newline or space separated)
export function cogCatalog(opts) {
  var urls = opts.urls;
  if (typeof urls === "string") urls = urls.split(/\s+/);
  urls = (urls || []).map(secureUrl).filter(Boolean);
  var infos = null;
  function read() {
    if (!infos) {
      infos = Promise.all(urls.map(function (u) {
        // "file.tif#crs=EPSG:3031" names the CRS of a file whose keys don't
        var m = /#crs=([^#]+)$/.exec(u), href = m ? u.slice(0, m.index) : u;
        return cogInfo(href, m ? decodeURIComponent(m[1]) : null).then(function (x) { return x; }, function (e) {
          return { href: u, error: String(e && e.message || e) };
        });
      }));
      infos.catch(function () { infos = null; });
    }
    return infos;
  }
  return {
    kind: "cog",
    label: urls.length === 1 ? urls[0] : urls.length + " COGs",
    capabilities: { cloud: false, time: false },
    // header facts for every file: { files: [info | {href, error}], bbox }
    info: async function () {
      var all = await read(), ok = all.filter(function (x) { return !x.error; });
      var bb = ok.reduce(function (a, x) {
        return [Math.min(a[0], x.bbox[0]), Math.min(a[1], x.bbox[1]),
                Math.max(a[2], x.bbox[2]), Math.max(a[3], x.bbox[3])];
      }, [180, 90, -180, -90]);
      return { files: all, bbox: ok.length ? bb : null };
    },
    search: async function (q) {
      var all = await read();
      var bad = all.filter(function (x) { return x.error; });
      var scenes = all.filter(function (x) { return !x.error; }).map(sceneOf)
        .filter(function (s) { return !q.bbox || bboxIntersects(s.bbox, q.bbox); });
      if (!scenes.length && bad.length) throw new Error(bad[0].href + ": " + bad[0].error);
      return scenes;
    }
  };
}
