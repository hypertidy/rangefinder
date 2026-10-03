// One cache for every source's native pieces: COG tiles (decoded, per
// overview level), Zarr chunks (decoded) and XYZ/WMTS tiles (decoded
// images). Keys name the piece as the file stores it (file + level + tile
// column/row, or array + chunk coordinates), never the view that asked for
// it, so a pan, a zoom inside one overview level, a band swap or a replay of
// the animation reuses whatever pieces it shares with an earlier read.
//
// Entries are kept least recently used first out under a byte budget.
// Requests in flight are shared: a second reader of the same piece waits on
// the first request instead of sending its own, and the request is only
// aborted when every reader waiting on it has aborted (so a read-ahead
// that gets cancelled does not take the visible load down with it).

var budget = 512 * 1024 * 1024;
var entries = new Map();   // key -> { p, size, done, ctl, waiters }
var bytes = 0, hits = 0, misses = 0;

function abortError() {
  try { return new DOMException("Aborted", "AbortError"); }
  catch (e) { var err = new Error("Aborted"); err.name = "AbortError"; return err; }
}

function evict() {
  var it = entries.keys();
  while (bytes > budget && entries.size > 1) {
    var k = it.next().value, e = entries.get(k);
    if (!e.done) continue;            // in flight: not counted yet, keep it
    entries.delete(k); bytes -= e.size;
  }
}

// Wait on an entry's promise unless this reader's own signal aborts first.
function follow(e, signal) {
  if (!signal) { e.waiters++; return e.p.finally(function () { e.waiters--; }); }
  e.waiters++;
  return new Promise(function (ok, no) {
    var left = false;
    function leave() {
      if (left) return;
      left = true; e.waiters--;
      signal.removeEventListener("abort", onAbort);
    }
    function onAbort() {
      leave();
      if (!e.done && e.waiters <= 0) {
        // nobody wants it any more: stop the transfer and forget it
        e.ctl.abort();
        if (entries.get(e.key) === e) entries.delete(e.key);
      }
      no(abortError());
    }
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort);
    e.p.then(function (v) { leave(); ok(v); }, function (err) { leave(); no(err); });
  });
}

// The cached piece for key, made by make(signal) on a miss.
//   sizeOf(value)  bytes it holds (default value.byteLength)
//   signal         this reader's AbortSignal
// -> { p: Promise<value>, hit: boolean }   hit: no request was sent for it
export function getChunk(key, make, opts) {
  opts = opts || {};
  var e = entries.get(key);
  if (e) {
    entries.delete(key); entries.set(key, e);   // most recently used
    hits++;
    return { p: follow(e, opts.signal), hit: true };
  }
  misses++;
  var ctl = new AbortController();
  e = { key: key, size: 0, done: false, ctl: ctl, waiters: 0 };
  e.p = Promise.resolve().then(function () { return make(ctl.signal); });
  e.p.then(function (v) {
    if (entries.get(key) !== e) return;
    e.done = true;
    var sizeOf = opts.sizeOf || function (x) { return (x && x.byteLength) || 0; };
    e.size = sizeOf(v) || 0;
    bytes += e.size;
    evict();
  }, function () {
    if (entries.get(key) === e) entries.delete(key);
  });
  entries.set(key, e);
  return { p: follow(e, opts.signal), hit: false };
}

// Whether a piece is already held (finished, not in flight).
export function hasChunk(key) {
  var e = entries.get(key);
  return !!(e && e.done);
}

export function chunkStats() {
  return { bytes: bytes, entries: entries.size, budget: budget, hits: hits, misses: misses };
}

export function setChunkBudget(b) {
  budget = Math.max(0, b);
  evict();
}

export function clearChunks() {
  entries.forEach(function (e) { if (!e.done && e.waiters <= 0) e.ctl.abort(); });
  entries.clear(); bytes = 0;
}
