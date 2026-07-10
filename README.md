# Minus — vision ad blocker (Chrome extension)

The browser cousin of the [minus](https://github.com/garagehq/minus) HDMI
device: instead of matching filter lists, it **looks** at page elements with a
vision model running **entirely inside your browser** and covers the ones that
are ads with Spanish flashcards. Hover an overlay and hit ✕ to reveal the ad if
you actually wanted it.

Nothing leaves your machine — no server, no filter-list subscriptions, no
telemetry. The model *sees* what you see.

## What it blocks

- **Display / banner ads** — static `<img>`, ad `<iframe>`s, and ad-shaped
  slots, classified from a cropped tab screenshot.
- **Video ads** — the detector runs in **every frame** (`all_frames`), so it
  covers in-player `<video>` ads (re-sampled every ~2.5 s with 2-verdict
  hysteresis, like the minus device) *and* video ads inside cross-origin iframe
  players it can't see into (a top-frame motion sampler). Verified covering real
  ads on YouTube, USA Today, and Al Jazeera.
- Overlays **yield to page UI** — if a modal/lightbox opens over a covered ad,
  the flashcard steps aside (clip-path hole) so the dialog stays clickable.

## The popup (left-click the icon)

Everything lives in one styled panel — there is **no right-click menu**:

- **Ads blocked on this page** counter (mirrors the toolbar badge; the M icon is
  blue at rest, red while blocking).
- **Block ads (all sites)** — master on/off.
- **Block on this site** — per-hostname toggle.
- **Ad types** — independent **Video ads** and **Display ads** toggles (applied
  live, no reload).
- **Ad threshold**, **Engine** picker, live engine status.
- **Contribute anonymous ad snapshots** — opt-in, off by default (see Privacy).

## Engines

The engine list is generated from the packaged models (`models/index.json`), so
dropping in a new model dir makes it selectable with no code changes. Switch in
the popup (reloads the engine).

| Engine (`key`) | Model | Notes |
|---|---|---|
| **`lfm`** (default) | LFM2.5-VL-450M **Iter 21-web**, q4/q8 ONNX (~431 MB) | Catches web-display ads **and** doesn't false-positive on product/book imagery. Shipping default. **WebGPU only.** |
| `lfm-iter22` | LFM Iter 22-web | Experimental; higher web-ad recall. WebGPU only. |
| `lfm-web` | LFM Iter 20-web | Aggressive web-ad blocking (more FPs on product imagery). WebGPU only. |
| `lfm-stream` | LFM Iter 14 | Streaming-tuned (99.08 % frozen holdout). WebGPU only. |
| `siglip2` | SigLIP2-SO400M-384 fine-tune | Single forward pass, fast; large (~817 MB fp16). |

### Requires WebGPU

The default LFM engines are **WebGPU-only** — their quantized graph uses the
`GatherBlockQuantized` op, which ONNX-Runtime's WASM backend can't run. WebGPU is
on by default in Chrome/Edge 121+; if it's unavailable the popup status shows a
clear "needs WebGPU — enable it and reload" message. The WebGPU load and warm-up
are timeout-bounded, so a flaky GPU driver can't wedge the engine.

> A retrained SigLIP2-Lite **WASM fallback** was prototyped so no-WebGPU
> machines could still run a classifier, but shelved — WASM inference for this
> ViT is ~7 s/image, too slow for a real experience (int8 quant, which would
> shrink it, collapses this model's ad recall). The work lives on the
> [`siglip2-wasm-fallback`](https://github.com/garagehq/Minus-chrome-extension/tree/siglip2-wasm-fallback)
> branch.

## Install (unpacked)

1. Download the latest `minus-extension-vX.Y.Z.zip` from
   [Releases](https://github.com/garagehq/Minus-chrome-extension/releases) and
   unzip it.
2. Open `chrome://extensions`, enable **Developer mode** (top-right).
3. **Load unpacked** → select the unzipped `extension/` folder.
4. Browse an ad-heavy site. The model loads on first use (~20–60 s), then
   overlays appear on detected ads. Left-click the icon for all settings.

Requirements: Chrome/Chromium/Edge 121+ (WebGPU recommended); ~1–2 GB free RAM.

**Platforms.** WebGPU has shipped in Chrome since 113 on **macOS** (backed by
Metal — both Apple Silicon and Intel Macs), Windows (D3D12), and ChromeOS, and
on Linux more recently. So the default LFM engine runs on the GPU on essentially
all current desktop Chrome/Edge installs. Apple Silicon Macs are an especially
good fit (unified memory + a strong Metal GPU).

## Architecture

```
content.js (all frames)     background.js (SW)          offscreen.js (window)
───────────────────────     ─────────────────          ─────────────────────
top frame: static scan  →   captureVisibleTab      →   LFM2.5-VL (transformers.js,
  + iframe motion sampler    (rate-limited crops)       WebGPU) or SigLIP2 (ORT)
every frame: <video>    →   route classify + badge →   P(ad) per crop
  sampling (hysteresis)     + per-tab counter              │
      ↑                                                    │
      └────────── overlay flashcard (hover → ✕) ───────────┘
```

## Privacy & opt-in data contribution

See [PRIVACY.md](PRIVACY.md). Default: nothing leaves your machine.
Toggle **Contribute anonymous ad snapshots** in the popup to opt in (element
crop + hostname only, 10-min local cool-down; clicking ✕ on an overlay retracts
the sample before upload).

## Dev

```bash
npm install
node build.mjs            # bundles ORT + transformers.js into extension/dist/,
                          # and regenerates models/index.json from the model dirs
node build_model_index.mjs  # (index only)
# load extension/ as an unpacked extension (chrome://extensions, Developer mode)
```

## Tests

```bash
npm test                 # fast regression: model catalog + auto-discovery,
                         # overlay occlusion, popup branding/charset, badge
                         # counter, ad-type toggles (no GPU / no model download)
```

Heavier, GPU-backed suites (real model + real sites) live under `tests/` and use
`tests/harness.mjs` (`launchWithExtension`, `waitForEngine`, `serveFixtures`).
Headless WebGPU on Linux/NVIDIA needs
`--enable-unsafe-webgpu --ignore-gpu-blocklist --use-angle=vulkan
--enable-features=Vulkan --disable-vulkan-surface` and the full Chromium build
(Playwright `channel: "chromium"`), not the headless shell.

## Support

Minus is free, open-source, and runs entirely on your machine — no ads, no
tracking, no server bills passed on to you. If it saves you from a few
autoplay pre-rolls, you can buy me a coffee ☕:

<a href="https://buymeacoffee.com/cyrilengmann" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50" width="210"></a>

> **[buymeacoffee.com/cyrilengmann](https://buymeacoffee.com/cyrilengmann)**

There's also a **☕ coffee** link in the extension popup footer.

## License

MIT
