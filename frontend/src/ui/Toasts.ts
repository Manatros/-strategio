// src/ui/Toasts.ts
// A stack of dismissible alert cards, always on top, top-right corner —
// this is what replaced the old "Notifications" panel that was easy to
// miss. Proposals show up here with action buttons; purely informational
// events (like a new war) show up as a card that just fades on its own.

export type ToastAction = { label: string; onClick: () => void };
export type Toast = { id: string; title: string; body: string; actions?: ToastAction[]; autoDismissMs?: number };

export class ToastStack {
  private root: HTMLElement;
  private cards = new Map<string, HTMLElement>();

  constructor(mount: HTMLElement) {
    this.root = document.createElement("div");
    this.root.style.position = "fixed";
    this.root.style.top = "12px";
    this.root.style.right = "12px";
    this.root.style.zIndex = "300";
    this.root.style.display = "flex";
    this.root.style.flexDirection = "column";
    this.root.style.gap = "8px";
    this.root.style.pointerEvents = "none";
    mount.appendChild(this.root);
  }

  show(toast: Toast) {
    this.dismiss(toast.id); // replace if the same id is already showing

    const card = document.createElement("div");
    card.className = "panel toast-card";
    card.style.pointerEvents = "auto";
    card.style.minWidth = "240px";
    card.style.borderLeft = "3px solid #ffd23f";
    card.innerHTML = `<div><strong>${toast.title}</strong></div><div style="margin-top:4px">${toast.body}</div>`;

    if (toast.actions?.length) {
      const row = document.createElement("div");
      row.className = "row";
      row.style.gap = "6px";
      row.style.marginTop = "6px";
      for (const action of toast.actions) {
        const btn = document.createElement("button");
        btn.className = "btn";
        btn.textContent = action.label;
        btn.onclick = () => { action.onClick(); this.dismiss(toast.id); };
        row.appendChild(btn);
      }
      card.appendChild(row);
    }

    this.root.appendChild(card);
    this.cards.set(toast.id, card);

    if (toast.autoDismissMs) {
      setTimeout(() => this.dismiss(toast.id), toast.autoDismissMs);
    }
  }

  dismiss(id: string) {
    const card = this.cards.get(id);
    if (!card) return;
    card.remove();
    this.cards.delete(id);
  }
}
