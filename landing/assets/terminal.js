// Agora Mesh Hunter console: CRT shell replaying the agent-economy pipeline.
// Five views (MISSION / DISCOVERY / SETTLEMENT / VERIFY / AUTHORITY) under the
// contract "scroll = watch, click/Enter = play".
//
// Boot is SCROLL-DRIVEN (setBootProgress). Interactive mode unlocks tabs + a command
// line + live views. Data is an EVIDENCE REPLAY (clearly labeled): service ids,
// prices and outcomes mirror the project's frozen BNB Testnet evidence.

import { t } from "./i18n.js";

const BOOT_KEYS = Array.from({ length: 12 }, (_, i) => `boot.${i}`);
const TABS = ["mission", "discovery", "settlement", "verify", "authority"];

const BANNER = `┌─────────────────────────────────────────────┐
│   A G O R A   ·   M E S H                    │
└─────────────────────────────────────────────┘
   HUNTER CONSOLE · EVIDENCE REPLAY · BNB TESTNET`;

export class TerminalApp {
  constructor(root, getLocale) {
    this.root = root;
    this.getLocale = getLocale;
    this.active = false;
    // 预览态：滚动到底、Boot 完成后先把交互模式里的实时数据「提前放出来」（只读，不锁滚动、
    // 不聚焦命令行）。按 Enter 才进入完整交互（命令行 + 锁滚动）。
    this.previewing = false;
    this.tab = "overview";
    this.bootShown = -1;
    this.tickTimer = 0;
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <div class="crt-overlay scanlines"></div>
      <div class="crt-overlay vignette"></div>
      <div class="crt-overlay flicker"></div>
      <div class="vhs-tracking"></div>

      <div class="term-content">
        <pre class="ascii-logo">${BANNER}</pre>
        <div class="boot-log" data-boot></div>

        <div class="term-live" data-live hidden>
          <div class="term-tabs" data-tabs>
            ${TABS.map(
              (name, i) =>
                `<button data-tab="${name}" class="term-tab${i === 0 ? " is-active" : ""}"></button>`
            ).join("")}
          </div>
          <div class="term-view" data-view></div>
          <div class="term-cmd">
            <span class="term-prompt">hunter:~$</span>
            <input class="term-input" data-input autocomplete="off" spellcheck="false" />
            <span class="cursor"></span>
          </div>
          <div class="term-hint" data-hint></div>
        </div>
      </div>

      <div class="enter-cta" data-enter hidden>
        <button class="btn-enter" data-enter-btn></button>
        <span class="enter-hint" data-enter-hint></span>
      </div>

      <div class="term-status">
        <span data-status-left></span>
        <button class="term-exit" data-exit hidden></button>
        <span data-status-right></span>
      </div>
    `;

    this.el = {
      boot: this.root.querySelector("[data-boot]"),
      live: this.root.querySelector("[data-live]"),
      cmd: this.root.querySelector(".term-cmd"),
      tabs: this.root.querySelector("[data-tabs]"),
      view: this.root.querySelector("[data-view]"),
      input: this.root.querySelector("[data-input]"),
      hint: this.root.querySelector("[data-hint]"),
      enter: this.root.querySelector("[data-enter]"),
      enterBtn: this.root.querySelector("[data-enter-btn]"),
      enterHint: this.root.querySelector("[data-enter-hint]"),
      statusL: this.root.querySelector("[data-status-left]"),
      statusR: this.root.querySelector("[data-status-right]"),
      exit: this.root.querySelector("[data-exit]"),
    };

    this.el.enterBtn.addEventListener("click", () => this.enter());
    this.el.exit.addEventListener("click", () => this.exit());
    this.el.tabs.addEventListener("click", (e) => {
      const b = e.target.closest("[data-tab]");
      if (b) this.setTab(b.getAttribute("data-tab"));
    });
    this.el.input.addEventListener("keydown", (e) => {
      // Escape must exit even while the input is focused. Handle it here first,
      // because stopPropagation() below would otherwise keep it from the
      // document-level Escape listener.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.exit();
        return;
      }
      e.stopPropagation();
      if (e.key === "Enter") this._runCommand(this.el.input.value.trim());
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.active) this.exit();
    });
  }

  applyLocale() {
    const loc = this.getLocale();
    this.el.enterBtn.textContent = t(loc, "terminal.enter");
    this.el.enterHint.textContent = t(loc, "terminal.enterHint");
    this.el.statusL.textContent = t(loc, "terminal.status.left");
    this.el.statusR.textContent = t(loc, "terminal.status.right");
    this.el.exit.textContent = t(loc, "terminal.exit");
    this.el.hint.textContent = t(loc, "terminal.hint");
    this.el.tabs.querySelectorAll("[data-tab]").forEach((b) => {
      b.textContent = t(loc, `terminal.tab.${b.getAttribute("data-tab")}`);
    });
    this._renderBootLines(this.bootShown);
    if (this.active || this.previewing) this._renderView();
  }

  // ---- scroll-driven boot ----
  setBootProgress(p) {
    const total = BOOT_KEYS.length;
    const shown = Math.max(0, Math.min(total, Math.round(p * total)));
    if (shown === this.bootShown) return;
    this.bootShown = shown;
    this._renderBootLines(shown);
    const done = shown >= total;
    // Boot 完成即进入只读预览：把交互态的实时视图提前显示出来（数据更丰富）。
    if (done && !this.active) this._enterPreview();
    this.el.enter.hidden = !done || this.active;
  }

  // 只读预览：显示 tabs + 实时视图并让数据滚动，但不锁滚动、不聚焦命令行、隐藏命令行与退出键。
  _enterPreview() {
    if (this.active || this.previewing) return;
    this.previewing = true;
    this.root.classList.add("is-live");
    this.el.live.hidden = false;
    if (this.el.cmd) this.el.cmd.hidden = true;
    this.el.exit.hidden = true;
    this.setTab(this.tab);
    this._startTick();
  }

  bootComplete() {
    return this.bootShown >= BOOT_KEYS.length;
  }

  _renderBootLines(shown) {
    if (shown < 0) return;
    const loc = this.getLocale();
    const lines = [];
    for (let i = 0; i < shown; i++) {
      const s = t(loc, BOOT_KEYS[i]);
      lines.push(s === "" ? " " : s);
    }
    this.el.boot.textContent = lines.join("\n");
  }

  // ---- interactive mode ----
  enter() {
    if (this.active) return;
    this.active = true;
    this.previewing = false;
    this.root.classList.add("is-live");
    this.el.enter.hidden = true;
    this.el.live.hidden = false;
    if (this.el.cmd) this.el.cmd.hidden = false;
    this.el.exit.hidden = false;
    document.documentElement.classList.add("hl-terminal-locked");
    this.setTab(this.tab);
    this.el.input.focus({ preventScroll: true });
    this._startTick();
  }

  exit() {
    if (!this.active) return;
    this.active = false;
    this.root.classList.remove("is-live");
    this.el.live.hidden = true;
    this.el.exit.hidden = true;
    document.documentElement.classList.remove("hl-terminal-locked");
    this._stopTick();
    this.root.dispatchEvent(new CustomEvent("term-exit", { bubbles: true }));
    // 退出交互后回到只读预览（而不是空屏），保持滚动区数据仍在。
    this.previewing = false;
    if (this.bootComplete()) this._enterPreview();
    this.el.enter.hidden = !this.bootComplete();
  }

  setTab(tab) {
    this.tab = tab;
    this.el.tabs.querySelectorAll("[data-tab]").forEach((b) => {
      b.classList.toggle("is-active", b.getAttribute("data-tab") === tab);
    });
    this._renderView();
  }

  _startTick() {
    this._stopTick();
    this.tickTimer = setInterval(() => {
      if (this.active || this.previewing) this._renderView();
    }, 1400);
  }
  _stopTick() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = 0;
  }

  // ---- evidence-replay helpers ----
  _jit(base, pct) {
    return base * (1 + (Math.random() - 0.5) * pct);
  }
  _hash() {
    const hex = "0123456789abcdef";
    let s = "0x";
    for (let i = 0; i < 6; i++) s += hex[Math.floor(Math.random() * 16)];
    return s + "…" + hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)];
  }
  _step() {
    // A slow cursor over the pipeline so the replay visibly progresses.
    return Math.floor(Date.now() / 1400) % 6;
  }

  _renderView() {
    this.el.view.innerHTML = this[`_data_${this.tab}`]();
  }

  // MISSION — one paid audit mission walking through the Commander V2 phases
  _data_mission() {
    const step = this._step();
    const phases = [
      ["DISCOVERY", "5 live offers found · x402-eligible on eip155:97"],
      ["DECISION", "ranked by capability · reputation · price · latency"],
      ["PAYMENT", "0.5 U → auditor wallet · scoped session signed"],
      ["EXECUTION", "SecurityFinding[] returned · receipt v2 signed"],
      ["VERIFICATION", "independent verifier re-checks same sourceHash"],
      ["SETTLED", "mission archived · reputation updated"],
    ];
    const head = `<div class="row row-3 row-head"><span>PHASE</span><span>STATE</span><span>DETAIL</span></div>`;
    return head + phases
      .map((p, i) => {
        const state = i < step ? `<span class="up">[ OK ]</span>` : i === step ? `<span class="up">[ RUN ]</span>` : `<span>[ .. ]</span>`;
        return `<div class="row row-3"><span class="${i <= step ? "up" : ""}">${p[0]}</span>${state}<span>${i <= step ? p[1] : "—"}</span></div>`;
      })
      .join("");
  }

  // DISCOVERY — the live audit market as recorded in the ranking evidence
  _data_discovery() {
    const rows = [
      ["sentinel-audit-v1", "contract audit", "0.40 U", "—", "0.70", "capability 100% · price 100%"],
      ["auditor-v1", "contract audit", "0.50 U", "83%", "0.60", "reputation 83% · proven delivery"],
      ["verifier-v1", "finding verification", "0.25 U", "83%", "—", "Slither 0.11.6 · independent wallet"],
      ["investigator-v1", "onchain investigation", "read-only", "—", "—", "deterministic RPC · no LLM"],
      ["risk-verifier-v1", "risk replay", "0.25 U", "—", "—", "historic-block replay"],
    ];
    const head = `<div class="row row-5 row-head"><span>SERVICE</span><span>TASK</span><span>PRICE</span><span>REP</span><span>SCORE</span></div>`;
    return head + rows
      .map((r, i) => `<div class="row row-5"><span class="${i === 0 ? "up" : ""}">${r[0]}</span><span>${r[1]}</span><span>${r[2]}</span><span>${r[3]}</span><span class="${i === 0 ? "up" : ""}">${r[4]}</span></div>`)
      .join("");
  }

  // SETTLEMENT — the x402 handshake, replayed from real paid runs
  _data_settlement() {
    const step = this._step();
    const rows = [
      ["402", "PAYMENT REQUIRED", "quote: 0.5 U · recipient bound · 300s deadline"],
      ["SIGN", "PERMIT2 NONCE = REQ HASH", `request ${this._hash()} · exact amount only`],
      ["TX", "SETTLED ON BNB TESTNET", `transfer ${this._hash()} · unique token Transfer`],
      ["RCPT", "RECEIPT v2 VERIFIED", "binds request · result · provider · timestamp"],
      ["PAY2", "VERIFIER HIRED · 0.25 U", "different identity · different wallet"],
      ["DONE", "6 SETTLEMENTS · 2.25 U", "three consecutive runs · zero double debits"],
    ];
    const head = `<div class="row row-3 row-head"><span>STEP</span><span>EVENT</span><span>DETAIL</span></div>`;
    return head + rows
      .map((r, i) => {
        const on = i <= step;
        return `<div class="row row-3"><span class="${on ? "up" : ""}">${r[0]}</span><span class="${on ? "up" : ""}">${on ? r[1] : "…"}</span><span>${on ? r[2] : ""}</span></div>`;
      })
      .join("");
  }

  // VERIFY — independent verification verdicts (Slither-backed)
  _data_verify() {
    const rows = [
      ["F-01", "HIGH", "unprotected mint on implementation", "confirmed"],
      ["F-02", "HIGH", "owner can pause transfers", "confirmed"],
      ["F-03", "MED", "proxy upgrade path via EIP-1967 slot", "confirmed"],
      ["F-04", "MED", "reentrancy surface in external call", "confirmed"],
      ["F-05", "LOW", "missing event on parameter change", "missed → flagged"],
    ];
    const head = `<div class="row row-5 row-head"><span>ID</span><span>SEV</span><span>FINDING</span><span>SOURCE</span><span>SLITHER</span></div>`;
    return head + rows
      .map((r) => `<div class="row row-5"><span>${r[0]}</span><span class="${r[1] === "HIGH" ? "down" : ""}">${r[1]}</span><span>${r[2]}</span><span>hash ✓</span><span class="${r[3].startsWith("confirmed") ? "up" : "down"}">${r[3]}</span></div>`)
      .join("");
  }

  // AUTHORITY — the scoped grant, its spend, and the revoke negative test
  _data_authority() {
    const spent = [0, 0.5, 0.75, 0.75, 0.75, 0.75][this._step()];
    const rows = [
      ["AUTHORITY", "browser-cbb87207 · scoped session"],
      ["SPEND CAP", `1.15 U · spent ${spent.toFixed(2)} U`],
      ["ALLOWLIST", "3 recipients: auditor · verifier · sentinel"],
      ["EXPIRY", "1 hour · admin key never in runtime"],
      ["REVOKE", "3 tx confirmed · Permit2 allowance = 0"],
      ["NEGATIVE TEST", "post-revoke payment REJECTED onchain"],
    ];
    const head = `<div class="row row-2 row-head"><span>FIELD</span><span>STATE (FROM FROZEN EVIDENCE)</span></div>`;
    return head + rows
      .map((r, i) => `<div class="row row-2"><span class="${i >= 4 ? "down" : "up"}">${r[0]}</span><span>${r[1]}</span></div>`)
      .join("");
  }

  // ---- command line ----
  _runCommand(raw) {
    this.el.input.value = "";
    if (!raw) return;
    const [cmd, arg] = raw.toLowerCase().split(/\s+/);
    if (cmd === "help") {
      this.el.hint.textContent =
        "views: mission · discovery · settlement · verify · authority | theme <green|amber|c64> · clear · exit";
    } else if (TABS.includes(cmd)) {
      this.setTab(cmd);
    } else if (cmd === "theme") {
      this._setTheme(arg || "green");
    } else if (cmd === "clear") {
      this.el.hint.textContent = "";
    } else if (cmd === "exit") {
      this.exit();
    } else {
      this.el.hint.textContent = `unknown command: ${cmd} — type 'help'`;
    }
  }

  _setTheme(name) {
    this.root.classList.remove("theme-amber", "theme-c64", "theme-amiga");
    if (name && name !== "green") this.root.classList.add("theme-" + name);
    this.root.classList.add("glitch-flash");
    setTimeout(() => this.root.classList.remove("glitch-flash"), 300);
  }
}
