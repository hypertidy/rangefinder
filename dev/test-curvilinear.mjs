// Checks lib/curvilinear.js on a real ROMS grid (CBOFS, from
// make_roms_fixture.py). ROMS gives each rho cell's corners as psi points,
// so the truth for a pixel is the water cell whose psi quadrilateral (in
// lon/lat) holds the pixel centre, found by brute force. For output grids
// in several CRSs, the cell the rasteriser gives each pixel (land cells
// count as no data, as in the reader: their made-up coordinates overlap the
// water) must be that cell, another water cell whose quad also holds the
// pixel, or a neighbour of it when the pixel centre sits on a shared edge. With CENTRES=1 the footprints are built half way
// between centres instead, and the same comparison measures how far that
// approximation is from the model's own cells (reported, not failed).
// node test-curvilinear.mjs
import fs from "fs";
import proj4 from "proj4";
import { footprints, projectFootprints, rasterCells, centresBbox } from "../lib/curvilinear.js";
globalThis.proj4 = proj4;
proj4.defs("EPSG:32618", "+proj=utm +zone=18 +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:3031", "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs");

const Z = "fixtures/refs/roms/cbofs.zarr/";
const zlib = await import("zlib");
function read(name) {
  const m = JSON.parse(fs.readFileSync(Z + name + "/.zarray"));
  const buf = zlib.inflateSync(fs.readFileSync(Z + name + "/0.0"));
  return { shape: m.shape, data: new Float64Array(buf.buffer, buf.byteOffset, buf.length / 8) };
}
const lon = read("lon_rho"), lat = read("lat_rho"), mask = read("mask_rho").data;
const [H, W] = lon.shape;
const psi = [read("lon_psi").data, read("lat_psi").data];
const fp = footprints(lon.data, lat.data, W, H, process.env.CENTRES ? null : { psi });
console.log("footprints from", fp.from);
const bb = centresBbox(lon.data, lat.data);
console.log("grid", W, "x", H, "bbox", bb.map(v => v.toFixed(3)).join(","));

const truthFp = footprints(lon.data, lat.data, W, H, { psi });
function inQuad(k, lo, la) {   // planar test in lon/lat, which is fine at these sizes
  const X = truthFp.lon, Y = truthFp.lat, o = 4 * k;
  let inside = false;
  for (let a = 0, b = 3; a < 4; b = a++) {
    const xa = X[o + a], ya = Y[o + a], xb = X[o + b], yb = Y[o + b];
    if ((ya > la) !== (yb > la) && lo < (xb - xa) * (la - ya) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
function truth(lo, la) {
  for (let k = 0; k < W * H; k++) if (mask[k] && inQuad(k, lo, la)) return k;
  return -1;
}
let fails = 0;
for (const crs of ["EPSG:4326", "EPSG:3857", "EPSG:32618"]) {
  // a box in the middle of the bay, about 60 x 80 pixels at 3 cells each
  const box = [-76.5, 38.0, -76.2, 38.4];
  const t = proj4("EPSG:4326", crs);
  const pts = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(p => t.forward(p));
  const ext = [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])),
               Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  const grid = { crs, bbox: ext, width: 90, height: 120 };
  const t0 = performance.now();
  const pf = projectFootprints(fp, crs);
  const t1 = performance.now();
  const rc0 = rasterCells(pf, grid);
  const rc = rasterCells(pf, grid, { window: rc0.window, keep: k => mask[k] > 0 });   // as the reader does
  const t2 = performance.now();
  const inv = proj4(crs, "EPSG:4326");
  const dx = (ext[2] - ext[0]) / grid.width, dy = (ext[3] - ext[1]) / grid.height;
  let have = 0, same = 0, near = 0, far = 0, overlap = 0;
  for (let y = 0; y < grid.height; y += 3) {
    for (let x = 0; x < grid.width; x += 3) {
      const p = y * grid.width + x;
      const k = rc.cell[p];
      const ll = inv.forward([ext[0] + (x + 0.5) * dx, ext[3] - (y + 0.5) * dy]);
      const n = truth(ll[0], ll[1]);
      if (k < 0 && n < 0) continue;   // land
      if (k < 0 || n < 0) { far++; if (process.env.VERBOSE) console.log("  pixel", x, y, "cell", k, "truth", n); continue; }
      have++;
      if (k === n) same++;
      else if (inQuad(k, ll[0], ll[1])) overlap++;   // the model's own cells overlap here
      else if (Math.abs((k % W) - (n % W)) <= 1 && Math.abs(Math.floor(k / W) - Math.floor(n / W)) <= 1) near++;
      else { far++; if (process.env.VERBOSE) console.log("  pixel", x, y, "cell", k % W, Math.floor(k / W), "truth", n % W, Math.floor(n / W)); }
    }
  }
  const ok = process.env.CENTRES ? true : far === 0 && same / have > 0.97;
  if (!ok) fails++;
  console.log(crs, ok ? "ok" : "FAIL", "water pixels", have, "same cell", same, "another cell holding it", overlap, "neighbour", near, "other", far,
              "window", rc.window.join(","), "project", (t1 - t0).toFixed(0), "ms, raster", (t2 - t1).toFixed(0), "ms");
}

// the whole grid in polar stereographic (no seam), and in a lon/lat grid
// across the antimeridian built by shifting the same grid by 180 degrees
{
  const grid = { crs: "EPSG:4326", bbox: [-180, 36, 180, 40], width: 3600, height: 40 };
  const shifted = new Float64Array(lon.data.length);
  for (let k = 0; k < shifted.length; k++) shifted[k] = lon.data[k] + 77.5 + 180;   // centred on 180
  const fps = footprints(shifted, lat.data, W, H);
  const rc = rasterCells(projectFootprints(fps, "EPSG:4326"), grid);
  let east = 0, west = 0;
  for (let p = 0; p < rc.cell.length; p++) if (rc.cell[p] >= 0) { if (p % grid.width < grid.width / 2) west++; else east++; }
  const ok = east > 0 && west > 0 && rc.window[2] - rc.window[0] > W * 0.9;
  if (!ok) fails++;
  console.log("antimeridian", ok ? "ok" : "FAIL", "pixels west", west, "east", east, "window", rc.window.join(","));
}
process.exit(fails ? 1 : 0);
