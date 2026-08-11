// src/ui/InGameMenu.ts
// A dismissible in-game overlay with Resume/Surrender/Leaderboard — deliberately never switches
// scenes away from GameScene (unlike OptionsScene/LeaderboardScene's own "Back" buttons, which
// hardcode a return to MenuScene). Switching away mid-game would abandon the live session, so this
// shows leaderboard data inline instead of navigating to it.

import { fetchHighscores, type Highscore } from "../net";

export class InGameMenu {
  private root: HTMLElement;
  private view: "menu" | "leaderboard" | "confirm-surrender" = "menu";

  constructor(private mount: HTMLElement, private onSurrender: () => void) {
    this.root = document.createElement("div");
    this.root.style.position = "fixed";
    this.root.style.inset = "0";
    this.root.style.background = "rgba(0,0,0,0.55)";
    this.root.style.zIndex = "500";
    this.root.style.display = "flex";
    this.root.style.alignItems = "center";
    this.root.style.justifyContent = "center";
    mount.appendChild(this.root);
    this.render();
  }

  private render() {
    this.root.innerHTML = "";
    const card = document.createElement("div");
    card.className = "panel";
    card.style.minWidth = "280px";
    card.style.maxWidth = "380px";
    card.style.padding = "16px";

    if (this.view === "menu") {
      card.innerHTML = `<div style="margin-bottom:10px"><strong>Menu</strong></div>`;
      const resumeBtn = this.makeButton("Resume", () => this.close());
      const leaderboardBtn = this.makeButton("Leaderboard", () => { this.view = "leaderboard"; this.render(); this.loadLeaderboard(card); });
      const surrenderBtn = this.makeButton("Surrender", () => { this.view = "confirm-surrender"; this.render(); });
      card.append(resumeBtn, leaderboardBtn, surrenderBtn);
    } else if (this.view === "confirm-surrender") {
      card.innerHTML = `<div style="margin-bottom:10px"><strong>Surrender?</strong></div><div style="margin-bottom:10px"><small>Your current score will be saved, and this game will end for you.</small></div>`;
      const confirmBtn = this.makeButton("Yes, surrender", () => this.onSurrender());
      const cancelBtn = this.makeButton("Cancel", () => { this.view = "menu"; this.render(); });
      card.append(confirmBtn, cancelBtn);
    } else {
      card.innerHTML = `<div style="margin-bottom:10px"><strong>Leaderboard</strong></div><div id="lb-body"><small>Loading…</small></div>`;
      const backBtn = this.makeButton("Back", () => { this.view = "menu"; this.render(); });
      card.appendChild(backBtn);
    }

    this.root.appendChild(card);
  }

  private makeButton(label: string, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = label;
    btn.style.display = "block";
    btn.style.width = "100%";
    btn.style.marginTop = "6px";
    btn.onclick = onClick;
    return btn;
  }

  private async loadLeaderboard(card: HTMLElement) {
    try {
      const highscores = await fetchHighscores("best");
      if (this.view !== "leaderboard") return; // menu moved on before the fetch resolved
      const bodyEl = card.querySelector("#lb-body") as HTMLElement;
      if (!bodyEl) return;
      bodyEl.innerHTML = highscores.slice(0, 10).map((s: Highscore, i: number) => {
        const nameTag = s.tag ? `${escapeHtml(s.name)}<small style="opacity:0.6">#${s.tag}</small>` : escapeHtml(s.name);
        return `<div class="row" style="justify-content:space-between"><span>${i + 1}. ${nameTag}</span><strong>${Math.round(s.bestScore)}</strong></div>`;
      }).join("") || `<small>No scores yet.</small>`;
    } catch {
      const bodyEl = card.querySelector("#lb-body") as HTMLElement;
      if (bodyEl) bodyEl.innerHTML = `<small>Couldn't load the leaderboard.</small>`;
    }
  }

  close() {
    this.root.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
