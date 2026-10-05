// Headless Zarr check: node test-zarr.mjs "<permalink hash with day=>" out.png
// Loads the day, steps to the next one (should come from the chunk cache),
// draws "last read" and prints the status lines (NOSTEP=1: no step, for a
// store with one day). Needs `node server.mjs`
// and `npm run bundle-zarrita`.
import { chromium } from "playwright";
const NM = process.cwd() + "/node_modules/";
const map = { "leaflet.min.css": NM + "leaflet/dist/leaflet.css", "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js", "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "hyparquet@1/+esm": process.cwd() + "/hyparquet.esm.js",
  "hyparquet-compressors@1/+esm": process.cwd() + "/hyparquet-compressors.esm.js", "zarrita@0.7/+esm": process.cwd() + "/zarrita.esm.js",
  "icechunk-js@0.6/+esm": process.cwd() + "/icechunk.esm.js" };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true })).newPage();
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.route(/cdnjs|jsdelivr/, r => { const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
  if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : "text/javascript" }); return r.abort(); });
await page.route(/arcgisonline/, r => r.abort());
const done = () => page.waitForFunction(() => { const s = document.getElementById("status").textContent; return / ms/.test(s) && !/reading|searching/.test(s) || document.querySelector('#status .err'); }, null, { timeout: 120000 });
const st = async l => console.log(l, (await page.textContent("#status")).replace(/\s+/g, " "));
await page.goto("http://localhost:8765/#" + process.argv[2]);
await page.waitForTimeout(1500); await done(); await st("load:");
console.log("info:", await page.textContent("#zarrInfo"));
// EVAL: an expression over the shown composite (c), e.g. a row of values
if (process.env.EVAL) console.log("eval:", JSON.stringify(await page.evaluate(new Function("var e = window.explorer, c = e.state.comp || e.state.base; return (" + process.env.EVAL + ");"))));
if (!process.env.NOSTEP) {
  await page.evaluate(() => document.getElementById("status").textContent = "");
  await page.evaluate(() => window.explorer.stepDay(1)); await page.waitForTimeout(300); await done(); await st("step:");
}
if (process.env.MAPSHOT) await page.screenshot({ path: process.env.MAPSHOT });
await page.click("#inspLast"); await page.waitForTimeout(300);
console.log("last:", await page.textContent("#inspInfo"));
await page.screenshot({ path: process.argv[3] || "zarr.png" });
await browser.close();
