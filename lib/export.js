// Export: the composite's values as a GeoTIFF, and a JSON sidecar that says
// where they came from.
//
// geotiffBytes(comp, opts) -> ArrayBuffer
//   A plain (uncompressed, one strip per band, band-separate) little-endian
//   GeoTIFF of the composite's stored values, in their own data type, on the
//   output grid: EPSG code as a GeoKey when the grid's CRS is one, the
//   pixel size and top-left corner as ModelPixelScale/ModelTiepoint, pixel
//   is area. Pixels no scene covered get a nodata value (NaN for floats).
//   GDAL_METADATA carries each band's name, offset and unit, so GDAL reads
//   "stored + offset" the way rangefinder shows it.
//   opts.names   band names (default the composite's keys)
//   opts.offset  per-band offset added to stored values (L2A), or a number
//   opts.units   per-band unit strings
//   opts.extra   { key: value } dataset-level metadata items
//
// sourceVrt(comp, opts) -> string
//   A GDAL VRT that rebuilds the composite from its sources rather than
//   holding pixels: per band, an inline GTI (GDAL tile index, GDAL >= 3.9)
//   whose tiles are the source files over /vsicurl/, sorted so the scene
//   rangefinder ranks first is drawn on top, warped by GDAL to the same
//   grid. COG-backed sources (STAC, starc, wildtiles, VRT, COG files) and
//   Zarr (GDAL's Zarr driver, one 2-D slice, packing kept); not tile servers.
//
// pamXml(grid, extra) -> a GDAL PAM sidecar (.aux.xml) placing a picture of
//   the grid (the PNG as shown) in its CRS, with provenance as metadata.

import { isGeographic, transformBbox } from "./geo.js";

function tiffType(arr) {
  // [BitsPerSample, SampleFormat (1 uint, 2 int, 3 float), bytes]
  if (arr instanceof Float64Array) return [64, 3, 8];
  if (arr instanceof Float32Array) return [32, 3, 4];
  if (arr instanceof Int32Array) return [32, 2, 4];
  if (arr instanceof Uint32Array) return [32, 1, 4];
  if (arr instanceof Int16Array) return [16, 2, 2];
  if (arr instanceof Uint16Array) return [16, 1, 2];
  if (arr instanceof Int8Array) return [8, 2, 1];
  return [8, 1, 1];
}

// A nodata value no valid pixel uses: NaN for floats, else the type's
// lowest (signed) or 0 / highest (unsigned) value.
function pickNodata(comp, fmt) {
  if (fmt[1] === 3) return NaN;
  var lo = fmt[1] === 2 ? -Math.pow(2, fmt[0] - 1) : 0;
  var hi = fmt[1] === 2 ? Math.pow(2, fmt[0] - 1) - 1 : Math.pow(2, fmt[0]) - 1;
  var used = function (v) {
    for (var c = 0; c < comp.channels.length; c++) {
      var ch = comp.channels[c];
      for (var i = 0; i < ch.length; i++) if (comp.valid[i] && ch[i] === v) return true;
    }
    return false;
  };
  if (!used(lo)) return lo;
  if (!used(hi)) return hi;
  return null;
}

function epsgOf(crs) {
  var m = /^EPSG:(\d+)$/i.exec(String(crs || ""));
  return m ? +m[1] : null;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function geotiffBytes(comp, opts) {
  opts = opts || {};
  var g = comp.grid, W = g.width, H = g.height, nb = comp.channels.length;
  var fmt = tiffType(comp.channels[0]), bps = fmt[2];
  var nodata = pickNodata(comp, fmt);
  var names = opts.names || comp.keys || [];
  var offs = typeof opts.offset === "number" || opts.offset === undefined || opts.offset === null
    ? comp.channels.map(function () { return +opts.offset || 0; }) : opts.offset;
  var units = opts.units || [];
  var epsg = epsgOf(g.crs);
  var geographic = epsg !== null && isGeographic(g.crs);

  // GDAL_METADATA. GDAL escapes item values once more than the XML needs
  // and unescapes them twice on reading, so values are escaped twice here.
  var val = function (v) { return xmlEscape(xmlEscape(v)); };
  var items = [];
  Object.keys(opts.extra || {}).forEach(function (k) {
    items.push('<Item name="' + xmlEscape(k) + '">' + val(opts.extra[k]) + "</Item>");
  });
  for (var b = 0; b < nb; b++) {
    if (names[b]) items.push('<Item name="DESCRIPTION" sample="' + b + '" role="description">' + val(names[b]) + "</Item>");
    if (offs[b]) {
      items.push('<Item name="OFFSET" sample="' + b + '" role="offset">' + offs[b] + "</Item>");
      items.push('<Item name="SCALE" sample="' + b + '" role="scale">1</Item>');
    }
    if (units[b]) items.push('<Item name="UNITTYPE" sample="' + b + '" role="unittype">' + val(units[b]) + "</Item>");
  }
  var gdalMeta = items.length ? "<GDALMetadata>" + items.join("") + "</GDALMetadata>" : null;

  // GeoKeys: model type, raster type (pixel is area), the EPSG code
  var keys = [[1024, epsg === null ? 0 : geographic ? 2 : 1], [1025, 1]];
  if (epsg !== null) keys.push([geographic ? 2048 : 3072, epsg]);
  if (epsg === null) keys = [[1025, 1]];
  var geoDir = [1, 1, 0, keys.length];
  keys.forEach(function (k) { geoDir.push(k[0], 0, 1, k[1]); });

  // a baked RGB product is RGB; other bands are grey plus unspecified extras
  var rgb = comp.kind === "rgb8" && nb === 3;
  var extraSamples = [];
  for (var e = rgb ? 3 : 1; e < nb; e++) extraSamples.push(0);
  var px = (g.bbox[2] - g.bbox[0]) / W, py = (g.bbox[3] - g.bbox[1]) / H;
  var ascii = function (s) { return s + "\0"; };
  // tag, type (3 SHORT, 4 LONG, 12 DOUBLE, 2 ASCII), values
  var stripBytes = W * H * bps;
  var tags = [
    [256, 4, [W]], [257, 4, [H]],
    [258, 3, comp.channels.map(function () { return fmt[0]; })],
    [259, 3, [1]],                                        // no compression
    [262, 3, [rgb ? 2 : 1]],                              // RGB or min-is-black
    [273, 4, null],                                       // strip offsets, filled below
    [277, 3, [nb]],
    [278, 4, [H]],
    [279, 4, comp.channels.map(function () { return stripBytes; })],
    [284, 3, [2]],                                        // band-separate
    [305, 2, ascii("rangefinder")],
    [338, 3, extraSamples],
    [339, 3, comp.channels.map(function () { return fmt[1]; })],
    [33550, 12, [px, py, 0]],
    [33922, 12, [0, 0, 0, g.bbox[0], g.bbox[3], 0]],
    [34735, 3, geoDir]
  ];
  if (!extraSamples.length) tags = tags.filter(function (t) { return t[0] !== 338; });
  if (gdalMeta) tags.push([42112, 2, ascii(gdalMeta)]);
  if (nodata !== null) tags.push([42113, 2, ascii(nodata !== nodata ? "nan" : String(nodata))]);
  tags.sort(function (a, b2) { return a[0] - b2[0]; });

  var size = { 2: 1, 3: 2, 4: 4, 12: 8 };
  function count(t) { return t[2] === null ? nb : t[2].length; }
  // layout: header, IFD, out-of-line tag values, then the strips
  var ifdLen = 2 + tags.length * 12 + 4;
  var extra = 0;
  tags.forEach(function (t) { var n = count(t) * size[t[1]]; if (n > 4) extra += n + (n & 1); });
  var dataStart = 8 + ifdLen + extra;
  dataStart += (8 - dataStart % 8) % 8;
  var total = dataStart + nb * stripBytes;
  var buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  var p = 8, ext = 8 + ifdLen;
  dv.setUint16(p, tags.length, true); p += 2;
  tags.forEach(function (t) {
    var vals = t[2] === null ? comp.channels.map(function (_, i) { return dataStart + i * stripBytes; }) : t[2];
    var n = count(t), len = n * size[t[1]];
    dv.setUint16(p, t[0], true); dv.setUint16(p + 2, t[1], true); dv.setUint32(p + 4, n, true);
    var at = len > 4 ? ext : p + 8;
    if (len > 4) { dv.setUint32(p + 8, ext, true); ext += len + (len & 1); }
    for (var i = 0; i < n; i++) {
      if (t[1] === 2) dv.setUint8(at + i, vals.charCodeAt(i) & 0x7f);
      else if (t[1] === 3) dv.setUint16(at + 2 * i, vals[i], true);
      else if (t[1] === 4) dv.setUint32(at + 4 * i, vals[i], true);
      else dv.setFloat64(at + 8 * i, vals[i], true);
    }
    p += 12;
  });
  dv.setUint32(p, 0, true);   // no next IFD

  // strips: the values, with nodata where no scene contributed
  var Ctor = comp.channels[0].constructor;
  for (var c = 0; c < nb; c++) {
    var out = new Ctor(W * H), ch = comp.channels[c];
    for (var i = 0; i < W * H; i++) out[i] = comp.valid[i] || nodata === null ? ch[i] : nodata;
    var bytes = new Uint8Array(out.buffer);
    if (!littleEndian()) swapInto(bytes, bps);
    u8.set(bytes, dataStart + c * stripBytes);
  }
  return buf;
}

var LE = null;
function littleEndian() {
  if (LE === null) LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  return LE;
}
function swapInto(b, n) {
  for (var i = 0; i < b.length; i += n) {
    for (var j = 0; j < n / 2; j++) { var t = b[i + j]; b[i + j] = b[i + n - 1 - j]; b[i + n - 1 - j] = t; }
  }
}

var GDAL_TYPES = [[Float64Array, "Float64"], [Float32Array, "Float32"], [Int32Array, "Int32"],
                  [Uint32Array, "UInt32"], [Int16Array, "Int16"], [Uint16Array, "UInt16"],
                  [Int8Array, "Int8"]];
var ZARR_TYPES = { int8: "Int8", uint8: "Byte", int16: "Int16", uint16: "UInt16", int32: "Int32",
                   uint32: "UInt32", float32: "Float32", float64: "Float64",
                   i1: "Int8", u1: "Byte", i2: "Int16", u2: "UInt16", i4: "Int32", u4: "UInt32",
                   f4: "Float32", f8: "Float64" };
function gdalType(arr) {
  for (var i = 0; i < GDAL_TYPES.length; i++) if (arr instanceof GDAL_TYPES[i][0]) return GDAL_TYPES[i][1];
  return "Byte";
}
function gdalHref(h) {
  if (/^s3:\/\//.test(h)) return "/vsis3/" + h.slice(5);
  if (/^gs:\/\//.test(h)) return "/vsigs/" + h.slice(5);
  return /^https?:\/\//.test(h) ? "/vsicurl/" + h : h;
}
function geoTransform(g) {
  var b = g.bbox;
  return [b[0], (b[2] - b[0]) / g.width, 0, b[3], 0, -(b[3] - b[1]) / g.height].join(",");
}
function metadataXml(items) {
  var keys = Object.keys(items || {});
  if (!keys.length) return "";
  return "<Metadata>" + keys.map(function (k) {
    return '<MDI key="' + xmlEscape(k) + '">' + xmlEscape(items[k]) + "</MDI>";
  }).join("") + "</Metadata>";
}

//   opts.names, opts.offset, opts.units   as for geotiffBytes
//   opts.nodata   per-band nodata of the sources (default 0, as rangefinder reads them)
//   opts.extra    { key: value } dataset metadata (provenance)
// Throws when a scene's asset is not a file GDAL can open as a raster.
export function sourceVrt(comp, opts) {
  opts = opts || {};
  var g = comp.grid, keys = comp.keys || [], scenes = comp.scenes || [];
  var dtype = gdalType(comp.channels[0]), gt = geoTransform(g);
  var names = opts.names || keys;
  var offs = typeof opts.offset === "number" || opts.offset === undefined || opts.offset === null
    ? comp.channels.map(function () { return +opts.offset || 0; }) : opts.offset;
  var units = opts.units || [];
  var nodata = opts.nodata || [];
  var n = scenes.length;
  // A packed Zarr variable stays packed: its own type, fill and
  // scale/offset, which GDAL applies on request as rangefinder did on reading.
  function packing(key) {
    var s0 = scenes[0], m = s0 && s0.assetMeta && s0.assetMeta[key];
    var z = m && m.gdal;
    if (!z) return null;
    var t = ZARR_TYPES[String(z.dtype).replace(/^[<>|]/, "")] || "Float32";
    return { dtype: t, nodata: z.fill === null || z.fill === undefined ? (/Float/.test(t) ? "nan" : null) : z.fill,
             scale: z.scale, offset: z.offset };
  }
  // one tile index per asset key: its files, the first-ranked on top
  function gti(key, bandCount, nd, dt) {
    var feats = scenes.map(function (s, p) {
      var a = s.assets[key], href;
      var m = (s.assetMeta && s.assetMeta[key]) || {};
      if (a && a.kind === "zarr" && /\.json(\?|#|$)/i.test(a.url)) {
        throw new Error("Kerchunk references are not exported as a VRT yet (GDAL reads them from 3.11)");
      }
      if (a && a.kind === "zarr" && m.gdal) {
        // GDAL's Zarr driver: one 2-D slice, with the CRS rangefinder used
        href = 'vrt://ZARR:"' + gdalHref(a.url) + '":/' + a.variable +
          m.gdal.slice.map(function (x) { return ":" + x; }).join("") + "?a_srs=" + s.crs;
      } else if (typeof a === "string" || (a && a.href && !a.kind)) {
        href = gdalHref(typeof a === "string" ? a : a.href);
        if (m.band !== undefined && bandCount === 1) href = "vrt://" + href + "?bands=" + (m.band + 1);
      } else {
        throw new Error("this source's assets are not files GDAL can mosaic (" + (a && a.kind || "unknown") + ")");
      }
      var b;
      try { b = s.bbox ? transformBbox(s.bbox, "EPSG:4326", g.crs, 16) : null; } catch (e) { b = null; }
      if (!b || !b.every(isFinite)) b = g.bbox;
      return { type: "Feature", properties: { location: href, priority: n - p, scene: s.id },
               geometry: { type: "Polygon", coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]],
                                                           [b[0], b[3]], [b[0], b[1]]]] } };
    });
    var fc = { type: "FeatureCollection", features: feats };
    var ep = epsgOf(g.crs);
    if (ep !== null) fc.crs = { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::" + ep } };
    return "<GDALTileIndexDataset>" +
      "<IndexDataset>" + xmlEscape(JSON.stringify(fc)) + "</IndexDataset>" +
      "<LocationField>location</LocationField><SortField>priority</SortField>" +
      "<SRS>" + xmlEscape(g.crs) + "</SRS>" +
      "<XSize>" + g.width + "</XSize><YSize>" + g.height + "</YSize><GeoTransform>" + gt + "</GeoTransform>" +
      "<BandCount>" + bandCount + "</BandCount><DataType>" + (dt || dtype) + "</DataType>" +
      (nd === null ? "" : "<NoData>" + nd + "</NoData>") + "<Resampling>nearest</Resampling>" +
      "</GDALTileIndexDataset>";
  }
  var bands = [];
  if (comp.kind === "rgb8") {
    var src = gti(keys[0], 3, nodata[0] !== undefined ? nodata[0] : 0);
    for (var c = 0; c < 3; c++) bands.push(band(c, src, c + 1, null));
  } else {
    keys.forEach(function (k, c) {
      var pk = packing(k);
      var nd = pk ? pk.nodata : nodata[c] !== undefined && nodata[c] !== null ? nodata[c] : 0;
      bands.push(band(c, gti(k, 1, nd, pk && pk.dtype), 1, pk));
    });
  }
  function band(c, src, sb, pk) {
    var nd = pk ? pk.nodata : nodata[c] !== undefined && nodata[c] !== null ? nodata[c] : 0;
    var scale = pk ? pk.scale : 1, off = (pk ? pk.offset : 0) + (offs[c] || 0);
    return '  <VRTRasterBand dataType="' + (pk ? pk.dtype : dtype) + '" band="' + (c + 1) + '">\n' +
      (names[c] ? "    <Description>" + xmlEscape(names[c]) + "</Description>\n" : "") +
      (nd === null ? "" : "    <NoDataValue>" + nd + "</NoDataValue>\n") +
      (off || scale !== 1 ? "    <Offset>" + off + "</Offset>\n    <Scale>" + scale + "</Scale>\n" : "") +
      (units[c] ? "    <UnitType>" + xmlEscape(units[c]) + "</UnitType>\n" : "") +
      '    <SimpleSource>\n      <SourceFilename relativeToVRT="0">' + xmlEscape(src) + "</SourceFilename>\n" +
      "      <SourceBand>" + sb + "</SourceBand>\n    </SimpleSource>\n  </VRTRasterBand>\n";
  }
  return '<VRTDataset rasterXSize="' + g.width + '" rasterYSize="' + g.height + '">\n' +
    "  <SRS>" + xmlEscape(g.crs) + "</SRS>\n  <GeoTransform>" + gt + "</GeoTransform>\n" +
    "  " + metadataXml(opts.extra) + "\n" + bands.join("") + "</VRTDataset>\n";
}

export function pamXml(grid, extra) {
  return "<PAMDataset>\n  <SRS>" + xmlEscape(grid.crs) + "</SRS>\n  <GeoTransform>" + geoTransform(grid) +
    "</GeoTransform>\n  " + metadataXml(extra) + "\n</PAMDataset>\n";
}

// Trigger a browser download of a Blob or ArrayBuffer.
export function download(data, name, type) {
  var blob = data instanceof Blob ? data : new Blob([data], { type: type || "application/octet-stream" });
  var a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
}
