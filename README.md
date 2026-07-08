# Minus — vision ad blocker (Chrome extension)

The browser cousin of the [minus](https://github.com/garagehq/minus) HDMI
device: instead of matching filter lists, it **looks** at page elements with a
vision model running **entirely inside your browser** (WebGPU via
[transformers.js](https://github.com/huggingface/transformers.js)) and covers
the ones that are ads with Spanish flashcards. Hover an overlay and hit ✕ to
reveal the ad if you actually wanted it.

Nothing leaves your machine — no server, no filter-list subscriptions, no
telemetry. The model *sees* what you see.

## How it works

```
content.js            background.js            offscreen.js
───────────           ─────────────            ────────────
find candidate   →    captureVisibleTab   →    LFM2.5-VL (Iter 14 fine-tune)
elements (img /       (one screenshot          via transformers.js on WebGPU:
iframe / ad-ish       per scan, cropped        P(ad) = logit decode over
divs / video)         per element)             Yes/No at first gen position
      ↑                                              │
      └────────── overlay Spanish flashcard ←────────┘
                  (hover → ✕ to allow)
```

- **Static elements** are classified once per content signature.
- **`<video>` elements** are re-sampled every ~2.5 s with 2-verdict
  hysteresis — the same stream behavior as the minus device.
- Engines: **LFM2.5-VL-450M** (our Iter 14 fine-tune, 99.08% on the frozen
  holdout) and **SigLIP2-SO400M-384** (98.26%, single forward pass, faster).

## Engines

| Engine | Model | Streaming holdout | Web-ad clean-core recall | Warm latency (Tegra WebGPU) |
|---|---|---|---|---|
| `lfm` (default) | LFM2.5-VL-450M Iter 14 fine-tune, q4/q8 ONNX (431MB) | 99.08% | 28.6% → Iter 20-web training in progress | ~340ms |
| `siglip2` | SigLIP2-SO400M-384 web fine-tune, fp16 ONNX (817MB) | 98.06% | 79.6% | ~25ms class |

### Engines (switch in the popup — reloads on change)

| Engine | Model | Streaming holdout | Web-ad clean-core | Size | Backends |
|---|---|---|---|---|---|
| **lfm** (default) | LFM2.5-VL-450M Iter 14, q4/q8 | **99.08%** | 28.6% | 431MB | WebGPU → WASM |
| lfm-web | LFM2.5-VL-450M Iter 20-web, q4/q8 | 99.08% | 75.0% | 431MB | WebGPU → WASM |
| siglip2 | SigLIP2-SO400M-384 web ft, fp16 | 98.06% | 79.6% | 817MB | WebGPU (→WebGL/WASM w/ fp32) |
| lite | ViT-B-16-SigLIP2-384, fp16/fp32 | 95.3% | (weaker) | 178MB fp16 / 356MB fp32 | WebGPU → WASM |

The **lfm** default is chosen for zero false-positives on web content
("just works"). **lfm-web** catches ~2.6× more web-display ads but
false-positives on product/book-cover imagery — offered for users who
want aggressive web-ad blocking (an Iter 21 hard-negative retrain aims to
make it FP-clean). **lite** is the low-end / no-WebGPU option: its fp32
graph runs on WASM in ~1-3s/image (vs ~26s for the 450M VLM on WASM).

Everything runs 100% locally — no server, no telemetry.

### Backend support matrix

| Backend | LFM engines | SigLIP2 / lite | Notes |
|---|---|---|---|
| **WebGPU** | ✅ (q4/q8) | ✅ (fp16) | primary path; Chrome 113+, Apple Silicon via Metal |
| **WASM** | ✅ (slow: ~26s/img for LFM) | ✅ (fp32; ~1-3s for lite) | universal fallback, no GPU needed |
| **WebGL** | ✗ (LFM fused ops unsupported) | ⚠️ build-gated | needs `onnxruntime-web/all` bundle + fp32 model; partial op coverage — the loader tries it and falls through to WASM |

Apple Silicon Chrome ships WebGPU-on-Metal by default, so the WebGPU
path covers it; WebGL mainly matters for older Chrome/Brave without
WebGPU, where the **lite** engine on WASM is the more reliable choice.

## Privacy & opt-in data contribution

See [PRIVACY.md](PRIVACY.md). Default: nothing leaves your machine.
Right-click the icon → "Contribute anonymous ad snapshots" to opt in
(element crop + hostname only, 10-min local cool-down, clicking ✕ on an
overlay retracts the sample before upload).

## Dev setup

```bash
npm install
node build.mjs          # bundles transformers.js + ORT runtime into extension/dist/
# load extension/ as an unpacked extension (chrome://extensions, Developer mode)
```

Until the fine-tuned ONNX export is packaged under `extension/models/`, the
engine falls back to the stock `onnx-community/LFM2.5-VL-450M-ONNX` from the
Hugging Face hub (pipeline-validation only — the fine-tune is the point).

## Site compatibility matrix

Playwright sweep with the default safe engine (LFM Iter 14) — **no page
breakage on any site**. "Overlays" are what the extension covered (headless
Chromium is served few real ads, so this is observational for true-positive
rate, but breakage and false-positives are hard signals):

| Site | Page OK | Overlays | Note |
|---|---|---|---|
| example.com | ✅ | 0 | no ads (correct) |
| Wikipedia (Advertising article) | ✅ | 1 | historical ad image (correct) |
| YouTube home / video | ✅ | 0 | — |
| BBC | ✅ | 0 | — |
| AP News | ✅ | 3 | real 970×250 ad units caught |
| old.reddit | ✅ | 0 | — |
| Google SERP | ✅ | 0 | — |
| Twitch | ✅ | 1 | promoted card |
| CNN / The Verge | ✅ | 0 | — |
| **Forbes** | ✅ | 3 | real 1280×282 billboards caught |
| **NYTimes** | ✅ | 4 | real 1280×270 leaderboards caught |
| **Amazon** (product search) | ✅ | 0 | no FP on product listings ✔ |
| eBay | ✅ | 1 | promoted listing |
| SPA in-page nav | ✅ | 0 | no overlay leak |

Highlights: coexists with every major site without breaking layout; catches
real programmatic ad units (Forbes/NYT/AP billboards & leaderboards); and the
safe default does **not** false-positive on Amazon product listings.

## Tests

```bash
node tests/spike_webgpu.mjs    # WebGPU adapter probe
node tests/spike_model.mjs     # in-browser model smoke test (downloads weights)
```

Headless WebGPU on Linux/NVIDIA needs:
`--enable-unsafe-webgpu --ignore-gpu-blocklist --use-angle=vulkan
--enable-features=Vulkan --disable-vulkan-surface` and the full Chromium build
(Playwright `channel: "chromium"`), not the headless shell.

## License

MIT
