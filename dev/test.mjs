// Headless check: node test.mjs "<permalink hash>" out.png
// Run from dev/ after `npm install && npm run bundle-hyparquet && npm run bundle-zarrita`, with
// `node server.mjs` running. CDN requests are served from node_modules.
// BASE env var overrides the page URL (e.g. file:///.../explorer.html).
// Optional STEPS env var: extra playwright code run after page load.
import { chromium } from "playwright";
const NM = process.cwd() + "/node_modules/";
const map = {
  "leaflet.min.css": NM + "leaflet/dist/leaflet.css",
  "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js",
  "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "hyparquet@1/+esm": process.cwd() + "/hyparquet.esm.js",
  "hyparquet-compressors@1/+esm": process.cwd() + "/hyparquet-compressors.esm.js",
  "zarrita@0.7/+esm": process.cwd() + "/zarrita.esm.js",
};
const hash = process.argv[2] || "";
const shot = process.argv[3] || "shot.png";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on("console", m => console.log("console:", m.type(), m.text()));
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.route(/cdnjs|jsdelivr/, r => {
  const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
  if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : "text/javascript", headers: { "Access-Control-Allow-Origin": "*" } });
  console.log("unrouted", u); return r.abort();
});
await page.route(/arcgisonline/, r => r.abort());
let bytes = 0, nreq = 0;
page.on("response", async resp => { if (/sentinel-cogs|zarr/.test(resp.url())) { nreq++; const l = +(resp.headers()["content-length"] || 0); bytes += l; } });
await page.goto((process.env.BASE || "http://localhost:8765/") + "#" + hash);
await page.waitForTimeout(1000);
if (process.env.STEPS) await eval("(async () => {" + process.env.STEPS + "})()");
const t0 = Date.now();
await page.waitForFunction(() => { const s = document.getElementById("status").textContent; return / ms/.test(s) && !/reading|searching|scenes read/.test(s) || /\S/.test([...document.querySelectorAll('#status .err')].map(e=>e.textContent).join('')); }, null, { timeout: 120000 }).catch(e => console.log("timeout"));
await page.waitForTimeout(500);
console.log("STATUS:", await page.textContent("#status"));
console.log("cog requests", nreq, "bytes", bytes, "wait", Date.now() - t0);
await page.screenshot({ path: shot });
await browser.close();
