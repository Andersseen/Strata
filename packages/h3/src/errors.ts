/**
 * Thrown during {@link registerControllers} when a controller is misconfigured
 * — e.g. missing `@Controller()`, or a route pointing at a non-callable
 * handler. Registration fails fast so these mistakes surface immediately
 * instead of on the first matching request.
 *
 * This is intentionally a single, simple error type. A richer Strata error
 * hierarchy is out of scope for this iteration.
 */
export class StrataH3ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrataH3ConfigurationError";
  }
}
