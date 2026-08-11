// src/ui/TutorialOverlay.ts
// A dismissible, step-by-step guide shown once per player on their first game (tracked via
// localStorage), with a way to re-open it manually later. Deliberately simple: fixed steps
// advanced by a Next button, not a fully game-state-reactive wizard — a lightweight, working guide
// beats an elaborate one that's only half-built.

export type TutorialStep = { title: string; body: string };

const STEPS: TutorialStep[] = [
  {
    title: "Welcome to Strategio",
    body: "Left-click selects units and buildings. Right-click acts on whatever's selected — move, attack, or assign a worker. Left-drag on empty ground box-selects multiple units; right-drag pans the map.",
  },
  {
    title: "Found your town",
    body: "You start with a Settler. Walk it somewhere with good nearby resources (forest, fields, stone, or water), then place your TownHall there from the build menu.",
  },
  {
    title: "Start gathering",
    body: "Build a Lumberjack, Farm, Mine, or FishingBoat on matching terrain near your TownHall. Idle Civilians will automatically walk over and start working once it's built.",
  },
  {
    title: "Grow your population",
    body: "Build a House to get more Civilians. Select any building to see its worker count and inventory — you can manually assign or unassign a worker from there too.",
  },
  {
    title: "Roads matter",
    body: "Civilians can only travel between buildings that are connected by road (or sit directly next to your TownHall/Warehouse). New buildings lay their first connection automatically — extend the network yourself to reach farther out.",
  },
  {
    title: "Defend and expand",
    body: "Train Soldiers and Archers at a Garrison to defend your town. Explore outward to claim more territory, and keep an eye on the diplomacy panel for other players nearby.",
  },
];

export class TutorialOverlay {
  private root: HTMLElement;
  private stepIndex = 0;

  constructor(private mount: HTMLElement, private onClose: () => void) {
    this.root = document.createElement("div");
    this.root.style.position = "fixed";
    this.root.style.inset = "0";
    this.root.style.background = "rgba(0,0,0,0.55)";
    this.root.style.zIndex = "500";
    this.root.style.display = "flex";
    this.root.style.alignItems = "center";
    this.root.style.justifyContent = "center";
    mount.appendChild(this.root);
    this.render();
  }

  private render() {
    const step = STEPS[this.stepIndex];
    const isLast = this.stepIndex === STEPS.length - 1;
    this.root.innerHTML = "";

    const card = document.createElement("div");
    card.className = "panel";
    card.style.maxWidth = "360px";
    card.style.padding = "16px";
    card.innerHTML = `
      <div><small style="opacity:0.6">Step ${this.stepIndex + 1} / ${STEPS.length}</small></div>
      <div style="margin-top:6px"><strong>${step.title}</strong></div>
      <div style="margin-top:8px">${step.body}</div>
    `;

    const row = document.createElement("div");
    row.className = "row";
    row.style.gap = "6px";
    row.style.marginTop = "14px";

    const skipBtn = document.createElement("button");
    skipBtn.className = "btn";
    skipBtn.textContent = "Skip";
    skipBtn.onclick = () => this.close();
    row.appendChild(skipBtn);

    const spacer = document.createElement("div");
    spacer.style.flex = "1";
    row.appendChild(spacer);

    if (this.stepIndex > 0) {
      const backBtn = document.createElement("button");
      backBtn.className = "btn";
      backBtn.textContent = "Back";
      backBtn.onclick = () => { this.stepIndex--; this.render(); };
      row.appendChild(backBtn);
    }

    const nextBtn = document.createElement("button");
    nextBtn.className = "btn";
    nextBtn.textContent = isLast ? "Done" : "Next";
    nextBtn.onclick = () => {
      if (isLast) { this.close(); return; }
      this.stepIndex++;
      this.render();
    };
    row.appendChild(nextBtn);

    card.appendChild(row);
    this.root.appendChild(card);
  }

  private close() {
    localStorage.setItem("strategio_tutorial_seen", "1");
    this.root.remove();
    this.onClose();
  }
}

/** Whether the tutorial should show automatically — only ever true once, the very first time a
 *  player reaches the game, unless they explicitly re-open it (see the Options screen link). */
export function shouldShowTutorialAutomatically(): boolean {
  return localStorage.getItem("strategio_tutorial_seen") !== "1";
}
