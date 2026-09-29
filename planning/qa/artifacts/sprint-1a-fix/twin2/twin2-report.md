# twin2 audit (sealed fixture, opened per DEV-33)

- Commit e638711, tag s1a-detectors-frozen-v2. Hash of planning/sealed/twin2 = 42d835c6...e845 == twin2.sha256: OK (also unchanged after the run).
- Command: `bash scripts/run-as-sitelens.sh pnpm exec tsx scripts/audit-twin.ts --twin-dir planning/sealed/twin2 --out-dir planning/qa/artifacts/sprint-1a-fix/twin2 --seed / --server server.mjs --map planning/qa/artifacts/sprint-1a-fix/twin2-map.json`
- Deviations (harness only, no detector/classifier/crawl/audit code touched):
  1. First run with the built-in static server gave every non-root page 404 (crawler normalises `/range/07/` to `/range/07`; built-in server has no dir-index without slash). Added `--server <file>` to scripts/audit-twin.ts: spawns twin2's own server.mjs (documented in its README) on a free port. Non-GET check is therefore n/a.
  2. First map used trailing-slash page names; crawler's page_path has none, so map pages were rewritten to crawl-normalised names (`range/07`, `range/07/item/2210`, ...). Map = defect->detector, pages/viewports from EXPECTED.json. Run 1 (0/7) and run 2 (0/7) were harness/mapping artefacts; final run is 6/7.
- Crawl: 10 pages (/, range/07?view=all, item 2210 (2 URL forms), 2214, info/1, info/4, bag?t=1, bag?set=2210, bag?set=2214). Classifier: home=homepage, range=category, items=product, info/4=info_shipping, bag=other.

## Result (strict: evidence on claimed page AND claimed viewport)
| # | detector | verdict | notes |
|---|---|---|---|
| 2 | shipping_depth | FOUND, viewport partial | item/2210 only @390x844 (one page-level row tagged M, says D and M checked); no 1440x1000 row |
| 5 | cta_below_fold | FOUND D+M | top 1041px @1000, 1417px @844; screenshot: button at y~1041 confirmed |
| 6 | axe:link-name | FOUND M | .bagl on range/07?view=all @390; screenshot: icon-only bag link, label hidden |
| 7 | horizontal_overflow | FOUND M | item/2214 scrollWidth 656 vs 390; screenshot: table/img extend past header width |
| 8 | oversized_image | FOUND D+M | hall-2019.png 2811137 B, rendered 1036x553 / 358x191; screenshot matches region |
| 9 | axe:image-alt | FOUND D | img g1.svg, g2.svg @1440 on range/07?view=all |
| 10 | price_first_viewport | MISS (strict) | see below |

Deterministic strict 6/7; full viewport coverage 5/7 (#2 partial, #10 miss).

## Misses / reasons
- #10: EXPECTED page is /bag/?t=1 (page_type `other`, detector not_applicable there; home is `homepage`, also not_applicable). The detector did fire on category and product pages (8 rows, unclaimed) which is the substance of the defect, but not on the claimed page. Cause: page-type applicability of price_first_viewport vs. where twin2's ground truth is anchored.
- #2 desktop: shipping_depth emits one page-level evidence row per page tagged with viewport M, so no D row exists.

## Unclaimed findings (not credited): 24
axe:link-name 11 (.bagl @390 on 8 other pages = same defect #6 "all pages", plus 2 card links a[href=2210/2211] @1440 on range/07, empty-link consequence of #9 images without alt), price_first_viewport 8 (category + product pages, both viewports), axe:image-alt 2 (range/07 @390; #9 claims D only, real), cta_below_fold 2 (item/2214 D+M, same layout, real), shipping_depth 1 (item/2214 @390, real). Overall these look genuine, not false alarms; EXPECTED lists only one page per defect.
Other evidence (not in map): axe document-title/html-has-lang etc. not present in final run (only 38 evidence rows total). No horizontal_overflow on other pages.

Artifacts: twin-summary.json, evidence.json, findings.json, pages/*/ (screenshots), coverage.json; summary.json (this QA summary); ../twin2-map.json.
