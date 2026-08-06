import type { Scene } from "./SceneManager";
import { SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";
import { GameScene } from "./GameScene";

export class GameOverScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager, private finalScore: number, private reason: string) {}

  mount(root: HTMLElement) {
    localStorage.removeItem("strategio_inGame"); // dying always ends the resumable session

    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    const reasonText = this.reason === "killed" ? "You were defeated." : "Game over.";
    wrap.innerHTML = `
      <div class="menu">
        <h1>${reasonText}</h1>
        <div class="panel">
          <div class="row" style="justify-content:center"><strong>Final score: ${Math.round(this.finalScore)}</strong></div>
        </div>
        <button class="btn" id="again">New Game</button>
        <button class="btn" id="menu">Main Menu</button>
      </div>
    `;
    wrap.querySelector<HTMLButtonElement>("#again")!.onclick = () => this.sm.switch(new GameScene(this.sm, "new"));
    wrap.querySelector<HTMLButtonElement>("#menu")!.onclick = () => this.sm.switch(new MenuScene(this.sm));
    root.appendChild(wrap);
    this.el = wrap;
  }
  unmount() { this.el?.remove(); this.el = null; }
}