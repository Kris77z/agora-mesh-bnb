import { applyI18n, detectLocale, saveLocale } from "./i18n.js";
import { ParticleShape } from "./particles.js";
import { TerminalApp } from "./terminal.js";

let locale = detectLocale();
const getLocale = () => locale;

const term = new TerminalApp(document.getElementById("terminal"), getLocale);

function setLocale(loc) {
  locale = loc;
  saveLocale(loc);
  applyI18n(loc);
  term.applyLocale();
  document.querySelectorAll("[data-lang]").forEach((b) => {
    b.classList.toggle("is-active", b.getAttribute("data-lang") === loc);
  });
}
document.querySelectorAll("[data-lang]").forEach((b) => {
  b.addEventListener("click", () => setLocale(b.getAttribute("data-lang")));
});

// CTAs that jump to the terminal: scroll to the track, then enter interactive mode.
document.querySelectorAll("[data-goto-terminal]").forEach((b) => {
  b.addEventListener("click", () => {
    const track = document.getElementById("zoom-track");
    track.scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(() => term.enter(), 700);
  });
});
// Secondary CTA (watch demo): just scroll into the boot sequence.
document.querySelectorAll("[data-scroll-terminal]").forEach((b) => {
  b.addEventListener("click", () => {
    document.getElementById("zoom-track").scrollIntoView({ behavior: "smooth", block: "start" });
  });
});

setLocale(locale);

// ---- particles ----
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let field = null;
try {
  field = new ParticleShape(document.getElementById("particles"), { shape: "chain" });
  if (!reduceMotion) field.start();
} catch (e) {
  console.warn("[particles] disabled:", e && e.message);
  field = null;
}
// expose for quick tweaking from the console: field.setShape('text')
window.__field = field;
// expose the class so shape geometry can be verified even without WebGL (2D sampling)
window.__ParticleShape = ParticleShape;

// ---- scroll orchestration ----
const track = document.getElementById("zoom-track");
const monitor = document.getElementById("monitor");
const heroLayer = document.getElementById("hero-layer");
const terminalEl = document.getElementById("terminal");

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, x) => a + (b - a) * x;

let zoomComplete = false; // monitor fills the viewport → Enter can start the terminal

let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    update();
  });
}

function update() {
  const rect = track.getBoundingClientRect();
  const vh = window.innerHeight;
  const total = track.offsetHeight - vh;
  const p = clamp01((0 - rect.top) / total);

  // Symmetric to remocn's scroll-driven video: grow in, hold fullscreen, then
  // gradually recede (shrink + fade) as you keep scrolling past it.
  const zoomP = clamp01(p / 0.55); // entry: 0.62 -> 1.0 over first 55%
  const exitP = clamp01((p - 0.72) / 0.28); // exit recede over last 28%

  let scale, radius;
  if (exitP > 0) {
    // exit mirrors entry: shrink fullscreen back down to the inset card
    scale = lerp(1.0, 0.62, exitP);
    radius = lerp(0, 18, exitP);
  } else {
    scale = lerp(0.62, 1.0, zoomP);
    radius = lerp(18, 0, zoomP);
  }
  monitor.style.transform = `scale(${scale.toFixed(4)})`;
  monitor.style.borderRadius = `${radius.toFixed(1)}px`;
  // stay visible while it shrinks; only a soft fade in the final stretch
  monitor.style.opacity = (1 - clamp01((exitP - 0.75) / 0.25) * 0.35).toFixed(3);
  terminalEl.style.setProperty("--crt-intensity", (zoomP * (1 - exitP * 0.7)).toFixed(3));

  // Enter is available only while fullscreen and not yet receding.
  zoomComplete = zoomP > 0.98 && exitP < 0.4;

  const bootP = clamp01((p - 0.08) / 0.5);
  term.setBootProgress(bootP);

  const heroFade = clamp01(1 - p / 0.35);
  heroLayer.style.opacity = heroFade.toFixed(3);
  heroLayer.style.pointerEvents = heroFade < 0.05 ? "none" : "auto";

  if (!reduceMotion && field) {
    field.setOpacity(heroFade.toFixed(3));
    if (p > 0.4 && field.running) field.pause();
    else if (p <= 0.4 && !field.running && !field.disposed) field.resume();
  }
}

// Issue #3: pressing Enter while the terminal is fullscreen (and not yet active)
// should enter interactive mode — no click required. Recompute scroll state on the
// keypress so it never depends on a scroll event having fired first.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || term.active) return;
  if (!reduceMotion) update();
  if (zoomComplete && term.bootComplete()) {
    e.preventDefault();
    term.enter();
  }
});

if (reduceMotion) {
  monitor.style.transform = "scale(1)";
  monitor.style.borderRadius = "0";
  terminalEl.style.setProperty("--crt-intensity", "1");
  term.setBootProgress(1);
  zoomComplete = true;
  heroLayer.style.opacity = "1";
  if (field) field.setOpacity(0);
} else {
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();
}
