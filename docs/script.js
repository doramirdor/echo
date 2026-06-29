// Echo landing — light interactions, no dependencies.
(function () {
  "use strict";

  var prefersReduced = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Sticky nav shadow ---------- */
  var nav = document.getElementById("nav");
  var onScroll = function () {
    if (window.scrollY > 8) nav.classList.add("is-scrolled");
    else nav.classList.remove("is-scrolled");
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Mobile menu ---------- */
  var toggle = document.getElementById("navToggle");
  var links = document.querySelector(".nav__links");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        links.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- Scroll reveal ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---------- Live dictation demo (refined line types out) ---------- */
  var demo = document.getElementById("demo");
  var after = document.getElementById("demoAfter");
  var out = document.getElementById("demoOut");
  var timeEl = document.getElementById("demoTime");
  var flowSvg = document.querySelector(".dictate__flow");

  function fmtTime(s) { return "0:" + (s < 10 ? "0" : "") + s; }

  if (demo && prefersReduced && flowSvg && flowSvg.pauseAnimations) {
    // Hold a calm, fully readable still frame when motion is reduced.
    try { flowSvg.pauseAnimations(); } catch (e) {}
  }

  if (demo && after && out && !prefersReduced && "IntersectionObserver" in window) {
    var AFTER_TEXT = after.textContent;
    var gen = 0;

    function sleep(ms, stop) { return new Promise(function (res) { setTimeout(function () { res(stop()); }, ms); }); }
    function type(el, text, speed, stop) {
      return new Promise(function (res) {
        var i = 0;
        (function step() {
          if (stop()) { res(true); return; }
          el.textContent = text.slice(0, i);
          if (i++ < text.length) setTimeout(step, speed);
          else res(false);
        })();
      });
    }
    function run() {
      var my = ++gen;
      (async function () {
        var stop = function () { return my !== gen; };
        while (!stop()) {
          after.textContent = "";
          out.classList.add("is-typing");
          if (timeEl) timeEl.textContent = "0:00";
          // Tick the recording timer while the line streams in.
          var secs = 0, ticker = setInterval(function () {
            if (timeEl) timeEl.textContent = fmtTime(++secs % 60);
          }, 1000);
          var aborted = await type(after, AFTER_TEXT, 30, stop);
          clearInterval(ticker);
          if (aborted) return;
          out.classList.remove("is-typing");
          if (await sleep(3200, stop)) return;
        }
      })();
    }
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) run(); else gen++; });
    }, { threshold: 0.3 }).observe(demo);
  }

  /* ---------- Copy install commands ---------- */
  var copyBtn = document.getElementById("copyBtn");
  var code = document.getElementById("installCode");
  if (copyBtn && code) {
    copyBtn.addEventListener("click", function () {
      var text = code.innerText.replace(/^#.*$/gm, "").replace(/✓.*/g, "").trim();
      var done = function () {
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("is-copied");
        setTimeout(function () { copyBtn.textContent = "Copy"; copyBtn.classList.remove("is-copied"); }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      } else {
        var ta = document.createElement("textarea"); ta.value = text;
        document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  }
})();
