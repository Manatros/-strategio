// src/scene/TermsScene.ts
// Same caveat as PrivacyPolicyScene: a reasonable starting draft, not legal advice.
import { type Scene, SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";

export class TermsScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager) {}

  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    wrap.style.alignItems = "stretch";
    wrap.innerHTML = `
      <div class="legal-page">
        <h1>Terms of Service</h1>
        <p><em>Last updated: [LAST UPDATED]</em></p>

        <h2>Playing the game</h2>
        <p>Strategio is free to play — every race is available to everyone at no cost. The game is
        funded by donations and, on menu screens only, advertising. Gameplay itself is always
        ad-free.</p>

        <h2>Accounts</h2>
        <p>You're responsible for keeping your account credentials (if you create a username/password
        account) confidential. We reserve the right to reset scores, remove content, or restrict
        access in cases of cheating, abuse, or exploiting bugs in bad faith.</p>

        <h2>Conduct</h2>
        <p>Don't use the game to harass other players, attempt to disrupt the service, or reverse
        engineer the client to gain an unfair advantage over other players.</p>

        <h2>Availability</h2>
        <p>This is an actively developed, independently run game. We don't guarantee uninterrupted
        availability, and features, balance, and content may change at any time.</p>

        <h2>Advertising</h2>
        <p>Ads shown on menu screens are served by Google AdSense and governed by Google's own
        policies. See our <a href="#" id="privacy-link">Privacy Policy</a> for details on cookies and
        opting out.</p>

        <h2>Contact</h2>
        <p>Questions about these terms: [CONTACT EMAIL]</p>

        <button class="btn" id="back" style="margin-top:24px">Back to Menu</button>
      </div>
    `;
    wrap.querySelector("#back")!.addEventListener("click", () => this.sm.switch(new MenuScene(this.sm)));
    wrap.querySelector("#privacy-link")!.addEventListener("click", async (e) => {
      e.preventDefault();
      const { PrivacyPolicyScene } = await import("./PrivacyPolicyScene");
      this.sm.switch(new PrivacyPolicyScene(this.sm));
    });
    root.appendChild(wrap);
    this.el = wrap;
  }
  unmount() { this.el?.remove(); this.el = null; }
}
