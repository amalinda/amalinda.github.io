(function () {
  var base = "https://cdn.nws.sg/p_83917462057456456456456";
  var params = new URLSearchParams({
    r: location.href || "/",
    sw: screen.width,
    sh: screen.height,
    dpr: window.devicePixelRatio || 1,
    vw: document.documentElement.clientWidth || window.innerWidth || 0,
    vh: document.documentElement.clientHeight || window.innerHeight || 0,
    lang: navigator.language || "",
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    lt: new Date().toISOString()
  });
  window.__mtr = new Image(1, 1);
  window.__mtr.src = base + "?" + params.toString();
})();