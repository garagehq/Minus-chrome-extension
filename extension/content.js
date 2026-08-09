// Minus content script.
// Finds candidate ad elements in the DOM, crops them out of a tab screenshot,
// asks the local vision model whether each one is an ad, and covers confirmed
// ads with a Spanish-flashcard overlay (hover → X to allow).
//
// Static elements (img / iframe / ad-shaped divs) are classified once per
// content signature. <video> elements are re-sampled on an interval with
// hysteresis, mirroring how the minus HDMI device handles streams.

(() => {
  const MIN_W = 90, MIN_H = 60;            // ignore tiny elements (icons, pixels)
  const MAX_VIEWPORT_FRACTION = 0.92;      // never cover ~whole page
  const SCAN_DEBOUNCE_MS = 700;
  const VIDEO_SAMPLE_MS = 2500;
  const VIDEO_HYSTERESIS = 2;              // consecutive verdicts to flip state
  const IFRAME_MIN_W = 400, IFRAME_MIN_H = 225; // ~video-player-sized cross-origin frames (#2)
  const IFRAME_MOTION = 6;                 // mean 8x8 luma delta between ticks => "playing"
  // Boundary = any non-alphanumeric (so "ad-slot", "slot-ad", "box ad", "/ad/"
  // all match, but "gradient"/"shadow"/"download" don't). The old [-_\b] set
  // excluded whitespace, so an id ending in "-ad" (e.g. "shadow-ad") missed.
  const AD_HINT = /(^|[^a-z0-9])(ad|ads|advert|advertisement|adsense|sponsor|sponsored|promo|banner|dbl|doubleclick|taboola|outbrain)([^a-z0-9]|$)/i;
  // Shape gates so we only ever crop a *single ad slot*, never a content
  // column / hero / page section. Standard IAB units fit inside these; the
  // failure mode was giant containers (e.g. 710×3555 article grids) whose
  // viewport-clamped area slipped past MAX_VIEWPORT_FRACTION.
  const MAX_AD_H = 650;                    // tallest common rectangle (300×600 sky, 336×280…)
  const MAX_AD_ANY_H = 1300;              // beyond any standard unit (300×1050 portrait is the tallest)
  const SKYSCRAPER_MAX_W = 340;            // tall units are always NARROW (120/160/300-wide)
  // Cookie/consent/CMP furniture: never an ad, and it overlaps real content
  // in screenshots (produced "article image + Agree button" crops).
  const CONSENT_HINT = /(consent|cookie|gdpr|ccpa|onetrust|didomi|cookiebot|truste|usercentrics|quantcast|sourcepoint|sp[-_]?message|fc[-_]consent|\bcmp\b)/i;
  // Confidence tiering: an <iframe>/ad-slot has structural ad signal, so trust
  // the model at the normal bar. A bare <img>/<div> (editorial photos live
  // here) needs high confidence — editorial-photo FPs cluster at 0.66–0.76
  // while real ads sit at 0.90+.
  // Defaults tuned for Iter 21-web; per-engine overrides may arrive with
  // minus:settings (catalog `thresholds` field) — a well-separated model like
  // Iter 24 (non-ad p>0.3 on only 8/499 bench images) supports lower gates.
  let CTX_BLOCK_P = 0.60;                  // element has ad context (iframe / ad-hint ancestor)
  let BARE_BLOCK_P = 0.88;                 // context-less element: require high confidence
  // A context-less element (bare <img>/<div>) is only ever blocked if it is a
  // near-standard IAB ad size. Editorial photos live at arbitrary sizes
  // (307×205, 371×482, 460×307) and were the dominant FP even at p=1.0; real
  // display ads without ad-markup are almost always a standard slot size.
  const STD_AD_SIZES = [
    [300, 250], [336, 280], [728, 90], [970, 250], [970, 90], [320, 50], [320, 100],
    [300, 600], [160, 600], [120, 600], [300, 1050], [468, 60], [234, 60], [250, 250],
    [200, 200], [300, 100], [250, 360], [980, 120], [930, 180], [750, 100], [480, 320],
  ];
  const STD_TOL = 0.14;                     // ±14% render tolerance
  const MIN_CROP_STDDEV = 11;              // reject near-blank crops (whitespace/nav wrappers)
  const BLACK_LUMA = 12;                    // a DIRECTLY-read video frame this dark = unreadable (trusted read, so tight)
  // The SCREENSHOT fallback only runs for videos whose direct read is tainted
  // (= DRM/Vevo). Such video renders as a black/dark letterbox in tab captures —
  // we can't actually SEE it, so we can neither detect its ad nor its content.
  // Treat a dark/low-variance screenshot crop of a tainted video as unreadable
  // (non-ad) with a much more generous bar than a trusted direct read, so a
  // Vevo player is never left covered on a letterbox (a genuinely visible ad in
  // a player is bright + high-variance, well above these).
  const SHOT_DARK_LUMA = 46;
  const SHOT_MIN_STD = 22;

  let enabled = true;
  let blockVideo = true, blockDisplay = true; // per-type toggles (popup)
  let collectOptIn = false;                // anonymous snapshot contribution
  // Block-action appearance (options page): flashcards in a chosen language,
  // or a minimal "blocked" card. Confidence tag is toggleable.
  let blockAction = "flashcards", blockLang = "es", showConfidence = true;
  // Full 500-card JSON deck, loaded async; the built-in starter deck serves
  // until it arrives (and forever if the fetch fails).
  let activeDeck = null;
  function loadActiveDeck() {
    if (typeof minusLoadDeck !== "function") return;
    const want = blockLang;
    minusLoadDeck(want).then((d) => { if (want === blockLang) activeDeck = d; }).catch(() => {});
  }
  const allowed = new WeakSet();           // user clicked X
  const sampleKeys = new WeakMap();        // element -> queued sample key (for retraction)
  const cropByEl = new WeakMap();          // element -> {img,p_ad,w,h} for a "not an ad" report (opt-in only)
  const verdictCache = new Map();          // signature -> is_ad
  const overlays = new Map();              // element -> overlay div
  const videoState = new Map();            // video element -> {adVotes, nonAdVotes, blocked, src, pausedSince} (Map, not WeakMap, so the sampler can prune stale-blocked overlays)
  const iframeState = new WeakMap();       // large cross-origin iframe -> {fp, adVotes, nonAdVotes, blocked, classified}
  let iframeTick = 0;                      // sampler tick counter (blocked frames re-verify every 2nd tick)
  // The content script runs in every frame (manifest all_frames). The TOP frame
  // does the full static scan + tab-screenshot work; SUB-frames run only the
  // <video> path (reading frames directly off the element, no tab screenshot —
  // its coordinates are the top frame's, not this frame's).
  const IS_TOP = window.top === window;
  let scanTimer = null;
  let scanning = false;
  let lastReported = -1;
  let started = false;
  let ctxDead = false;                      // extension context invalidated (SW update/reload)
  const timers = [];                        // setInterval ids, cleared on shutdown

  // chrome.runtime.sendMessage THROWS synchronously once the extension context
  // is invalidated (the extension was updated/reloaded while this page lived).
  // Route every message through here so that (a) we never emit unhandled
  // rejections, and (b) the first such failure shuts the content script down
  // instead of spamming failed capture/classify attempts every 2.5s forever.
  function sendMsg(msg) {
    return new Promise((resolve) => {
      if (ctxDead) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          void chrome.runtime.lastError;    // consume "context invalidated"/"no receiver"
          resolve(resp ?? null);
        });
      } catch (e) {
        if (/context invalidated|Extension context/i.test(String(e))) shutdown();
        resolve(null);
      }
    });
  }
  function shutdown() {
    if (ctxDead) return;
    ctxDead = true;
    clearTimeout(scanTimer); scanTimer = null;
    for (const id of timers) clearInterval(id);
    for (const [, div] of overlays) div.remove();
    overlays.clear();
  }

  // Tell the background the live count of ads currently covered on this page so
  // it can drive the toolbar badge (and flip the icon blue->red). Only fires on
  // change to avoid chattering the service worker.
  function reportBlocked() {
    const n = overlays.size;
    if (n === lastReported) return;
    lastReported = n;
    sendMsg({ type: "minus:blocked", count: n });
  }

  // Sub-frames only ever run the video path, so skip frames too small to host a
  // visible player — this keeps us out of the swarm of tracking pixels / 1x1
  // and chrome iframes that all_frames would otherwise inject into.
  if (!IS_TOP && (innerWidth < 160 || innerHeight < 120)) return;

  sendMsg({ type: "minus:settings" }).then((resp) => {
    if (resp?.ok) {
      enabled = resp.settings.enabled;
      collectOptIn = !!resp.settings.collectOptIn;
      blockVideo = resp.settings.blockVideo !== false;
      blockDisplay = resp.settings.blockDisplay !== false;
      if (resp.settings.blockAction) blockAction = resp.settings.blockAction;
      if (resp.settings.blockLang) blockLang = resp.settings.blockLang;
      showConfidence = resp.settings.showConfidence !== false;
      loadActiveDeck();
      const th = resp.settings.engineThresholds;
      if (th) {
        if (typeof th.ctx === "number" && th.ctx > 0 && th.ctx < 1) CTX_BLOCK_P = th.ctx;
        if (typeof th.bare === "number" && th.bare > 0 && th.bare < 1) BARE_BLOCK_P = th.bare;
      }
    }
    start();  // set up the machinery once; every scan/sampler self-skips while !enabled
  });

  // Uncover everything and forget page state — used when blocking is turned off
  // (globally or for this site) so the page visibly returns to normal at once.
  function teardownOverlays() {
    for (const [, div] of overlays) div.remove();
    overlays.clear();
    videoState.clear();
    reportBlocked();
  }

  function applyEnabledState(next) {
    next = !!next;
    if (next === enabled) return;
    enabled = next;
    if (!enabled) { clearTimeout(scanTimer); scanTimer = null; teardownOverlays(); }
    else if (IS_TOP && !document.hidden) scheduleScan(300);
  }

  // React live to popup/options changes (no reload).
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    // Master enable / per-site allowlist changed → re-derive whether WE are on,
    // since the background folds disabledSites+host into `settings.enabled`.
    if ("enabled" in changes || "disabledSites" in changes || "pausedUntil" in changes) {
      sendMsg({ type: "minus:settings" }).then((resp) => {
        if (resp?.ok) applyEnabledState(resp.settings.enabled);
      });
    }
    if ("blockVideo" in changes) blockVideo = changes.blockVideo.newValue !== false;
    if ("blockDisplay" in changes) blockDisplay = changes.blockDisplay.newValue !== false;
    for (const [el, div] of overlays) {
      const kind = div.dataset.minusKind;
      if ((kind === "video" && !blockVideo) || (kind === "display" && !blockDisplay)) {
        div.remove(); overlays.delete(el);
        // a re-enabled type must re-cover, so clear the sticky "blocked" state
        if (kind === "video") videoState.delete(el);
      }
    }
    // Block-action appearance changed in the options page: re-render live
    // overlays in place (no reload, keeps position/occlusion state).
    if ("blockAction" in changes || "blockLang" in changes || "showConfidence" in changes) {
      if ("blockAction" in changes) blockAction = changes.blockAction.newValue || "flashcards";
      if ("blockLang" in changes) { blockLang = changes.blockLang.newValue || "es"; activeDeck = null; loadActiveDeck(); }
      if ("showConfidence" in changes) showConfidence = changes.showConfidence.newValue !== false;
      for (const [el, div] of overlays) {
        const p = div.dataset.minusP ? parseFloat(div.dataset.minusP) : null;
        renderCard(el, div, Number.isFinite(p) ? p : null);
      }
    }
    reportBlocked();
  });

  // Opt-in only: queue a blocked element's crop for contribution. The
  // background holds it for a 10-minute cool-down; clicking X retracts it.
  function maybeQueueSample(el, crop, r) {
    if (!collectOptIn || !crop) return;
    cropByEl.set(el, { img: crop, p_ad: r.p_ad, w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) });
    const key = `${location.hostname}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
    sampleKeys.set(el, key);
    sendMsg({
      type: "minus:queue-sample",
      sample: {
        key,
        img: crop,                        // element crop only, never the full page
        p_ad: r.p_ad,
        verdict: r.is_ad ? "ad" : "non_ad",
        host: location.hostname,          // hostname only, never the full URL
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height),
        engine: r.engineId || "lfm-iter14",
      },
    });
  }

  function start() {
    if (started) return;   // idempotent — set up observers/intervals/rAF exactly once
    started = true;
    // Static DOM scan + large-iframe motion sampler are top-frame only (they
    // rely on the tab screenshot, whose coordinates are the top viewport's).
    if (IS_TOP) {
      scheduleScan(200);
      // NOTE: no "style" in the filter. Pages that animate inline styles (tickers,
      // progress bars, sticky-header transforms) mutate every frame; watching
      // style would fire the observer nonstop. Combined with the coalescing
      // scheduleScan below, a scan is guaranteed to run instead of being reset
      // forever (the "ads never get scanned on animated pages" bug).
      new MutationObserver(() => scheduleScan(SCAN_DEBOUNCE_MS))
        .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "class", "id"] });
      addEventListener("scroll", () => scheduleScan(SCAN_DEBOUNCE_MS), { passive: true });
      addEventListener("resize", () => scheduleScan(SCAN_DEBOUNCE_MS), { passive: true });
      timers.push(setInterval(sampleIframes, VIDEO_SAMPLE_MS));
    }
    timers.push(setInterval(sampleVideos, VIDEO_SAMPLE_MS));  // runs in every frame

    // Only the visible (active) tab scans. The scan + samplers all self-skip on
    // document.hidden, and the background refuses captures/classifies from a
    // non-active tab — so a backgrounded tab never fights the single shared
    // engine or the capture rate limiter. On returning to the foreground, kick
    // a fresh scan so the newly-active tab catches up promptly.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { clearTimeout(scanTimer); scanTimer = null; }
      else if (enabled && IS_TOP) scheduleScan(300);
    });
  }

  // Coalescing scheduler: once a scan is queued it is NEVER pushed back. A pure
  // trailing debounce (clearTimeout + reset) meant a page mutating on a timer
  // reset the countdown every tick and scan() never ran; coalescing guarantees
  // the queued scan fires, then the next mutation queues a fresh one.
  function scheduleScan(delay) {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, delay);
  }

  // ---------------------------------------------------------------- candidates
  function isVisible(el, rect) {
    if (rect.width < MIN_W || rect.height < MIN_H) return false;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) return false;
    const area = Math.min(rect.width, innerWidth) * Math.min(rect.height, innerHeight);
    if (area > innerWidth * innerHeight * MAX_VIEWPORT_FRACTION) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.1;
  }

  // Short, stable-ish DOM path (tag + sibling index, up to 4 levels) — used to
  // disambiguate src-less candidates that would otherwise share a signature.
  function domKey(el) {
    let k = "", node = el, depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      const p = node.parentNode;
      const idx = p && p.children ? Array.prototype.indexOf.call(p.children, node) : 0;
      k = `${node.tagName}:${idx}>${k}`;
      node = p; depth++;
    }
    return k;
  }
  function signature(el, rect) {
    const src = el.currentSrc || el.src || el.dataset?.src || "";
    const base = `${el.tagName}|${src}|${Math.round(rect.width)}x${Math.round(rect.height)}`;
    if (src) return base;
    // src-less ad slots (div/section/a) all look like "DIV||300x250" — two
    // distinct 300×250 slots would share one cached verdict and a real ad could
    // be silently skipped (or a non-ad auto-blocked). Disambiguate by id/class +
    // DOM position.
    const cls = typeof el.className === "string" ? el.className.slice(0, 40) : "";
    return `${base}|${el.id || ""}|${cls}|${domKey(el)}`;
  }

  // True only for shapes a real ad slot can plausibly be. Rejects content
  // columns, heroes, and full-page sections that the model happily calls "ad".
  function adPlausibleShape(rect) {
    const w = rect.width, h = rect.height;
    if (h > MAX_AD_ANY_H) return false;                    // whole-column / page section
    if (h > MAX_AD_H && w > SKYSCRAPER_MAX_W) return false; // tall AND wide = content block
    if (w >= innerWidth * 0.99 && h > 320) return false;    // full-bleed & tall = hero/section
    return true;
  }

  // Structural ad signal: an iframe, or an ad-hint token on the element or a
  // near ancestor (word-bounded, so "shadow"/"header" don't count). Bare
  // editorial imgs have none of this and must clear the higher bar.
  function hasAdContext(el) {
    if (el.tagName === "IFRAME") return true;
    let n = el, depth = 0;
    while (n && depth < 4) {
      const hint = `${n.id || ""} ${typeof n.className === "string" ? n.className : ""}`;
      if (AD_HINT.test(hint)) return true;
      n = n.parentElement; depth++;
    }
    return false;
  }

  function isStandardAdSize(w, h) {
    for (const [sw, sh] of STD_AD_SIZES) {
      if (Math.abs(w - sw) <= sw * STD_TOL && Math.abs(h - sh) <= sh * STD_TOL) return true;
    }
    return false;
  }

  // A near-square element (aspect ~1.0). The only square IAB sizes (200x200,
  // 250x250) are rare and are what square PRODUCT tiles collide with, so a bare
  // (context-less) near-square image is a product/content tile, not an ad.
  // Banner ads are rectangular (300x250 = 1.2, 728x90, 160x600, ...), so they
  // pass. This is the primary guard against shopping-grid product-tile FPs.
  function isSquarish(w, h) {
    if (!h) return false;
    const r = w / h;
    return r >= 0.87 && r <= 1.15;
  }

  function isConsentUI(el) {
    const s = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`;
    if (CONSENT_HINT.test(s)) return true;
    try {
      return !!el.closest(
        '[id*="onetrust" i],[id*="sp_message" i],[id*="didomi" i],[class*="consent" i],' +
        '[class*="cookie" i],[class*="cmp" i],[class*="didomi" i],[class*="gdpr" i]');
    } catch { return false; }
  }

  // document + every open shadow root (ad slots often live inside web
  // components; closed roots are invisible to everyone).
  function allRoots() {
    const roots = [document];
    for (let i = 0; i < roots.length && roots.length < 200; i++) {
      for (const el of roots[i].querySelectorAll("*")) {
        if (el.shadowRoot) roots.push(el.shadowRoot);
      }
    }
    return roots;
  }

  function candidates() {
    const out = [];
    for (const root of allRoots()) {
      for (const el of root.querySelectorAll("img, iframe")) out.push(el);
      for (const el of root.querySelectorAll("div, section, aside, a")) {
        const hint = `${el.id} ${el.className}`;
        if (typeof hint === "string" && AD_HINT.test(hint)) out.push(el);
      }
    }
    return out.filter((el) => {
      if (allowed.has(el) || overlays.has(el)) return false;
      if (el.closest?.("[data-minus-overlay]")) return false;
      if (isConsentUI(el)) return false;                  // cookie/CMP banners are not ads
      // Video players belong to the <video> sampler, which re-verifies over time
      // and UNCOVERS when the ad ends. The display path must never cover a player:
      // YouTube toggles an "ad-showing"/"ad-interrupting" class on the player
      // container (matching AD_HINT), so the display scan would stack persistent,
      // never-clearing covers on the player over the whole video (the "YouTube ad
      // blocked then never recovers" bug).
      if (el.tagName === "VIDEO") return false;
      if (el.tagName !== "IMG" && el.tagName !== "IFRAME") {
        const v = el.querySelector?.("video");
        if (v) { const vr = v.getBoundingClientRect(); if (vr.width >= IFRAME_MIN_W && vr.height >= IFRAME_MIN_H) return false; }
      }
      // An <img> whose pixels haven't loaded is a dark/blank placeholder box —
      // classifying it flags lazy-loading product/content tiles as ads (seen on
      // Nike/Wish/AliExpress grids). Skip until it actually has pixels; the next
      // scan re-evaluates it (real ad creatives load fast, so coverage is intact).
      if (el.tagName === "IMG" && (!el.complete || el.naturalWidth === 0)) return false;
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) return false;
      if (!adPlausibleShape(rect)) return false;          // single ad slot only, no content columns
      // Large iframes (player-sized) are tracked over time, not one-shot here:
      // same-origin ones by their own in-frame video path (#1), cross-origin by
      // the motion sampler (#2). One-shotting them would fight those (and leave
      // a stale cover after a video ad ends, since the static verdict is cached).
      if (el.tagName === "IFRAME" && rect.width >= IFRAME_MIN_W && rect.height >= IFRAME_MIN_H) return false;
      return true;
    });
  }

  // ---------------------------------------------------------------- classify
  async function scan() {
    if (!enabled || document.hidden || !blockDisplay) return; // display path
    if (scanning) { scheduleScan(SCAN_DEBOUNCE_MS); return; } // busy: retry after the in-flight scan
    scanning = true;
    try {
      const els = candidates().filter((el) => {
        const sig = signature(el, el.getBoundingClientRect());
        if (verdictCache.get(sig) === true) { block(el, undefined, "display"); return false; }
        return !verdictCache.has(sig);
      }).slice(0, 12); // cap batch per scan
      if (!els.length) return;

      const shot = await captureClean(els.map((el) => el.getBoundingClientRect()));
      if (!shot) return;
      const crops = [];
      const kept = [];
      const seenRects = new Set(); // collapse overlapping candidates (iframe + wrapper + img) onto the same region -> identical crop
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (!isVisible(el, rect)) continue;
        const rk = `${Math.round(rect.left / 6)}_${Math.round(rect.top / 6)}_${Math.round(rect.width / 6)}_${Math.round(rect.height / 6)}`;
        if (seenRects.has(rk)) continue; // same screen region as an earlier candidate -> would be a duplicate crop
        seenRects.add(rk);
        const crop = cropFromShot(shot, rect);
        if (crop) { crops.push(crop); kept.push({ el, sig: signature(el, rect), ctx: hasAdContext(el) }); }
      }
      if (!crops.length) return;

      const results = await classifyBatch(crops);
      if (!results) { scheduleScan(5000); return; } // engine hiccup: try again
      let hadError = false;
      results.forEach((r, i) => {
        const { el, sig, ctx } = kept[i];
        // transient engine errors must NOT become cached "not an ad" verdicts
        if (r.error) { hadError = true; return; }
        // Tiered decision:
        //  - ad-context (iframe / ad-hint slot): trust model at normal bar.
        //  - bare + standard IAB size: likely a bare-<img> ad, high-confidence bar.
        //  - bare + non-standard size: never (this is where editorial photos live,
        //    and the model FPs on them confidently — shape is the only signal).
        const rc = el.getBoundingClientRect();
        let isAd;
        if (ctx) isAd = r.p_ad >= CTX_BLOCK_P;
        else if (isStandardAdSize(rc.width, rc.height) && !isSquarish(rc.width, rc.height)) isAd = r.p_ad >= BARE_BLOCK_P;
        else isAd = false;                                  // bare + non-rectangular-standard: editorial photos / product tiles live here
        verdictCache.set(sig, isAd);
        if (verdictCache.size > 500) verdictCache.delete(verdictCache.keys().next().value);
        if (isAd) {
          block(el, r.p_ad, "display");
          maybeQueueSample(el, crops[i], r);
        }
      });
      if (hadError) scheduleScan(5000);
    } finally {
      scanning = false;
    }
  }

  // Screenshot with our own overlays hidden, so a crop can never bake in a
  // prior "el anuncio" flashcard that visually overlaps the target region.
  // Take a screenshot with our own flashcards out of the way — but ONLY the
  // cards overlapping `rects` (the regions actually being read). Hiding every
  // card made ALL overlays blink visibly on the iframe sampler's ~3s cadence
  // (the "ads reappear then get re-blocked" bug on iframe-heavy sites): the
  // hide window spanned the capture rate-limit wait (<=600ms) + shot + decode.
  // Now: (1) targeted hide, (2) the rate-limit wait happens BEFORE hiding
  // (minus:capture-wait pre-arms the slot), (3) cards are restored before the
  // (slow) dataURL->Image decode. Cards not under inspection never blink.
  async function captureClean(rects) {
    const divs = [...overlays.values()].filter((d) => {
      if (d.style.visibility === "hidden") return false;
      if (!rects || !rects.length) return true;
      const r = d.getBoundingClientRect();
      return rects.some((q) => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top);
    });
    if (divs.length) {
      await sendMsg({ type: "minus:capture-wait" }); // pre-arm rate limiter
      divs.forEach((d) => (d.style.visibility = "hidden"));
      await new Promise((r) => setTimeout(r, 50)); // let the compositor repaint
    }
    const dataUrl = await sendMsg({ type: "minus:capture" }).then((resp) => (resp?.ok ? resp.dataUrl : null));
    divs.forEach((d) => (d.style.visibility = ""));
    if (!dataUrl) return null;
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  async function capture() {
    const resp = await sendMsg({ type: "minus:capture" });
    if (!resp?.ok) return null;
    return await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = resp.dataUrl;
    });
  }

  // Mean luma + luma stddev of a screenshot region. Used to detect an UNREADABLE
  // video surface: DRM / hardware-overlay video (Vevo, protected content) renders
  // black-or-flat in tab captures, so its crop carries no real ad signal. A real
  // ad always has visual variety (high stddev); a black or dark-uniform surface
  // has near-zero stddev. Returns {luma, std}; luma=-1 if the region is too small.
  function regionStats(img, rect) {
    try {
      const vw = document.documentElement.clientWidth || innerWidth;
      const scale = img.width / vw;
      const sx = Math.max(0, rect.left) * scale, sy = Math.max(0, rect.top) * scale;
      const sw = (Math.min(rect.right, vw) - Math.max(0, rect.left)) * scale;
      const sh = (Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top)) * scale;
      if (sw < 8 || sh < 8) return { luma: -1, std: -1 };
      const c = document.createElement("canvas"); c.width = 24; c.height = 24;
      const cx = c.getContext("2d"); cx.drawImage(img, sx, sy, sw, sh, 0, 0, 24, 24);
      const d = cx.getImageData(0, 0, 24, 24).data;
      const n = d.length / 4; let sum = 0, sumSq = 0;
      for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sumSq += l * l; }
      const mean = sum / n;
      return { luma: mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
    } catch { return { luma: -1, std: -1 }; }
  }

  function cropFromShot(img, rect) {
    // screenshot is in physical pixels; rect is in CSS pixels. Use clientWidth
    // (the rendered content width) not innerWidth (which includes the scrollbar
    // gutter) so crops don't skew a few px on pages with a classic scrollbar.
    const vw = document.documentElement.clientWidth || innerWidth;
    const scale = img.width / vw;
    const sx = Math.max(0, rect.left) * scale;
    const sy = Math.max(0, rect.top) * scale;
    const sw = (Math.min(rect.right, innerWidth) - Math.max(0, rect.left)) * scale;
    const sh = (Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top)) * scale;
    if (sw < 16 || sh < 16) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx2d = canvas.getContext("2d");
    ctx2d.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    // Reject near-blank crops (nav bars / whitespace wrappers / unfilled slots):
    // a real ad creative has visual variance. Sample luminance stddev cheaply.
    if (cropStddev(ctx2d, canvas.width, canvas.height) < MIN_CROP_STDDEV) return null;
    return canvas.toDataURL("image/png");
  }

  function cropStddev(ctx2d, w, h) {
    try {
      const step = Math.max(1, Math.floor(Math.min(w, h) / 40)); // subsample grid
      const data = ctx2d.getImageData(0, 0, w, h).data;
      let n = 0, sum = 0, sumSq = 0;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const i = (y * w + x) * 4;
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          sum += lum; sumSq += lum * lum; n++;
        }
      }
      if (!n) return 999;
      const mean = sum / n;
      return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    } catch { return 999; } // tainted/edge: don't reject on error
  }

  function classifyBatch(images) {
    return new Promise((resolve) => {
      sendMsg({ type: "minus:classify", images }).then((resp) => resolve(resp?.ok ? resp.results : null));
    });
  }

  // ---------------------------------------------------------------- overlay
  // kind: "display" (static img/iframe/ad-slot) or "video" (in-player / playing
  // iframe). Stored on the overlay so a popup type-toggle can clear it live.
  // Card body per the configured block action (options page). The X button is
  // (re)wired by renderCard so a live style switch keeps reveal working.
  function renderCard(el, div, pAd) {
    let w, en, ex;
    if (blockAction === "minimal") {
      w = "ad blocked"; en = ""; ex = "This ad has been blocked by minus.";
    } else {
      const deck = activeDeck
        || (typeof MINUS_DECKS !== "undefined" && MINUS_DECKS[blockLang]) || MINUS_SPANISH;
      const card = deck[Math.floor(Math.random() * deck.length)];
      w = card.w ?? card.es; en = card.en || ""; ex = card.ex || "";
      // Record the exposure so this word can enter spaced-repetition review
      // (background coalesces; a new word becomes a "new" card due now).
      if (w) sendMsg({ type: "minus:learn-seen", card: { l: blockLang, w, en, ex } });
    }
    // Skeleton via innerHTML (static, first-party), dynamic strings via
    // textContent (never HTML — safe even if a future deck string contains
    // markup). The flashcard text is aria-hidden so a screen reader doesn't read
    // random foreign vocabulary injected over every blocked ad; only the labeled
    // reveal button is exposed.
    // The "not an ad" report only appears when the user has opted into
    // contribution (so a click is a consented submission of that one crop).
    const reportBtn = collectOptIn
      ? `<button class="minus-report" aria-label="Report: this is not an ad">⚑ not an ad</button>` : "";
    div.innerHTML = `
      <button class="minus-x" aria-label="Reveal the ad blocked by Minus" title="Show this ad">&times;</button>
      <div class="minus-brand" aria-hidden="true">minus</div>
      <div class="minus-es" aria-hidden="true"></div>
      <div class="minus-en" aria-hidden="true"></div>
      <div class="minus-ex" aria-hidden="true"></div>
      <div class="minus-p" aria-hidden="true"></div>
      ${reportBtn}`;
    div.querySelector(".minus-es").textContent = w;
    div.querySelector(".minus-en").textContent = en;
    div.querySelector(".minus-ex").textContent = ex;
    const pEl = div.querySelector(".minus-p");
    if (pAd != null && showConfidence) pEl.textContent = `ad ${(pAd * 100).toFixed(0)}%`;
    else pEl.remove();
    div.querySelector(".minus-x").addEventListener("click", (e) => {
      e.stopPropagation();
      allowed.add(el);
      div.remove();
      overlays.delete(el);
      reportBlocked();
      // user said "show it" -> retract any queued contribution for this element
      const key = sampleKeys.get(el);
      if (key) sendMsg({ type: "minus:retract-sample", key });
    });
    div.querySelector(".minus-report")?.addEventListener("click", (e) => {
      e.stopPropagation();
      // Reveal the ad AND submit it as a user-verified false positive (the
      // strongest training signal — a human said "this isn't an ad").
      allowed.add(el);
      const crop = cropByEl.get(el);
      const key = sampleKeys.get(el);
      if (key) sendMsg({ type: "minus:retract-sample", key }); // don't also keep the passive "ad" sample
      if (crop?.img) {
        sendMsg({ type: "minus:report-fp", sample: {
          key: `fp|${location.hostname}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`,
          img: crop.img, p_ad: crop.p_ad, verdict: "user_fp", host: location.hostname,
          w: crop.w, h: crop.h,
        } });
      }
      div.remove();
      overlays.delete(el);
      reportBlocked();
    });
  }

  function block(el, pAd, kind = "display") {
    if (overlays.has(el) || allowed.has(el)) return;
    const div = document.createElement("div");
    div.setAttribute("data-minus-overlay", "");
    div.setAttribute("role", "group");
    div.setAttribute("aria-label", "Advertisement blocked by Minus");
    div.dataset.minusKind = kind;
    if (pAd != null) div.dataset.minusP = String(pAd);
    renderCard(el, div, pAd);
    document.documentElement.appendChild(div);
    overlays.set(el, div);
    positionOverlay(el, div);
    ensureTracking();
    reportBlocked();
  }

  function positionOverlay(el, div) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || !el.isConnected) {
      div.remove();
      overlays.delete(el);
      reportBlocked();
      return;
    }
    Object.assign(div.style, {
      top: `${rect.top}px`, left: `${rect.left}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    div.classList.toggle("minus-compact", rect.height < 140 || rect.width < 220);
  }

  // The rAF loop only runs while there ARE overlays to track. An always-on
  // 60fps loop is pure busywork on the vast majority of pages that have no ads
  // covered; block() restarts it via ensureTracking() when the first overlay
  // appears, and it self-suspends once the last overlay is gone.
  let tracking = false;
  function ensureTracking() {
    if (tracking || ctxDead) return;
    tracking = true;
    requestAnimationFrame(trackOverlays);
  }
  function trackOverlays() {
    if (overlays.size === 0 || ctxDead) { tracking = false; return; }
    const now = performance.now();
    const checkOcclusion = now - lastOcclusionCheck >= OCCLUSION_MS;
    if (checkOcclusion) lastOcclusionCheck = now;
    for (const [el, div] of overlays) {
      positionOverlay(el, div);
      // positionOverlay may have removed a detached overlay mid-iteration.
      if (checkOcclusion && overlays.has(el)) updateOcclusion(el, div);
    }
    requestAnimationFrame(trackOverlays);
  }

  // ---------------------------------------------------------------- occlusion
  // A card sits above its ad at (near) max z-index. If the page later opens a
  // modal / lightbox / secondary overlay over that region, the card must step
  // aside instead of covering it. Each throttled tick we ask what element is
  // actually painted on top of the ad; if it's something foreign, we hide the
  // card (and restore it once that layer goes away). This is z-index-agnostic:
  // it works even when the ad or the modal uses an arbitrary stacking value.
  const OCCLUSION_MS = 150;
  let lastOcclusionCheck = 0;

  // Deepest element painted at a viewport point, descending through open shadow
  // roots (ad slots — and the modals that cover them — often live in shadow DOM,
  // and Node.contains / a plain elementFromPoint won't cross those boundaries).
  function topmostAt(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  }

  // Probe points inside the ad rect, clamped to the viewport (center first so
  // it carries the vote when the ad is partially scrolled off-screen).
  function occlusionSamples(rect) {
    const fx = [0.5, 0.3, 0.7, 0.3, 0.7], fy = [0.5, 0.3, 0.3, 0.7, 0.7];
    const pts = [];
    for (let i = 0; i < fx.length; i++) {
      const x = rect.left + rect.width * fx[i];
      const y = rect.top + rect.height * fy[i];
      if (x >= 1 && x < innerWidth - 1 && y >= 1 && y < innerHeight - 1) pts.push([x, y]);
    }
    return pts;
  }

  // The screen rect of the region where a foreign element (not this ad, not one
  // of our own cards) is painted over the ad — or null if nothing covers it.
  // Momentarily drops the card's own pointer-events so elementFromPoint reports
  // what is *underneath* it. Returns the union of the covering elements' rects,
  // intersected with the ad, so a modal that clips only a corner yields only a
  // corner (a full-screen modal/backdrop yields the whole card).
  function foreignCoverRect(el, div) {
    const rect = el.getBoundingClientRect();
    const pts = occlusionSamples(rect);
    if (!pts.length) return null;
    const prevPE = div.style.pointerEvents;
    div.style.pointerEvents = "none";                    // synchronous window; no click can interleave
    const foreign = new Set();
    for (const [x, y] of pts) {
      const hit = topmostAt(x, y);
      if (!hit) continue;
      if (hit === el || el.contains(hit) || hit.contains(el)) continue; // the ad itself / its wrapper / its content
      if (hit.closest?.("[data-minus-overlay]")) continue;              // another one of our cards
      foreign.add(hit);
    }
    div.style.pointerEvents = prevPE;
    if (!foreign.size) return null;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const f of foreign) {
      const fr = f.getBoundingClientRect();
      l = Math.min(l, fr.left); t = Math.min(t, fr.top);
      r = Math.max(r, fr.right); b = Math.max(b, fr.bottom);
    }
    const il = Math.max(rect.left, l), it = Math.max(rect.top, t);
    const ir = Math.min(rect.right, r), ib = Math.min(rect.bottom, b);
    if (ir <= il || ib <= it) return null;               // union doesn't actually overlap the ad
    return { adRect: rect, left: il, top: it, right: ir, bottom: ib };
  }

  // Reconcile the card with whatever now covers its ad:
  //  - nothing            -> full card, no clip
  //  - covered edge-to-edge -> hide entirely (.minus-occluded)
  //  - covered in part    -> punch that sub-rect out of the card with an
  //                          evenodd clip-path hole, so the covering layer is
  //                          both visible and clickable there while the rest of
  //                          the ad stays covered.
  function updateOcclusion(el, div) {
    const c = foreignCoverRect(el, div);
    let hide = false, clip = "";
    if (c) {
      const A = c.adRect, W = A.width, H = A.height, eps = 2;
      const x0 = Math.max(0, c.left - A.left), y0 = Math.max(0, c.top - A.top);
      const x1 = Math.min(W, c.right - A.left), y1 = Math.min(H, c.bottom - A.top);
      if (x0 <= eps && y0 <= eps && x1 >= W - eps && y1 >= H - eps) {
        hide = true;                                     // covered corner-to-corner: yield the whole card
      } else {
        const f = (n) => Math.round(n * 100) / 100;
        clip = `path(evenodd, 'M0 0H${f(W)}V${f(H)}H0Z M${f(x0)} ${f(y0)}H${f(x1)}V${f(y1)}H${f(x0)}Z')`;
      }
    }
    applyOcclusion(div, hide, clip);
  }

  function applyOcclusion(div, hide, clip) {
    if ((div.dataset.minusHidden === "1") !== hide) {
      div.dataset.minusHidden = hide ? "1" : "0";
      div.classList.toggle("minus-occluded", hide);
    }
    if (div.dataset.minusClip !== clip) {                // hidden state clears the clip (clip === "")
      div.style.clipPath = clip;
      div.dataset.minusClip = clip;
    }
  }

  // ---------------------------------------------------------------- video
  // Prefer reading frames straight off the <video> element: it ignores our
  // own overlay (avoids the "flashcard looks like an ad slate" deadlock) and
  // works for same-origin + MSE playback (YouTube et al). Falls back to a
  // tab-screenshot crop for tainted canvases, hiding the overlay for a beat.
  // Returns { url, luma, std } for a directly-readable <video> frame, or null if
  // the frame can't be read (tainted / no dimensions). luma+std let the sampler
  // reject a low-signal (dark, near-flat) frame as not-a-confident-ad — a music
  // video's dark opening should not be covered as an ad, and a black surface
  // must not hold a cover.
  function frameFromVideo(v) {
    try {
      if (!v.videoWidth) return null;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / v.videoWidth);
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      const cx = canvas.getContext("2d");
      cx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/png"); // throws if tainted
      // sample a 24x24 downscale for luma/std (cheap)
      const sc = document.createElement("canvas"); sc.width = 24; sc.height = 24;
      const scx = sc.getContext("2d"); scx.drawImage(canvas, 0, 0, 24, 24);
      const d = scx.getImageData(0, 0, 24, 24).data; const nn = d.length / 4;
      let sum = 0, sumSq = 0;
      for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sumSq += l * l; }
      const mean = sum / nn;
      return { url, luma: mean, std: Math.sqrt(Math.max(0, sumSq / nn - mean * mean)) };
    } catch {
      return null;
    }
  }

  function clearVideo(v) {
    overlays.get(v)?.remove();
    overlays.delete(v);
    const st = videoState.get(v);
    if (st) { st.blocked = false; st.adVotes = 0; st.nonAdVotes = 0; st.pausedSince = 0; }
    reportBlocked();
  }

  async function sampleVideos() {
    if (!enabled || document.hidden || !blockVideo) return; // video path
    // Release stale video overlays BEFORE sampling. The old code filtered out
    // paused videos entirely, so a blocked pre-roll that PAUSED when it finished
    // never got a non-ad vote and stayed covered forever — the "blocks the ad
    // then never unblocks" bug. Clear a covered video the moment it ends, has
    // its source swapped to program content, leaves the DOM, scrolls off, or
    // sits paused-under-a-card for >3s (ad ended or the user paused).
    for (const [v, st] of videoState) {
      if (!v.isConnected) { overlays.get(v)?.remove(); overlays.delete(v); videoState.delete(v); reportBlocked(); continue; }
      if (!st.blocked) continue;
      const r = v.getBoundingClientRect();
      const cur = v.currentSrc || v.src || "";
      if (v.ended || !isVisible(v, r) || (st.src && cur && cur !== st.src)) { clearVideo(v); continue; }
      if (v.paused) {
        st.pausedSince = st.pausedSince || Date.now();
        if (Date.now() - st.pausedSince > 3000) clearVideo(v);
      } else {
        st.pausedSince = 0;
      }
    }
    const videos = [...document.querySelectorAll("video")].filter((v) => {
      const r = v.getBoundingClientRect();
      if (allowed.has(v) || !isVisible(v, r)) return false;
      // Sample playing videos AND keep re-verifying a blocked video even while
      // paused, so a finished / mislabeled ad clears on non-ad votes.
      return !v.paused || !!videoState.get(v)?.blocked;
    });
    if (!videos.length) return;

    const crops = [], kept = [], needShot = [];
    const unreadable = new WeakSet(); // frame too dark/flat to be a confident ad
    for (const v of videos) {
      const direct = frameFromVideo(v);
      if (direct) {
        crops.push(direct.url); kept.push(v);
        // A dark, near-flat frame (a music video's dark opening, a black surface)
        // is not a confident ad — don't let it block/hold a cover.
        if (direct.luma < BLACK_LUMA || direct.std < MIN_CROP_STDDEV) unreadable.add(v);
        // tell the top frame this iframe's video is directly readable — it can
        // skip screenshot-peeking (and card-blinking) our iframe entirely
        if (!IS_TOP && Date.now() - (window.__minusLastHello || 0) > 5000) {
          window.__minusLastHello = Date.now();
          try { window.top.postMessage({ __minusInnerVideo: true }, "*"); } catch {}
        }
      }
      else if (IS_TOP) needShot.push(v); // screenshot fallback needs top-frame coordinates
      // in a sub-frame a video we can't read directly is skipped (#2's top-frame
      // motion sampler covers its iframe instead)
    }

    if (needShot.length) {
      // tainted canvas fallback: hide overlays so the screenshot sees the video
      const hidden = needShot.map((v) => overlays.get(v)).filter(Boolean);
      hidden.forEach((d) => (d.style.visibility = "hidden"));
      if (hidden.length) await new Promise((r) => setTimeout(r, 90));
      const shot = await capture();
      hidden.forEach((d) => (d.style.visibility = ""));
      if (shot) {
        for (const v of needShot) {
          const rect = v.getBoundingClientRect();
          const crop = cropFromShot(shot, rect);
          if (crop) {
            crops.push(crop); kept.push(v);
            // A blocked video read only via screenshot (direct read tainted =
            // likely DRM) whose crop is black or dark-uniform is UNREADABLE — we
            // can't actually see it, so it must not stay covered on content.
            const { luma, std } = regionStats(shot, rect);
            // Aggressive bar: this is the tainted (DRM) path — a dark/flat crop
            // is a hardware-overlay letterbox we can't read, not a visible ad.
            if (luma >= 0 && (luma < SHOT_DARK_LUMA || std < SHOT_MIN_STD)) unreadable.add(v);
          }
        }
      }
    }

    if (!crops.length) return;
    const results = await classifyBatch(crops);
    if (!results) return;

    results.forEach((r, i) => {
      if (r.error) return; // transient errors are not votes
      const v = kept[i];
      const st = videoState.get(v) || { adVotes: 0, nonAdVotes: 0, blocked: false };
      // A black (unreadable) crop is NOT a confident ad. DRM/hardware-overlay
      // video (Vevo etc.) is CORS-tainted for a direct read AND renders black in
      // tab captures — so we can never actually SEE it. Counting black as "ad"
      // left such a player covered forever on content (the Adele-Hello case);
      // treat it as non-ad so a covered unreadable video clears and an unblocked
      // one is never covered on a black frame.
      const isAd = r.is_ad && !unreadable.has(v);
      if (isAd) { st.adVotes++; st.nonAdVotes = 0; } else { st.nonAdVotes++; st.adVotes = 0; }
      if (!st.blocked && st.adVotes >= VIDEO_HYSTERESIS) {
        st.blocked = true;
        st.src = v.currentSrc || v.src || "";   // ad's source; a swap to content clears the card
        st.pausedSince = 0;
        block(v, r.p_ad, "video");
        // instant clear when THIS ad element ends/empties (faster than the tick)
        const onEnd = () => { v.removeEventListener("ended", onEnd); v.removeEventListener("emptied", onEnd); clearVideo(v); };
        v.addEventListener("ended", onEnd);
        v.addEventListener("emptied", onEnd);
      } else if (st.blocked && st.nonAdVotes >= VIDEO_HYSTERESIS) {
        clearVideo(v);
      }
      videoState.set(v, st);
    });
  }

  // ---------------------------------------------------------------- iframe video (#2)
  // The top frame can't see inside a cross-origin iframe, but it CAN crop the
  // iframe's rendered pixels from the tab screenshot. A large iframe that is
  // visibly ANIMATING is a playing embedded video/ad the inner content script
  // couldn't read (tainted); we resample + reclassify it over time with the
  // same hysteresis as <video>, so an embedded pre-roll flips on/off. A large
  // iframe that's static gets a one-shot verdict (like the display path).
  // Same-origin iframes are left to their own injected content script.
  function isCrossOriginFrame(iframe) {
    try { return !iframe.contentDocument; } catch { return true; }
  }

  // Crop the iframe region from the tab screenshot; return { url, fp } where fp
  // is an 8x8 luminance grid used to detect motion between ticks. null if unusable.
  function iframeFrameAndFp(shot, rect) {
    const scale = shot.width / innerWidth;
    const sx = Math.max(0, rect.left) * scale, sy = Math.max(0, rect.top) * scale;
    const sw = (Math.min(rect.right, innerWidth) - Math.max(0, rect.left)) * scale;
    const sh = (Math.min(rect.bottom, innerHeight) - Math.max(0, rect.top)) * scale;
    if (sw < 32 || sh < 32) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw); canvas.height = Math.round(sh);
    const ctx2d = canvas.getContext("2d");
    ctx2d.drawImage(shot, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/png");
    const g = 8, fp = new Float32Array(g * g), cw = canvas.width, ch = canvas.height;
    const data = ctx2d.getImageData(0, 0, cw, ch).data;
    for (let gy = 0; gy < g; gy++) for (let gx = 0; gx < g; gx++) {
      const x = Math.min(cw - 1, Math.floor((gx + 0.5) * cw / g));
      const y = Math.min(ch - 1, Math.floor((gy + 0.5) * ch / g));
      const i = (y * cw + x) * 4;
      fp[gy * g + gx] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return { url, fp };
  }

  function fpDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  // ---- covered-frame peek scheduling (the anti-blink policy) ----------------
  // Once a frame/video is COVERED, reading beneath its card requires briefly
  // hiding the card — a visible blink. So covered things are re-checked on an
  // EVENT-DRIVEN schedule, not a timer cadence:
  //   - first peek 10s after covering, then backoff x2 up to 45s (a looping
  //     wco-style ad settles at ~1 blink/45s instead of blinking every tick);
  //   - a "maybe the ad ended" verdict (non-ad vote 1 of 2) fast-tracks the
  //     confirming peek (~2.6s) so real ad-break ends still uncover quickly;
  //   - an iframe src change (ad rotation / player state change) peeks NOW;
  //   - an iframe whose INNER Minus script can read its <video> directly
  //     (untainted) announces itself and is never screenshot-peeked at all.
  function schedulePeek(st, stillAd) {
    if (!stillAd && !(st.fastConfirms > 0)) {
      // "maybe the ad ended" -> ONE fast confirming peek. Capped at one so a
      // borderline verdict that churns around the threshold can't ping-pong
      // the card (each fast peek is a visible blink).
      st.fastConfirms = 1;
      st.nextPeekAt = Date.now() + VIDEO_SAMPLE_MS + 100;
    } else {
      st.fastConfirms = 0;
      st.peekGap = Math.min(45000, (st.peekGap || 5000) * 2);
      st.nextPeekAt = Date.now() + st.peekGap;
    }
  }

  // inner-frame handshake: sub-frame video path announces direct readability
  if (IS_TOP) {
    window.addEventListener("message", (e) => {
      if (!e.data || e.data.__minusInnerVideo !== true) return;
      for (const f of document.querySelectorAll("iframe")) {
        if (f.contentWindow === e.source) {
          const st = iframeState.get(f) || { fp: null, adVotes: 0, nonAdVotes: 0, blocked: false, classified: false };
          st.innerCapableAt = Date.now();
          iframeState.set(f, st);
        }
      }
    });
  }

  const srcWatched = new WeakSet();
  function watchSrc(f) {
    if (srcWatched.has(f)) return;
    srcWatched.add(f);
    new MutationObserver(() => {
      const st = iframeState.get(f);
      if (st) { st.nextPeekAt = 0; st.fp = null; iframeState.set(f, st); } // rotation: peek now, refingerprint
    }).observe(f, { attributes: true, attributeFilter: ["src"] });
  }

  async function sampleIframes() {
    if (!IS_TOP || !enabled || document.hidden) return;
    if (!blockVideo && !blockDisplay) return; // this sampler feeds both types
    const now = Date.now();
    const frames = [...document.querySelectorAll("iframe")].filter((f) => {
      if (allowed.has(f) || !isCrossOriginFrame(f)) return false;
      const r = f.getBoundingClientRect();
      if (r.width < IFRAME_MIN_W || r.height < IFRAME_MIN_H || !isVisible(f, r)) return false;
      const st = iframeState.get(f);
      // the inner Minus script reads this frame's video directly — never peek
      if (st?.innerCapableAt && now - st.innerCapableAt < 15000) return false;
      // covered frames wait for their scheduled peek (no card-blink otherwise)
      if (st?.blocked && now < (st.nextPeekAt || 0)) return false;
      watchSrc(f);
      return true;
    });
    if (!frames.length) return;
    const shot = await captureClean(frames.map((f) => f.getBoundingClientRect()));
    if (!shot) return;

    const pending = [];
    for (const f of frames) {
      const frame = iframeFrameAndFp(shot, f.getBoundingClientRect());
      if (!frame) continue;
      const st = iframeState.get(f) || { fp: null, adVotes: 0, nonAdVotes: 0, blocked: false, classified: false };
      const moving = st.fp && fpDiff(st.fp, frame.fp) > IFRAME_MOTION;
      st.fp = frame.fp;
      iframeState.set(f, st);
      if (st.blocked) {
        // a peek is a classification, motion or not (a static end-card after a
        // looping ad would otherwise never be re-judged and stay covered forever)
        if (blockVideo || blockDisplay) pending.push({ f, url: frame.url, st, motion: true, peek: true });
      } else if (moving) {
        if (blockVideo) pending.push({ f, url: frame.url, st, motion: true });
      } else if (!st.classified && blockDisplay) {
        pending.push({ f, url: frame.url, st, motion: false });
      }
    }
    if (!pending.length) return;

    const results = await classifyBatch(pending.map((p) => p.url));
    if (!results) {
      for (const p of pending) if (p.peek) { p.st.nextPeekAt = Date.now() + (p.st.peekGap || 5000); iframeState.set(p.f, p.st); }
      return;
    }
    results.forEach((r, i) => {
      const { f, st, motion, peek } = pending[i];
      if (r.error) { // transient errors are not votes — but a covered frame must still reschedule, not machine-gun
        if (peek) { st.nextPeekAt = Date.now() + (st.peekGap || 5000); iframeState.set(f, st); }
        return;
      }
      st.classified = true;
      if (motion) {
        if (r.is_ad) { st.adVotes++; st.nonAdVotes = 0; } else { st.nonAdVotes++; st.adVotes = 0; }
        if (!st.blocked && st.adVotes >= VIDEO_HYSTERESIS) {
          st.blocked = true; st.peekGap = 5000; st.nextPeekAt = Date.now() + 10000;
          block(f, r.p_ad, "video");
        } else if (st.blocked && st.nonAdVotes >= VIDEO_HYSTERESIS) {
          st.blocked = false; st.peekGap = 0; st.nextPeekAt = 0;
          overlays.get(f)?.remove(); overlays.delete(f); reportBlocked();
        } else if (peek) {
          schedulePeek(st, r.is_ad);
        }
      } else if (r.is_ad && !st.blocked) {   // still iframe: one-shot, persistent (display-ad behavior)
        st.blocked = true; st.peekGap = 0; st.nextPeekAt = Infinity; // no periodic peeks: static banners never blink (src change resets)
        block(f, r.p_ad, "display");
      }
      iframeState.set(f, st);
    });
  }
})();
