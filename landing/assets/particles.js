// Hero "chain" — the SAME double-helix geometry as before (two strands + faint rungs),
// but rendered as GLOWING PARTICLE DOTS instead of hex letters, and it FORMS IN on
// first load/refresh (dots start scattered, ease into the helix, then track its slow
// rotation). Rungs stay thin lines (not dots) so the strands read clean — no fan clutter.
//
// 2D canvas (no WebGL) → renders anywhere, including headless. API kept compatible:
// start / pause / resume / setOpacity / dispose / setShape.

const MINT = "47, 230, 183";
const HEX = "0123456789ABCDEF".split(""); // strand glyphs read as address fragments

export class ParticleShape {
  constructor(container, opts = {}) {
    this.container = container;
    this.shape = opts.shape || "chain";
    this.running = false;
    this.disposed = false;
    this.raf = 0;
    this.t = 0;
    this.intro = 0;
    this._loop = this._loop.bind(this);
    this._onResize = this._onResize.bind(this);
    this._build();
  }

  _build() {
    this.canvas = document.createElement("canvas");
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvas.style.display = "block";
    this.container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d");
    this._resize();
    this._make();
    window.addEventListener("resize", this._onResize);
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = this.container.clientWidth || window.innerWidth;
    this.h = this.container.clientHeight || window.innerHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.mobile = this.w < 768;
    // match the previous letter-helix layout exactly
    this.align = this.mobile ? 0.5 : 0.72;
    this.radius = this.mobile ? 74 : 150;
    this.rungs = this.mobile ? 60 : 92;
    this.spacing = (this.h * 1.05) / this.rungs;
    this.top = this.h * 0.06;
  }

  // Two on-rung nodes per rung (the strands) + a few dots along the strand between
  // rungs for particle density. Rungs themselves are drawn as lines in the loop.
  _make() {
    const rnd = () => Math.random();
    this.pairs = [];
    this.fill = [];
    const subs = this.mobile ? 2 : 3; // extra strand dots between successive rungs
    for (let i = 0; i < this.rungs; i++) {
      this.pairs.push({
        a: { fi: i, off: 0, ch: HEX[(i * 7) % 16], sx: rnd() * this.w, sy: rnd() * this.h },
        b: { fi: i, off: Math.PI, ch: HEX[(i * 11 + 5) % 16], sx: rnd() * this.w, sy: rnd() * this.h },
      });
      for (let s = 1; s < subs; s++) {
        const fi = i + s / subs;
        for (const off of [0, Math.PI]) {
          this.fill.push({ fi, off, sx: rnd() * this.w, sy: rnd() * this.h });
        }
      }
    }
  }

  _project(fi, off, time) {
    const angle = fi * 0.05 + time + off;
    const x3d = Math.sin(angle) * this.radius;
    const z3d = Math.cos(angle) * this.radius;
    const fov = 1000;
    const scale = fov / (fov + z3d);
    return { x: this.w * this.align + x3d * scale, y: fi * this.spacing * scale + this.top, scale };
  }

  // current on-screen position of a dot, blended from its scattered start by intro ease
  _pos(d, time, e) {
    const p = this._project(d.fi, d.off, time);
    return {
      x: d.sx + (p.x - d.sx) * e,
      y: d.sy + (p.y - d.sy) * e,
      scale: p.scale,
    };
  }

  start() {
    if (this.disposed) return;
    this.running = true;
    if (!this.raf) this.raf = requestAnimationFrame(this._loop);
  }
  pause() {
    this.running = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }
  resume() {
    if (!this.disposed && !this.running) this.start();
  }

  _loop() {
    if (!this.running || this.disposed) return;
    this.raf = requestAnimationFrame(this._loop);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    this.t += 0.008;
    if (this.intro < 1) this.intro = Math.min(1, this.intro + 0.012);
    const e = 1 - Math.pow(1 - this.intro, 3);

    for (const pr of this.pairs) {
      const a = this._pos(pr.a, this.t, e);
      const b = this._pos(pr.b, this.t, e);
      // rung line between the two strands
      ctx.strokeStyle = `rgba(${MINT}, ${0.14 * Math.min(a.scale, b.scale) * e})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      this._char(a, pr.a.ch);
      this._char(b, pr.b.ch);
    }
    for (const d of this.fill) {
      this._dot(this._pos(d, this.t, e), 1.2);
    }
  }

  // strand nodes render as address hex glyphs (bright on the front strand)
  _char(p, ch) {
    const ctx = this.ctx;
    const front = p.scale > 1;
    const alpha = front ? 1 : 0.32;
    ctx.font = `bold ${(this.mobile ? 11 : 13) * p.scale}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowBlur = front ? 10 : 0;
    ctx.shadowColor = `rgba(${MINT}, 0.9)`;
    ctx.fillStyle = `rgba(${MINT}, ${alpha})`;
    ctx.fillText(ch, p.x, p.y);
    ctx.shadowBlur = 0;
  }

  _dot(p, base) {
    const ctx = this.ctx;
    const front = p.scale > 1;
    const alpha = front ? 1 : 0.3;
    const r = Math.max(0.5, base * p.scale);
    if (front) {
      ctx.beginPath();
      ctx.fillStyle = `rgba(${MINT}, ${alpha * 0.16})`;
      ctx.arc(p.x, p.y, r * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.fillStyle = `rgba(${MINT}, ${alpha})`;
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  setOpacity(v) {
    if (this.canvas) this.canvas.style.opacity = String(v);
  }
  setShape() {}
  reform() {
    this.intro = 0;
    this._make();
  }

  _onResize() {
    if (this.disposed) return;
    this._resize();
    this._make();
    this.intro = 1;
  }

  dispose() {
    this.pause();
    this.disposed = true;
    window.removeEventListener("resize", this._onResize);
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
  }
}
