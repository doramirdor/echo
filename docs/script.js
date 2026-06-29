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

  /* ---------- Live transcript demo (typewriter loop) ---------- */
  var demo = document.getElementById("demo");
  var before = document.getElementById("demoBefore");
  var after = document.getElementById("demoAfter");
  var rawRow = document.getElementById("demoCardBefore");
  var cleanRow = document.getElementById("demoCardAfter");
  if (demo && before && after && rawRow && cleanRow && !prefersReduced && "IntersectionObserver" in window) {
    var BEFORE_TEXT = before.textContent;
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
          before.textContent = ""; after.textContent = "";
          rawRow.classList.remove("is-typing"); cleanRow.classList.remove("is-typing");
          if (await sleep(650, stop)) return;
          rawRow.classList.add("is-typing");
          if (await type(before, BEFORE_TEXT, 26, stop)) return;
          rawRow.classList.remove("is-typing");
          if (await sleep(500, stop)) return;
          cleanRow.classList.add("is-typing");
          if (await type(after, AFTER_TEXT, 20, stop)) return;
          cleanRow.classList.remove("is-typing");
          if (await sleep(2800, stop)) return;
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
