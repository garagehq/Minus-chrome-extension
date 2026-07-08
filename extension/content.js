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
  const AD_HINT = /(^|[-_\b])(ad|ads|advert|advertisement|adsense|sponsor|sponsored|promo|banner|dbl|doubleclick|taboola|outbrain)([-_\b]|$)/i;
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
  const CTX_BLOCK_P = 0.60;                // element has ad context (iframe / ad-hint ancestor)
  const BARE_BLOCK_P = 0.88;               // context-less element: require high confidence
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

  let enabled = true;
  let collectOptIn = false;                // anonymous snapshot contribution
  const allowed = new WeakSet();           // user clicked X
  const sampleKeys = new WeakMap();        // element -> queued sample key (for retraction)
  const verdictCache = new Map();          // signature -> is_ad
  const overlays = new Map();              // element -> overlay div
  const videoState = new WeakMap();        // video -> {adVotes, nonAdVotes, blocked}
  let scanTimer = null;
  let scanning = false;

  chrome.runtime.sendMessage({ type: "minus:settings" }, (resp) => {
    if (resp?.ok) {
      enabled = resp.settings.enabled;
      collectOptIn = !!resp.settings.collectOptIn;
    }
    if (enabled) start();
  });

  // Opt-in only: queue a blocked element's crop for contribution. The
  // background holds it for a 10-minute cool-down; clicking X retracts it.
  function maybeQueueSample(el, crop, r) {
    if (!collectOptIn || !crop) return;
    const key = `${location.hostname}|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
    sampleKeys.set(el, key);
    chrome.runtime.sendMessage({
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
    scheduleScan(200);
    new MutationObserver(() => scheduleScan(SCAN_DEBOUNCE_MS))
      .observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "class", "id", "style"] });
    addEventListener("scroll", () => scheduleScan(SCAN_DEBOUNCE_MS), { passive: true });
    addEventListener("resize", () => scheduleScan(SCAN_DEBOUNCE_MS), { passive: true });
    setInterval(sampleVideos, VIDEO_SAMPLE_MS);
    requestAnimationFrame(trackOverlays);
  }

  function scheduleScan(delay) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
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

  function signature(el, rect) {
    const src = el.currentSrc || el.src || el.dataset?.src || "";
    return `${el.tagName}|${src}|${Math.round(rect.width)}x${Math.round(rect.height)}`;
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
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) return false;
      if (!adPlausibleShape(rect)) return false;          // single ad slot only, no content columns
      return true;
    });
  }

  // ---------------------------------------------------------------- classify
  async function scan() {
    if (!enabled || scanning || document.hidden) return;
    scanning = true;
    try {
      const els = candidates().filter((el) => {
        const sig = signature(el, el.getBoundingClientRect());
        if (verdictCache.get(sig) === true) { block(el); return false; }
        return !verdictCache.has(sig);
      }).slice(0, 12); // cap batch per scan
      if (!els.length) return;

      const shot = await captureClean();
      if (!shot) return;
      const crops = [];
      const kept = [];
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (!isVisible(el, rect)) continue;
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
        else if (isStandardAdSize(rc.width, rc.height)) isAd = r.p_ad >= BARE_BLOCK_P;
        else isAd = false;
        verdictCache.set(sig, isAd);
        if (verdictCache.size > 500) verdictCache.delete(verdictCache.keys().next().value);
        if (isAd) {
          block(el, r.p_ad);
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
  async function captureClean() {
    const divs = [...overlays.values()].filter((d) => d.style.visibility !== "hidden");
    divs.forEach((d) => (d.style.visibility = "hidden"));
    if (divs.length) await new Promise((r) => setTimeout(r, 50));
    const shot = await capture();
    divs.forEach((d) => (d.style.visibility = ""));
    return shot;
  }

  function capture() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "minus:capture" }, async (resp) => {
        if (!resp?.ok) return resolve(null);
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = resp.dataUrl;
      });
    });
  }

  function cropFromShot(img, rect) {
    // screenshot is in physical pixels; rect is in CSS pixels
    const scale = img.width / innerWidth;
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
      chrome.runtime.sendMessage({ type: "minus:classify", images }, (resp) => {
        resolve(resp?.ok ? resp.results : null);
      });
    });
  }

  // ---------------------------------------------------------------- overlay
  function block(el, pAd) {
    if (overlays.has(el) || allowed.has(el)) return;
    const card = MINUS_SPANISH[Math.floor(Math.random() * MINUS_SPANISH.length)];
    const div = document.createElement("div");
    div.setAttribute("data-minus-overlay", "");
    div.innerHTML = `
      <button class="minus-x" title="Show this ad">&times;</button>
      <div class="minus-brand">minus</div>
      <div class="minus-es">${card.es}</div>
      <div class="minus-en">${card.en}</div>
      <div class="minus-ex">${card.ex}</div>
      ${pAd != null ? `<div class="minus-p">ad ${(pAd * 100).toFixed(0)}%</div>` : ""}`;
    div.querySelector(".minus-x").addEventListener("click", (e) => {
      e.stopPropagation();
      allowed.add(el);
      div.remove();
      overlays.delete(el);
      // user said "show it" -> retract any queued contribution for this element
      const key = sampleKeys.get(el);
      if (key) chrome.runtime.sendMessage({ type: "minus:retract-sample", key });
    });
    document.documentElement.appendChild(div);
    overlays.set(el, div);
    positionOverlay(el, div);
  }

  function positionOverlay(el, div) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || !el.isConnected) {
      div.remove();
      overlays.delete(el);
      return;
    }
    Object.assign(div.style, {
      top: `${rect.top}px`, left: `${rect.left}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    });
    div.classList.toggle("minus-compact", rect.height < 140 || rect.width < 220);
  }

  function trackOverlays() {
    for (const [el, div] of overlays) positionOverlay(el, div);
    requestAnimationFrame(trackOverlays);
  }

  // ---------------------------------------------------------------- video
  // Prefer reading frames straight off the <video> element: it ignores our
  // own overlay (avoids the "flashcard looks like an ad slate" deadlock) and
  // works for same-origin + MSE playback (YouTube et al). Falls back to a
  // tab-screenshot crop for tainted canvases, hiding the overlay for a beat.
  function frameFromVideo(v) {
    try {
      if (!v.videoWidth) return null;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / v.videoWidth);
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/png"); // throws if tainted
    } catch {
      return null;
    }
  }

  async function sampleVideos() {
    if (!enabled || document.hidden) return;
    const videos = [...document.querySelectorAll("video")].filter((v) => {
      const r = v.getBoundingClientRect();
      return !allowed.has(v) && !v.paused && isVisible(v, r);
    });
    if (!videos.length) return;

    const crops = [], kept = [], needShot = [];
    for (const v of videos) {
      const direct = frameFromVideo(v);
      if (direct) { crops.push(direct); kept.push(v); }
      else needShot.push(v);
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
          const crop = cropFromShot(shot, v.getBoundingClientRect());
          if (crop) { crops.push(crop); kept.push(v); }
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
      if (r.is_ad) { st.adVotes++; st.nonAdVotes = 0; } else { st.nonAdVotes++; st.adVotes = 0; }
      if (!st.blocked && st.adVotes >= VIDEO_HYSTERESIS) {
        st.blocked = true;
        block(v, r.p_ad);
      } else if (st.blocked && st.nonAdVotes >= VIDEO_HYSTERESIS) {
        st.blocked = false;
        overlays.get(v)?.remove();
        overlays.delete(v);
      }
      videoState.set(v, st);
    });
  }
})();
