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

Switch in the popup. Both run 100% locally. WebGL fallback for
non-WebGPU browsers is on the roadmap (SigLIP2 graph only — the LFM's
fused ops need WebGPU/WASM).

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
