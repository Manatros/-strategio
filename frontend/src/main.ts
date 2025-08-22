import { SceneManager } from "./scene/SceneManager";
import { MenuScene } from "./scene/MenuScene";

(async function run() {
  const root = document.getElementById("app")!;
  const sm = new SceneManager(root);
  await sm.switch(new MenuScene(sm));
})();
