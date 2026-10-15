import { edgeHeaders } from "./browser.ts";
import { describeError } from "./deployed.ts";

/**
 * Attribution of one answer to the request that was sent
 * (docs/research/full-stack-cloudflare-concurrency.md).
 *
 * The classes are DIAGNOSTIC categories, not proof of a root cause: an HTTP status
 * never says which layer produced it, so a class only says what the answer LOOKS like.
 *
 *   match                          exactly the expected answer
 *   controller-response-mismatch   a valid controller-shaped answer that is not the one this
 *                                  request should get (wrong status, wrong resource, wrong
 *                                  correlation id, a body that belongs to another request)
 *   edge-response                  an answer with no controller fingerprint that looks like a
 *                                  platform/edge page (HTML or empty 404/5xx), not controller JSON
 *   transport-error                no HTTP response at all (fetch failed, timeout, reset, DNS)
 *   unclassified                   anything else that is not the expected answer
 */
export type ResponseClass =
  "match" | "controller-response-mismatch" | "edge-response" | "transport-error" | "unclassified";

export interface RequestExpectation {
  /** Path and query actually requested. Only synthetic values are ever put here. */
  readonly target: string;
  readonly status: number;
  readonly contentType: string;
  /** The semantic public id the answer must carry (`/api/products/:id` → `id`, or `resource`). */
  readonly subject: string | null;
  /** The synthetic correlation id the answer must echo, when the route echoes one. */
  readonly correlation: string | null;
  /** The exact baseline body, when one is recorded. */
  readonly body: string | null;
}

export interface ObservedReply {
  readonly status: number;
  readonly headers: { get(name: string): string | null; entries(): Iterable<[string, string]> };
  readonly body: string;
}

export interface AnomalySample {
  readonly classification: Exclude<ResponseClass, "match">;
  readonly detail: string;
  readonly target: string;
  readonly expectedStatus: number;
  readonly actualStatus: number | null;
  readonly expectedContentType: string;
  readonly actualContentType: string | null;
  readonly expectedSubject: string | null;
  readonly observedSubject: string | null;
  readonly expectedCorrelation: string | null;
  readonly observedCorrelation: string | null;
  readonly controllerFingerprint: boolean;
  readonly edgeHeaders: Record<string, string>;
  /** Bounded, and replaced when it would carry a synthetic private value. */
  readonly bodyPrefix: string;
  readonly privateValueInBody: boolean;
  readonly elapsedMs: number;
  readonly transportError: string | null;
}

export const FINGERPRINT_HEADER = "x-fullstack-catalog";
export const BODY_PREFIX_LIMIT = 160;

interface Identity {
  readonly subject: string | null;
  readonly correlation: string | null;
  readonly strataError: string | null;
}

function identityOf(body: string): Identity {
  try {
    const parsed = JSON.parse(body) as unknown;

    if (parsed === null || typeof parsed !== "object") return empty;

    const record = parsed as Record<string, unknown>;
    const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

    return {
      subject: text(record["id"]) ?? text(record["resource"]),
      correlation: text(record["correlation"]),
      strataError: text(record["error"]),
    };
  } catch {
    return empty;
  }
}

const empty: Identity = { subject: null, correlation: null, strataError: null };

/**
 * Classify one answer. `leaks` reports synthetic private values in a body (names only); a body
 * that carries one is never copied into a sample.
 */
export function classifyReply(
  expected: RequestExpectation,
  reply: ObservedReply,
  elapsedMs: number,
  leaks: (text: string) => readonly string[],
): { readonly class: ResponseClass; readonly sample?: AnomalySample } {
  const contentType = reply.headers.get("content-type");
  const hasFingerprint = reply.headers.get(FINGERPRINT_HEADER) !== null;
  const identity = identityOf(reply.body);
  const privateValueInBody = leaks(reply.body).length > 0;
  const statusOk = reply.status === expected.status;
  const typeOk = !!contentType?.includes(expected.contentType);
  const subjectOk = expected.subject === null || identity.subject === expected.subject;
  const correlationOk =
    expected.correlation === null || identity.correlation === expected.correlation;
  const bodyOk = expected.body === null || reply.body === expected.body;

  if (statusOk && typeOk && subjectOk && correlationOk && bodyOk && !privateValueInBody)
    return { class: "match" };

  // A controller-shaped answer is JSON that either carries the controller fingerprint header or is
  // the controller's own `{"error":…}` body. Anything else is not something the adapter produced.
  const controllerShaped =
    !!contentType?.includes("application/json") &&
    (hasFingerprint || identity.strataError !== null);
  const html = !!contentType?.includes("text/html");
  const problems = [
    statusOk ? null : `status ${reply.status}≠${expected.status}`,
    typeOk ? null : `content-type ${contentType ?? "none"}≠${expected.contentType}`,
    subjectOk ? null : `subject ${identity.subject ?? "none"}≠${expected.subject}`,
    correlationOk ? null : `correlation ${identity.correlation ?? "none"}≠${expected.correlation}`,
    !bodyOk && subjectOk && correlationOk && statusOk && typeOk
      ? "body differs from baseline"
      : null,
    privateValueInBody ? "private value in body" : null,
  ].filter((problem): problem is string => problem !== null);

  const klass: ResponseClass = controllerShaped
    ? "controller-response-mismatch"
    : (html || contentType === null || reply.body.length === 0) &&
        !hasFingerprint &&
        (reply.status >= 400 || reply.status === 404)
      ? "edge-response"
      : "unclassified";

  return {
    class: klass,
    sample: {
      classification: klass,
      detail: problems.join("; "),
      target: expected.target,
      expectedStatus: expected.status,
      actualStatus: reply.status,
      expectedContentType: expected.contentType,
      actualContentType: contentType,
      expectedSubject: expected.subject,
      observedSubject: identity.subject,
      expectedCorrelation: expected.correlation,
      observedCorrelation: identity.correlation,
      controllerFingerprint: hasFingerprint,
      edgeHeaders: edgeHeaders([...reply.headers.entries()]),
      bodyPrefix: privateValueInBody
        ? "[withheld: private value]"
        : reply.body.slice(0, BODY_PREFIX_LIMIT),
      privateValueInBody,
      elapsedMs: Math.round(elapsedMs * 10) / 10,
      transportError: null,
    },
  };
}

/** No HTTP response at all. */
export function classifyTransportError(
  expected: RequestExpectation,
  error: unknown,
  elapsedMs: number,
): AnomalySample {
  return {
    classification: "transport-error",
    detail: "no HTTP response",
    target: expected.target,
    expectedStatus: expected.status,
    actualStatus: null,
    expectedContentType: expected.contentType,
    actualContentType: null,
    expectedSubject: expected.subject,
    observedSubject: null,
    expectedCorrelation: expected.correlation,
    observedCorrelation: null,
    controllerFingerprint: false,
    edgeHeaders: {},
    bodyPrefix: "",
    privateValueInBody: false,
    elapsedMs: Math.round(elapsedMs * 10) / 10,
    transportError: describeError(error),
  };
}
