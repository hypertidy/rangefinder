// Headless check of the map/output CRS: node test-crs.mjs "<permalink hash>" "utm,EPSG:3577,EPSG:3857"
// loads the permalink, then picks each CRS in turn from the picker, printing the
// status line and hash and saving /tmp/claude-0/sw-<crs>.png. Esri imagery (not
// reachable from the dev container) is stood in for by the AWS terrain tiles.
import { chromium } from "playwright";
const NM = process.cwd() + "/node_modules/";
const map = { "leaflet.min.css": NM + "leaflet/dist/leaflet.css", "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js", "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "zarrita@0.7/+esm": process.cwd() + "/zarrita.esm.js" };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true })).newPage();
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.route(/cdnjs|jsdelivr/, r => { const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
  if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : "text/javascript" }); return r.abort(); });
// stand in for Esri imagery (unreachable here) with the AWS terrain tiles
await page.route(/arcgisonline/, r => { const m = /tile\/(\d+)\/(\d+)\/(\d+)/.exec(r.request().url()); if (!m) return r.abort();
  return r.continue({ url: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${m[1]}/${m[3]}/${m[2]}.png` }); });
const done = () => page.waitForFunction(() => { const s = document.getElementById("status").textContent; return / ms/.test(s) && !/reading|searching/.test(s) || document.querySelector('#status .err'); }, null, { timeout: 120000 }).catch(() => console.log("timeout"));
const st = async l => console.log(l, (await page.textContent("#status")).replace(/\s+/g, " ").slice(0, 250));
await page.goto("http://localhost:8765/#" + process.argv[2]);
await page.waitForTimeout(1500); await done(); await st("load:");
for (const step of (process.argv[3] || "").split(",").filter(Boolean)) {
  await page.evaluate(() => document.getElementById("status").textContent = "");
  await page.selectOption("#ocrs", step); await page.waitForTimeout(800); await done(); await page.waitForTimeout(2500);
  await st(step + ":"); console.log("hash", await page.evaluate(() => location.hash.slice(0, 200)));
  await page.screenshot({ path: (process.env.OUT || "/tmp/claude-0") + "/sw-" + step.replace(":", "") + ".png" });
}
await browser.close();
