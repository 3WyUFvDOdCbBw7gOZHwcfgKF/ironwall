# Multithread GC Demo

Files:
- `demo~gc~multithread@main.iw`: the Ironwall source.
- `demo~gc~multithread$lit.json`: string literal database for the demo source.
- `build-iw.json`: ready-to-run CLI config for the pure-IW demo.

Fastest way to run it:

```bash
npm run build
node build/main.js src/examples/gc-multithread-demo/build-iw.json
```

What it demonstrates:
- One worker thread explicitly triggers `iw_gc_collect`.
- Other worker threads keep allocating and holding live heap references.
- Workers coordinate through the new `std~thread` mutex/cond wrappers instead of a host-side pthread shim.
- GC waits for worker threads to reach tagged safepoints or blocking parking points, stops the world, and scans all attached worker stacks.
- The output includes `gc-thread`, `gc-frame`, `gc-live-frame`, and `gc-sweep-summary` lines, then prints the final checksum.

Expected final line:

```text
752
```

The demo is now self-contained IW source and no longer relies on an external pthread host shim.
