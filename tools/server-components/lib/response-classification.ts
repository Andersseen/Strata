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
  /**
   * Where a body first differs from the expected baseline: the character offset, both lengths, a
   * bounded window of each around the offset and the build stamps on each side. Absent when the body
   * was not compared or a private value was found (nothing is copied then).
   */
  readonly bodyDifference?: BodyDifference;
  readonly elapsedMs: number;
  readonly transportError: string | null;
}

export interface BodyDifference {
  readonly offset: number;
  readonly expectedLength: number;
  readonly actualLength: number;
  readonly expectedWindow: string;
  readonly actualWindow: string;
  readonly expectedBuilds: readonly string[];
  readonly actualBuilds: readonly string[];
}

export const DIFFERENCE_WINDOW = 80;

// Angular's transfer-state script (`<script id="${APP_ID}-state" type="application/json">`).
const STATE_SCRIPT = /(<script[^>]*type="application\/json"[^>]*>)([\s\S]*?)(<\/script>)/g;

/**
 * Angular numbers the serialized templates of its hydration annotation (`__nghData__`, ids `t0`,
 * `t1`, …) from render history that lives in the server process: a Worker isolate that already
 * rendered the page numbers them differently from a fresh one (observed on Cloudflare Pages,
 * deployed run 42034490852). Renumbering those ids by first appearance makes two such documents
 * equal; ANY other byte still counts, including the ids' structure and every other value.
 */
export function canonicalDocument(html: string): string {
  return html.replace(STATE_SCRIPT, (_match, open: string, state: string, close: string) => {
    if (!state.includes("__nghData__")) return `${open}${state}${close}`;

    const ids = new Map<string, string>();
    const renumbered = state.replace(/"(t\d+)"/g, (_id, id: string) => {
      if (!ids.has(id)) ids.set(id, `t${ids.size}`);

      return `"${ids.get(id)}"`;
    });

    return `${open}${renumbered}${close}`;
  });
}

export const sameDocument = (expected: string, actual: string): boolean =>
  expected === actual || canonicalDocument(expected) === canonicalDocument(actual);

const buildsIn = (html: string): string[] => [
  ...new Set([...html.matchAll(/data-strata-build="([^"]*)"/g)].map((m) => m[1]!)),
];

/** The first difference between two public bodies, bounded; never called for a private body. */
export function bodyDifference(expected: string, actual: string): BodyDifference {
  let offset = 0;

  while (offset < expected.length && offset < actual.length && expected[offset] === actual[offset])
    offset++;

  const from = Math.max(0, offset - DIFFERENCE_WINDOW / 2);

  return {
    offset,
    expectedLength: expected.length,
    actualLength: actual.length,
    expectedWindow: expected.slice(from, from + DIFFERENCE_WINDOW),
    actualWindow: actual.slice(from, from + DIFFERENCE_WINDOW),
    expectedBuilds: buildsIn(expected),
    actualBuilds: buildsIn(actual),
  };
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
  const bodyOk = expected.body === null || sameDocument(expected.body, reply.body);

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
      ...(!bodyOk &&
      expected.body !== null &&
      !privateValueInBody &&
      leaks(expected.body).length === 0
        ? { bodyDifference: bodyDifference(expected.body, reply.body) }
        : {}),
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
