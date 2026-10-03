// The map in any CRS: a Leaflet CRS built from a proj4 definition, an image
// overlay placed by its extent in that CRS, and a basemap warped into it.
//
// The composite is computed on an OutputGrid in the output CRS (geo.js
// makeGrid), so the map has to be in that CRS too for the image to sit
// still under it. Leaflet's own CRSs are Web Mercator and plate carree;
// anything else is an affine of the projected coordinates, which is all a
// Leaflet CRS needs. No live re-projection while panning: the map simply is
// that projection.
//
// Uses the page's globals L (Leaflet) and proj4.

import { ensureCrs, transformBbox } from "./geo.js";
import { readTilesWarped, webMercatorQuad } from "./tiles.js";

// Where the map starts and how far it reaches, per CRS: the polar
// stereographics cover their hemisphere south (north) of about 45 degrees.
var POLAR = [-4194304 * 1.5, -4194304 * 1.5, 4194304 * 1.5, 4194304 * 1.5];
var HOME = {
  "EPSG:3031": POLAR, "EPSG:3976": POLAR, "EPSG:3413": POLAR, "EPSG:3995": POLAR,
  "EPSG:3412": POLAR, "EPSG:3411": POLAR, "EPSG:9354": POLAR,
  "EPSG:6931": [-9e6, -9e6, 9e6, 9e6], "EPSG:6932": [-9e6, -9e6, 9e6, 9e6],
  "EPSG:4326": [-180, -90, 180, 90]
};

// A first view for a CRS with nothing else to go on: the polar ones open
// on their whole polar cap, others on wherever the map was.
export function defaultView(crs) {
  crs = ensureCrs(crs);
  return HOME[crs] && crs !== "EPSG:4326" ? [-3.6e6, -3.6e6, 3.6e6, 3.6e6].map(function (v) {
    return /^EPSG:69/.test(crs) ? v * 2 : v; }) : null;
}

// The extent a map in this CRS spans at zoom 0: a known one, else the
// given lon/lat box (the region of interest, widened) projected.
export function homeExtent(crs, lonlat) {
  crs = ensureCrs(crs);
  if (HOME[crs]) return HOME[crs].slice();
  var b = lonlat || [-180, -85, 180, 85];
  var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
  var wx = Math.max(20, (b[2] - b[0]) * 4), wy = Math.max(15, (b[3] - b[1]) * 4);
  var wide = [Math.max(-180, cx - wx / 2), Math.max(-85, cy - wy / 2),
              Math.min(180, cx + wx / 2), Math.min(85, cy + wy / 2)];
  var e = transformBbox(wide, "EPSG:4326", crs, 32);
  var s = Math.max(e[2] - e[0], e[3] - e[1]) / 2, mx = (e[0] + e[2]) / 2, my = (e[1] + e[3]) / 2;
  return [mx - s, my - s, mx + s, my + s];
}

// A Leaflet CRS for any proj4-known code. Zoom 0 shows `extent` in 256 px.
export function leafletCrs(code, extent) {
  var L = globalThis.L;
  code = ensureCrs(code);
  if (code === "EPSG:3857") return L.CRS.EPSG3857;
  extent = extent || homeExtent(code);
  var f = globalThis.proj4("EPSG:4326", code);
  var res0 = Math.max(extent[2] - extent[0], extent[3] - extent[1]) / 256;
  var projection = {
    project: function (ll) { var p = f.forward([ll.lng, ll.lat]); return L.point(p[0], p[1]); },
    unproject: function (pt) { var q = f.inverse([pt.x, pt.y]); return L.latLng(q[1], q[0]); },
    bounds: L.bounds([extent[0], extent[1]], [extent[2], extent[3]])
  };
  return L.extend({}, L.CRS, {
    code: code, projection: projection, extent: extent,
    transformation: new L.Transformation(1 / res0, -extent[0] / res0, -1 / res0, extent[3] / res0),
    scale: function (z) { return Math.pow(2, z); },
    zoom: function (s) { return Math.log(s) / Math.LN2; },
    distance: L.CRS.Earth.distance, R: L.CRS.Earth.R,
    infinite: false
  });
}

// The map view as an extent in the map's CRS.
export function viewExtent(map) {
  var crs = map.options.crs, pb = map.getPixelBounds(), z = map.getZoom();
  var a = crs.projection.project(crs.pointToLatLng(pb.min, z));
  var b = crs.projection.project(crs.pointToLatLng(pb.max, z));
  return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
}

// Fit the map to an extent in its CRS.
// (Not map.fitBounds: a LatLngBounds sorts its corners by lat and lng,
// which mixes up opposite corners of a box in a polar projection.)
export function fitExtent(map, e, pad) {
  var crs = map.options.crs, L = globalThis.L, size = map.getSize();
  pad = pad || 0;
  var w = (e[2] - e[0]) * (1 + 2 * pad), h = (e[3] - e[1]) * (1 + 2 * pad);
  // pixels per CRS unit at a zoom is |a| * scale(zoom)
  var s = Math.min(size.x / w, size.y / h) / Math.abs(crs.transformation._a);
  var z = Math.floor(crs.zoom(s));
  z = Math.max(map.getMinZoom(), Math.min(isFinite(map.getMaxZoom()) ? map.getMaxZoom() : 22, z));
  var c = crs.projection.unproject(L.point((e[0] + e[2]) / 2, (e[1] + e[3]) / 2));
  map.setView(c, z, { animate: false });
}

// A lon/lat polygon of an extent in the map's CRS, densified, for drawing
// a box that is square in that CRS.
export function extentLatLngs(map, e, n) {
  var crs = map.options.crs, L = globalThis.L, out = [];
  n = n || 16;
  var pts = [];
  for (var i = 0; i < n; i++) pts.push([e[0] + (e[2] - e[0]) * i / n, e[1]]);
  for (i = 0; i < n; i++) pts.push([e[2], e[1] + (e[3] - e[1]) * i / n]);
  for (i = 0; i < n; i++) pts.push([e[2] - (e[2] - e[0]) * i / n, e[3]]);
  for (i = 0; i < n; i++) pts.push([e[0], e[3] - (e[3] - e[1]) * i / n]);
  pts.forEach(function (p) { out.push(crs.projection.unproject(L.point(p[0], p[1]))); });
  return out;
}

// An image (or canvas) placed by its extent in the map's CRS, which a
// lon/lat bounds box cannot do once the map is not Web Mercator.
export function extentOverlayClass() {
  var L = globalThis.L;
  return L.ImageOverlay.extend({
    initialize: function (url, extent, options) {
      this._extent = extent;
      L.ImageOverlay.prototype.initialize.call(this, url, L.latLngBounds([0, 0], [0, 0]), options);
    },
    setExtent: function (e) { this._extent = e; if (this._map) this._reset(); return this; },
    _corners: function () {
      var crs = this._map.options.crs, e = this._extent;
      return [crs.projection.unproject(L.point(e[0], e[3])), crs.projection.unproject(L.point(e[2], e[1]))];
    },
    _animateZoom: function (ev) {
      var c = this._corners(), m = this._map;
      var tl = m._latLngToNewLayerPoint(c[0], ev.zoom, ev.center);
      L.DomUtil.setTransform(this._image, tl, m.getZoomScale(ev.zoom));
    },
    _reset: function () {
      var c = this._corners(), m = this._map;
      this._bounds = L.latLngBounds(c[0], c[1]);
      var tl = m.latLngToLayerPoint(c[0]), br = m.latLngToLayerPoint(c[1]);
      L.DomUtil.setPosition(this._image, tl);
      this._image.style.width = (br.x - tl.x) + "px";
      this._image.style.height = (br.y - tl.y) + "px";
    }
  });
}

// A Web Mercator tile basemap warped into the map's CRS for the current
// view (the same warp a composite uses), redrawn when the view settles.
// Nothing south of 85.05 S or north of 85.05 N: Mercator tiles stop there.
export function warpedBasemap(template, opts) {
  var L = globalThis.L, Overlay = extentOverlayClass();
  opts = opts || {};
  var src = { kind: "tiles", template: template, tms: webMercatorQuad(opts.maxzoom || 18),
              format: "rgb", label: "basemap", bbox: null };
  var layer = L.Layer.extend({
    onAdd: function (map) {
      this._map = map; this._seq = 0;
      this._ov = null;
      map.on("moveend", this._update, this);
      this._update();
    },
    onRemove: function (map) {
      map.off("moveend", this._update, this);
      if (this._ov) map.removeLayer(this._ov);
      this._ov = null;
    },
    _update: async function () {
      var map = this._map, seq = ++this._seq;
      if (!map) return;
      var e = viewExtent(map), size = map.getSize();
      var grid = { crs: map.options.crs.code, bbox: e,
                   width: Math.max(1, Math.round(size.x)), height: Math.max(1, Math.round(size.y)) };
      var r = null;
      try { r = await readTilesWarped(src, grid, { maxTiles: 96 }); } catch (err) { r = null; }
      if (seq !== this._seq || !this._map) return;
      if (!r) return;
      var n = grid.width * grid.height, rgba = new Uint8ClampedArray(n * 4);
      for (var i = 0; i < n; i++) {
        rgba[4 * i] = r.bands[0][i]; rgba[4 * i + 1] = r.bands[1][i]; rgba[4 * i + 2] = r.bands[2][i];
        rgba[4 * i + 3] = r.valid[i] ? 255 : 0;
      }
      var cv = document.createElement("canvas");
      cv.width = grid.width; cv.height = grid.height;
      cv.getContext("2d").putImageData(new ImageData(rgba, grid.width, grid.height), 0, 0);
      var ov = new Overlay(cv.toDataURL("image/png"), e, { pane: "tilePane", interactive: false });
      ov.addTo(map);
      if (this._ov) map.removeLayer(this._ov);
      this._ov = ov;
    }
  });
  return new layer();
}
