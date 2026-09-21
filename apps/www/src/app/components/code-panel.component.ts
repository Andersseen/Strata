import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";

@Component({
  selector: "strata-code-panel",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="code-window">
    <div class="window-bar">
      <div class="window-dots"><i></i><i></i><i></i></div>
      <span>{{ filename() }}</span
      ><button type="button" (click)="copy()">{{ copied() ? "Copied" : "Copy" }}</button>
    </div>
    <pre><code>{{ code() }}</code></pre>
  </div>`,
})
export class CodePanelComponent {
  readonly code = input.required<string>();
  readonly filename = input.required<string>();
  protected readonly copied = signal(false);
  protected copy(): void {
    void this.copySource();
  }

  private async copySource(): Promise<void> {
    try {
      await navigator.clipboard?.writeText(this.code());
    } catch {
      // Browser privacy settings can reject Clipboard API writes even on a
      // trusted localhost page. Retain a selection-based fallback so the
      // interaction stays useful in previews and embedded browsers.
      const textarea = document.createElement("textarea");
      textarea.value = this.code();
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand?.("copy");
      textarea.remove();
    }

    this.copied.set(true);
    window.setTimeout(() => this.copied.set(false), 1400);
  }
}
