import { ChangeDetectionStrategy, Component } from "@angular/core";

import { DevNoteComponent } from "./dev-note.component";

/** An ordinary server-owned child (no decorator of its own) of the dev Server Component. */
@Component({
  selector: "dev-child",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DevNoteComponent],
  template: `<p data-dev-child>Server child A</p>
    <dev-note />`,
})
export class DevChildComponent {}
