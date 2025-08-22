import type { Scene } from "./SceneManager";
import { GameScene } from "./GameScene";
import { OptionsScene } from "./OptionsScene";
import { LeaderboardScene } from "./LeaderboardScene";
import { SceneManager } from "./SceneManager";

export class MenuScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager){}
  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    wrap.innerHTML = `
      <div class="menu">
        <h1>Strategio</h1>
        <small>Casual hex RTS — drop-in multiplayer</small>
        <button class="btn" id="play">Play</button>
        <div class="grid">
          <button class="btn" id="options">Options</button>
          <button class="btn" id="leaderboard">Leaderboard</button>
        </div>
      </div>
    `;
    wrap.querySelector<HTMLButtonElement>("#play")!.onclick = () => {
      this.sm.switch(new GameScene(this.sm));
    };
    wrap.querySelector<HTMLButtonElement>("#options")!.onclick = () => {
      this.sm.switch(new OptionsScene(this.sm));
    };
    wrap.querySelector<HTMLButtonElement>("#leaderboard")!.onclick = () => {
      this.sm.switch(new LeaderboardScene(this.sm));
    };
    root.appendChild(wrap);
    this.el = wrap;
  }
  unmount(){ this.el?.remove(); this.el = null; }
}
