import { ChangeDetectionStrategy, Component } from "@angular/core";

/**
 * This application does NOT opt into `@strata-sc/server-components/ssr`. The page fails during the
 * server render after partial output, so the qualification can pin the native Analog behaviour the
 * opt-in contract exists for: an HTTP 200 document, and Angular's default ErrorHandler printing the
 * private message to the server log.
 */
@Component({
  selector: "app-native-render-failure-page",
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<main>
    <p id="native-partial-before">Rendered before the failure</p>
    <p>{{ explode() }}</p>
  </main>`,
})
export default class NativeRenderFailurePage {
  protected explode(): string {
    throw new Error("native render failure NATIVE_RENDER_FAILURE_PRIVATE_4b8e");
  }
}
