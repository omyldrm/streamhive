'use strict';
// Applies the saved (or system) colour theme before the page paints, to avoid a flash.
(function () {
  var theme = null;
  try { theme = localStorage.getItem('sh_theme'); } catch (e) { /* storage unavailable */ }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
