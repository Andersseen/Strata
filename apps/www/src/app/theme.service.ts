import { DOCUMENT, isPlatformBrowser } from "@angular/common";
import { inject, Injectable, PLATFORM_ID, signal } from "@angular/core";

export type Theme = "dark" | "light";

@Injectable({ providedIn: "root" })
export class ThemeService {
  readonly theme = signal<Theme>("dark");
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);

  constructor() {
    if (isPlatformBrowser(this.platformId)) {
      let stored: string | null = null;
      try {
        stored = this.document.defaultView?.localStorage.getItem("strata-theme") ?? null;
      } catch {
        // Storage can be disabled; the server-rendered dark theme remains usable.
      }
      this.setTheme(stored === "light" || stored === "dark" ? stored : this.theme());
    }
  }

  toggle(): void {
    this.setTheme(this.theme() === "dark" ? "light" : "dark");
  }

  private setTheme(theme: Theme): void {
    this.theme.set(theme);
    const root = this.document.documentElement;
    root?.setAttribute("data-theme", theme);
    root?.classList.toggle("dark", theme === "dark");
    if (root) root.style.colorScheme = theme;
    try {
      this.document.defaultView?.localStorage.setItem("strata-theme", theme);
    } catch {
      // The selected theme still applies for this session without storage access.
    }
  }
}
