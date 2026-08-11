import { type Scene, SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";
import { fetchHighscores, type Highscore } from "../net";

type SortMode = "best" | "total";

function colorSwatch(color: number): string {
  const hex = "#" + color.toString(16).padStart(6, "0");
  return `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${hex};margin-right:8px;vertical-align:middle"></span>`;
}

export class LeaderboardScene implements Scene {
  private el: HTMLElement | null = null;
  private mode: SortMode = "best";
  private requestSeq = 0; // guards against a slow earlier fetch overwriting a later tab switch's result

  constructor(private sm: SceneManager) {}

  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    wrap.innerHTML = `
      <div class="menu" style="min-width:440px">
        <h1>Leaderboard</h1>
        <div class="row" style="gap:6px;margin-bottom:8px">
          <button class="btn" id="tab-best">Best Game</button>
          <button class="btn" id="tab-total">Total Score</button>
        </div>
        <div class="panel" id="list"><small>Loading…</small></div>
        <button class="btn" id="back" style="margin-top:8px">Back</button>
      </div>
    `;
    wrap.querySelector("#back")!.addEventListener("click", () => this.sm.switch(new MenuScene(this.sm)));
    wrap.querySelector("#tab-best")!.addEventListener("click", () => this.switchMode("best"));
    wrap.querySelector("#tab-total")!.addEventListener("click", () => this.switchMode("total"));
    root.appendChild(wrap);
    this.el = wrap;

    this.updateTabStyles();
    this.load();
  }

  private switchMode(mode: SortMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.updateTabStyles();
    this.load();
  }

  private updateTabStyles() {
    const bestBtn = this.el?.querySelector("#tab-best") as HTMLElement | null;
    const totalBtn = this.el?.querySelector("#tab-total") as HTMLElement | null;
    if (!bestBtn || !totalBtn) return;
    bestBtn.style.opacity = this.mode === "best" ? "1" : "0.55";
    totalBtn.style.opacity = this.mode === "total" ? "1" : "0.55";
  }

  private load() {
    const list = this.el?.querySelector("#list");
    if (list) list.innerHTML = "<small>Loading…</small>";
    const seq = ++this.requestSeq;
    fetchHighscores(this.mode)
      .then((scores) => { if (seq === this.requestSeq) this.render(scores); })
      .catch(() => { if (seq === this.requestSeq) this.renderError(); });
  }

  private render(scores: Highscore[]) {
    const list = this.el?.querySelector("#list");
    if (!list) return;
    if (!scores.length) { list.innerHTML = "<small>No games played yet — be the first!</small>"; return; }
    const scoreLabel = this.mode === "best" ? "pts (best)" : "pts (total)";
    list.innerHTML = scores.map((s, i) => {
      const nameTag = s.tag ? `${escapeHtml(s.name)}<small style="opacity:0.6">#${s.tag}</small>` : escapeHtml(s.name);
      const raceLine = s.race ? `<small style="opacity:0.7">${s.race}</small>` : "";
      const st = s.stats;
      const statsLine = st
        ? `<small style="opacity:0.7">Gathered ${Math.round(st.gathered)} · Built ${st.built} · Destroyed ${st.destroyed} · Captured ${st.captured} · Claimed ${st.landClaimed} tiles · ${st.kills} kills</small>`
        : "";
      const shownScore = this.mode === "best" ? s.bestScore : s.totalScore;
      return `
        <div style="padding:6px 0;border-bottom:1px solid #222">
          <div class="row" style="justify-content:space-between">
            <span>#${i + 1} ${colorSwatch(s.color)}${nameTag}</span>
            <span><strong>${Math.round(shownScore)}</strong> ${scoreLabel} · ${s.gamesPlayed} games</span>
          </div>
          <div class="row" style="justify-content:space-between;margin-top:2px">
            ${raceLine}${statsLine}
          </div>
        </div>
      `;
    }).join("");
  }

  private renderError() {
    const list = this.el?.querySelector("#list");
    if (list) list.innerHTML = "<small>Couldn't load the leaderboard right now.</small>";
  }

  unmount() { this.el?.remove(); this.el = null; }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
