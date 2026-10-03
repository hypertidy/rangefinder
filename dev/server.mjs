// Dev server: serves the explorer, a mock STAC /search over real Earth Search
// items (dev/fixtures/items.json), a mock wildtiles bucket at /wt/ and mock
// starc stores: /starc/ (with manifest.json), /starc-flat/ (consolidated
// tables) and /s3/store/ (no manifest, S3 ListObjectsV2 on /s3/).
// Run from dev/: node server.mjs
// (fixtures: python3 make_fixtures.py; python3 make_starc_fixture.py)
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const items = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/items.json")));
const inter = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.end(); return; }
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
