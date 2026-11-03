import { ChangeDetectionStrategy, Component, computed, input, signal } from "@angular/core";
import { VoltButton } from "@voltui/components";
import { LmnCheckIcon } from "lumen-icons/check";
import { LmnClipboardIcon } from "lumen-icons/clipboard";

import { copyText } from "../clipboard";
import { highlight } from "../highlight";
import type { CodeLanguage } from "../highlight";

@Component({
  selector: "strata-code-panel",
  imports: [VoltButton, LmnCheckIcon, LmnClipboardIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="code-window">
    <div class="window-bar">
      <div class="window-dots" aria-hidden="true"><i></i><i></i><i></i></div>
      <span class="window-file">{{ filename() }}</span
      ><volt-button
        class="copy-button"
        variant="ghost"
        size="sm"
        [aria-label]="copied() ? 'Copied' : 'Copy'"
        (click)="copy()"
      >
        @if (copied()) {
          <lmn-check [size]="14" />
        } @else {
          <lmn-clipboard [size]="14" />
        }
        <span aria-hidden="true">{{ copied() ? "Copied" : "Copy" }}</span></volt-button
      >
    </div>
    <pre
      [attr.data-language]="language()"
    ><code>@for (token of tokens(); track $index) {<span [class]="'tok-' + token.kind">{{ token.text }}</span>}</code></pre>
  </div>`,
})
export class CodePanelComponent {
  readonly code = input.required<string>();
  readonly filename = input.required<string>();
  readonly language = input<CodeLanguage>("ts");

  protected readonly tokens = computed(() => highlight(this.code(), this.language()));
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    await copyText(this.code());
    this.copied.set(true);
    window.setTimeout(() => this.copied.set(false), 1400);
  }
}
