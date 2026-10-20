/** Create a JSON response using the platform's native Response implementation. */
export function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const status = init.status ?? 200;
  assertHttpStatus(status);
  const body = JSON.stringify(value);
  if (body === undefined) {
    throw new TypeError("jsonResponse() cannot serialize a top-level undefined value.");
  }

  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8");
  }
  return new Response(body, { ...init, status, headers });
}

/** Create an empty 204 response, optionally with consumer supplied headers. */
export function noContent(init: Pick<ResponseInit, "headers"> = {}): Response {
  return new Response(null, { status: 204, headers: new Headers(init.headers) });
}

function assertHttpStatus(status: number): void {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new RangeError("Response status must be an integer from 200 through 599.");
  }
}
