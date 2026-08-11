// src/audio/SoundManager.ts
//
// Every sound is entirely optional, same philosophy as tile/building
// textures: if a file exists at the expected path, it plays; if not,
// nothing happens and nothing breaks. To add sounds, drop files into
// frontend/public/sounds/ using these paths:
//
//   /sounds/music/<name>.mp3        — looping background music tracks
//   /sounds/ambience/<name>.mp3     — looping ambient soundscapes (wind, birds, etc.)
//   /sounds/sfx/<name>.mp3          — one-shot effects, e.g.:
//       build_place.mp3, build_complete.mp3, train_complete.mp3,
//       attack_soldier.mp3, attack_archer.mp3, unit_death.mp3,
//       building_destroyed.mp3, research_unlocked.mp3, achievement.mp3,
//       war_declared.mp3, resource_capped.mp3, click.mp3
//
// Browsers block audio from playing before the user has interacted with
// the page at all — that's not a bug here, it's a platform rule. Since
// this only ever gets constructed after the player clicks "Play" in the
// menu, that requirement is already satisfied by the time it's used.
export type SoundCategory = "music" | "ambience" | "sfx";

const VOLUME_KEY = "strategio_volumes";
const MUTED_KEY = "strategio_muted";

function loadVolumes(): Record<SoundCategory, number> {
  const defaults: Record<SoundCategory, number> = { music: 0.5, ambience: 0.4, sfx: 0.7 };
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw) return { ...defaults, ...JSON.parse(raw) };
  } catch { /* ignore corrupt/blocked storage */ }
  return defaults;
}

export class SoundManager {
  volumes: Record<SoundCategory, number> = loadVolumes();
  muted = localStorage.getItem(MUTED_KEY) === "1";

  private musicEl: HTMLAudioElement | null = null;
  private ambienceEl: HTMLAudioElement | null = null;
  private currentMusic: string | null = null;
  private currentAmbience: string | null = null;
  private sfxCooldowns = new Map<string, number>(); // avoid the same sfx spamming when many things happen in one tick

  /** One-shot effect — fire-and-forget, never throws, never blocks gameplay if the file is missing. */
  playSfx(name: string) {
    if (this.muted || this.volumes.sfx <= 0) return;
    const now = performance.now();
    const last = this.sfxCooldowns.get(name) ?? 0;
    if (now - last < 80) return; // same effect firing many times in one instant (e.g. AoE) collapses to one play
    this.sfxCooldowns.set(name, now);

    const audio = new Audio(`/sounds/sfx/${name}.mp3`);
    audio.volume = this.volumes.sfx;
    audio.play().catch(() => { /* file missing, or a stricter autoplay policy -- silently ignore either way */ });
  }

  setMusic(name: string | null) {
    if (this.currentMusic === name) return;
    this.currentMusic = name;
    this.musicEl?.pause();
    this.musicEl = null;
    if (!name) return;
    const audio = new Audio(`/sounds/music/${name}.mp3`);
    audio.loop = true;
    audio.volume = this.muted ? 0 : this.volumes.music;
    audio.play().catch(() => { /* file missing -- silently ignore */ });
    this.musicEl = audio;
  }

  setAmbience(name: string | null) {
    if (this.currentAmbience === name) return;
    this.currentAmbience = name;
    this.ambienceEl?.pause();
    this.ambienceEl = null;
    if (!name) return;
    const audio = new Audio(`/sounds/ambience/${name}.mp3`);
    audio.loop = true;
    audio.volume = this.muted ? 0 : this.volumes.ambience;
    audio.play().catch(() => { /* file missing -- silently ignore */ });
    this.ambienceEl = audio;
  }

  setVolume(category: SoundCategory, value: number) {
    this.volumes[category] = Math.max(0, Math.min(1, value));
    try { localStorage.setItem(VOLUME_KEY, JSON.stringify(this.volumes)); } catch { /* ignore */ }
    if (category === "music" && this.musicEl) this.musicEl.volume = this.muted ? 0 : this.volumes.music;
    if (category === "ambience" && this.ambienceEl) this.ambienceEl.volume = this.muted ? 0 : this.volumes.ambience;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try { localStorage.setItem(MUTED_KEY, muted ? "1" : "0"); } catch { /* ignore */ }
    if (this.musicEl) this.musicEl.volume = muted ? 0 : this.volumes.music;
    if (this.ambienceEl) this.ambienceEl.volume = muted ? 0 : this.volumes.ambience;
  }

  stopAll() {
    this.musicEl?.pause(); this.musicEl = null; this.currentMusic = null;
    this.ambienceEl?.pause(); this.ambienceEl = null; this.currentAmbience = null;
  }
}
