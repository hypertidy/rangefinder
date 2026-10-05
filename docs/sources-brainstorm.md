# Beyond Sentinel-2: other sources, and tile servers as a source

Brainstorm, 2026-10-03. Read against `lib/` as it stands after the
core thread, and the four layers of `seed/sentinel-explorer-design.md`
(space, time, pixels, render). No code was changed.

## 1. How Sentinel-specific is it now?

Less than it looks. The skeleton is general; Sentinel lives in a handful of
defaults and tables.

Already general:

- **geo.js / OutputGrid.** Any source warps onto one Web Mercator grid.
  `ensureCrs()` auto-defines UTM only, but any CRS registered with
  `proj4.defs()` works (EPSG:3031 polar stereographic, a national grid...).
- **cog.js / readWarped.** A generic windowed COG reader with overview
  selection. Nothing in it knows about bands or Sentinel.
- **render.js.** Mosaic, percentile stretch, gamma: pure typed arrays.
- **Catalog interface + STAC binding.** Any STAC API collection whose assets
  are public, CORS-enabled COGs already works, in principle.

Sentinel-2 shaped (each is small to lift):

| Where | Assumption | Generalise to |
|---|---|---|
| `stac.js` BAND_ALIASES | S2 band names (B04, visual...) | per-source band table, falling back to `eo:bands` / `raster:bands` |
| `index.html` makeGrid | `minGroundRes: 10` | `catalog.nativeRes` (or read from `proj:transform` / `gsd`) |
| page presets | S2 combos (SWIR/NIR/RGB) | `catalog.presets` |
| cloud filter | `eo:cloud_cover` exists | `catalog.capabilities.cloud` (hide the control when false) |
| cog.js | nodata defaults to 0 | `raster:bands[].nodata`, per asset |
| render.js | composite is TCI (rgb8) or 3 numeric bands | add a 1-band mode (colour map) and a categorical mode (palette) |
| render.js | DN as stored | apply `raster:bands` scale/offset (also fixes the L2A -1000 offset generically) |
| groupByDay | everything has a solar day | time is optional; static products (DEMs, land cover) have one "day" |

So the main generalisation is: a source declares its band table, native
resolution, nodata/scale, presets and capabilities, and render grows two
modes (single band with a colour ramp, categorical with a palette).

## 2. What other sources look like

Grouped by which layers they rebind. All of these are inferences from what
I know of the services; none was probed from here.

**Same shape, new band table (STAC API, public COGs):**

- Copernicus DEM GLO-30 (`cop-dem-glo-30` on Earth Search): no time axis,
  single band, wants hillshade or a terrain ramp. Good first non-S2 test
  because it exercises "no time" and "single band" together.
- ESA WorldCover / IO land cover: categorical, wants the palette from the
  STAC `classification` extension.
- Landsat C2 L2: same shape as S2, but the AWS copy is requester-pays, so
  it is only browser-friendly via Planetary Computer (see below).

**Needs URL signing (small addition to layer 2):**

- Planetary Computer (Landsat, Sentinel-1 RTC, HLS, many more): anonymous
  SAS token from its token endpoint, appended to hrefs. One function in the
  STAC binding: `signHref(href)`. Sentinel-1 RTC then also needs a dB
  transfer and a VV / VH / ratio preset, which `TRANSFERS` can hold.

**Static STAC, not an API (new layer-2 binding):**

- Static catalogs (walk `child` / `item` links, filter client-side). The
  Southern Ocean example that matters: **REMA** Antarctic DEM mosaics, public
  COGs in EPSG:3031 with a static STAC catalogue. It also tests the polar
  path end to end (3031 file -> 3857 grid; Web Mercator itself falls apart
  south of about 85S, see section 4).

**No catalogue at all:**

- "Paste a COG URL" (or a list): a trivial Catalog returning one Scene.
  Cheap, and the most useful debugging source there is.
- starc store and stac-geoparquet snapshots: already planned in the design
  doc; read with hyparquet like wildtiles.

**Different pixel format (later):**

- Zarr / GeoZarr (sea ice, SST, model output): a different layer 3, and a
  time axis that is an array dimension rather than a list of files. Worth
  keeping in mind so the Scene shape doesn't hard-code "one file per asset".
  (Built since: lib/sources/zarr.js reads Zarr v2/v3, Kerchunk JSON and
  Parquet references, and Icechunk repositories, see docs/icechunk.md.)

## 3. XYZ / WMTS image servers: yes, and it fits the layers cleanly

The key observation: **a tile pyramid is a COG whose internal tiles happen
to be separate URLs.** A TileMatrixSet (TMS) gives, per zoom level, an
origin, a cell size and a tile size, which is exactly the affine and
overview list that `readWarped` already uses. So a tile server is:

- **Layer 1, space:** the TileMatrixSet. WebMercatorQuad for plain XYZ;
  whatever WMTS GetCapabilities declares otherwise (NASA GIBS serves
  EPSG:3031 and EPSG:4326 pyramids alongside 3857).
- **Layer 2, time:** none, or the WMTS `TIME` dimension (GIBS is daily).
  A WMTS with TIME can feed the same day list and future time scrubber.
- **Layer 3, pixels:** fetch the tiles intersecting the window at the chosen
  level, decode with `createImageBitmap`, and warp with the same lattice
  resampler. Because tiles go through the warp rather than straight into
  a Leaflet tile layer, a 3031 or 4326 pyramid mosaics onto the map just
  like a UTM COG does.
- **Layer 4, render:** usually rendered RGB, so it is `kind: "rgb8"` and
  passes through. But two cases get the full render layer:
  - numeric-in-RGB tiles (Terrarium, Mapbox terrain-RGB) decode to real
    elevations, then stretch / ramp / hillshade like a DEM;
  - stretching or channel-swapping rendered RGB is still useful for
    inspection (e.g. pushing contrast to see JPEG artefacts or seams).

URL templates to support: `{z}/{x}/{y}`, `{-y}` (TMS flipped rows),
`{q}` quadkey, `{s}` subdomains, WMTS REST
(`{TileMatrix}/{TileRow}/{TileCol}`, `{Time}`) and WMTS KVP. TileJSON and
WMTS capabilities give bounds and zoom ranges for free when offered.

## 4. The tile inspector: structure and imagery side by side

This is the part that is new, rather than "another source". Ideas, roughly
in order of value:

1. **Tile grid overlay** at a chosen level, independent of the map zoom,
   labelled z/x/y (or TileMatrix/Row/Col), drawn in the server's own CRS
   (so a 3031 grid shows as the curved lattice it really is on the map).
2. **Per-tile status layer:** colour each cell by what the request returned:
   200 with data, 404, 204, error, slow, and **placeholder**. Many servers
   return 200 with a blank or "no data" image outside coverage; detect that
   by hashing tile bytes and flagging any hash that repeats a lot, or by an
   all-transparent / single-colour decode. Hover a cell for status, bytes,
   content type, timing, cache headers.
3. **Coverage walk:** a capped quadtree descent from a starting level that
   only recurses into tiles that exist. The result is a map of "deepest
   real zoom here", which is exactly what you want for patchy, non-global
   servers. Stop recursing on 404 or placeholder.
4. **Overzoom detection:** compare a tile against its parent upsampled; if
   they match, the server is resampling rather than serving native data.
   Shows where native resolution actually ends.
5. **Raw tile panel:** click a cell to see the tile exactly as delivered
   (bytes, format, its own pixel grid), next to the warped composite.
6. **Free coverage when the format declares it:** PMTiles has a full tile
   directory in its header (exact coverage, zero probing); WMTS
   `TileMatrixSetLimits`, TileJSON `bounds`/`minzoom`/`maxzoom`, and Cesium
   `layer.json` `available` all narrow the probe.

The same inspector applies to **COGs**, which is a nice unification. A COG's
internal tiles are its tile structure: the inspector can draw the internal
tile grid at each overview, show which tiles a load actually read (read
amplification becomes visible; sentinel-cogs uses 1024 px tiles), and flag
sparse tiles (TileByteCounts of 0). So "how are the tiles structured" is one
feature across XYZ, WMTS, PMTiles and COG.

## 5. What this suggests for the interfaces

A small change to the Scene shape covers all of the above:

```
Scene.assets[key] = href                                  (today)
Scene.assets[key] = { href, kind: "cog" }                 (COG)
                  | { template, kind: "tiles", tms, format, subdomains }
                  | { href, kind: "pmtiles" }
plus per-asset: nodata, scale, offset, dataType, bandName
```

`loadComposite` dispatches on `kind` to `readWarped` (COG) or a new
`readTilesWarped` (tile pyramid), both returning the same
`{ bands, valid, level }`, and both able to report a **read log**
(which tiles, which level, bytes, status) that the inspector draws. The
render layer does not change apart from the single-band and categorical
modes in section 1.

A Catalog gains optional descriptors: `nativeRes`, `presets`,
`capabilities: { cloud, time }`, and `tms` for tile sources.

## 6. Caveats

- **CORS decides what is possible.** Reading pixels, status codes and bytes
  needs `Access-Control-Allow-Origin`. Without it, tiles can still be
  shown as images and the inspector can tell loaded vs failed, but no
  stats, no hashing, no stretch. The inspector should say which mode it
  is in rather than fail silently.
- **Politeness and terms.** Coverage walks are crawls. Cap requests per
  walk, rate-limit, and treat commercial basemaps (whose terms usually
  forbid bulk access) as display-only.
- **Web Mercator near the poles.** The OutputGrid is 3857, which stops
  around 85S. For Antarctic sources a polar OutputGrid (3031) plus a
  matching map CRS is the real fix; worth deciding before the Southern
  Ocean sources land, since it touches geo.js and the map setup.

## 7. Suggested order

1. Source descriptors (band table, nativeRes, presets, capabilities) and
   per-asset nodata/scale: lifts the S2 assumptions out of the page.
2. Single-band render mode + "paste a COG URL" + Copernicus DEM: proves
   non-S2, no-time, single-band.
3. XYZ / WMTS source via `readTilesWarped` (WebMercatorQuad first, then
   WMTS capabilities with GIBS as the non-Mercator test).
4. Tile inspector: grid overlay, per-tile status with placeholder
   detection, then the coverage walk; then the COG read-log view.
5. Polar OutputGrid, then REMA / sea ice.
