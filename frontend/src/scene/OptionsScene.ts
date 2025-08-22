import type { Scene } from "./SceneManager";
import { SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";

const COLORS = [
  "#ff595e","#ff924c","#ffca3a","#8ac926","#52b788","#1982c4","#6a4c93","#e5383b",
  "#f48c06","#e9c46a","#2a9d8f","#118ab2","#073b4c","#8338ec","#3a86ff","#ff006e"
];

export class OptionsScene implements Scene {
  private el: HTMLElement | null = null;
  constructor(private sm: SceneManager){}
  mount(root: HTMLElement){
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
    root.appendChild(wrap);
    this.el = wrap;
  }
  unmount(){ this.el?.remove(); this.el = null; }
}
