export function attachHUD(mount: HTMLElement) {
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `
    <div class="panel">
      <div class="row"><strong>Strategio</strong></div>
      <div class="row" id="fps">fps: --</div>
      <div class="row"><button class="btn" id="center">Center</button></div>
    </div>
    <div class="panel">
      <div class="minimap"></div>
    </div>
  `;
  mount.appendChild(hud);
  return {
    setFPS(n:number){ hud.querySelector("#fps")!.textContent = "fps: " + n.toFixed(0); },
    onCenter(cb:()=>void){ hud.querySelector<HTMLButtonElement>("#center")!.onclick = cb; }
  };
}
