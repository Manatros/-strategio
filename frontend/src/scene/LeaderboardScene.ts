import type { Scene } from "./SceneManager";
import { SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";

export class LeaderboardScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager){}
  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    wrap.innerHTML = `
      <div class="menu">
        <h1>Leaderboard</h1>
        <div class="panel"><small>Coming soon</small></div>
        <button class="btn" id="back">Back</button>
      </div>
    `;
    wrap.querySelector("#back")!.addEventListener("click", ()=> this.sm.switch(new MenuScene(this.sm)));
    root.appendChild(wrap); this.el = wrap;
  }
  unmount(){ this.el?.remove(); this.el = null; }
}
