import { GameScene } from "./GameScene";
import { OptionsScene } from "./OptionsScene";
import { LeaderboardScene } from "./LeaderboardScene";
import { type Scene, SceneManager } from "./SceneManager";
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
      ? `<div class="panel" style="margin-top:6px"><small>Signed in — your progress now follows this account on any device.</small></div>`
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
        <button class="btn" id="account-toggle">Log In / Create Account</button>
        <div class="panel" id="account-form" style="display:none;margin-top:6px">
          <input id="acc-username" class="btn" style="text-align:left;cursor:text;width:100%;box-sizing:border-box" placeholder="Username" maxlength="24" />
          <input id="acc-password" type="password" class="btn" style="text-align:left;cursor:text;width:100%;box-sizing:border-box;margin-top:6px" placeholder="Password (min 8 characters)" />
          <div class="row" style="margin-top:6px;gap:6px">
            <button class="btn" id="acc-login" style="flex:1">Log In</button>
            <button class="btn" id="acc-register" style="flex:1">Create Account</button>
          </div>
          <div id="acc-status" style="margin-top:4px"></div>
        </div>
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

    const accForm = wrap.querySelector("#account-form") as HTMLElement;
    const accStatus = wrap.querySelector("#acc-status") as HTMLElement;
    wrap.querySelector<HTMLButtonElement>("#account-toggle")!.onclick = () => {
      accForm.style.display = accForm.style.display === "none" ? "block" : "none";
    };

    const submitAccount = async (endpoint: "login" | "register") => {
      const username = (wrap.querySelector("#acc-username") as HTMLInputElement).value.trim();
      const password = (wrap.querySelector("#acc-password") as HTMLInputElement).value;
      accStatus.innerHTML = `<small>Working…</small>`;
      try {
        const res = await fetch(`/auth/${endpoint}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const data = await res.json();
        if (!res.ok) {
          const messages: Record<string, string> = {
            invalid_username: "Username must be 3-24 characters (letters, numbers, underscore).",
            password_too_short: "Password must be at least 8 characters.",
            username_taken: "That username is already taken.",
            invalid_credentials: "Incorrect username or password.",
            too_many_attempts: "Too many attempts — please wait a few minutes.",
          };
          accStatus.innerHTML = `<small>${messages[data.error] || "Something went wrong."}</small>`;
          return;
        }
        // Adopt the returned token exactly like Steam login does, then refresh the menu so
        // everything (race ownership, Name#tag) re-fetches against the new identity.
        localStorage.setItem("strategio_clientToken", data.token);
        localStorage.removeItem("strategio_inGame");
        if (data.name) localStorage.setItem("playerName", data.name);
        this.sm.switch(new MenuScene(this.sm, { signedIn: true, error: false }));
      } catch {
        accStatus.innerHTML = `<small>Couldn't reach the server — please try again.</small>`;
      }
    };
    wrap.querySelector<HTMLButtonElement>("#acc-login")!.onclick = () => submitAccount("login");
    wrap.querySelector<HTMLButtonElement>("#acc-register")!.onclick = () => submitAccount("register");

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