// src/scene/PrivacyPolicyScene.ts
//
// This is a reasonable starting draft covering the standard disclosures
// Google AdSense requires (cookies, third-party ad personalization, opt-out
// info) plus what this game itself actually collects. It is NOT legal
// advice — have an actual lawyer review it before relying on it,
// especially if you'll have EEA/UK users (GDPR) or expect meaningful
// traffic from California (CCPA) or elsewhere with its own privacy law.
// Replace the [CONTACT EMAIL] and [LAST UPDATED] placeholders before publishing.
import { type Scene, SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";

export class PrivacyPolicyScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager) {}

  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    wrap.style.alignItems = "stretch";
    wrap.innerHTML = `
      <div class="legal-page">
        <h1>Privacy Policy</h1>
        <p><em>Last updated: [LAST UPDATED]</em></p>

        <h2>What this covers</h2>
        <p>This policy explains what information Strategio ("the game," "we") collects when you play,
        and how cookies are used — including by Google, to show ads on the menu screens. Ads never
        appear during actual gameplay.</p>

        <h2>Account &amp; gameplay data</h2>
        <p>If you create an account or sign in with Steam, we store your chosen display name, a
        randomly generated tag, your best score, games played, and in-game statistics (resources
        gathered, buildings built, units trained, and similar). If you create a username/password
        account, your password is stored only as a salted, irreversible hash — we never store or
        have access to your actual password.</p>

        <h2>Cookies &amp; local storage</h2>
        <p>We use your browser's local storage to remember your identity token, display name, and
        preferences (like volume settings) between visits. This is functionally necessary for the
        game to work and isn't used for advertising by us directly.</p>

        <h2>Advertising cookies (Google AdSense)</h2>
        <p>On menu screens only, we show ads served by Google AdSense. Google and its advertising
        partners use cookies to serve ads based on your prior visits to this or other websites. You
        can opt out of personalized advertising by visiting
        <a href="https://adssettings.google.com" target="_blank" rel="noopener">Google's Ads Settings</a>,
        or by visiting <a href="https://www.aboutads.info" target="_blank" rel="noopener">aboutads.info</a>
        to opt out of participating vendors generally. We only load these cookies after you accept
        the cookie consent banner — declining means no ad cookies are set.</p>

        <h2>Third-party services</h2>
        <p>If you choose to sign in with Steam, that authentication is handled directly by Valve;
        see <a href="https://store.steampowered.com/privacy_agreement" target="_blank" rel="noopener">Steam's own privacy policy</a>
        for how they handle your data. Google's use of advertising data is governed by
        <a href="https://policies.google.com/technologies/partner-sites" target="_blank" rel="noopener">Google's Partner Sites policy</a>.</p>

        <h2>Children's privacy</h2>
        <p>This game is not directed at children under 13, and we do not knowingly collect personal
        information from children under 13.</p>

        <h2>Your choices</h2>
        <p>You can decline ad cookies at any time via the consent banner, clear your browser's local
        storage to remove your locally-stored identity token, and opt out of Google's ad
        personalization via the links above.</p>

        <h2>Contact</h2>
        <p>Questions about this policy: [CONTACT EMAIL]</p>

        <button class="btn" id="back" style="margin-top:24px">Back to Menu</button>
      </div>
    `;
    wrap.querySelector("#back")!.addEventListener("click", () => this.sm.switch(new MenuScene(this.sm)));
    root.appendChild(wrap);
    this.el = wrap;
  }
  unmount() { this.el?.remove(); this.el = null; }
}
