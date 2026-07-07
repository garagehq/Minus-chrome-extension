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

  let enabled = true;
  const allowed = new WeakSet();           // user clicked X
  const verdictCache = new Map();          // signature -> is_ad
  const overlays = new Map();              // element -> overlay div
  const videoState = new WeakMap();        // video -> {adVotes, nonAdVotes, blocked}
  let scanTimer = null;
  let scanning = false;

  chrome.runtime.sendMessage({ type: "minus:settings" }, (resp) => {
    if (resp?.ok) enabled = resp.settings.enabled;
    if (enabled) start();
  });

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

  function candidates() {
    const out = [];
    for (const el of document.querySelectorAll("img, iframe")) out.push(el);
    for (const el of document.querySelectorAll("div, section, aside, a")) {
      const hint = `${el.id} ${el.className}`;
      if (typeof hint === "string" && AD_HINT.test(hint)) out.push(el);
    }
    return out.filter((el) => {
      if (allowed.has(el) || overlays.has(el)) return false;
      if (el.closest?.("[data-minus-overlay]")) return false;
      // skip nested candidates whose ancestor is already a candidate container
      return isVisible(el, el.getBoundingClientRect());
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

      const shot = await capture();
      if (!shot) return;
      const crops = [];
      const kept = [];
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (!isVisible(el, rect)) continue;
        const crop = cropFromShot(shot, rect);
        if (crop) { crops.push(crop); kept.push({ el, sig: signature(el, rect) }); }
      }
      if (!crops.length) return;

      const results = await classifyBatch(crops);
      if (!results) { scheduleScan(5000); return; } // engine hiccup: try again
      let hadError = false;
      results.forEach((r, i) => {
        const { el, sig } = kept[i];
        // transient engine errors must NOT become cached "not an ad" verdicts
        if (r.error) { hadError = true; return; }
        verdictCache.set(sig, r.is_ad);
        if (verdictCache.size > 500) verdictCache.delete(verdictCache.keys().next().value);
        if (r.is_ad) block(el, r.p_ad);
      });
      if (hadError) scheduleScan(5000);
    } finally {
      scanning = false;
    }
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
    canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
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
