import { ChangeDetectionStrategy, Component, input, signal } from "@angular/core";
import { VoltButton } from "@voltui/components";
import { LmnCursorArrowRaysIcon } from "lumen-icons/cursor-arrow-rays";

// Qualification evidence: the one showcase module that must reach the browser.
const CLIENT_ISLAND_MARKER = "STRATA_WWW_CLIENT_ISLAND_MARKER";

/**
 * The client island of the landing's Server Component: an ordinary Angular
 * component, hydrated in the browser from the plain-data props the server
 * serialized on its `[strataClient]` boundary.
 */
@Component({
  selector: "strata-server-demo",
  imports: [VoltButton, LmnCursorArrowRaysIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="island-card" [attr.data-island]="marker">
    <p class="island-tag">
      <span class="island-dot"></span>Client island · hydrated in the browser
    </p>
    <p class="island-props">
      Props from the server: <code>{{ componentId() }}</code> with
      {{ serverOnlyModules() }} server-only modules left behind.
    </p>
    <div class="island-actions">
      <volt-button class="primary-action island-button" type="button" (click)="interact()"
        ><lmn-cursor-arrow-rays [size]="16" />{{ label() }}</volt-button
      >
      <output class="island-count" aria-live="polite">Interactions: {{ count() }}</output>
    </div>
  </div>`,
})
export class ServerComponentDemoComponent {
  readonly label = input.required<string>();
  readonly componentId = input.required<string>();
  readonly serverOnlyModules = input.required<number>();

  protected readonly count = signal(0);
  protected readonly marker = CLIENT_ISLAND_MARKER;

  protected interact(): void {
    this.count.update((count) => count + 1);
  }
}
