// Clear-day scan stats (lib/scan.js) over a search result.
//   node test-scan.mjs [items.json]
// Default: the small dev fixture (sanity checks only). With the output of
// make_scan_fixture.py (Tasmania to Brisbane, Apr to Jul 2026) it prints
// the top days and checks the design's validation case, 2026-06-22.
import fs from "node:fs";
import assert from "node:assert";
import { scanDays, viewDays, scanFrame, rasterize, sharpness, swathTilt, swathPolygon,
         polygonBbox } from "../lib/scan.js";
import { stacCatalog } from "../lib/sources/stac.js";

// a 10 x 10 degree region, a square footprint over its NW quarter
var f = scanFrame([140, -40, 150, -30], 100);
var m = new Uint8Array(f.nx * f.ny);
var sq = { type: "Polygon", coordinates: [[[140, -35], [145, -35], [145, -30], [140, -30], [140, -35]]] };
var n = rasterize(sq, f, m);
assert(Math.abs(n / m.length - 0.25) < 0.03, "quarter cover " + n / m.length);
assert.equal(rasterize(sq, f, m), 0, "union: nothing new the second time");
// a ring with a hole covers less
var holed = { type: "Polygon", coordinates: [sq.coordinates[0],
  [[141, -34], [144, -34], [144, -31], [141, -31], [141, -34]]] };
var m2 = new Uint8Array(f.nx * f.ny);
assert(rasterize(holed, f, m2) < n, "hole");
// flat image has no sharpness, a checkerboard plenty
var flat = new Uint8ClampedArray(32 * 32 * 4).fill(120);
assert.equal(sharpness(flat, 32, 32), 0);
var chk = new Uint8ClampedArray(32 * 32 * 4);
for (var i = 0; i < 32 * 32; i++) chk.fill(((i % 32) + (i >> 5)) % 2 ? 200 : 40, i * 4, i * 4 + 3);
assert(sharpness(chk, 32, 32) > 1000);

// ground track tilt, against the edges of real footprints (12-16 deg over
// eastern Australia) and growing toward the poles
assert(Math.abs(swathTilt(-25) - 13.0) < 0.2 && Math.abs(swathTilt(-44) - 14.7) < 0.2);
assert.equal(swathTilt(30).toFixed(6), swathTilt(-30).toFixed(6));
// a swath-aligned region keeps the box's north and south edges and width,
// and its north edge is east of its south edge
var sp = swathPolygon([150, -40, 152, -30]).coordinates[0], pb = polygonBbox({ type: "Polygon", coordinates: [sp] });
assert.equal(pb[1], -40); assert.equal(pb[3], -30);
assert(Math.abs((sp[24][0] - sp[25][0]) - 2) < 1e-9 && sp[24][0] > sp[0][0] + 2.5);
// cover inside the region only: a footprint equal to the region covers all of it
var reg = swathPolygon([150, -40, 152, -30]);
var one = scanDays([{ id: "a", day: "2026-01-01", cloud: 0, geometry: reg }], pb, { region: reg });
assert(one[0].extent > 0.97, "cover inside region " + one[0].extent);

var file = process.argv[2] || new URL("./fixtures/items.json", import.meta.url).pathname;
var raw = JSON.parse(fs.readFileSync(file));
var feats = raw.features || raw;
var bbox = process.argv[2] ? [145.283, -44.269, 155.566, -22.999] : [146, -44, 149, -40];
globalThis.fetch = async () => ({ ok: true, json: async () => ({ features: feats, links: [] }) });
var scenes = await stacCatalog({ url: "http://x", collection: "c" }).search({ bbox, maxItems: 1e6 });
var t0 = performance.now();
var days = scanDays(scenes, bbox, { cloudMax: 20 });
var ms = performance.now() - t0;
console.log(scenes.length, "scenes,", days.length, "days under 20% cloud,", ms.toFixed(0), "ms");
days.forEach(function (d) {
  assert(d.nClear <= d.nAll && d.completeness > 0 && d.completeness <= 1);
  assert(d.extent >= 0 && d.extent <= 1);
});
assert(scanDays(scenes, bbox, { cloudMax: 100 }).length >= days.length, "a looser limit keeps more days");
var top = viewDays(days, { sort: "extent" });
top.slice(0, 12).forEach(function (d, k) {
  console.log(String(k + 1).padStart(2), d.day, "cover", (100 * d.extent).toFixed(1) + "%",
    "clear", d.nClear + "/" + d.nAll, "(" + (100 * d.completeness).toFixed(0) + "%)",
    "cloud", d.cloudMin.toFixed(1) + "-" + d.cloudMax.toFixed(1));
});
if (process.argv[2]) {
  ["2026-06-20", "2026-06-22", "2026-06-24"].forEach(function (day) {
    var k = top.findIndex(function (d) { return d.day === day; });
    console.log(day, "rank", k + 1, "of", top.length);
  });
  var r = top.findIndex(function (d) { return d.day === "2026-06-22"; });
  assert(r >= 0 && r < 3, "2026-06-22 ranks in the top three on extent");
}
console.log("ok");
