# Reading a starc store

[starc](https://github.com/hypertidy/starc) harvests STAC search results
into an append-only Parquet store: `queries`, `acquisitions` (with
`solarday`), `products` and `assets` (every asset href, verbatim). That is
everything the explorer needs for layer 2 (which days exist, and the hrefs
for each), so `lib/sources/starc.js` reads the store directly: no
catalogue round trip, no API, and any curated archive someone has harvested
becomes explorable from a static page. This is option C in
`docs/design.md`.

Status (Oct 2026): no starc store is public yet. Publishing the wildtiles
store, and possibly making that bucket listable, is future work in the
starc / wildtiles project. Until then the wildtiles cube itself is
explorable through its inventory and tile registry (the wildtiles source).

## Publishing a store

Copy the store directory to any static host that allows anonymous GET with
CORS and range requests (an S3 or Ceph bucket, GitHub Pages for a small
one), then point the explorer at the directory URL: source "starc store",
store URL, `read store`.

A static host cannot list a directory, so the explorer looks for the
Parquet files in this order:

1. **`manifest.json`** at the store root (recommended). Either a JSON
   array of paths or `{ "files": [...] }`, relative to the store root:

   ```json
   { "starc": 1, "files": [
     "acquisitions/0ffe296c54da3413.parquet",
     "products/collection=sentinel-2-c1-l2a/0ffe296c54da3413.parquet",
     "assets/collection=sentinel-2-c1-l2a/0ffe296c54da3413.parquet",
     "queries/0ffe296c54da3413.parquet"
   ] }
   ```

   From R, after a harvest:

   ```r
   files <- list.files(store, pattern = "\\.parquet$", recursive = TRUE)
   jsonlite::write_json(list(starc = 1, files = I(files)),
                        file.path(store, "manifest.json"), auto_unbox = TRUE)
   ```

2. **A bucket listing** (S3 `ListObjectsV2` on the store prefix), when the
   bucket allows it. Path-style URLs (`https://host/bucket/prefix`) and
   virtual-hosted ones (`https://bucket.s3.region.amazonaws.com/prefix`)
   both work. Many public buckets (wildtiles on Pawsey among them) do not
   allow listing, hence the manifest.
3. **Consolidated tables**: `acquisitions.parquet`, `products.parquet` and
   `assets.parquet` at the store root, one file each. Duplicates are fine;
   the reader deduplicates.

The first path segment names the table; `key=value` segments (the hive
partitions starc writes, such as `products/collection=.../`) fill in a
column a file leaves out.

## What the explorer reads

- `acquisitions`: `acquisition_id`, `platform`, `datetime`, `solarday`,
  `centroid_lon`, `centroid_lat`, `tile`, and `footprint_wkb` when present.
  Deduplicated by `acquisition_id`.
- `products`: `product_id`, `acquisition_id`, `collection`, `item_id`,
  `epsg`, `cloud_cover`, `baseline`, `query_id`. Deduplicated by
  `product_id`.
- `assets`: `product_id`, `asset_key`, `href`, `media_type`. Asset keys
  map to the explorer's band names through the same aliases the STAC
  binding uses (`red`/`B04`, `visual`/`TCI`, ...), so Earth Search and
  Planetary Computer style keys both work.

Each search reads the acquisitions and products tables once (cached for
the session), filters by date range, footprint and cloud, picks one
product per acquisition, and then reads only the asset files it needs:
starc names every shard after its `query_id`, and products carry
`query_id`, so a search touches the asset files of the queries that found
its scenes. Consolidated tables are read whole.

**One product per acquisition.** Reprocessings and other providers are
separate product rows of the same acquisition. With the collection box
blank, the explorer prefers `sentinel-2-c1-l2a`, then `sentinel-2-l2a`,
then anything else, and the highest processing baseline within a
collection; type a collection to use only that one (`read store` lists
the collections present).

**Footprints.** With `footprint_wkb` (the item geometry) the footprint is
the scene's data area, and results match a STAC search exactly (checked on
the dev fixtures: 17 scenes on 7 days and 34 on 11, both sources). Without
it, the footprint is the full 110 km MGRS tile computed from `tile`
(`mgrsExtent()` in `lib/geo.js`), so a partial-swath scene can be listed
for a region its data does not reach; loading that day then reports "no
pixels in the region". starc's `extract_item()` does not fill
`footprint_wkb` yet, so writing the item geometry there would sharpen
this.

**Pixels.** Hrefs must be public, CORS-enabled COGs, as for the STAC
source. Planetary Computer hrefs need signing and will not load.

## Scale

Acquisitions and products are read in full (only the columns above), which
is fine for curated stores: the 82-region Antarctic store is about 55k
acquisitions. A store harvested as thousands of small query shards costs
one request per shard on first read; consolidating the acquisitions and
products tables (and listing those in the manifest) makes that a handful.

## Dev fixtures

`dev/make_starc_fixture.py` builds two mock stores from
`dev/fixtures/items.json`: `fixtures/starc/` in starc's sharded layout with
a manifest (one overlapping re-harvest included, to exercise the dedup), and
`fixtures/starc-flat/` as consolidated tables with `footprint_wkb`.
`dev/server.mjs` serves them at `/starc/` and `/starc-flat/`, and the
sharded one again at `/s3/store/` behind a mock `ListObjectsV2` with no
manifest. For example:

```
http://localhost:8765/#src=starc&store=http%3A%2F%2Flocalhost%3A8765%2Fstarc&roi=146.6,-42.8,147.4,-42.2&from=2025-01-01&to=2025-01-31&cloud=40&preset=visual&day=2025-01-03
```
