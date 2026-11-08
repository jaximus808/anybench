/* global window, document, location, URL */
/* Anybench embed loader (TDM-205): each <div data-anybench-embed="<slug>"> gets the /embed/<slug>
   iframe, resized to the height the widget posts (anybench:height). */
(function () {
  var w = window;
  if (w.AnybenchEmbed) return w.AnybenchEmbed.mount();
  var s = document.currentScript;
  var base = new URL(s && s.src ? s.src : location.href).origin;
  var frames = [];
  var SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
  function mount() {
    var els = document.querySelectorAll("[data-anybench-embed]:not([data-anybench-mounted])");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var slug = el.getAttribute("data-anybench-embed");
      if (!SLUG.test(slug)) continue;
      var theme = el.getAttribute("data-theme");
      var version = el.getAttribute("data-version");
      var q = "?theme=" + (/^(light|dark|auto)$/.test(theme) ? theme : "auto");
      if (/^[1-9]\d*$/.test(version)) q += "&version=" + version;
      var f = document.createElement("iframe");
      f.src = base + "/embed/" + slug + q;
      f.title = "Anybench results: " + slug;
      f.loading = "lazy";
      f.setAttribute("scrolling", "no");
      f.style.cssText = "display:block;width:100%;height:320px;border:0;overflow:hidden";
      el.setAttribute("data-anybench-mounted", "");
      el.appendChild(f);
      frames.push(f);
    }
  }
  w.addEventListener("message", function (e) {
    var d = e.data;
    if (e.origin !== base || !d || d.type !== "anybench:height") return;
    var h = Math.ceil(Number(d.height));
    if (!(h > 0 && h < 5000)) return;
    for (var i = 0; i < frames.length; i++)
      if (frames[i].contentWindow === e.source) frames[i].style.height = h + "px";
  });
  w.AnybenchEmbed = { mount: mount };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
