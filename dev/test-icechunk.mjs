// Headless Icechunk check against the local fixture (python3
// make_icechunk_fixture.py; node server.mjs; npm run bundle-zarrita and
// bundle-icechunk): the repository is found by sniffing, its sharded array
// reads the values the fixture wrote, ?tag= and ?snapshot= read the older
// commit, and a branch's resolved snapshot lands in the permalink.
// Optionally REMOTE=1 also opens dynamical.org's GFS analysis repository.
import { chromium } from "playwright";
import fs from "node:fs";
const NM = process.cwd() + "/node_modules/";
const map = { "leaflet.min.css": NM + "leaflet/dist/leaflet.css", "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js", "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "hyparquet@1/+esm": process.cwd() + "/hyparquet.esm.js",
  "hyparquet-compressors@1/+esm": process.cwd() + "/hyparquet-compressors.esm.js", "zarrita@0.7/+esm": process.cwd() + "/zarrita.esm.js",
  "icechunk-js@0.6/+esm": process.cwd() + "/icechunk.esm.js" };
const snaps = JSON.parse(fs.readFileSync("fixtures/icechunk/snapshots.json"));
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const q = encodeURIComponent, ROI = "&zvar=sst&roi=140,-44,152,-36&from=2025-01-01&to=2025-01-03&day=2025-01-03";
let fails = 0;
async function run(name, hash, want) {
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("pageerror:", e.message));
  await page.route(/cdnjs|jsdelivr/, r => { const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
    if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : "text/javascript" }); return r.abort(); });
  await page.route(/arcgisonline/, r => r.abort());
  await page.goto("http://localhost:8765/#" + hash);
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => { const s = document.getElementById("status").textContent; return / ms/.test(s) && !/reading|searching/.test(s) || document.querySelector('#status .err'); }, null, { timeout: 120000 });
  const got = await page.evaluate(() => ({ status: document.getElementById("status").textContent.replace(/\s+/g, " "),
    info: document.getElementById("zarrInfo").textContent, hash: location.hash, url: document.getElementById("zarrUrl").value }));
  const bad = Object.keys(want).filter(k => !want[k].test(got[k]));
  console.log((bad.length ? "FAIL " : "ok   ") + name + (bad.length ? "\n  " + bad.map(k => k + ": " + got[k]).join("\n  ") : ""));
  fails += bad.length ? 1 : 0;
  await page.close();
}
const L = "http://localhost:8765/ic/sst";
// day 3 = 20 + lon index / 100 + lat index / 10000 on main; zeros at tag v1
await run("sniffed, branch main", "src=zarr&zarr=" + q(L) + ROI,
  { status: /min 20, max 20\.5939/, info: new RegExp("branch main at snapshot " + snaps.main), hash: new RegExp("zsnap=" + snaps.main) });
await run("icechunk+ prefix, tag v1", "src=zarr&zarr=" + q("icechunk+" + L + "?tag=v1") + ROI,
  { status: /min 0, max 0,/, info: new RegExp("tag v1 at snapshot " + snaps.v1) });
await run("snapshot pinned by the permalink", "src=zarr&zarr=" + q(L + "#icechunk") + "&zsnap=" + snaps.v1 + ROI,
  { status: /min 0, max 0,/, url: new RegExp("\\?snapshot=" + snaps.v1 + "$"), hash: /^((?!zsnap).)*$/ });
if (process.env.REMOTE) {
  await run("dynamical.org GFS analysis", "src=zarr&zarr=" + q("https://dynamical-noaa-gfs.s3.amazonaws.com/noaa-gfs-analysis/v0.1.0.icechunk") +
    "&zvar=temperature_2m&roi=140,-48,155,-36&from=2025-01-02&to=2025-01-02&day=2025-01-02",
    { status: /valid px: temperature_2m: min/, info: /Icechunk repository, branch main/ });
}
await browser.close();
process.exit(fails ? 1 : 0);
