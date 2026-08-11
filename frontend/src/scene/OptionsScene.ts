import { type Scene, SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";
import { DEFAULT_KEYBINDINGS, KEYBIND_ACTION_LABELS, loadLocalKeybindings, saveKeybindings, type KeybindAction } from "../core/keybindings";
import { getClientToken } from "../net";

const COLORS = [
  "#ff595e","#ff924c","#ffca3a","#8ac926","#52b788","#1982c4","#6a4c93","#e5383b",
  "#f48c06","#e9c46a","#2a9d8f","#118ab2","#073b4c","#8338ec","#3a86ff","#ff006e"
];

const VOLUME_KEY = "strategio_volumes";
const MUTED_KEY = "strategio_muted";
type Volumes = { music: number; ambience: number; sfx: number };

function loadVolumes(): Volumes {
  const defaults: Volumes = { music: 0.5, ambience: 0.4, sfx: 0.7 };
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* ignore corrupt/blocked storage */ }
  return defaults;
}
function saveVolumes(v: Volumes) {
  try { localStorage.setItem(VOLUME_KEY, JSON.stringify(v)); } catch { /* ignore */ }
}

export class OptionsScene implements Scene {
  private el: HTMLElement | null = null;
  private keydownForRebind: ((e: KeyboardEvent) => void) | null = null;
  constructor(private sm: SceneManager){}
  mount(root: HTMLElement){
    const volumes = loadVolumes();
    const muted = localStorage.getItem(MUTED_KEY) === "1";

    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    wrap.innerHTML = `
      <div class="menu">
        <h1>Options</h1>
        <div class="panel">
          <div class="row" style="gap:12px;align-items:flex-start">
            <div>
              <div>Player color</div>
              <div class="color-pick">${
                COLORS.map(c=>`<div class="color-swatch" data-c="${c}" style="background:${c}"></div>`).join("")
              }</div>
            </div>
          </div>
        </div>
        <div class="panel">
          <label class="row" style="justify-content:space-between"><span>Mute all sound</span><input type="checkbox" id="vol-muted" ${muted ? "checked" : ""} /></label>
          <label class="row" style="justify-content:space-between;margin-top:6px"><span>Music</span><input type="range" id="vol-music" min="0" max="1" step="0.05" value="${volumes.music}" /></label>
          <label class="row" style="justify-content:space-between;margin-top:6px"><span>Ambience</span><input type="range" id="vol-ambience" min="0" max="1" step="0.05" value="${volumes.ambience}" /></label>
          <label class="row" style="justify-content:space-between;margin-top:6px"><span>Sound effects</span><input type="range" id="vol-sfx" min="0" max="1" step="0.05" value="${volumes.sfx}" /></label>
          <small style="opacity:.6">Changes apply next time you're in a game.</small>
        </div>
        <div class="panel" id="keybind-panel">
          <div class="row" style="justify-content:space-between;align-items:center">
            <strong>Keybindings</strong>
            <button class="btn" id="keybind-reset" style="padding:2px 8px">Reset to defaults</button>
          </div>
          <div id="keybind-list" style="margin-top:6px"></div>
          <small style="opacity:.6">Saved locally, and synced to your account if you're logged in — same bindings wherever you play.</small>
        </div>
        <button class="btn" id="back">Back</button>
      </div>
    `;
    wrap.querySelector("#back")!.addEventListener("click", ()=> this.sm.switch(new MenuScene(this.sm)));
    wrap.querySelectorAll<HTMLElement>(".color-swatch").forEach(el=>{
      el.onclick = () => {
        localStorage.setItem("playerColor", el.dataset.c || COLORS[0]);
        el.animate([{transform:"scale(1)"},{transform:"scale(1.2)"},{transform:"scale(1)"}],{duration:200});
      };
    });

    wrap.querySelector<HTMLInputElement>("#vol-muted")!.onchange = (e) => {
      localStorage.setItem(MUTED_KEY, (e.target as HTMLInputElement).checked ? "1" : "0");
    };
    for (const cat of ["music", "ambience", "sfx"] as const) {
      wrap.querySelector<HTMLInputElement>(`#vol-${cat}`)!.oninput = (e) => {
        const v = loadVolumes();
        v[cat] = Number((e.target as HTMLInputElement).value);
        saveVolumes(v);
      };
    }

    let bindings = loadLocalKeybindings();
    let listeningFor: KeybindAction | null = null;
    const listEl = wrap.querySelector("#keybind-list") as HTMLElement;

    const renderKeybindList = () => {
      listEl.innerHTML = (Object.keys(KEYBIND_ACTION_LABELS) as KeybindAction[]).map((action) => `
        <div class="row" style="justify-content:space-between;align-items:center;margin-top:4px">
          <span>${KEYBIND_ACTION_LABELS[action]}</span>
          <button class="btn" data-rebind="${action}" style="min-width:70px">${listeningFor === action ? "Press a key…" : bindings[action]}</button>
        </div>
      `).join("");
      listEl.querySelectorAll<HTMLButtonElement>("[data-rebind]").forEach((btn) => {
        btn.onclick = () => {
          listeningFor = btn.dataset.rebind as KeybindAction;
          renderKeybindList();
        };
      });
    };
    renderKeybindList();

    const keydownForRebind = (e: KeyboardEvent) => {
      if (!listeningFor) return;
      e.preventDefault();
      if (e.key === "Escape") { listeningFor = null; renderKeybindList(); return; } // cancel without changing
      bindings = { ...bindings, [listeningFor]: e.key };
      listeningFor = null;
      renderKeybindList();
      saveKeybindings(getClientToken(), bindings);
    };
    this.keydownForRebind = keydownForRebind;
    window.addEventListener("keydown", keydownForRebind);

    wrap.querySelector("#keybind-reset")!.addEventListener("click", () => {
      bindings = { ...DEFAULT_KEYBINDINGS };
      renderKeybindList();
      saveKeybindings(getClientToken(), bindings);
    });

    root.appendChild(wrap);
    this.el = wrap;
  }
  unmount(){
    this.el?.remove();
    this.el = null;
    if (this.keydownForRebind) { window.removeEventListener("keydown", this.keydownForRebind); this.keydownForRebind = null; }
  }
}
