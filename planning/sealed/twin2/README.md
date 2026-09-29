# twin2 (sealed fixture, second twin)

Static multi-page shop "Halden Hearth". Sealed until the detector-freeze tag v2; do not tune detectors against it.

Serve from this directory root. Links use query strings (`?view=all`, `?ref=hm`, `?t=1`) and numeric nested paths (`/range/07/item/2210/`); these map to directories with `index.html`, and the query is ignored by any static server. Either use any static server rooted here (directory index enabled), or run `node server.mjs [port]` (no dependencies, default 4402).

Ground truth: `EXPECTED.json`. Hash: `../twin2.sha256`.
