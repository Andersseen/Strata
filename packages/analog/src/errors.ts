/**
 * Thrown during {@link registerControllers} when a controller is misconfigured
 * — e.g. missing `@Controller()`, or a route pointing at a non-callable
 * handler. Registration fails fast so these mistakes surface at server
 * bootstrap instead of on the first matching request.
 *
 * This is intentionally a single, simple error type. It is deliberately not
 * shared with `@strata/h3`: the two adapters are siblings, and a common Strata
 * error hierarchy is out of scope for this iteration.
 */
export class StrataAnalogConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StrataAnalogConfigurationError";
  }
}
