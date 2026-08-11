import { type Scene, SceneManager } from "./SceneManager";
import { MenuScene } from "./MenuScene";
import { fetchAchievements, getClientToken, type Achievement } from "../net";

const CATEGORY_LABEL: Record<string, string> = { combat: "Combat", economy: "Economy", trophy: "Race Trophies" };
const CATEGORY_ORDER = ["combat", "economy", "trophy"];

export class AchievementsScene implements Scene {
  private el: HTMLElement | null = null;

  constructor(private sm: SceneManager) {}

  mount(root: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "menu-root";
    wrap.innerHTML = `
      <div class="menu" style="min-width:440px">
        <h1>Achievements</h1>
        <div class="panel" id="list"><small>Loading…</small></div>
        <button class="btn" id="back" style="margin-top:8px">Back</button>
      </div>
    `;
    wrap.querySelector("#back")!.addEventListener("click", () => this.sm.switch(new MenuScene(this.sm)));
    root.appendChild(wrap);
    this.el = wrap;
    this.load();
  }

  private async load() {
    const listEl = this.el?.querySelector("#list") as HTMLElement;
    try {
      const { achievements, unlocked } = await fetchAchievements(getClientToken());
      if (!this.el) return; // scene switched away before the fetch resolved
      const unlockedSet = new Set(unlocked);
      const unlockedCount = achievements.filter(a => unlockedSet.has(a.id)).length;

      const byCategory = new Map<string, Achievement[]>();
      for (const a of achievements) {
        const list = byCategory.get(a.category) ?? [];
        list.push(a);
        byCategory.set(a.category, list);
      }

      const sections = CATEGORY_ORDER.filter(c => byCategory.has(c)).map(cat => {
        const items = byCategory.get(cat)!.map(a => {
          const got = unlockedSet.has(a.id);
          return `
            <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid #222;opacity:${got ? "1" : "0.5"}">
              <span style="font-size:20px">${got ? "🏆" : "🔒"}</span>
              <div style="flex:1">
                <div><strong>${a.name}</strong>${got ? "" : " <small>(locked)</small>"}</div>
                <small>${a.description}</small>
              </div>
            </div>
          `;
        }).join("");
        return `<div style="margin-top:10px"><strong>${CATEGORY_LABEL[cat] ?? cat}</strong>${items}</div>`;
      }).join("");

      listEl.innerHTML = `<div><small>${unlockedCount} / ${achievements.length} unlocked</small></div>${sections}`;
    } catch {
      if (this.el) listEl.innerHTML = `<small>Couldn't load achievements — check your connection and try again.</small>`;
    }
  }

  unmount() {
    this.el?.remove();
    this.el = null;
  }
}
