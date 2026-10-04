// Headless check of the exports: node test-export.mjs "<permalink hash>" outdir
// Loads the hash, then clicks GeoTIFF, source VRT and PNG (with its
// .aux.xml) and saves each download into outdir (check them with GDAL afterwards).
import { chromium } from "playwright";
import { mkdirSync } from "fs";
const NM = process.cwd() + "/node_modules/";
const map = {
  "leaflet.min.css": NM + "leaflet/dist/leaflet.css",
  "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js",
  "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "hyparquet@1/+esm": process.cwd() + "/hyparquet.esm.js",
  "zarrita@0.7/+esm": process.cwd() + "/zarrita.esm.js",
};
const out = process.argv[3] || "export-out";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true, acceptDownloads: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.route(/cdnjs|jsdelivr/, r => {
  const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
  if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : "text/javascript", headers: { "Access-Control-Allow-Origin": "*" } });
  return r.abort();
});
await page.route(/arcgisonline|openstreetmap/, r => r.abort());
await page.goto((process.env.BASE || "http://localhost:8765/") + "#" + process.argv[2]);
await page.waitForFunction(() => {
  const s = document.getElementById("status").textContent;
  return / ms/.test(s) && !/reading|searching|scenes read/.test(s) || document.querySelector("#status .err");
}, null, { timeout: 120000 }).catch(() => console.log("timeout"));
for (const id of ["expTif", "expVrt", "expPng"]) {
  const dl = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
  await page.click("#" + id);
  const d = await dl;
  if (d) { await d.saveAs(out + "/" + d.suggestedFilename()); console.log(id, "->", d.suggestedFilename()); }
  if (id === "expPng") {   // its .aux.xml follows
    const d2 = await page.waitForEvent("download", { timeout: 5000 }).catch(() => null);
    if (d2) { await d2.saveAs(out + "/" + d2.suggestedFilename()); console.log(id, "->", d2.suggestedFilename()); }
  }
  console.log(id, "note:", await page.textContent("#expNote"));
}
await browser.close();
