import { Component } from "@angular/core";

// Positive control for the client/server graph baseline: this string is
// bundled into the client output on purpose, so a scan of that output that
// finds it proves the scanner can see client code at all.
const STRATA_CLIENT_CONTROL_MARKER = "STRATA_ANALOG_CLIENT_CONTROL_MARKER";

@Component({
  selector: "app-home",
  template: `<h1>Strata Analog fixture</h1>
    <p>{{ marker }}</p>`,
})
export default class Home {
  protected readonly marker = STRATA_CLIENT_CONTROL_MARKER;
}
