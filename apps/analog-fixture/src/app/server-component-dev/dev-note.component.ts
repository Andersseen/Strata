import { ChangeDetectionStrategy, Component } from "@angular/core";

/** A server-owned grandchild with a `templateUrl`: the dev gate edits the .html file. */
@Component({
  selector: "dev-note",
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./dev-note.component.html",
})
export class DevNoteComponent {}
