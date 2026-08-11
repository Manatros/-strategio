import { GameScene } from "./GameScene";
import { OptionsScene } from "./OptionsScene";
import { LeaderboardScene } from "./LeaderboardScene";
import { AchievementsScene } from "./AchievementsScene";
import { type Scene, SceneManager } from "./SceneManager";
import { RACES, RACE_DISPLAY, type Race } from "../core/races";
import { getClientToken } from "../net";
import { createAdSlot, AD_SLOT_IDS, ADS_ENABLED } from "../ads/AdSlot";
import { showConsentBannerIfNeeded } from "../ads/ConsentManager";

/** A real identity (Steam or username/password account) vs. the auto-generated anonymous token
 *  every fresh browser gets. Used purely to decide whether to show the login UI or hide it. */
function isSignedIn(): boolean {
  const token = getClientToken();
  return token.startsWith("steam:") || token.startsWith("account:");
}

export class MenuScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager, private steamLogin?: { signedIn: boolean; error: boolean }){}

  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    const canResume = localStorage.getItem("strategio_inGame") === "1"; // a local hint only — verified with the server below before ever showing the button
    const name = localStorage.getItem("playerName") || "";
    const savedRace = (localStorage.getItem("playerRace") as Race) || "Human";
    const signedIn = isSignedIn();

    const statusPanel = signedIn
      ? `<div class="panel" style="margin-top:6px"><small>Signed in — your progress follows this account on any device.</small> <a href="#" id="sign-out" style="opacity:0.7;margin-left:6px">Log out</a></div>`
      : this.steamLogin?.error
        ? `<div class="panel" style="margin-top:6px"><small>Steam sign-in failed — please try again.</small></div>`
        : "";

    const loginSection = signedIn ? "" : `
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
        </div>`;

    wrap.innerHTML = `
      <div class="menu">
        <h1>Strategio</h1>
        <small>Casual hex RTS — drop-in multiplayer</small>
        <input id="name" class="btn" style="text-align:left;cursor:text" placeholder="Your name" value="${name}" maxlength="24" />
        <small id="player-id" style="opacity:0.6"></small>
        ${loginSection}
        ${statusPanel}
        <div style="margin-top:8px"><small>Race:</small></div>
        <div class="grid" id="race-grid" style="grid-template-columns:1fr 1fr"></div>
        <div class="panel" id="race-blurb" style="margin-top:6px"><small>${RACE_DISPLAY[savedRace].blurb}</small></div>
        <div id="resume-slot"></div>
        <button class="btn" id="play">Play</button>
        <div class="grid">
          <button class="btn" id="options">Options</button>
          <button class="btn" id="leaderboard">Leaderboard</button>
        </div>
        <button class="btn" id="achievements" style="margin-top:6px">Achievements</button>
        ${ADS_ENABLED ? `<div id="ad-banner-slot" style="margin-top:10px"></div>` : ""}
        <div style="margin-top:10px;text-align:center"><small style="opacity:.5">
          <a href="#" id="privacy-link" style="color:inherit">Privacy Policy</a> ·
          <a href="#" id="terms-link" style="color:inherit">Terms of Service</a>
        </small></div>
      </div>
    `;

    if (signedIn) {
      wrap.querySelector<HTMLAnchorElement>("#sign-out")!.onclick = (e) => {
        e.preventDefault();
        localStorage.removeItem("strategio_clientToken"); // a fresh anonymous token is generated next time one's needed
        localStorage.removeItem("strategio_inGame");
        this.sm.switch(new MenuScene(this.sm));
      };
    } else {
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
          // everything (Name#tag, the now-signed-in UI, etc.) re-fetches against the new identity.
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
    }

    // Every race is free — no ownership check needed, just pick one.
    let selectedRace: Race = savedRace;
    const raceGrid = wrap.querySelector("#race-grid") as HTMLElement;
    const blurb = wrap.querySelector("#race-blurb") as HTMLElement;

    const renderRaceGrid = () => {
      raceGrid.innerHTML = RACES.map(r => {
        const selected = r === selectedRace;
        return `<button class="btn" data-race="${r}" style="${selected ? "outline:2px solid #fff" : ""}">${RACE_DISPLAY[r].label}</button>`;
      }).join("");
    };
    renderRaceGrid();

    raceGrid.addEventListener("click", (e) => {
      const btn = e.target as HTMLElement;
      const race = btn.dataset.race as Race | undefined;
      if (!race) return;
      selectedRace = race;
      localStorage.setItem("playerRace", race);
      blurb.innerHTML = `<small>${RACE_DISPLAY[race].blurb}</small>`;
      renderRaceGrid();
    });

    // Just for the Name#tag display — nothing here gates race selection anymore.
    fetch(`/races/${getClientToken()}`)
      .then(r => r.json())
      .then((data: { name: string | null; tag: string | null }) => {
        if (data.tag) {
          const idLine = wrap.querySelector("#player-id") as HTMLElement;
          if (idLine) idLine.textContent = `${data.name || name || "Player"}#${data.tag}`;
        }
      })
      .catch(() => { /* server unreachable — just skip the Name#tag display for now */ });

    const saveName = () => {
      const val = wrap.querySelector<HTMLInputElement>("#name")!.value.trim();
      if (val) localStorage.setItem("playerName", val);
    };

    // Only actually show "Resume Game" once the server confirms it's real — the local flag is
    // just a hint that it's worth asking, not proof (the grace period may have expired, or the
    // game may have already ended from another tab/device since this flag was set).
    if (canResume) {
      fetch(`/can-resume/${getClientToken()}`)
        .then(r => r.json())
        .then((data: { canResume: boolean }) => {
          if (!data.canResume) { localStorage.removeItem("strategio_inGame"); return; }
          const slot = wrap.querySelector("#resume-slot") as HTMLElement;
          slot.innerHTML = `<button class="btn" id="resume">Resume Game</button>`;
          wrap.querySelector<HTMLButtonElement>("#resume")!.onclick = () => {
            saveName();
            this.sm.switch(new GameScene(this.sm, "auto"));
          };
          wrap.querySelector<HTMLButtonElement>("#play")!.textContent = "New Game";
        })
        .catch(() => { /* server unreachable — just leave Resume hidden for now */ });
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
    wrap.querySelector<HTMLButtonElement>("#achievements")!.onclick = () => {
      this.sm.switch(new AchievementsScene(this.sm));
    };
    // Ad rails flank the menu content (never shown in-game — GameScene never imports this module).
    // While ADS_ENABLED is false, none of this renders at all — normal single-column menu layout.
    if (ADS_ENABLED) {
      const menuEl = wrap.querySelector(".menu") as HTMLElement;
      const flexWrap = document.createElement("div");
      flexWrap.className = "menu-with-ads";
      menuEl.replaceWith(flexWrap);
      flexWrap.appendChild(createAdSlot(AD_SLOT_IDS.menuLeft, "rail"));
      flexWrap.appendChild(menuEl);
      flexWrap.appendChild(createAdSlot(AD_SLOT_IDS.menuRight, "rail"));

      const bannerSlot = wrap.querySelector("#ad-banner-slot") as HTMLElement;
      bannerSlot.appendChild(createAdSlot(AD_SLOT_IDS.menuBanner, "banner"));
    }

    wrap.querySelector("#privacy-link")!.addEventListener("click", async (e) => {
      e.preventDefault();
      const { PrivacyPolicyScene } = await import("./PrivacyPolicyScene");
      this.sm.switch(new PrivacyPolicyScene(this.sm));
    });
    wrap.querySelector("#terms-link")!.addEventListener("click", async (e) => {
      e.preventDefault();
      const { TermsScene } = await import("./TermsScene");
      this.sm.switch(new TermsScene(this.sm));
    });

    root.appendChild(wrap);
    this.el = wrap;

    if (ADS_ENABLED) {
      showConsentBannerIfNeeded(
        root,
        () => this.sm.switch(new MenuScene(this.sm)), // re-render so ad slots reflect the new consent choice
        async () => { const { PrivacyPolicyScene } = await import("./PrivacyPolicyScene"); this.sm.switch(new PrivacyPolicyScene(this.sm)); }
      );
    }
  }
  unmount(){ this.el?.remove(); this.el = null; }
}
