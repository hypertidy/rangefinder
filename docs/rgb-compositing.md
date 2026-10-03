# RGB compositing controls

Handoff record from the thread that built the compositing controls. Its
`render.js` is now `lib/render.js` and its page changes are in `index.html`;
the file-level notes below describe that handoff. The L2A offset findings
are the lasting part.

Thread 2 of the plan. Everything here is additive and static; nothing in
`lib/` or the top-level pages was touched.

## Files

- `render.js`: drop-in replacement for `lib/render.js`. Same exports, same
  output by default (checked: identical RGBA for linear/gamma, identical
  2-98% limits). Adds:
  - `TRANSFERS.sqrt`, `TRANSFERS.log` (log1p with k = 100, normalised)
  - `RenderParams.offset` (number or [r, g, b]) added to stored values
    before the stretch; limits are in corrected units
  - `autoStretch(comp, lo, hi, { joint, offset })`: `joint` pools the three
    bands into one pair of limits (keeps true-colour balance)
  - `sceneOffset(scene)`, `scenesOffset(scenes)`, `L2A_OFFSET`,
    `HARMONISED_ARCHIVES`: decide the L2A offset from scene metadata
- `index.html`: the top-level `index.html` (as of 01:38 UTC) with the new
  controls. `index.html.diff` is the same change as a unified diff against
  `../index.html`. It imports `../lib/explorer.js` plus `./render.js`;
  once `render.js` replaces `lib/render.js`, the import goes back to
  `import * as X from "./lib/explorer.js";` (the three-line shim at the
  top of the module script goes away).
- `screens/`: controls in use; Collection 1 scene with the offset applied.

To fold in: copy `render.js` over `lib/render.js`, apply the diff to
`index.html` (then restore the import), run `dev/build_standalone.py`.

## Controls

Under "composite" for raw-band presets:

- **limits**: `percentile` (low % / high %, default 2 / 98, over the whole
  view so mosaics stay seamless) or `manual`. The R/G/B min/max boxes
  always show the limits in use; typing in one switches to manual.
- **same limits for all bands**: joint percentiles; in manual mode an edit
  to one band is copied to the others.
- **stretch curve**: linear, sqrt, log. Then **gamma** (unchanged).
- **L2A offset**: auto (from scene metadata), always -1000, off.
- **reset to 2-98% auto**.

All of it re-renders the cached composite (no refetch) and goes into the
permalink: `lim=pct|man`, `pct=2,98`, `mm=lo:hi,lo:hi,lo:hi`, `joint=1`,
`curve=`, `gamma=`, `off=auto|-1000|0`.

## The L2A offset: what the archives actually store

Checked on pixels, not just metadata, by regressing B04 against TCI for
the same scene (S2C 55HBU 2025-02-18) in both Earth Search archives:

| collection | bucket | B04 1st pct | TCI = 0 at B04 | needs -1000 |
|---|---|---|---|---|
| `sentinel-2-l2a` (legacy) | sentinel-cogs / sentinel-s2-l2a-cogs | 147 | ~0 | no |
| `sentinel-2-c1-l2a` | e84-earth-search-sentinel-data | 1140 | ~950 | yes |

Both items carry `raster:bands` offset -0.1 and baseline 05.11, so the
metadata alone can't tell them apart; `earthsearch:boa_offset_applied` is
true on some legacy items and false on others with harmonised pixels
either way. So `sceneOffset()` uses: baseline < 04.00 -> 0; href in a known
harmonised archive (`HARMONISED_ARCHIVES`, currently the legacy bucket) ->
0; otherwise baseline >= 04.00 -> -1000. A source can override by setting
`scene.meta.dnOffset`. Planetary Computer and CDSE serve ESA's DN with the
+1000, so they fall in the -1000 branch (once those catalogues are
supported).

End-to-end check through the page (mock STAC over real items, Victoria,
2025-02-18, auto offset): legacy limits 144:2399 / 176:2093 / 93:1914,
Collection 1 limits 144:2398 / 176:2093 / 93:1913. Same picture from both.

The Collection 1 bucket is public with CORS (`Access-Control-Allow-Origin: *`),
so `sentinel-2-c1-l2a` on Earth Search should work in the explorer as is;
it is the collection Element84 maintains going forward.

Limit: the offset is one value per load (majority of the day's scenes; the
note under the selector says when a day mixes both). A day mixing
baselines would need the offset applied per layer before `mosaic()` in
`loadComposite()`; that never happened in the fixtures.
