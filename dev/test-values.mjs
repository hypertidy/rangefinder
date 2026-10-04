// Headless check of the hover value readout and the status statistics.
// node test-values.mjs "<permalink hash>" [out.png]   (with node server.mjs running)
// Loads the hash, waits for the composite, then hovers the map centre and an
// off-image corner and prints the readout box each time, then pins a
// point and prints the point series.
import { chromium } from "playwright";
const NM = process.cwd() + "/node_modules/";
const map = {
  "leaflet.min.css": NM + "leaflet/dist/leaflet.css",
  "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js",
  "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "hyparquet@1/+esm": process.cwd() + "/hyparquet.esm.js",
  "zarrita@0.7/+esm": process.cwd() + "/zarrita.esm.js",
};
const hash = process.argv[2] || "";
const shot = process.argv[3] || "values.png";
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const page = await ctx.newPage();
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.route(/cdnjs|jsdelivr/, r => {
  const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
  if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : "text/javascript", headers: { "Access-Control-Allow-Origin": "*" } });
  return r.abort();
});
await page.route(/arcgisonline|openstreetmap/, r => r.abort());
await page.goto((process.env.BASE || "http://localhost:8765/") + "#" + hash);
await page.waitForFunction(() => {
  const s = document.getElementById("status").textContent;
  return / ms/.test(s) && !/reading|searching|scenes read/.test(s) || document.querySelector("#status .err");
}, null, { timeout: 120000 }).catch(() => console.log("timeout"));
// Optional STEPS env var: playwright code run after the first load, then wait again.
if (process.env.STEPS) {
  await eval("(async () => {" + process.env.STEPS + "})()");
  await page.waitForTimeout(300);
  await page.waitForFunction(() => {
    const s = document.getElementById("status").textContent;
    return / ms/.test(s) && !/reading|searching|scenes read/.test(s) || document.querySelector("#status .err");
  }, null, { timeout: 120000 }).catch(() => console.log("timeout"));
}
console.log("STATUS:", await page.textContent("#status"));
const box = await page.locator("#map").boundingBox();
for (const [fx, fy] of [[0.5, 0.5], [0.45, 0.55], [0.02, 0.02]]) {
  await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
  await page.waitForTimeout(100);
  console.log("HOVER " + fx + "," + fy + ":", JSON.stringify(await page.textContent(".coords")));
}
// pin a point (PIN="fx,fy" of the map, default the centre) and wait for its series
const [px, py] = (process.env.PIN || "0.5,0.5").split(",").map(Number);
await page.mouse.click(box.x + box.width * px, box.y + box.height * py);
await page.waitForFunction(() => !/reading/.test(document.getElementById("pointNote").textContent), null,
  { timeout: 180000 }).catch(() => console.log("point timeout"));
console.log("POINT:", await page.textContent("#pointNote"));
console.log("POINT dots:", await page.locator("#pointChart circle").count(),
  JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("#pointChart circle title")].slice(0, 4).map(t => t.textContent))));
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.screenshot({ path: shot });
await page.locator("#pointBox").scrollIntoViewIfNeeded();
await page.locator("#pointBox").screenshot({ path: shot.replace(/\.png$/, "-point.png") });
await browser.close();
