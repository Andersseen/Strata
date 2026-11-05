import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { ActivatedRoute } from "@angular/router";

import { RenderFailureBoundary } from "../products/render-failure-boundary.server-component";
import { RenderFailureConstructor } from "../products/render-failure-constructor.server-component";
import { RenderFailureHandled } from "../products/render-failure-handled.server-component";
import { RenderFailureHeader } from "../products/render-failure-header.server-component";
import { RenderFailureNone } from "../products/render-failure-none.server-component";
import { RenderFailureService } from "../products/render-failure-service.server-component";
import { RenderFailureTemplate } from "../products/render-failure-template.server-component";

@Component({
  selector: "app-render-failure-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RenderFailureBoundary,
    RenderFailureConstructor,
    RenderFailureHandled,
    RenderFailureHeader,
    RenderFailureNone,
    RenderFailureService,
    RenderFailureTemplate,
  ],
  template: `<h1>Render failure probe</h1>
    @switch (mode) {
      @case ("constructor") {
        <render-failure-constructor />
      }
      @case ("service") {
        <render-failure-service />
      }
      @case ("template") {
        <render-failure-template />
      }
      @case ("boundary") {
        <render-failure-boundary />
      }
      @case ("header") {
        <render-failure-header />
      }
      @case ("handled") {
        <render-failure-handled />
      }
      @default {
        <render-failure-none />
      }
    }`,
})
export default class RenderFailurePage {
  protected readonly mode = inject(ActivatedRoute).snapshot.paramMap.get("mode") ?? "none";
}
