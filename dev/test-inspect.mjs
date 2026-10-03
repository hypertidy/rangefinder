// Headless check of the tile inspector:
//   node test-inspect.mjs "<permalink hash>" '[[lat, lon], zoom]' "Grid:6,Probe:6,Walk:9,Last" out.png
// Each step clicks an inspector button (optionally choosing a level first)
// and prints the inspector's summary. Same setup as test.mjs.
import { chromium } from "playwright";
const NM = process.cwd() + "/node_modules/";
const map = { "leaflet.min.css": NM + "leaflet/dist/leaflet.css", "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js", "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "hyparquet@1/+esm": process.cwd() + "/hyparquet.esm.js" };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true })).newPage();
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.route(/cdnjs|jsdelivr/, r => { const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
  if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : "text/javascript" }); return r.abort(); });
await page.route(/arcgisonline/, r => r.abort());
await page.goto((process.env.BASE || "http://localhost:8765/") + "#" + process.argv[2]);
await page.waitForTimeout(2000);
await page.evaluate(v => window.explorer.map.setView(v[0], v[1], { animate: false }), JSON.parse(process.argv[3]));
await page.waitForTimeout(800);
for (const step of process.argv[4].split(",")) {
  const [btn, lvl] = step.split(":");
  if (lvl) await page.selectOption("#inspLevel", lvl);
  await page.click("#insp" + btn);
  await page.waitForFunction(() => !/probing|walking/.test(document.getElementById("inspInfo").textContent), null, { timeout: 120000 });
  console.log(btn, "->", await page.textContent("#inspInfo"));
}
await page.evaluate(() => document.getElementById("panel").scrollTop = 10000);
await page.screenshot({ path: process.argv[5] || "inspect.png" });
await browser.close();
