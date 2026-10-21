// On iOS, adds maximum-scale=1 to the viewport so Safari does not zoom the
// page into a focused text field set below 16px. iOS still allows pinch
// zoom with it; on other systems it would block pinch zoom, so they keep
// the plain viewport. iPadOS reports itself as a Mac, told apart by its
// touch points. A same-origin file because the CSP (script-src 'self')
// permits no inline script.
(function () {
  var ios =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios) return;
  var meta = document.querySelector('meta[name="viewport"]');
  if (meta) meta.content += ", maximum-scale=1";
})();
