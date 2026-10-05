# HEALPix (and other DGGS) as a rangefinder geometry: design and plan

Status: steps 1 to 5 of section 8 built (2026-10-05) in lib/dggs.js; see
"What was built" at the end. The plan below is kept as written, against
rangefinder main as of 2026-10-06 (lib/sources/zarr.js, lib/curvilinear.js)
and healpix-geo 0.3.3.

## 0. The gap, as the software states it

Opening DKRZ's EERIE store (HEALPix level 7, monthly means) and picking
pr:

    GET .../eerie-future-ssp245-v20240618_P1M_mean_7.zarr/cell/.zarray   404
    GET .../cell/zarr.json                                                404
    Error: pr: no 1D coordinate arrays for cell / time
        at regularGeometry (zarr.js:545)

rangefinder went looking for a coordinate array named after the spatial
dimension and there is none, because in a HEALPix store the dimension is
nameless on purpose: a cell's position is implied by its index, the
refinement level, and the indexing scheme (nested or ring). The geometry
is a recipe (level + scheme), not a payload (coordinate arrays). The 404s
are the gap: regularGeometry() and curvilinearCoords() both assume
geometry arrives as arrays.

## 1. What a HEALPix grid gives us that a curvilinear grid does not

lib/curvilinear.js draws a grid whose geometry is only known as arrays:
cell corners (from CF bounds or from neighbouring centres) become
footprints, footprints are projected to the output CRS, and every output
pixel takes the one footprint containing its centre (rasterCells). That
is the only option when there is no inverse mapping from position to
cell.

A HEALPix grid has an inverse. Given (lon, lat) the cell id is a closed
computation, and healpix-geo does it in bulk inside wasm:

    const cells = grid.lonLatToHealpix(lonlats)   // Float64Array in, BigUint64Array out

So the primary path is the one the warp renderers already use for
affine grids: for each output pixel centre, compute the source index,
read the value. No footprints, no rasterisation, no point-in-polygon.
The output grid's pixel centres go to lon/lat through proj4 (as the
affine path already does for a reprojected view), then to cell ids in
one wasm call, then to values by indexing the chunk data.

Footprints (section 4) remain useful for two things: drawing cell
outlines in the inspector, and a correctness check of the inverse path
during development.

## 2. Detection: the DGGS attributes

Three conventions are in circulation and the EERIE store follows at
least one of them; check its .zattrs and the variable's attrs when
implementing, and support all three because the cost is a few lines:

- xdggs / Zarr DGGS convention (what gridlook detects, changelog 1.3.0):
  a coordinate variable, typically cell_ids, with attrs
  grid_name = "healpix", level (or nside), indexing_scheme = "nested" |
  "ring". The data variable's spatial dimension is named cell or cells.
- CF grid_mapping style: a grid-mapping variable with
  grid_mapping_name = "healpix", healpix_nside, healpix_order (= "nest"
  | "ring"). Used by easy.gems / the hackathon stores.
- The crs attribute dictionary that DKRZ's HEALPix stores carry on the
  root or variable: healpix_nside, healpix_order.

Rule: a variable is HEALPix when any of those is found and the spatial
dimension is 1D with length 12 * nside * nside (that length check is the
cheap sanity test; it also distinguishes HEALPix from an ICON cell list,
which has no such relation). nside = 2^level.

Replace the current failure message with a specific one when the length
check passes but the geometry is not implemented yet, so the gap is
named:

    pr: HEALPix grid (nside 128, nested) is not supported yet

That line is worth landing first, before any of the rest.

Other DGGS (S2, H3, rHEALPix) are out of scope for this plan but the
detection and the geometry object (section 3) are shaped so that adding
one is a new cellsOf() implementation, not a new source. S2 is the one
that matters locally (trend.sst publishes S2-cell aggregates); it has
the same inverse property, and a JS S2 library exists.

## 3. The geometry object

describe() in zarr.js builds v.geom for regular grids and v.curv for
curvilinear ones; readZarrWarped() branches on them. Add v.dggs:

    v.dggs = {
      kind: "healpix", nside: 128, level: 7, scheme: "nested",
      ellipsoid: null,          // sphere unless the attrs say otherwise
      ncell: 12 * nside * nside,
      dim: "cell",              // the spatial dimension's name and index
      axis: 1,
      grid: <healpix-geo Grid>, // constructed once per dataset
      cellsOf: function (lon, lat) -> BigUint64Array,   // bulk inverse
      cornersOf: function (ids) -> Float64Array          // 4 corners per cell, section 4
    }

Extents: a HEALPix grid is global, so the variable's bbox is the whole
sphere and centresBbox() is not needed. crs is EPSG:4326 with the sphere
datum unless the attrs give an ellipsoid (healpix-geo supports
ellipsoidal HEALPix via the Grid constructor; gridlook added that in
1.5.0, so DKRZ stores may use it).

## 4. healpix-geo

npm healpix-geo, 0.3.3, wasm (healpix_geo_core bindings, from the
xdggs / openEO Antarctic work). Loaded on demand with the same lazy CDN
pattern as zarrita and icechunk-js; the wasm needs init() before use:

    var HEALPIX = ["https://cdn.jsdelivr.net/npm/healpix-geo@0.3/+esm", "https://esm.sh/healpix-geo@0.3"];
    // after import: await mod.default(); var Grid = mod.Grid;

Check how the CDN serves the .wasm file (jsdelivr +esm usually handles
the import.meta.url resolution; esm.sh may need the wasm URL passed to
init()). This is the one build risk; gridlook depends on the same
package through a bundler, so it is known to work in browsers.

API used:

    var grid = new Grid({ scheme: "nested", level: 7 });
    grid.lonLatToHealpix(Float64Array [lon0, lat0, lon1, lat1, ...]) -> BigUint64Array
    grid.healpixToLonLat(BigUint64Array) -> Float64Array centres
    grid.vertex(cellId, u, v) -> [lon, lat], u, v in [0, 1]   // corners at (0,0) (1,0) (1,1) (0,1)
    grid.vertices(cellId, steps) -> Float64Array steps*steps mesh of one cell

Cell ids are BigInt (BigUint64Array). Chunk indexing needs a Number;
for nside up to 2^13 (gridlook's tested maximum) ids fit in 53 bits, so
Number(id) is safe. Assert ncell < 2^53 at detection.

There is no bulk corners call; cornersOf() loops vertex() four times per
cell. That is fine for the inspector (a few hundred cells on screen) and
for a development check, and is why footprints are the fallback and not
the primary path.

## 5. The read path

readZarrWarped(a, grid, opts) for v.dggs, mirroring readCurvilinear():

1. Output grid -> pixel centres in the output CRS -> lon/lat via proj4
   (the affine path's lattice code in cog.js already does this for a
   reprojected view; reuse latticeWindow / resampleWindow where the shape
   fits, otherwise a plain loop, it is W*H points).
2. cells = v.dggs.cellsOf(lonlats). One wasm call.
3. Which chunks: the array's chunk shape along the cell axis (DKRZ
   stores chunk the cell axis in large runs, e.g. 4096 or more cells;
   the EERIE monthly store will say). Map each needed cell id to
   (chunk index, offset in chunk); collect the distinct chunk indices
   for the selected time (and other dims at opts.sel, as today).
4. Read those chunks through the shared chunk cache (getChunk), capped
   by chunk count / MB as the other paths are, logged as tiles for the
   inspector's "last read".
5. Fill the output: out[p] = chunk[cells[p] - chunkStart], unpacked with
   scale_factor / add_offset, fill -> NaN. Pixels whose cell is in a
   chunk that was skipped by the cap get NaN and the inspector reports
   the cap, as now.

Level of detail: a view at low zoom touches every chunk of the field
(one cell per pixel, cells spread over the whole sphere), which is what
the whole-field read in gridlook does too. DKRZ publishes the hierarchy
as sibling stores (_5, _6, _7 suffixes on the store name, or z5/z6/z7
groups), so the honest LOD move is to choose the sibling whose cell size
is nearest the view's pixel size, as the COG path chooses an overview.
Make that a catalogue-level hint (opts.levels: a list of store URLs by
level) rather than guessing from names; a second pass. Without it, read
the one store and let the chunk cap do its job.

Nested vs ring: healpix-geo's Grid takes the scheme, so cellsOf() returns
ids in the store's own scheme and no conversion is needed. Do not
convert; nested is the usual case and the z-order locality is what makes
chunk runs coherent.

## 6. Footprints and the inspector

For the inspector's cell outline and for a one-off correctness check,
cornersOf(ids) -> footprints in the shape footprints() in curvilinear.js
produces, then projectFootprints() and the existing drawing code. A dev
check: rasterise a few hundred footprints with rasterCells() and compare
the cell id under each pixel with cellsOf(); they must agree except at
shared edges.

The inspector's variable line should read like the curvilinear one does:

    pr (precipitation): float32 2 x 196608 as [time, cell],
    HEALPix nside 128 (level 7), nested, 196608 cells about 0.46 degrees
    across; chunks 1 x 196608 (...)

## 7. Fixtures and tests

- EERIE monthly level 7 (DKRZ waterpark, CORS open): the live fixture,
  and the sidebyside page 01 dataset.
- A self-written level 3 store (12 * 64 = 768 cells) with pr = cell id
  as float, written with xdggs or by hand, hosted CORS open: the unit
  fixture. Reading it at a coarse view and checking out[p] == cellsOf(p)
  tests the whole path with no numerical tolerance.
- Under dev/: the footprints-vs-inverse agreement check from section 6.

## 8. Order of work

1. Detection + the specific error message (section 2). Ship on its own.
2. Lazy healpix-geo loader; v.dggs with cellsOf (sections 3, 4).
3. Read path (section 5); first picture of EERIE pr.
4. Inspector line and permalink; sidebyside page 01 left.url.
5. Footprints for the outline and the dev check (section 6).
6. LOD by sibling store, as a catalogue hint (section 5, second pass).
7. S2 via the same v.dggs shape, with trend.sst output as the fixture;
   at that point the sidebyside page 01 is shared from both ends.

## 9. Relation to the rest

- sidebyside page 01: this plan is the bridge named there. Step 4 moves
  the page from warp-gap toward shared; step 7 completes it.
- gridlook: uses the same healpix-geo (and ellipsoidal HEALPix from it).
  The two viewers would share the cell geometry library and differ only
  in what they do with it: gridlook builds a mesh and draws cells;
  rangefinder inverts the view and samples. That difference, one grid
  two routes, is the comparison sidebyside exists to show.
- docs/icechunk.md: independent, but DKRZ's next-generation stores are
  likely to be Icechunk + HEALPix together, so both plans landing is what
  makes those readable.

## What was built (2026-10-05)

- lib/dggs.js holds all of it; zarr.js only calls findHealpix() in
  describe() and hands readZarrWarped() to readDggs() when v.dggs is set.
- Detection (section 2): the three conventions, plus the Zarr DGGS
  convention's dggs attribute (name, refinement_level, indexing_scheme,
  spatial_dimension, coordinate). Looked for on the variable, then the
  arrays its grid_mapping and coordinates name, its dimensions, cell_ids
  and crs, then the root group. A store whose attributes say HEALPix but
  whose shape does not fit gets a specific message naming the nside and
  the dimension; if healpix-geo cannot load the message is "HEALPix grid
  (nside N, nested) is not supported here yet (could not load ...)".
- healpix-geo 0.3.3 is built for bundlers (its JS imports the .wasm as a
  module, and there is no init()), so neither +esm nor esm.sh is relied
  on: healpix_geo_bg.js is imported from jsdelivr (unpkg as fallback), the
  .wasm fetched and instantiated against it, then __wbg_set_wasm() and
  __wbindgen_start(). Pinned to 0.3.3 because the two files must match.
- Cell lists: a cell_ids coordinate equal to 0 .. ncell - 1 is checked
  (up to 3.2 million cells) and then ignored; any other list (a regional
  subset, or ids in another order) is sorted once and looked up by binary
  search, and the variable's bbox comes from the listed cells' centres.
  A 1D variable along such a dimension is offered in the variable list.
- CRS: EPSG:4326, flagged [assumed] unless the attributes name the body.
  With no ellipsoid the cells are healpix-geo's default sphere (radius
  6370997 m) and map latitudes are used as they are; a named WGS84 /
  GRS80 or an explicit a, 1/f (or CF semi_major_axis /
  inverse_flattening) builds the ellipsoidal Grid, which takes geodetic
  latitude.
- Read (section 5): every output pixel (not a lattice), one wasm call per
  grid, the cell index under each pixel cached per grid so stepping days
  costs only chunks. The output pixel is a quarter of a cell (meta.res),
  so the diamonds are drawn as diamonds. Past the chunk cap the
  most-used chunks are read and the rest are logged as "not read" (status
  "capped") with their lon/lat extent, so the inspector shows where.
  A whole-world view of a level 7 field in 48 chunks of 4096 cells is
  about 2.3 million pixels and takes about 1.3 s headless.
- Inspector line: "HEALPix nside 128 (level 7), nested, 196608 cells
  about 0.46 degrees across", after the CRS line with where the
  attributes were found. Pinning a point outlines its cell (8 points per
  edge, as edges are curves in lon/lat) and names its id and index.
- Footprints and the dev check (section 6): dev/test-healpix.mjs
  rasterises 400 level 8 cells' corners with rasterCells() and compares
  with the inverse: all interior pixels agree.
- Tests: dev/make_healpix_fixture.mjs writes four stores where every
  value is its cell id (level 3 nested with a CF crs variable, level 3
  ring with xdggs cell_ids and no time, level 7 with a root crs
  dictionary, a level 8 WGS84 regional subset listed in reverse order);
  test-healpix.mjs checks sampled pixels against healpix-geo in
  EPSG:4326, 3857 and 3031 with no tolerance.

Not done:

- No live store was opened: DKRZ (eerie.cloud.dkrz.de,
  s3.eu-dkrz-1.dkrz.cloud) and the CDNs are blocked from the build
  container, so the EERIE pr store, its exact attributes and the CDN
  loading of the wasm are unverified. REMOTE=<store url> node
  test-healpix.mjs opens one. No EERIE entry in the store picker yet,
  for want of a checked URL.
- Step 6 (LOD by sibling store) and step 7 (S2).
- Permalinks need nothing new (zarr, zvar, day); the sidebyside page 01
  left.url is in another repository.
