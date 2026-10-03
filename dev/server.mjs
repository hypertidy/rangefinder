// Dev server: serves the explorer, a mock STAC /search over real Earth Search
// items (dev/fixtures/items.json), a mock wildtiles bucket at /wt/ and mock
// starc stores: /starc/ (with manifest.json), /starc-flat/ (consolidated
// tables) and /s3/store/ (no manifest, S3 ListObjectsV2 on /s3/).
// Also a mock tile server (tilesFor below): XYZ at /xyz/{z}/{x}/{y}.png and a
// WMTS at /wmts/1.0.0/WMTSCapabilities.xml with a Web Mercator and an EPSG:3031 matrix set and a
// time dimension, all drawn from one synthetic pattern that covers only part
// of the world, has native data to a fixed level and is upsampled beyond it,
// answers 404 or a blank placeholder outside its coverage.
// Run from dev/: node server.mjs
// (fixtures: python3 make_fixtures.py; python3 make_starc_fixture.py)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const items = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/items.json")));
const inter = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// --- mock tile server -----------------------------------------------------------
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const MERC = 20037508.342789244;
const SETS = {
  WebMercatorQuad: { origin: [-MERC, MERC], cell0: 2 * MERC / 256, native: 11, max: 18,
    // Tasmania, in Web Mercator metres
    cover: [16194000, -5475000, 16570000, -4930000] },
  EPSG3031: { origin: [-4194304, 4194304], cell0: 8192 * 4, native: 6, max: 9,
    // a box over the Ross Sea and the Dry Valleys, polar stereographic metres
    cover: [-200000, -1500000, 600000, -900000] }
};
const placeholder = png(256, 256, Buffer.alloc(256 * 256 * 4, 220));
function tileFor(setId, z, x, y, time) {
  const S = SETS[setId]; if (!S || z > S.max) return { status: 404 };
  const cell = S.cell0 / 2 ** z, nCell = S.cell0 / 2 ** S.native, shift = time === "2025-01-02" ? 40 : 0;
  const x0 = S.origin[0] + x * 256 * cell, y1 = S.origin[1] - y * 256 * cell;
  const c = S.cover, ext = [x0, y1 - 256 * cell, x0 + 256 * cell, y1];
  if (!(ext[0] < c[2] && ext[2] > c[0] && ext[1] < c[3] && ext[3] > c[1])) {
    return (x + y) % 2 ? { status: 404 } : { status: 200, body: placeholder };
  }
  const buf = Buffer.alloc(256 * 256 * 4);
  for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
    const X = x0 + (px + 0.5) * cell, Y = y1 - (py + 0.5) * cell, o = (py * 256 + px) * 4;
    if (X < c[0] || X > c[2] || Y < c[1] || Y > c[3]) continue;
    // the value depends only on the native cell, so deeper levels are exact upsamples
    const i = Math.floor((X - S.origin[0]) / nCell), j = Math.floor((S.origin[1] - Y) / nCell);
    // plus per-cell noise, so each native cell differs from its neighbours
    const nz = (((i * 73856093) ^ (j * 19349663)) >>> 0) % 48 - 24;
    buf[o] = 128 + 90 * Math.sin(i / 40) + nz; buf[o + 1] = 128 + 90 * Math.cos(j / 55) - nz;
    buf[o + 2] = (((i + shift) >> 6) ^ (j >> 6)) & 1 ? 210 : 50; buf[o + 3] = 255;
  }
  return { status: 200, body: png(256, 256, buf) };
}
function capsXml() {
  const sets = Object.entries(SETS).map(([id, S]) => {
    const crs = id === "EPSG3031" ? "urn:ogc:def:crs:EPSG::3031" : "urn:ogc:def:crs:EPSG::3857";
    let m = "";
    for (let z = 0; z <= S.max; z++) m += `<TileMatrix><ows:Identifier>${z}</ows:Identifier><ScaleDenominator>${S.cell0 / 2 ** z / 0.00028}</ScaleDenominator><TopLeftCorner>${S.origin[0]} ${S.origin[1]}</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>${2 ** z}</MatrixWidth><MatrixHeight>${2 ** z}</MatrixHeight></TileMatrix>`;
    return `<TileMatrixSet><ows:Identifier>${id}</ows:Identifier><ows:SupportedCRS>${crs}</ows:SupportedCRS>${m}</TileMatrixSet>`;
  }).join("");
  return `<?xml version="1.0"?><Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.0.0"><ows:ServiceIdentification><ows:Title>mock WMTS</ows:Title></ows:ServiceIdentification><Contents><Layer><ows:Title>pattern</ows:Title><ows:WGS84BoundingBox><ows:LowerCorner>-180 -90</ows:LowerCorner><ows:UpperCorner>180 -40</ows:UpperCorner></ows:WGS84BoundingBox><ows:Identifier>pattern</ows:Identifier><Style isDefault="true"><ows:Identifier>default</ows:Identifier></Style><Format>image/png</Format><Dimension><ows:Identifier>Time</ows:Identifier><Default>2025-01-01</Default><Value>2025-01-01/2025-01-02/P1D</Value></Dimension><TileMatrixSetLink><TileMatrixSet>WebMercatorQuad</TileMatrixSet></TileMatrixSetLink><TileMatrixSetLink><TileMatrixSet>EPSG3031</TileMatrixSet></TileMatrixSetLink><ResourceURL format="image/png" resourceType="tile" template="http://localhost:8765/wmts/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png"/></Layer>${sets}</Contents></Capabilities>`;
}
function tilesFor(u, res) {
  let m = /^\/xyz\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(u.pathname), t;
  if (m) t = tileFor("WebMercatorQuad", +m[1], +m[2], +m[3]);
  else if ((m = /^\/wmts\/([^/]+)\/(\w+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(u.pathname))) t = tileFor(m[2], +m[3], +m[5], +m[4], m[1]);
  else if (u.pathname === "/wmts/1.0.0/WMTSCapabilities.xml") { res.setHeader("Content-Type", "application/xml"); res.end(capsXml()); return true; }
  else return false;
  res.statusCode = t.status;
  if (t.body) res.setHeader("Content-Type", "image/png");
  res.end(t.body || "");
  return true;
}

http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.end(); return; }
  if (tilesFor(u, res)) return;
  if (u.pathname === "/stac/collections") { res.end(JSON.stringify({ collections: [{ id: "sentinel-2-l2a", title: "Sentinel-2 L2A" }] })); return; }
  if (u.pathname === "/stac/search") {
    let body = ""; req.on("data", c => body += c); req.on("end", () => {
      const q = JSON.parse(body); console.log("search", body);
      const [a, b] = q.datetime.split("/");
      let f = items.filter(it => inter(it.bbox, q.bbox) && it.properties.datetime >= a && it.properties.datetime <= b);
      if (q.query) f = f.filter(it => it.properties["eo:cloud_cover"] <= q.query["eo:cloud_cover"].lte);
      const off = q.token ? +q.token : 0;
      const page = f.slice(off, off + q.limit);
      const links = off + q.limit < f.length ? [{ rel: "next", href: "http://localhost:8765/stac/search", method: "POST", body: { token: String(off + q.limit) }, merge: true }] : [];
      res.setHeader("Content-Type", "application/geo+json");
      res.end(JSON.stringify({ type: "FeatureCollection", features: page, links }));
    }); return;
  }
  if (u.pathname === "/s3/" && u.searchParams.get("list-type") === "2") {
    const pre = u.searchParams.get("prefix") || "";
    const base = path.join(HERE, "fixtures/starc");
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const keys = walk(base).map(f => "store/" + path.relative(base, f))
      .filter(k => k.startsWith(pre) && !k.endsWith("manifest.json")).sort();
    // two pages, to exercise continuation tokens
    const start = +(u.searchParams.get("continuation-token") || 0), half = Math.ceil(keys.length / 2);
    const page = keys.slice(start, start + half), more = start + half < keys.length;
    res.setHeader("Content-Type", "application/xml");
    res.end('<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>s3</Name><Prefix>' + pre +
      "</Prefix><IsTruncated>" + more + "</IsTruncated>" + page.map(k => "<Contents><Key>" + k +
      "</Key></Contents>").join("") + (more ? "<NextContinuationToken>" + (start + half) +
      "</NextContinuationToken>" : "") + "</ListBucketResult>");
    return;
  }
  const bucket = [["/wt/", "fixtures/wt/"], ["/starc/", "fixtures/starc/"],
                  ["/starc-flat/", "fixtures/starc-flat/"], ["/s3/store/", "fixtures/starc/"]]
    .find(([pre]) => u.pathname.startsWith(pre));
  if (bucket) {
    const f = path.join(HERE, bucket[1], decodeURIComponent(u.pathname.slice(bucket[0].length)));
    if (!fs.existsSync(f) || !fs.statSync(f).isFile() || (bucket[0] === "/s3/store/" && f.endsWith("manifest.json"))) {
      res.statusCode = 403; res.end(); return;
    }
    const buf = fs.readFileSync(f); const rg = req.headers.range;
    res.setHeader("Accept-Ranges", "bytes"); res.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length");
    res.setHeader("Content-Length", buf.length);
    if (req.method === "HEAD") { res.end(); return; }
    if (rg) { const m = /bytes=(\d+)-(\d*)/.exec(rg); const a = +m[1], b = m[2] ? Math.min(+m[2], buf.length - 1) : buf.length - 1;
      res.statusCode = 206; res.setHeader("Content-Range", `bytes ${a}-${b}/${buf.length}`); res.setHeader("Content-Length", b - a + 1); res.end(buf.subarray(a, b + 1)); return; }
    res.end(buf); return;
  }
  const p = path.join(ROOT, u.pathname === "/" ? "index.html" : u.pathname);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) { res.statusCode = 404; res.end(); return; }
  res.setHeader("Content-Type", types[path.extname(p)] || "application/octet-stream");
  res.end(fs.readFileSync(p));
}).listen(8765, () => console.log("up"));
