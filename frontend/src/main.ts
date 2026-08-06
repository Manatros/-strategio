import { SceneManager } from "./scene/SceneManager";
import { MenuScene } from "./scene/MenuScene";
import { consumeSteamLoginFromUrl } from "./net";

(async function run() {
  const steamLogin = consumeSteamLoginFromUrl();
  const root = document.getElementById("app")!;
  const sm = new SceneManager(root);
  await sm.switch(new MenuScene(sm, steamLogin));
})();