# "Just works" acceptance gate

The bar: **anyone can install the unpacked extension and it works with zero
configuration** — no flags, no server, no setup. This documents what is
automatically verified vs what needs real-hardware confirmation.

## Automatically verified (Playwright, this repo)

Run `bash tests/run_all.sh` plus the individual suites. All green as of the
last run against the **default safe engine (LFM Iter 14)** on WebGPU:

| # | Criterion | Test | Status |
|---|---|---|---|
| 1 | Loads with no flags/config; engine reaches "ready" | every suite's `waitForEngine` | ✅ |
| 2 | Blocks a real ad element with a Spanish overlay | `test_overlay_basic` | ✅ |
| 3 | Leaves non-ad content uncovered | `test_overlay_basic`, `test_sites fp` | ✅ |
| 4 | ✕ reveals the ad and it stays revealed | `test_overlay_basic` | ✅ |
| 5 | Video ad-breaks covered, cleared when content resumes | `test_video_hysteresis` | ✅ |
| 6 | Zero false-positives on 6 image-heavy no-ad pages | `test_sites fp` | ✅ |
| 7 | Dynamic-insert / below-fold / iframe / shadow-DOM ads caught | `test_sites fixtures`, `test_edge_cases` | ✅ |
| 8 | Works under page zoom / DPR ≠ 1 | `test_edge_cases` | ✅ |
| 9 | Per-site disable honored | `test_edge_cases` | ✅ |
| 10 | No memory / overlay leak over sustained browsing | `test_perf_soak` (15 pages, 0 leaks) | ✅ |
| 11 | Opt-in data collection off by default; ✕ retracts | `test_collection_optin` | ✅ |
| 12 | Engine switch in popup reloads live | `test_lite_engine` | ✅ |
| 13 | Model loads in a reasonable time | `test_perf_soak` (6.4s cached) | ✅ |

## Needs real-hardware / manual confirmation

These can't be faithfully tested in datacenter headless Chromium:

- **Live ad true-positives** on YouTube/news/etc. — headless is served almost
  no real ads; we validate on fixtures with real ad creatives + a video
  stream instead. Confirm on a normal machine browsing ad-supported sites.
- **First-run model download UX** — the repo ships models locally; the
  download-on-first-run path (HF hub + progress bar) is exercised by
  `test_first_run` but the real CDN download speed/quota behavior needs a
  fresh install on a real network.
- **WASM-only machines** (no WebGPU) — latency there is far higher
  (~26s/img for the LFM VLM; the **lite** engine is the intended path at
  ~1-3s). Confirm on a machine without WebGPU.
- **WebGL backend** — build-gated behind `onnxruntime-web/all`; op coverage
  is partial. Unvalidated on this project's WebGPU-only hardware.

## Known limitations (by design)

- The default **lfm** engine is streaming-specialized: it catches web-display
  ads conservatively (28.6% recall) to guarantee zero content false-positives.
  Users wanting aggressive web-ad blocking select **lfm-web** (accepting some
  product-image FPs until the Iter 21 hard-negative retrain lands).
- Cross-origin iframe *interiors* can't be pixel-inspected; we classify the
  iframe element as rendered in the top-level screenshot.
