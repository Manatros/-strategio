import { type Scene, SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";
import { GameScene } from "./GameScene";

export type WinInfo = { youWon: boolean; winnerName: string; winnerRace: string; reason: string; bonus: number };

export class GameOverScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager, private finalScore: number, private reason: string, private winInfo?: WinInfo) {}

  mount(root: HTMLElement) {
    localStorage.removeItem("strategio_inGame"); // the game ending (win or loss) always closes the resumable session

    const wrap = document.createElement("div");
    wrap.className = "menu-root";

    let headline: string;
    let bonusLine = "";
    if (this.winInfo) {
      if (this.winInfo.youWon) {
        headline = "Victory by Domination!";
        bonusLine = `<div class="row" style="justify-content:center;margin-top:4px"><small>+${Math.round(this.winInfo.bonus)} bonus for winning</small></div>`;
      } else {
        headline = `${this.winInfo.winnerName} (${this.winInfo.winnerRace}) achieved Domination Victory.`;
      }
    } else {
      headline = this.reason === "killed" ? "You were defeated."
        : this.reason === "surrendered" ? "You surrendered."
        : this.reason === "no_townhalls_remaining" ? "Your last TownHall fell."
        : "Game over.";
    }

    wrap.innerHTML = `
      <div class="menu">
        <h1>${headline}</h1>
        <div class="panel">
          <div class="row" style="justify-content:center"><strong>Final score: ${Math.round(this.finalScore)}</strong></div>
          ${bonusLine}
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
