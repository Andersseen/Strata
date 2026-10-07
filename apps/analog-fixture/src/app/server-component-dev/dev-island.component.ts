import { ChangeDetectionStrategy, Component, signal } from "@angular/core";

import { devBarrelValue } from "./dev-barrel";
import { devShared } from "./dev-shared";

/**
 * The browser-owned island of the dev gate: its own template and logic are
 * edited to prove client HMR coexists with Server Component reloads, and it
 * imports a shared module, a barrel and (dynamically) a lazy module that the
 * gate marks server-only while Vite is running.
 */
@Component({
  selector: "dev-island",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button" data-dev-bump (click)="bump()">Client label A</button>
    <output data-dev-count>Clicks: {{ count() }}</output>
    <span data-dev-shared>{{ shared }}</span>
    <span data-dev-barrel>{{ barrel }}</span>
    <button type="button" data-dev-lazy (click)="loadLazy()">Load lazy</button>
    <output data-dev-lazy-result>{{ lazy() }}</output>`,
})
export class DevIslandComponent {
  protected readonly count = signal(0);
  protected readonly lazy = signal("idle");
  protected readonly shared = devShared();
  protected readonly barrel = devBarrelValue;

  protected bump(): void {
    this.count.update((count) => count + 1);
  }

  protected async loadLazy(): Promise<void> {
    try {
      this.lazy.set((await import("./dev-lazy")).devLazy);
    } catch {
      this.lazy.set("lazy failed");
    }
  }
}
