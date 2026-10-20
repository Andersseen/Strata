const APPLICATION_ERROR_STATUSES = new Set([400, 404, 409, 422, 429, 503]);

export type StrataAnalogHttpErrorStatus = 400 | 404 | 409 | 422 | 429 | 503;

/**
 * An expected application failure with a stable, safe HTTP representation.
 * `message` and `cause` remain available to server-side error reporting; only
 * `status` and `code` are used in the HTTP response.
 */
export class StrataAnalogHttpError extends Error {
  readonly status: StrataAnalogHttpErrorStatus;
  readonly code: string;

  constructor(
    status: StrataAnalogHttpErrorStatus,
    code: string,
    message = code,
    options?: ErrorOptions,
  ) {
    super(message, options);
    if (!APPLICATION_ERROR_STATUSES.has(status)) {
      throw new TypeError("Unsupported Strata Analog HTTP error status.");
    }
    if (typeof code !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(code)) {
      throw new TypeError("Strata Analog HTTP error code must be a lowercase identifier.");
    }
    if (typeof message !== "string") {
      throw new TypeError("Strata Analog HTTP error message must be a string.");
    }
    this.name = "StrataAnalogHttpError";
    this.status = status;
    this.code = code;
  }
}
