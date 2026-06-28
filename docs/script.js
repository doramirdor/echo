// Echo landing — light interactions, no dependencies.
(function () {
  "use strict";

  var prefersReduced = window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Sticky nav shadow on scroll ---------- */
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

  /* ---------- Count-up for stats ---------- */
  function animateCount(el) {
    var target = parseFloat(el.getAttribute("data-count"));
    var suffix = el.getAttribute("data-suffix") || "";
    var dur = 1300;
    var start = null;
    function frame(t) {
      if (start === null) start = t;
      var p = Math.min((t - start) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(frame);
      else el.textContent = target + suffix;
    }
    requestAnimationFrame(frame);
  }
  // Start counters from zero (only when we'll actually animate).
  if (!prefersReduced) {
    document.querySelectorAll("[data-count]").forEach(function (el) {
      el.textContent = "0" + (el.getAttribute("data-suffix") || "");
    });
  }

  /* ---------- Scroll reveal (+ trigger counters) ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          if (!prefersReduced) {
            entry.target.querySelectorAll("[data-count]").forEach(function (c) {
              if (!c.dataset.counted) { c.dataset.counted = "1"; animateCount(c); }
            });
          }
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("is-in"); });
  }

  /* ---------- Live dictation demo (typewriter loop) ---------- */
  var demo = document.getElementById("demo");
  if (demo && !prefersReduced && "IntersectionObserver" in window) {
    var before = document.getElementById("demoBefore");
    var after = document.getElementById("demoAfter");
    var status = document.getElementById("demoStatus");
    var rec = document.getElementById("demoRec");
    var arrow = document.getElementById("demoArrow");
    var cardBefore = document.getElementById("demoCardBefore");
    var cardAfter = document.getElementById("demoCardAfter");
    var BEFORE_TEXT = before.textContent;
    var AFTER_TEXT = after.textContent;
    var activeGen = 0;

    function sleep(ms, stop) {
      return new Promise(function (res) {
        setTimeout(function () { res(stop()); }, ms);
      });
    }
    function typeText(el, text, speed, stop) {
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
      var myGen = ++activeGen;
      (async function () {
        var stop = function () { return myGen !== activeGen; };
        while (!stop()) {
          // reset
          before.textContent = "";
          after.textContent = "";
          cardBefore.classList.remove("is-typing");
          cardAfter.classList.remove("is-typing", "is-done");
          arrow.classList.remove("is-active");
          rec.className = "demo__rec";
          status.textContent = "Listening…";
          if (await sleep(750, stop)) return;

          // type the messy speech
          cardBefore.classList.add("is-typing");
          if (await typeText(before, BEFORE_TEXT, 26, stop)) return;
          cardBefore.classList.remove("is-typing");
          if (await sleep(450, stop)) return;

          // refining
          status.textContent = "Refining…";
          rec.classList.add("is-refining");
          arrow.classList.add("is-active");
          if (await sleep(750, stop)) return;

          // type the polished result
          cardAfter.classList.add("is-typing");
          if (await typeText(after, AFTER_TEXT, 20, stop)) return;
          cardAfter.classList.remove("is-typing");
          arrow.classList.remove("is-active");

          // done
          status.textContent = "Inserted ✓";
          rec.classList.remove("is-refining");
          rec.classList.add("is-done");
          cardAfter.classList.add("is-done");
          if (await sleep(2800, stop)) return;
        }
      })();
    }

    new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) run();   // start a fresh generation
          else activeGen++;              // invalidate → loop bails at next check
        });
      },
      { threshold: 0.3 }
    ).observe(demo);
  }

  /* ---------- Copy install commands ---------- */
  var copyBtn = document.getElementById("copyBtn");
  var code = document.getElementById("installCode");
  if (copyBtn && code) {
    copyBtn.addEventListener("click", function () {
      var text = code.innerText;
      var done = function () {
        copyBtn.textContent = "Copied!";
        copyBtn.classList.add("is-copied");
        setTimeout(function () {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("is-copied");
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  }
})();
