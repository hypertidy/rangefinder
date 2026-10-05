# What the numbers are

rangefinder reads source pixels and composes them in the browser. This page
lists what is exact, what is approximated, and where each approximation is
shown. The model is ncview-rs's "source-value fidelity" page: never paint a
guess as data, and label every place where presentation and data differ.

## Exact

- **Stored values.** Every composite holds the source's own numbers in the
  source's data type: Sentinel-2 DN, DEM metres, Zarr values unpacked with
  `scale_factor` / `add_offset`. Stretch, curve, gamma, ramp, hillshade and
  reverse only change colours. The hover readout, the point series, the
  statistics and the GeoTIFF export all read these numbers, never the
  colours.
- **Nodata stays nodata.** A pixel no scene covered is "no data" in the
  readout, a gap in the point series and nodata in the GeoTIFF (NaN for
  floats). A Zarr fill value or `missing_value` becomes NaN when read.
- **Statistics.** The status line's min / max / mean use every valid pixel
  of the composite. NaN and infinities are counted apart and never enter
  them.
- **Point series.** A day that has not been composed reads one output
  pixel through `cellGrid()`, a 1x1 grid on the same lattice. That gives the
  same value a full read of the day would give at that pixel (checked
  against full reads on Sentinel-2 and MUR SST).

- **Curvilinear grids** (2D longitude / latitude: ROMS, NEMO, tripolar)
  are not warped through a lattice. Each output pixel takes the cell whose
  footprint holds the pixel centre, tested exactly. The footprint is the
  model's own where it says so: CF `bounds`, or ROMS psi points. Checked on
  CBOFS against the psi cells: every water pixel took a cell whose psi
  quadrilateral holds it.
- **Profiles** read each level at the pinned pixel through the same
  1x1 cell grid as the point series, so each value is the map's value at
  that level. ROMS depths use the model's own stretching (Vtransform 1 or
  2, `Cs_r`, `hc`) with `h` and `zeta` at that pixel and time; they
  matched a direct computation from the NetCDF.

## Approximated, and how it is disclosed

- **Resampling is nearest-neighbour onto the output grid.** The composite
  is on the output grid (map CRS, pixel size from "output size"), not on
  the source's pixels. Each output pixel takes one source pixel and nothing
  is averaged. The source coordinates are computed exactly every 16 output
  pixels and interpolated bilinearly in between, so a pixel near a source
  cell edge can take its neighbour. The readout shows the output pixel
  (`@ px col,row`) so this is never hidden.
- **Overviews and levels.**
  - A COG or VRT mosaic is read from the coarsest overview that is still
    as fine as the output pixel. A coarse view therefore shows overview
    values, which GDAL usually built by averaging or nearest. The status
    line names the overview level.
  - A tile server is read at the level that suits the grid, or coarser when
    that level would need too many tiles. The status line names the level.
  - A Zarr grid is decimated by striding when one output pixel spans
    several cells.
- **Mosaicking.** Each pixel takes the first scene with valid data, least
  cloudy first, up to "max scenes". A pixel is valid when any band differs
  from the file's nodata, or from 0 when the file declares none. For band
  combinations, all bands must be valid. Real zeros in a file without a
  nodata value are therefore read as nodata.
- **Percentile limits** come from a sample of about 250,000 valid values,
  not every pixel. Zeros are left out of three-band composites, where 0 is
  reflectance nodata, and kept for single bands such as DEMs and SST. They
  set colours only.
- **The L2A offset** (-1000 DN from processing baseline 04.00) is decided
  from scene metadata. The status line says whether it is "auto", "always"
  or "off", and the readout shows the stored number beside the corrected
  one. The point series decides it per day. See `rgb-compositing.md`.
- **Curvilinear footprints without bounds** are built half way between
  neighbouring centres (on the sphere), with the outer ring extrapolated
  one cell. The source line says which footprints were used. Where
  footprints overlap (ROMS land cells carry made-up coordinates; CBOFS has
  water cells over water cells near the bay mouth), a cell with data wins,
  and among those the last in storage order.
- **CRS.** Every source line says where its CRS came from, and marks
  guesses `[assumed]`. Today's guesses are XYZ templates taken as Web
  Mercator and Zarr lon/lat (1D or 2D) taken as WGS84. The GeoTIFF and VRT exports
  record the definition's provenance.
- **Tile servers serve pictures.** Most XYZ/WMTS tiles are colours, often
  JPEG, not values. Only the RGB-packed elevation encodings (terrarium,
  Mapbox terrain-RGB) are decoded back to metres.
- **The source VRT export** is a recipe: GDAL warps the same files to the
  same grid with its own sample points. Its values match the GeoTIFF up to
  nearest-neighbour choices. In tests 93-97% of pixels were identical, and
  the rest took a neighbouring source pixel.

## Display only

- Ramps are interpolated from control points (17 per Crameri map) into a
  256-entry table, and limits and curves go through a 4096-step lookup.
  Colours are quantised; values are not.
- The PNG export is the picture as shown. Use the GeoTIFF for values.
