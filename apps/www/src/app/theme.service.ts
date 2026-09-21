import { DOCUMENT, isPlatformBrowser } from "@angular/common";
import { afterNextRender, inject, Injectable, PLATFORM_ID, signal } from "@angular/core";

export type Theme = "dark" | "light";

@Injectable({ providedIn: "root" })
export class ThemeService {
  readonly theme = signal<Theme>("dark");
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      afterNextRender(() => {
        const stored = this.document.defaultView?.localStorage.getItem("strata-theme");
        this.setTheme(stored === "light" || stored === "dark" ? stored : this.theme());
      });
    }
  }

  toggle(): void {
    this.setTheme(this.theme() === "dark" ? "light" : "dark");
  }

  private setTheme(theme: Theme): void {
    this.theme.set(theme);
    this.document.documentElement?.setAttribute("data-theme", theme);
    this.document.defaultView?.localStorage.setItem("strata-theme", theme);
  }
}
