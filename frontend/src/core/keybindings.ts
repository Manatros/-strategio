// src/core/keybindings.ts
// Adjustable keybindings: defaults matching the game's original hardcoded keys, persisted to
// localStorage immediately (so they work with zero setup and offline), and synced to the server
// keyed by the player's token (see net.ts's getClientToken) — this is what makes them follow an
// account across devices once logged in, since login adopts the account's stable token. Without an
// account, the token is just a random per-browser one, so bindings still save, just locally.

export type KeybindAction =
  | "moveUp" | "moveDown" | "moveLeft" | "moveRight" | "moveUpRight" | "moveDownLeft"
  | "stop" | "diplomacy" | "cycleUnit";

export const KEYBIND_ACTION_LABELS: Record<KeybindAction, string> = {
  moveUp: "Move Up", moveDown: "Move Down", moveLeft: "Move Left", moveRight: "Move Right",
  moveUpRight: "Move Up-Right", moveDownLeft: "Move Down-Left",
  stop: "Stop", diplomacy: "Toggle Diplomacy", cycleUnit: "Cycle Selected Unit",
};

export const DEFAULT_KEYBINDINGS: Record<KeybindAction, string> = {
  moveUp: "w", moveDown: "s", moveLeft: "a", moveRight: "d",
  moveUpRight: "e", moveDownLeft: "q",
  stop: "x", diplomacy: "f", cycleUnit: "Tab",
};

const STORAGE_KEY = "strategio_keybindings";

/** Loads keybindings — starts from defaults, applies any locally-saved overrides. Never fails: a
 *  corrupt or missing localStorage entry just falls back to defaults. */
export function loadLocalKeybindings(): Record<KeybindAction, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_KEYBINDINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_KEYBINDINGS, ...parsed };
  } catch {
    return { ...DEFAULT_KEYBINDINGS };
  }
}

export function saveLocalKeybindings(bindings: Record<KeybindAction, string>) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings)); } catch { /* storage full/unavailable — bindings still work this session */ }
}

/** Pulls server-saved bindings (if any) for this token and merges them in, overwriting local ones
 *  — called once on startup so a returning/logged-in player gets their synced bindings rather than
 *  whatever this specific browser had locally. Silently keeps local bindings if the fetch fails. */
export async function fetchAndMergeServerKeybindings(token: string): Promise<Record<KeybindAction, string>> {
  const local = loadLocalKeybindings();
  try {
    const res = await fetch(`/keybindings/${token}`);
    const json = await res.json();
    if (json.bindings) {
      const merged = { ...DEFAULT_KEYBINDINGS, ...json.bindings };
      saveLocalKeybindings(merged);
      return merged;
    }
  } catch { /* offline or server unreachable — local bindings are still valid */ }
  return local;
}

export async function saveKeybindings(token: string, bindings: Record<KeybindAction, string>) {
  saveLocalKeybindings(bindings); // always save locally first, immediately, regardless of network
  try {
    await fetch(`/keybindings/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bindings }),
    });
  } catch { /* offline — local save above still succeeded, will sync next time the server's reachable */ }
}
