// Steam login via OpenID 2.0 — the lightweight "Sign in through Steam"
// flow, not the full Steamworks SDK. No App ID or Steam Direct fee needed;
// this works from any website. What you get back is just a permanent,
// verified SteamID64 — nothing else (no email, no friends list).
//
// Flow: browser -> GET /auth/steam -> redirect to Steam -> user logs in ->
// Steam redirects to GET /auth/steam/return -> we verify with Steam's
// servers -> redirect back to the game with ?steamToken=steam:<id64>.
// The client stores that as its clientToken, replacing the random
// localStorage one, so every existing token-based system (resume,
// entitlements, highscores) works unchanged — Steam login is just a way
// to get a *stable, cross-device* token instead of a random per-browser one.
//
// OpenID alone only proves *identity*, not a username — Steam's OpenID
// response contains nothing but the SteamID64. To actually show their real
// Steam display name we make a second, separate call to Steam's Web API
// (ISteamUser/GetPlayerSummaries), which needs its own API key — free,
// obtained at https://steamcommunity.com/dev/apikey, set as STEAM_WEB_API_KEY.
// Without that key configured, sign-in still works fine, it just can't
// pull the username — falls back to whatever name the player already has.
import openidPkg from "openid";
const { RelyingParty } = openidPkg;
import { upsertIdentity } from "../persist/store.js";
import { log } from "../utils/logger.js";

const STEAM_OPENID_PROVIDER = "https://steamcommunity.com/openid";
const CLAIMED_ID_RE = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/;

function relyingPartyFor(req) {
  const origin = `${req.protocol}://${req.get("host")}`;
  return new RelyingParty(`${origin}/auth/steam/return`, `${origin}/`, true, true, []);
}

/** Best-effort: returns the player's current Steam display name, or null if unavailable/not configured. */
async function fetchSteamPersonaName(steamId64) {
  const apiKey = process.env.STEAM_WEB_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=${apiKey}&steamids=${steamId64}`;
    const res = await fetch(url);
    if (!res.ok) { log(`[steam-auth] GetPlayerSummaries HTTP ${res.status}`); return null; }
    const data = await res.json();
    const name = data?.response?.players?.[0]?.personaname;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch (err) {
    log(`[steam-auth] GetPlayerSummaries failed: ${err.message}`);
    return null;
  }
}

export function redirectToSteamLogin(req, res) {
  relyingPartyFor(req).authenticate(STEAM_OPENID_PROVIDER, false, (err, authUrl) => {
    if (err || !authUrl) {
      log(`[steam-auth] failed to build auth URL: ${err?.message || "no url returned"}`);
      return res.redirect("/?steamError=1");
    }
    res.redirect(authUrl);
  });
}

export function handleSteamReturn(req, res) {
  relyingPartyFor(req).verifyAssertion(req, async (err, result) => {
    if (err || !result?.authenticated) {
      log(`[steam-auth] verification failed: ${err?.message || "not authenticated"}`);
      return res.redirect("/?steamError=1");
    }
    const match = CLAIMED_ID_RE.exec(result.claimedIdentifier || "");
    if (!match) {
      log(`[steam-auth] unexpected claimed identifier: ${result.claimedIdentifier}`);
      return res.redirect("/?steamError=1");
    }
    const steamId64 = match[1];
    const token = `steam:${steamId64}`;
    const personaName = await fetchSteamPersonaName(steamId64);

    upsertIdentity(token, { name: personaName ?? undefined });
    log(`[steam-auth] signed in: ${steamId64}${personaName ? ` (${personaName})` : ""}`);

    const params = new URLSearchParams({ steamToken: token });
    if (personaName) params.set("steamName", personaName);
    res.redirect(`/?${params}`);
  });
}
