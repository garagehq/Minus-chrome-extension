# Privacy

Minus runs its vision model **entirely inside your browser**. By default,
nothing you browse ever leaves your machine: no URLs, no screenshots, no
telemetry, no filter-list phone-home. Classification happens locally on your
GPU (or CPU).

## Anonymous snapshot contribution (opt-in, default OFF)

To improve the model you can opt in — right-click the Minus icon →
*"Contribute anonymous ad snapshots (opt-in)"*. When enabled, and only then:

- When Minus blocks an element, the **cropped image of that element only**
  (never the full page, never the visible tab) is queued locally together
  with: the model's confidence, the element's size, the page **hostname
  only** (e.g. `example.com` — never the full URL or query strings), and the
  engine version.
- Samples wait in a **10-minute local cool-down** before upload. If you click
  the ✕ on an overlay ("show me this ad") during that window, the sample is
  **deleted and never uploaded** — an ✕ means the block was unwanted, and we
  don't collect what you didn't want blocked.
- Uploads go to the ingest endpoint configured by the extension build
  (`server/ingest-server.mjs` is the reference implementation). The training
  dataset lives in a private Hugging Face dataset repo owned by garagehq;
  write credentials live on the ingest server, never in the extension.
- Turn it off at any time from the same right-click menu; the local queue is
  simply abandoned and uploads stop.

No account, no cookies, no user identifier of any kind is attached to
contributions — samples are not linkable to each other or to you.
