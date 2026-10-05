// Headless HEALPix check against the local fixtures (node
// make_healpix_fixture.mjs; node server.mjs; npm run bundle-zarrita). Each
// fixture value is its own cell id, so every valid pixel of a read must equal
// the cell healpix-geo puts under that pixel's centre: the whole path
// (detection, lon/lat, cell ids, chunk indexing) with no tolerance. Also
// checks the footprints against the inverse (section 6 of docs/healpix.md):
// a few hundred cells' corners rasterised with curvilinear.js rasterCells
// give the same cell as cellsOf, except within a pixel of a shared edge.
// Optionally REMOTE=1 opens a DKRZ EERIE HEALPix store (not reachable from
// every network).
import { chromium } from "playwright";
const NM = process.cwd() + "/node_modules/";
const map = { "leaflet.min.css": NM + "leaflet/dist/leaflet.css", "leaflet.min.js": NM + "leaflet/dist/leaflet.js",
  "proj4.min.js": NM + "proj4/dist/proj4.js", "geotiff.min.js": NM + "geotiff/dist-browser/geotiff.js",
  "hyparquet@1/+esm": process.cwd() + "/hyparquet.esm.js",
  "hyparquet-compressors@1/+esm": process.cwd() + "/hyparquet-compressors.esm.js", "zarrita@0.7/+esm": process.cwd() + "/zarrita.esm.js",
  "icechunk-js@0.6/+esm": process.cwd() + "/icechunk.esm.js",
  "healpix_geo_bg.js": NM + "healpix-geo/healpix_geo_bg.js", "healpix_geo_bg.wasm": NM + "healpix-geo/healpix_geo_bg.wasm" };
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", proxy: { server: process.env.HTTPS_PROXY, bypass: "localhost" }, args: ["--ignore-certificate-errors"] });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: true });
const q = encodeURIComponent;
let fails = 0;

// every valid pixel of the shown composite against healpix-geo directly
const CHECK = async ({ level, scheme, ellipsoid, plus }) => {
  const e = window.explorer, c = e.state.comp, g = c.grid;
  const hg = await (await import("/lib/dggs.js")).healpixGeo();
  const opts = { scheme, level };
  if (ellipsoid) opts.ellipsoid = ellipsoid;
  const grid = new hg.Grid(opts);
  const W = g.width, H = g.height, dx = (g.bbox[2] - g.bbox[0]) / W, dy = (g.bbox[3] - g.bbox[1]) / H;
  const tr = proj4(g.crs, "EPSG:4326"), ll = [], at = [];
  for (let r = 0; r < H; r += 3) for (let k = 0; k < W; k += 3) {
    const s = tr.forward([g.bbox[0] + (k + 0.5) * dx, g.bbox[3] - (r + 0.5) * dy]);
    if (!isFinite(s[0]) || !(Math.abs(s[1]) <= 90)) continue;
    ll.push(s[0], s[1]); at.push(r * W + k);
  }
  const ids = grid.lonLatToHealpix(new Float64Array(ll));
  let valid = 0, bad = 0, firstBad = null, ch = c.channels[0];
  for (let i = 0; i < at.length; i++) {
    if (!c.valid[at[i]]) continue;
    valid++;
    if (ch[at[i]] !== Number(ids[i]) + plus) { bad++; if (!firstBad) firstBad = [at[i], ch[at[i]], Number(ids[i])]; }
  }
  return { valid, bad, firstBad, sampled: at.length };
};

async function run(name, hash, want, check, extra) {
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log("pageerror:", e.message));
  page.on("console", m => { if (/^footprints/.test(m.text())) console.log("  " + m.text()); });
  await page.route(/cdnjs|jsdelivr/, r => { const u = r.request().url(); const k = Object.keys(map).find(k => u.endsWith(k));
    if (k) return r.fulfill({ path: map[k], contentType: k.endsWith("css") ? "text/css" : k.endsWith("wasm") ? "application/wasm" : "text/javascript" });
    return r.abort(); });
  await page.route(/arcgisonline|unpkg/, r => r.abort());
  await page.goto("http://localhost:8765/#" + hash);
  await page.waitForTimeout(1000);
  await page.waitForFunction(() => { const s = document.getElementById("status").textContent; return / ms/.test(s) && !/reading|searching/.test(s) || document.querySelector('#status .err'); }, null, { timeout: 120000 });
  const got = await page.evaluate(() => ({ status: document.getElementById("status").textContent.replace(/\s+/g, " "),
    info: document.getElementById("zarrInfo").textContent }));
  const bad = Object.keys(want).filter(k => !want[k].test(got[k]));
  let note = "";
  if (check && !bad.length) {
    const r = await page.evaluate(CHECK, check);
    note = " (" + r.valid + " of " + r.sampled + " sampled pixels valid, " + r.bad + " wrong)";
    if (!r.valid || r.bad) { bad.push("values"); got.values = JSON.stringify(r); }
  }
  if (extra && !bad.length) {
    const r = await extra(page);
    if (r) { bad.push("extra"); got.extra = r; }
  }
  if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/" + name.replace(/\W+/g, "-").slice(0, 40) + ".png" });
  if (process.env.VERBOSE) console.log("  " + got.status);
  console.log((bad.length ? "FAIL " : "ok   ") + name + note + (bad.length ? "\n  " + bad.map(k => k + ": " + got[k]).join("\n  ") : ""));
  fails += bad.length ? 1 : 0;
  await page.close();
}

const HP = "http://localhost:8765/hp/";
await run("level 3 nested, CF crs variable, second time step (EPSG:4326 view)",
  "src=zarr&zarr=" + q(HP + "l3-crs.zarr") + "&zvar=pr&roi=100,-60,180,10&from=2020-01-15&to=2020-01-16&day=2020-01-16&crs=EPSG:4326",
  { info: /HEALPix nside 8 \(level 3\), nested, 768 cells about 7\.3 degrees across/, status: /valid px/ },
  { level: 3, scheme: "nested", plus: 1000 });
await run("level 3 nested, polar view (EPSG:3031)",
  "src=zarr&zarr=" + q(HP + "l3-crs.zarr") + "&zvar=pr&roi=-180,-90,180,-50&from=2020-01-15&to=2020-01-16&day=2020-01-15&crs=EPSG:3031",
  { status: /valid px/ }, { level: 3, scheme: "nested", plus: 0 });
await run("level 7 nested, root crs dictionary, whole world (48 chunks)",
  "src=zarr&zarr=" + q(HP + "l7-root.zarr") + "&zvar=pr&roi=-180,-85,180,85&from=2020-01-15&to=2020-01-15&day=2020-01-15",
  { info: /the crs attribute dictionary.*HEALPix nside 128 \(level 7\), nested, 196608 cells about 0\.46 degrees/, status: /valid px/ },
  { level: 7, scheme: "nested", plus: 0 },
  async page => {
    // past the chunk cap: the most-used chunks are read, the rest logged as not read
    const cap = await page.evaluate(async () => {
      const e = window.explorer, sc = e.state.scenes[0], a = sc.assets.pr, g = e.state.comp.grid;
      const r = await e.X.readZarrWarped(a, g, { maxChunks: 10 });
      const capped = r.log.filter(t => t.status === "capped").length, read = r.log.filter(t => t.ok).length;
      let valid = 0;
      for (let i = 0; i < r.valid.length; i++) valid += r.valid[i];
      return { capped, read, valid, n: r.valid.length, msg: (r.log.find(t => t.status === "capped") || {}).error };
    });
    if (cap.read !== 10 || cap.capped !== 38 || !(cap.valid > 0 && cap.valid < cap.n)) return "cap: " + JSON.stringify(cap);
    // a pinned point outlines its cell and names it
    const box = await page.locator("#map").boundingBox();
    await page.mouse.click(box.x + box.width / 2 + 40, box.y + box.height / 2 - 30);
    await page.waitForFunction(() => /HEALPix cell \d+ \(index \d+ along cell\)/.test(document.getElementById("pointNote").textContent), null, { timeout: 10000 })
      .catch(() => null);
    const note = await page.textContent("#pointNote");
    if (process.env.SHOTS) await page.screenshot({ path: process.env.SHOTS + "/pinned-cell.png" });
    return /HEALPix cell \d+ \(index \d+ along cell\), centre/.test(note) ? null : "pin note: " + note;
  });
await run("level 3 ring, xdggs cell_ids, no time axis",
  "src=zarr&zarr=" + q(HP + "l3-ring.zarr") + "&zvar=tas&roi=-40,-30,60,40",
  { info: /cell_ids checked: 0 \.\. 767.*HEALPix nside 8 \(level 3\), ring, 768 cells/, status: /valid px/ },
  { level: 3, scheme: "ring", plus: 0 });
await run("level 8 regional subset on WGS84, ids listed out of order",
  "src=zarr&zarr=" + q(HP + "l8-regional.zarr") + "&zvar=sst&roi=138,-47,152,-36",
  { info: /WGS84 ellipsoid.*nside 256 \(level 8\), nested, 1012 of 786432 cells/, status: /valid px/ },
  { level: 8, scheme: "nested", plus: 0, ellipsoid: { semi_major_axis: 6378137, inverse_flattening: 298.257223563 } },
  // footprints vs the inverse: the cell under each pixel by rasterising
  // corners must match the cell the inverse gives, away from edges
  page => page.evaluate(async () => {
    const d = await import("/lib/dggs.js"), cv = await import("/lib/curvilinear.js");
    const hg = await d.healpixGeo();
    const grid = new hg.Grid({ scheme: "nested", level: 8, ellipsoid: { semi_major_axis: 6378137, inverse_flattening: 298.257223563 } });
    const g = window.explorer.state.comp.grid, W = g.width, H = g.height;
    const ids = [];
    const cen = grid.lonLatToHealpix(new Float64Array([145, -42]));
    for (let k = 0n; k < 400n; k++) ids.push(cen[0] - 200n + k);
    const n = ids.length, lon = new Float64Array(4 * n), lat = new Float64Array(4 * n), uv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    ids.forEach((id, i) => uv.forEach((p, m) => { const c = grid.vertex(id, p[0], p[1]); lon[4 * i + m] = c.lon; lat[4 * i + m] = c.lat; }));
    const pf = cv.projectFootprints({ W: n, H: 1, lon, lat }, g.crs);
    const cell = cv.rasterCells(pf, g).cell;
    const dx = (g.bbox[2] - g.bbox[0]) / W, dy = (g.bbox[3] - g.bbox[1]) / H, tr = proj4(g.crs, "EPSG:4326");
    let same = 0, diff = 0, edge = 0;
    for (let r = 1; r < H - 1; r += 2) for (let k = 1; k < W - 1; k += 2) {
      const p = r * W + k;
      if (cell[p] < 0) continue;
      if (cell[p - 1] !== cell[p] || cell[p + 1] !== cell[p] || cell[p - W] !== cell[p] || cell[p + W] !== cell[p]) { edge++; continue; }
      const s = tr.forward([g.bbox[0] + (k + 0.5) * dx, g.bbox[3] - (r + 0.5) * dy]);
      const id = grid.lonLatToHealpix(new Float64Array(s))[0];
      if (id === ids[cell[p]]) same++; else diff++;
    }
    const msg = "footprints vs inverse: " + same + " pixels agree, " + diff + " differ, " + edge + " on cell edges skipped";
    console.log(msg);
    return !same || diff ? msg : null;
  }));
await run("HEALPix 1-D variable is listed, coordinates are not",
  "src=zarr&zarr=" + q(HP + "l3-ring.zarr") + "&roi=-40,-30,60,40",
  { status: /valid px/ }, null,
  page => page.evaluate(() => { const o = [...document.querySelectorAll("#zarrVar option")].map(x => x.value).join(",");
    return o === "tas" ? null : "variables listed: " + o; }));
if (process.env.REMOTE) {
  await run("EERIE ICON monthly, HEALPix level 7 (DKRZ)", "src=zarr&zarr=" + q(process.env.REMOTE) + "&zvar=pr&roi=100,-60,180,10",
    { info: /HEALPix nside 128/, status: /valid px/ });
}
await browser.close();
process.exit(fails ? 1 : 0);
