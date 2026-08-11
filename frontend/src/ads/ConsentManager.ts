// src/ads/ConsentManager.ts
//
// Google AdSense's EU User Consent Policy requires publishers to get
// consent before loading ads (or at minimum, before loading personalized
// ads) for users in the EEA/UK, and general best practice extends this
// everywhere. This is a minimal, honest implementation: nothing ad-related
// loads until the person has explicitly accepted or declined.
//
// This does NOT replace a certified CMP for EEA/UK traffic — Google's own
// policy (as of this writing) expects publishers serving that audience to
// use a Google-certified Consent Management Platform. For a small
// solo-developer project, this basic banner is a reasonable starting
// point, but check Google's current EU User Consent Policy before
// launching ads to EEA/UK users specifically, since that requirement is
// stricter than what's implemented here.
const CONSENT_KEY = "strategio_ad_consent"; // "accepted" | "declined"

export function getConsent(): "accepted" | "declined" | null {
  const v = localStorage.getItem(CONSENT_KEY);
  return v === "accepted" || v === "declined" ? v : null;
}

export function setConsent(value: "accepted" | "declined") {
  localStorage.setItem(CONSENT_KEY, value);
}

/** Shows a one-time consent banner if the person hasn't answered yet. No-op if they already have. */
export function showConsentBannerIfNeeded(
  root: HTMLElement,
  onDecision: (accepted: boolean) => void,
  onPrivacyClick: () => void
) {
  if (getConsent() !== null) return;

  const banner = document.createElement("div");
  banner.id = "consent-banner";
  banner.style.cssText = `
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 200;
    background: #14100c; border-top: 1px solid #3a2f22; color: #e8dfce;
    padding: 14px 18px; display: flex; gap: 16px; align-items: center;
    flex-wrap: wrap; font-size: 13px; box-shadow: 0 -4px 12px rgba(0,0,0,.5);
  `;
  banner.innerHTML = `
    <span style="flex:1;min-width:220px">
      We use cookies to show ads on the menu screens (never in-game) and to keep the game itself
      running. See our <a href="#" id="consent-privacy-link" style="color:#ffcc66">Privacy Policy</a>.
    </span>
    <button class="btn" id="consent-decline" style="min-width:90px">Decline</button>
    <button class="btn" id="consent-accept" style="min-width:90px">Accept</button>
  `;
  root.appendChild(banner);

  const cleanup = () => banner.remove();
  banner.querySelector<HTMLButtonElement>("#consent-accept")!.onclick = () => {
    setConsent("accepted");
    cleanup();
    onDecision(true);
  };
  banner.querySelector<HTMLButtonElement>("#consent-decline")!.onclick = () => {
    setConsent("declined");
    cleanup();
    onDecision(false);
  };
  banner.querySelector<HTMLAnchorElement>("#consent-privacy-link")!.onclick = (e) => {
    e.preventDefault();
    onPrivacyClick();
  };
}
