import { makeDraggable } from "./draggable";
import type { DebugLogEntry } from "../net";

function appendLine(el: HTMLElement, text: string, color: string, cap: number) {
  const line = document.createElement("div");
  line.style.color = color;
  line.textContent = text;
  el.appendChild(line);
  while (el.children.length > cap) el.removeChild(el.firstChild!);
  el.scrollTop = el.scrollHeight;
}

export type ServerTelemetry = {
  roomId: string; tickCount: number; playerCount: number; buildingCount: number;
  claimCount: number; discoveredTiles: number; memoryMB: number;
};

/**
 * Base panel (FPS + Center) for everyone. Admins additionally get a second
 * panel: live server telemetry, a resource-cheat form, a running log of
 * every message sent/received, and captured console errors/warnings —
 * "everything the client and server are doing," per the design goal.
 */
export function attachHUD(mount: HTMLElement, isAdmin: boolean) {
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `
    <div class="panel" id="debug-basic">
      <div class="row"><strong>Strategio</strong>${isAdmin ? ` <small style="opacity:.7">🛠 ADMIN</small>` : ""}</div>
      <div class="row" id="fps">fps: --</div>
      <div class="row"><button class="btn" id="center">Center</button></div>
    </div>
  `;
  mount.appendChild(hud);

  const basicPanel = hud.querySelector<HTMLElement>("#debug-basic")!;
  makeDraggable(basicPanel, { id: "debug-panel", defaultPos: (el) => ({ x: window.innerWidth / 2 - el.offsetWidth / 2, y: 48 }) });

  let logEl: HTMLElement | null = null;
  let consoleEl: HTMLElement | null = null;
  let serverInfoEl: HTMLElement | null = null;
  let cheatStatusEl: HTMLElement | null = null;

  if (isAdmin) {
    const adminPanel = document.createElement("div");
    adminPanel.className = "panel";
    adminPanel.style.minWidth = "270px";
    adminPanel.style.maxHeight = "75vh";
    adminPanel.style.overflowY = "auto";
    adminPanel.innerHTML = `
      <div><strong>Admin Debug</strong></div>
      <div id="admin-server-info" style="margin-top:6px"><small>Waiting for server telemetry…</small></div>

      <button class="btn" id="reveal-toggle" style="margin-top:8px;width:100%">Reveal Map: OFF</button>

      <div style="margin-top:8px"><small>Cheat resources (bypasses storage cap):</small></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:4px;margin-top:4px">
        <input id="cheat-wood" type="number" placeholder="Wood" class="btn" style="text-align:left" />
        <input id="cheat-stone" type="number" placeholder="Stone" class="btn" style="text-align:left" />
        <input id="cheat-bread" type="number" placeholder="Bread" class="btn" style="text-align:left" />
        <input id="cheat-fish" type="number" placeholder="Fish" class="btn" style="text-align:left" />
        <input id="cheat-gold" type="number" placeholder="Gold" class="btn" style="text-align:left" />
        <button class="btn" id="cheat-apply">Apply</button>
      </div>
      <div id="cheat-status" style="margin-top:4px"></div>

      <div style="margin-top:8px"><small>Message log (live, last 30):</small></div>
      <div id="admin-log" style="margin-top:4px;font-family:monospace;font-size:11px;max-height:170px;overflow-y:auto;background:#0b0906;border-radius:3px;padding:4px"></div>

      <div style="margin-top:8px"><small>Console errors / warnings:</small></div>
      <div id="admin-console" style="margin-top:4px;font-family:monospace;font-size:11px;max-height:110px;overflow-y:auto;background:#2a1010;border-radius:3px;padding:4px"></div>
    `;
    hud.appendChild(adminPanel);
    makeDraggable(adminPanel, { id: "admin-debug-panel", defaultPos: () => ({ x: 320, y: 48 }) });

    logEl = adminPanel.querySelector("#admin-log") as HTMLElement;
    consoleEl = adminPanel.querySelector("#admin-console") as HTMLElement;
    serverInfoEl = adminPanel.querySelector("#admin-server-info") as HTMLElement;
    cheatStatusEl = adminPanel.querySelector("#cheat-status") as HTMLElement;

    // Mirror console.error/warn and uncaught errors into the panel — visible in-game, not just devtools.
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...args: unknown[]) => {
      origError(...args);
      appendLine(consoleEl!, `[ERROR] ${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`, "#ff8080", 50);
    };
    console.warn = (...args: unknown[]) => {
      origWarn(...args);
      appendLine(consoleEl!, `[WARN] ${args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`, "#ffd080", 50);
    };
    window.addEventListener("error", (e) => appendLine(consoleEl!, `[ERROR] ${e.message}`, "#ff8080", 50));
    window.addEventListener("unhandledrejection", (e) => appendLine(consoleEl!, `[ERROR] unhandled: ${String(e.reason)}`, "#ff8080", 50));
  }

  return {
    setFPS(n: number) { hud.querySelector("#fps")!.textContent = "fps: " + n.toFixed(0); },
    onCenter(cb: () => void) { hud.querySelector<HTMLButtonElement>("#center")!.onclick = cb; },
    isAdmin,

    updateServerInfo(info: ServerTelemetry) {
      if (!serverInfoEl) return;
      serverInfoEl.innerHTML = `
        <small>Room: ${info.roomId} · Tick: ${info.tickCount}</small><br/>
        <small>Players: ${info.playerCount} · Buildings: ${info.buildingCount}</small><br/>
        <small>Claims: ${info.claimCount} · Discovered tiles: ${info.discoveredTiles}</small><br/>
        <small>Server memory: ${info.memoryMB} MB</small>
      `;
    },
    appendLog(entry: DebugLogEntry) {
      if (!logEl) return;
      appendLine(logEl, `${entry.dir === "out" ? "→" : "←"} ${entry.type}`, entry.dir === "out" ? "#8ab4ff" : "#8aff9e", 30);
    },
    onCheatApply(cb: (amounts: Record<string, number>) => void) {
      if (!isAdmin) return;
      hud.querySelector<HTMLButtonElement>("#cheat-apply")!.onclick = () => {
        const get = (id: string) => Number((hud.querySelector(`#${id}`) as HTMLInputElement).value) || 0;
        cb({ Wood: get("cheat-wood"), Stone: get("cheat-stone"), Bread: get("cheat-bread"), Fish: get("cheat-fish"), Gold: get("cheat-gold") });
        if (cheatStatusEl) cheatStatusEl.innerHTML = `<small>Applied.</small>`;
      };
    },
    onRevealToggle(cb: (reveal: boolean) => void) {
      if (!isAdmin) return;
      let revealed = false;
      const btn = hud.querySelector<HTMLButtonElement>("#reveal-toggle")!;
      btn.onclick = () => {
        revealed = !revealed;
        btn.textContent = `Reveal Map: ${revealed ? "ON" : "OFF"}`;
        if (revealed) btn.style.outline = "2px solid #fff"; else btn.style.outline = "";
        cb(revealed);
      };
    },
  };
}
