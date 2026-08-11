// src/ads/AdSlot.ts
//
// ============================================================================
// SETUP REQUIRED BEFORE ADS WILL ACTUALLY SHOW:
// 1. Sign up for Google AdSense (https://adsense.google.com) with this site's
//    real domain and get it approved — that review is entirely Google's own
//    process and can't be done from here.
// 2. Replace ADSENSE_PUBLISHER_ID below with your real "ca-pub-XXXXXXXXXXXXXXXX".
// 3. Create ad units in your AdSense dashboard and replace the three
//    AD_SLOT_IDS below with their real slot IDs.
// 4. Update the real ads.txt SOURCE file at frontend/public/ads.txt (NOT
//    server/public/ads.txt — that's regenerated build output and gets
//    wiped on every `vite build`) with your real publisher ID. See that
//    file for the exact format Google expects.
// Until all four are done, these slots will render an empty placeholder box
// instead of a real ad, and nothing will break.
// ============================================================================
import { getConsent } from "./ConsentManager";

// Master switch: while false, MenuScene skips creating ad slots and the consent banner entirely —
// nothing is rendered, nothing is requested, no layout space is reserved. Flip to true once you're
// actually ready to start showing ads (after the AdSense setup steps above are done).
export const ADS_ENABLED = false;

const ADSENSE_PUBLISHER_ID = "ca-pub-0000000000000000"; // REPLACE with your real publisher ID
export const AD_SLOT_IDS = {
  menuLeft: "0000000000",   // REPLACE with a real ad unit slot ID
  menuRight: "0000000000",  // REPLACE with a real ad unit slot ID
  menuBanner: "0000000000", // REPLACE with a real ad unit slot ID
};

let scriptLoaded = false;

/** Loads the AdSense script once, only after the person has consented. Safe to call repeatedly. */
function ensureAdSenseScript() {
  if (scriptLoaded || getConsent() !== "accepted") return;
  if (document.querySelector('script[data-adsense-loader="1"]')) { scriptLoaded = true; return; }
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}`;
  script.crossOrigin = "anonymous";
  script.dataset.adsenseLoader = "1";
  document.head.appendChild(script);
  scriptLoaded = true;
}

export type AdSlotFormat = "rail" | "banner"; // rail = vertical (left/right of menu), banner = horizontal (beneath)

/**
 * Creates one ad container. Only actually requests a real ad if the person has consented AND a real
 * slot ID has been configured above — otherwise renders an inert placeholder box so the menu layout
 * still looks right during development, with zero risk of an accidental policy-violating empty-ad-slot
 * request going out to Google before setup is complete.
 */
export function createAdSlot(slotId: string, format: AdSlotFormat): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `ad-slot ad-slot-${format}`;

  const isConfigured = ADSENSE_PUBLISHER_ID !== "ca-pub-0000000000000000" && slotId !== "0000000000";
  const consented = getConsent() === "accepted";

  if (!isConfigured || !consented) {
    wrap.classList.add("ad-slot-placeholder");
    wrap.innerHTML = `<small>${!consented ? "Ad (requires cookie consent)" : "Ad slot — configure AdSense to enable"}</small>`;
    return wrap;
  }

  ensureAdSenseScript();
  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = "block";
  ins.dataset.adClient = ADSENSE_PUBLISHER_ID;
  ins.dataset.adSlot = slotId;
  if (format === "rail") {
    ins.style.width = "160px";
    ins.style.height = "600px";
  } else {
    ins.dataset.adFormat = "auto";
    ins.dataset.fullWidthResponsive = "true";
    wrap.style.minHeight = "90px";
  }
  wrap.appendChild(ins);

  try {
    ((window as any).adsbygoogle = (window as any).adsbygoogle || []).push({});
  } catch { /* AdSense not ready yet or blocked — never let an ad failure affect the game */ }

  return wrap;
}
