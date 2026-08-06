import type { Scene } from "./SceneManager";
import { GameScene } from "./GameScene";
import { OptionsScene } from "./OptionsScene";
import { LeaderboardScene } from "./LeaderboardScene";
import { SceneManager } from "./SceneManager";
import { RACES, RACE_DISPLAY, type Race } from "../core/races";
import { getClientToken } from "../net";

const RACE_PRICE_EUR = 2; // matches the server's per-race entitlement gate — display only, not authoritative

export class MenuScene implements Scene {
  private el: HTMLElement | null = null;
  private ownedRaces: Race[] = ["Human"]; // safe default until the real list arrives
  constructor(private sm: SceneManager, private steamLogin?: { signedIn: boolean; error: boolean }){}

  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    const canResume = localStorage.getItem("strategio_inGame") === "1";
    const name = localStorage.getItem("playerName") || "";
    const savedRace = (localStorage.getItem("playerRace") as Race) || "Human";

    const steamStatus = this.steamLogin?.signedIn
      ? `<div class="panel" style="margin-top:6px"><small>Signed in with Steam — your progress now follows this Steam account on any device.</small></div>`
      : this.steamLogin?.error
        ? `<div class="panel" style="margin-top:6px"><small>Steam sign-in failed — please try again.</small></div>`
        : "";

    wrap.innerHTML = `
      <div class="menu">
        <h1>Strategio</h1>
        <small>Casual hex RTS — drop-in multiplayer</small>
        <input id="name" class="btn" style="text-align:left;cursor:text" placeholder="Your name" value="${name}" maxlength="24" />
        <small id="player-id" style="opacity:0.6"></small>
        <button class="btn" id="steam-login">Sign in with Steam</button>
        ${steamStatus}
        <div style="margin-top:8px"><small>Race:</small></div>
        <div class="grid" id="race-grid" style="grid-template-columns:1fr 1fr"><small>Checking your unlocked races…</small></div>
        <div class="panel" id="race-blurb" style="margin-top:6px"><small>${RACE_DISPLAY[savedRace].blurb}</small></div>
        ${canResume ? `<button class="btn" id="resume">Resume Game</button>` : ``}
        <button class="btn" id="play">${canResume ? "New Game" : "Play"}</button>
        <div class="grid">
          <button class="btn" id="options">Options</button>
          <button class="btn" id="leaderboard">Leaderboard</button>
        </div>
      </div>
    `;

    wrap.querySelector<HTMLButtonElement>("#steam-login")!.onclick = () => {
      // Full page navigation, not fetch — Steam's login page can't be opened inside an iframe/XHR.
      window.location.href = "/auth/steam";
    };

    let selectedRace: Race = this.ownedRaces.includes(savedRace) ? savedRace : "Human";
    const raceGrid = wrap.querySelector("#race-grid") as HTMLElement;
    const blurb = wrap.querySelector("#race-blurb") as HTMLElement;

    const renderRaceGrid = () => {
      raceGrid.innerHTML = RACES.map(r => {
        const owned = this.ownedRaces.includes(r);
        const selected = r === selectedRace;
        const label = owned ? RACE_DISPLAY[r].label : `${RACE_DISPLAY[r].label} 🔒 €${RACE_PRICE_EUR}`;
        return `<button class="btn" data-race="${r}" style="${selected ? "outline:2px solid #fff" : ""}${owned ? "" : ";opacity:0.6"}">${label}</button>`;
      }).join("");
    };
    renderRaceGrid();

    raceGrid.addEventListener("click", (e) => {
      const btn = e.target as HTMLElement;
      const race = btn.dataset.race as Race | undefined;
      if (!race) return;
      if (!this.ownedRaces.includes(race)) {
        blurb.innerHTML = `<small>${RACE_DISPLAY[race].label} isn't unlocked yet (€${RACE_PRICE_EUR}). Purchases aren't wired up in this build.</small>`;
        return;
      }
      selectedRace = race;
      localStorage.setItem("playerRace", race);
      blurb.innerHTML = `<small>${RACE_DISPLAY[race].blurb}</small>`;
      renderRaceGrid();
    });

    // Fetch what this identity actually owns (and its Name#tag) before letting them pick a locked race.
    fetch(`/races/${getClientToken()}`)
      .then(r => r.json())
      .then((data: { ownedRaces: Race[]; name: string | null; tag: string | null }) => {
        this.ownedRaces = data.ownedRaces?.length ? data.ownedRaces : ["Human"];
        if (!this.ownedRaces.includes(selectedRace)) selectedRace = "Human";
        renderRaceGrid();
        if (data.tag) {
          const idLine = wrap.querySelector("#player-id") as HTMLElement;
          if (idLine) idLine.textContent = `${data.name || name || "Player"}#${data.tag}`;
        }
      })
      .catch(() => { /* server unreachable — stick with the safe Human-only default */ });

    const saveName = () => {
      const val = wrap.querySelector<HTMLInputElement>("#name")!.value.trim();
      if (val) localStorage.setItem("playerName", val);
    };

    if (canResume) {
      wrap.querySelector<HTMLButtonElement>("#resume")!.onclick = () => {
        saveName();
        this.sm.switch(new GameScene(this.sm, "auto"));
      };
    }
    wrap.querySelector<HTMLButtonElement>("#play")!.onclick = () => {
      saveName();
      this.sm.switch(new GameScene(this.sm, "new"));
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