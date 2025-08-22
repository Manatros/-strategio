export interface Scene {
  mount(root: HTMLElement): void|Promise<void>;
  unmount(): void;
}
export class SceneManager {
  private current: Scene | null = null;
  constructor(private root: HTMLElement) {}
  async switch(next: Scene) {
    this.current?.unmount();
    this.current = next;
    await next.mount(this.root);
  }
}
