# Clear-day scan for rangefinder

Design and plan, 6 Oct 2026. Origin: looking for a single very clear Sentinel-2
day over Tasmania and the eastern mainland coast, and realising the search is a
per-day aggregate over footprints, not a per-scene cloud filter.

## Problem

"Find the clearest day over this region" is not well defined analytically. It
is a combination of:

1. metadata (STAC cloud and nodata percentages, footprints, acquisition date),
2. a cheap prediction from that metadata (which days are worth looking at),
3. the user looking at low-resolution imagery and deciding.

rangefinder already does 3 (overview reads, composites, day scrub). This design
adds 1 and 2 as a client-side pass over the existing search result, plus the
list controls needed to act on it. No server component, no new index.

## What STAC metadata can and cannot tell us

Per item on earth-search `sentinel-2-c1-l2a`:

- `eo:cloud_cover` plus the Sen2Cor breakdown: `s2:high_proba_clouds_percentage`,
  `s2:medium_proba_clouds_percentage`, `s2:thin_cirrus_percentage`,
  `s2:cloud_shadow_percentage`, `s2:nodata_pixel_percentage`, water/vegetation/
  snow fractions.
- `grid:code` for the MGRS tile (replaces the `mgrs:*` fields of the old
  `sentinel-2-l2a` collection).
- `geometry` is the valid-data footprint, not the full MGRS square.

Limits:

- Cloud is per granule (110 km MGRS square). "Region clear" is an aggregate
  over every granule of a solar date.
- SCL is unreliable over water; ocean granules should not dominate either way.
- Nothing captures haze, smoke or glint. "Crisp" is low aerosol, and metadata
  cannot distinguish a clear day from a smoky one. Metadata is the coarse
  filter; the ranking needs pixels and the final choice needs a human.

A day mosaic in a browser (Copernicus, rangefinder) is usually one to three
swaths; S2A/B/C are phased so adjacent tracks over the east coast can fall on
the same calendar day. Group by solar date, not by track. Browsers also fill
gaps per pixel from the nearest prior date, so a remembered "whole coast
clear" view may be two adjacent days.

## Per-day statistics

Computed client-side from the search result. Search runs WITHOUT the cloud
filter so one result gives all the stats; the cloud threshold becomes a live
re-sort rather than a re-query.

For each solar date d, with region R:

- `n_all`: scenes acquired over R on d.
- `n_clear`: scenes with `eo:cloud_cover` below the threshold.
- `completeness = n_clear / n_all`. Judge a day against what was flown, not
  against the whole bbox: a day only ever covers one to three swaths.
- `extent`: area of the union of clear footprints (nodata-adjusted) as a
  fraction of R, or of the land area of R if a land mask is available.
  This is what "all the way up the coast" means.
- `cloud_max`, `cloud_mean` over clear scenes, for display.

Extent without polygon union: rasterise footprints onto a coarse grid of R
(about 200 cells across), count covered cells. Same answer at any resolution
that matters, trivially fast, and the same grid can be reused for the row
glyph.

Default sort: extent descending, completeness as tiebreak. The remembered
"incredible day" should float to the top on exactly these two numbers.

## Scene list controls

The day list is the real interface. Add:

- sort: date | scene count | extent | completeness.
- filters: minimum scene count or minimum extent, so hundreds of single-scene
  days disappear; cloud threshold slider (live, no re-query).
- per-row glyph: the day's footprints drawn into a small canvas (about 40 px)
  in region coordinates, no projection needed at that size, fill alpha by
  cloud percentage. Lets the whole year be scanned without clicking.
- footprint layer on the map coloured by cloud percentage rather than uniform,
  so the aggregate is legible at a glance.

## Imagery at low resolution

Two tiers, both free and CORS-open on sentinel-cogs:

1. `thumbnail` asset per item (TCI, about 343 px, around 30 KB). Use for
   hover preview on a day row and for a cheap haze proxy (see below). A year of
   a ten-granule region filtered to a shortlist is a few hundred requests,
   cached.
2. COG overview reads, which rangefinder already does. Add an explicit
   "lowest overview" option to load imagery, so a whole-region day can be
   pulled at the coarsest level regardless of output size. The current logic
   probably lands there for a big region already; making it a setting makes
   the behaviour visible and lets the user force it for a small region when
   scanning rather than inspecting.

WMTS/WMS was considered for the triage step. Copernicus Data Space OGC
services are per-account instances with quotas, awkward for a public Pages
site. DEA OWS (`ows.dea.ga.gov.au`) is free with a TIME dimension on the S2 ARD
collections and would work for Australia, but it is a second index with its
own date semantics. Thumbnails are cheaper than either for triage, and for
the view step rangefinder's windowed overview reads keep raw bands and
interactive stretch, which WMTS cannot.

## Haze proxy (optional, later)

From thumbnails, a per-scene scalar to reorder the metadata shortlist:

- mean blue over land pixels (haze and smoke raise it),
- or local contrast / Laplacian variance (crisp scenes are sharper).

Aggregate per day the same way as cloud. This is the only thing in the design
that addresses "crisp" rather than "cloud-free". Keep it as an extra sort key,
not a filter, since the user still decides.

## STAC access notes

- Use `sentinel-2-c1-l2a`; element84 have said the old `sentinel-2-l2a` stops
  being updated. Field names differ (`grid:code` vs `mgrs:*`).
- POST with a CQL2 filter and large `limit` over a big bbox returns 502 from
  the earth-search gateway (timeout). Use `limit` 100 and page on the `next`
  link, which for c1 is a GET href with the token baked in.
- The `query` extension works as a URL parameter on GET
  (`query={"eo:cloud_cover":{"lt":15}}`), useful for R and curl checks.
- sds::stacit currently mangles a single "start/end" datetime string into
  "start/start"; it expects a length-2 vector. One-line fix: pass a
  length-1 string containing "/" through unchanged.

## Plan

1. Stats pass: group search result by solar date, compute n_all, n_clear,
   completeness, extent (coarse grid), cloud_max, cloud_mean. Pure function
   over the items array, unit-testable with a fixture.
2. List controls: sort select, min count/extent filter, live cloud slider.
   Search runs unfiltered; threshold applied in the stats pass.
3. Row glyph and coloured footprints, both from the same coarse grid and
   footprint geometry.
4. "lowest overview" setting on load imagery.
5. Thumbnail hover preview on day rows.
6. Haze proxy from thumbnails as an additional sort key.

Steps 1 to 4 are the useful unit; 5 and 6 are refinements.

## Validation

- The Tasmania to Brisbane search (region about 953 x 2394 km, Apr to Jul
  2026, cloud 20, 3000 items) showed 2026-06-22 with 103 clear scenes on a
  single east-aligned swath. That is the test case: it should rank first or
  near first on extent, and the glyph should show the swath shape.
- Check 2026-06-20 and 2026-06-24 as possible adjacent-swath halves of the
  same high-pressure system.

## Out of scope

- Any server-side tiling or precomputed per-day products.
- Polygon union libraries; the coarse grid is sufficient.
- A land mask beyond what is cheap to include; extent relative to the bbox is
  acceptable for a first cut.

## Status (built)

All six plan steps are in: `lib/scan.js` (stats pass, sort and filter,
sharpness), the scene panel (live cloud slider, sort, min scenes, min
cover, row glyphs, hover thumbnails, "score sharpness"), cloud-coloured
footprints, and "lowest overview" under the composite controls.

Choices made along the way:

- Days with no scene under the limit are left out of the list and the
  timeline (they have nothing to composite). `n_all` still counts them.
- Extent is relative to the region bbox (no land mask). The grid is about
  200 cells on the long side, cells square on the ground.
- The glyph and the hover preview draw footprint polygons in region
  coordinates (equirectangular, scaled by cos(latitude)), not the grid.
- Thumbnails are placed by their MGRS square (`grid:code`) and clipped to
  the item footprint, since a thumbnail is black where there is no data.
- Sharpness is the variance of the Laplacian of thumbnail luminance over
  non-black pixels, averaged over a day's clear scenes. It is scored on
  demand for the listed (filtered) days only.
- Search defaults to 1000 max items now, since it is unfiltered; `max` is
  kept in the permalink when changed.

Validation (`dev/make_scan_fixture.py` walks the public bucket for the real
items, `dev/test-scan.mjs` scores them): Tasmania to Brisbane, 3 Apr to 5 Jul
2026, cloud 20: 9630 items unfiltered, 93 days with clear scenes, stats in
about 50 ms. On extent 2026-06-22 ranks 3rd (cover 29.6%, 103 of 222 scenes
clear), behind 2026-04-03 (31.2%) and 2026-04-23 (29.8%). It was flown by
S2A and S2B on adjacent swaths; the eastern one is the clear one, and the
glyph shows it. 2026-06-20 and 2026-06-24 rank 74th and 46th, so they are
not the other half of that day. On thumbnail sharpness among days over 20%
cover, 2026-06-22 ranks 2nd of 12.
