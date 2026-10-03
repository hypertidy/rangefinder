# An HTML-native Sentinel explorer: design notes

Distilled from the wildtiles composer proof-of-concept (Oct 2026): a
single HTML file that streamed per-band Sentinel-2 COGs from a public
bucket, composed RGB client-side with interactive stretch, and
scrubbed dates discovered from a parquet index -- 9 tiles in 636 ms,
no server, no credentials. This document separates what that page IS
from what it merely ASSUMED, so the idea can stand alone as a general
Sentinel explorer independent of the estinel/wildtiles line.

## 1. The logic, distilled

The page is four independent layers. Everything else is UI.

1. SPACE: something names a footprint, and that name resolves to both
   a projected extent and a geographic placement. In the PoC this is
   pure arithmetic: tile id -> (zone, res, col, row) -> UTM extent
   (origin + index * tilesize) -> densified edge through proj4 ->
   bounds on a web map.
2. TIME: something lists which days exist for a footprint. In the PoC:
   one small parquet file (inventory) read in-browser with hyparquet,
   filtered to (tile, band).
3. PIXELS: given (footprint, band, day), bytes arrive by HTTP range
   request and decode to typed arrays (geotiff.js). The browser is a
   perfectly good COG client.
4. RENDER: composition and stretch happen on the raw numbers, client
   side: any three bands to RGB, percentile stretch computed across
   the current view so adjacent footprints are seamless, gamma, nodata
   to transparency, canvas onto the map.

The load-bearing insight is that layers 1-3 are INTERFACES, not
implementations. The PoC bound them all to wildtiles; nothing in layer
4 or the UI knows that.

## 2. The contract the PoC has with wildtiles

Assumptions, in roughly decreasing order of how much work they save:

- DETERMINISTIC URLS. cube/<tile>/<band>/<day>.tif means space + band
  + time resolve to a URL by string formatting. No search, no listing,
  no catalog round-trip. This is the single biggest simplification.
- FILE = DISPLAY UNIT. Tiles are fixed 720x720; a whole-file read is
  the right granularity, so no windowing, no overview selection, no
  read amplification concerns.
- ONE FILE PER SOLARDAY. The pipeline already resolved overlapping
  acquisitions, datatake duplicates, and reprocessing versions. The
  client never sees two candidates for the same (place, day).
- CO-REGISTERED BANDS. Every band of a tile shares the exact grid, so
  band math is elementwise with no alignment step.
- A TINY TIME INDEX. inventory.parquet is one small file covering the
  whole archive, cheap to read entirely in the browser.
- OPEN DOOR. Anonymous GET, CORS on, 403-for-missing understood as
  "no file" (no-ListBucket policy).
- KNOWN SEMANTICS. Nodata is 0; TCI is the one 3-band Byte exception;
  everything else UInt16 native DN.

These assumptions are exactly the product that the wildtiles pipeline
manufactures. The composer is thin BECAUSE the pipeline is thick.

## 3. The same page without wildtiles

Rebinding layers 1-3 to the public Sentinel-2 archive (sentinel-cogs
on AWS Open Data, us-west-2) and public indexes:

### Layer 1, space

The MGRS scene replaces the aatgrid tile as the named footprint. The
scene-extent model is already solved and archive-verified (aatgrid
R/mgrs.R: 0 m residual against 132 codes): code -> UTM zone + exact
extent, same densified-edge placement. A JS port of that small model
is the only geometry the page needs. Alternatively the view extent
drives everything and scenes are discovered, not named.

### Layer 2, time (the real fork in the road)

Scene URLs on sentinel-cogs are ALMOST deterministic:
.../{zone}/{band}/{square}/{year}/{month}/{scene_id}/B04.tif -- but
the final scene_id carries a processing suffix (_0, _1), so some index
is unavoidable. Three candidate bindings:

- A. LIVE STAC API (earth-search /search, bbox + datetime). Zero
  infrastructure, always current, CORS-friendly JSON. Costs a catalog
  round-trip per interaction and couples the page to API availability
  and politeness. Right default for a general public tool.
- B. STAC-GEOPARQUET SNAPSHOT. Static parquet of the catalog, range-
  read with hyparquet. No API dependency, but global snapshots are
  large, so this binding wants spatial partitioning (per-MGRS-square
  files) to stay browser-friendly -- at which point you are
  maintaining an index artifact again.
- C. A PUBLISHED STARC STORE. This is the quiet winner for curated
  regions: starc already harvests STAC into exactly the four tables
  the page needs (acquisitions with solarday, assets with hrefs),
  append-only parquet, provider-agnostic, and wildtiles already
  publishes one in the bucket. The explorer reads queries/products/
  assets and gets days AND hrefs with no scene-id guessing. "Index as
  recipe": the store is small because it holds references, not pixels.

A and C compose naturally: C for the regions someone cares for, A as
the fallback anywhere on Earth.

### Layer 3, pixels

Scenes are 10980x10980 (10 m bands), so whole-file reads are off the
table. The page must become a WINDOWED reader:

- choose an overview level from the view scale (geotiff.js exposes the
  COG pyramid; sentinel-cogs files carry overviews);
- map the view extent into scene pixel space and read that window at
  that level (readRasters with window + output size);
- expect multiple scenes per view and per day (orbit overlap, zone
  seams): mosaic client-side, last-wins or nodata-aware.

This is a real step up in complexity -- it is the reprojection-window
problem -- but it is bounded, well-understood, and the payoff is the
entire global archive with zero preprocessing.

Practicalities to verify early: CORS on sentinel-cogs (widely used
from browsers, confirm with the same curl probe used for wildtiles);
the L2A BOA offset (-1000 DN from processing baseline 04.00) if
cross-date comparability of stretch values matters; request fan-out
politeness (a zoomed-out view can touch many scenes -- cap it).

### Layer 4, render

Unchanged. Composition, block-wide percentile stretch, gamma, nodata
transparency are source-agnostic. This layer is the product.

## 4. What this clarifies about wildtiles

Going source-direct does not make wildtiles redundant; it shows
precisely what the cube is FOR. The pipeline pre-pays, once, the costs
the general page pays per view: scene discovery, dedup to one file
per solarday, windowing, and above all GRID FIXITY -- every date of a
wildtiles tile shares identical pixels, so time series are elementwise
and a date scrub never resamples. The general explorer trades that
away for universal coverage. Both are the same four layers; they
differ only in which layers are bound at write time versus read time.

## 5. Shape of the project

- A small library (ES module) holding layers 1-3 behind interfaces:
  footprint provider, time index provider, pixel source. The PoC's
  wildtiles bindings and the sentinel-cogs bindings are the first two
  implementations; CDSE or planetary-computer later, same interfaces.
- The page as the reference UI over the library; the aatgrid explorer
  and ortho-cog-viewer consume the same library rather than forking
  the page (ortho-cog-viewer replaces the bbox placement with honest
  mesh/UV reprojection -- it is a better layer-4 neighbour, not a
  competitor).
- Static hosting only, forever: GitHub Pages, no server component, no
  build step beyond bundling. The absence of infrastructure is the
  feature.
- Name: open. It is not estinel (no pipeline), not wildtiles (no
  bucket of its own). It is a reader.

## 6. Minimal path

1. Extract the PoC into the module + thin page, wildtiles binding
   only (pure refactor, already proven).
2. Add the earth-search binding: STAC search for layer 2, windowed
   overview reads for layer 3, client mosaic. First milestone: the
   same composer UI over any point on Earth.
3. Add the starc-store binding (reads the published store parquet) --
   small, and it makes every starc deployment an explorable archive
   for free.
4. Fold the library back under the aatgrid explorer and the
   ortho-cog-viewer as consumers.
