// Onboarding page shown once on first install (opened by background.js).
document.getElementById("ver").textContent = chrome.runtime.getManifest().version;

// Tell the background the user has seen onboarding, so it clears the "NEW"
// toolbar hint even if they never open the popup.
try { chrome.runtime.sendMessage({ type: "minus:onboarding-seen" }); } catch {}

document.getElementById("done").addEventListener("click", () => {
  window.close();
});
