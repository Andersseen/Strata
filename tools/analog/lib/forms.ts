import type { Report, Runtime } from "./streaming.ts";

const PATH = "/api/strata/forms";
const LOG = "/api/strata/observed-log";
const CANARY = "fixture-private-form-canary";

interface Entry {
  readonly kind: string;
  readonly resource?: string;
  readonly observation?: { readonly outcome: string; readonly status?: number };
}

const readLog = async (baseUrl: string): Promise<Entry[]> =>
  (await (await fetch(`${baseUrl}${LOG}`)).json()) as Entry[];
const reset = async (baseUrl: string): Promise<void> => {
  await fetch(`${baseUrl}${LOG}/reset`, { method: "POST" });
};
const sameJson = (text: string, expected: unknown): boolean => {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(expected);
  } catch {
    return false;
  }
};

export async function observeForms(
  baseUrl: string,
  runtime: Runtime,
  report: Report,
  output: () => string,
): Promise<void> {
  const label = `${runtime}:`;
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${PATH}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", ...headers },
      body,
    });

  await reset(baseUrl);
  const success = await post(
    "/orders",
    "orderId=order-a7&tag=fragile&tag=gift&note=Leave+at+door%20please",
    {
      "x-correlation-id": "form-correlation-7",
      authorization: `Bearer ${CANARY}-auth`,
      cookie: `session=${CANARY}-cookie`,
    },
  );
  const successText = await success.text();
  report(
    `${label} valid URL-encoded order transforms and preserves repeated tags`,
    success.status === 200 &&
      sameJson(successText, {
        orderId: "ORDER-A7",
        tags: ["fragile", "gift"],
        note: "Leave at door please",
        correlation: "form-correlation-7",
      }),
    `${success.status} ${successText}`,
  );
  let log = await readLog(baseUrl);
  report(
    `${label} successful form is cleaned and observed completed`,
    log.map((entry) => entry.kind).join() === "cleanup,observation" &&
      log[1]?.observation?.outcome === "completed",
  );

  await reset(baseUrl);
  const rejected = await post("/invalid", `secret=${CANARY}`);
  const rejectedText = await rejected.text();
  log = await readLog(baseUrl);
  report(
    `${label} schema issue uses the safe 400 without form or schema details`,
    rejected.status === 400 &&
      rejectedText === '{"error":"invalid_request","source":"body"}' &&
      rejected.headers.get("cache-control") === "no-store" &&
      !rejectedText.includes(CANARY),
  );
  report(
    `${label} form issue is observed as input-rejected after cleanup without private values`,
    log.map((entry) => entry.kind).join() === "cleanup,observation" &&
      log[1]?.observation?.outcome === "input-rejected" &&
      !JSON.stringify(log).includes(CANARY),
  );

  for (const [name, body, contentType, status] of [
    ["malformed percent escape", "orderId=%", "application/x-www-form-urlencoded", 400],
    ["invalid percent-encoded UTF-8", "orderId=%C3%28", "application/x-www-form-urlencoded", 400],
    [
      "unsupported charset",
      "orderId=order-a7",
      "application/x-www-form-urlencoded; charset=iso-8859-1",
      415,
    ],
    ["wrong media type", "{}", "application/json", 415],
  ] as const) {
    const response = await post("/orders", body, { "content-type": contentType });
    report(
      `${label} ${name} returns safe ${status}`,
      response.status === status &&
        (await response.text()) ===
          JSON.stringify({
            error: status === 415 ? "unsupported_media_type" : "invalid_request",
            source: "body",
          }),
    );
  }

  await reset(baseUrl);
  const tooLarge = await post("/orders", `orderId=order-a7&note=${"x".repeat(1024 * 1024)}`);
  report(
    `${label} a streamed request body above 1 MiB returns safe 413`,
    tooLarge.status === 413 &&
      (await tooLarge.text()) === '{"error":"payload_too_large","source":"body"}',
  );
  const tooMany = await post(
    "/orders",
    `orderId=order-a7&${Array.from({ length: 10_000 }, (_, i) => `tag=${i}`).join("&")}`,
  );
  report(`${label} more than 10,000 fields returns safe 413`, tooMany.status === 413);

  await reset(baseUrl);
  const mixed = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const valid = index % 4 !== 0;
      const response = await post(
        valid ? "/orders" : "/invalid",
        valid
          ? `orderId=order-${index}&tag=${index}-one&tag=${index}-two`
          : `secret=${CANARY}-${index}`,
        { "x-correlation-id": `correlation-${index}` },
      );
      const text = await response.text();
      return valid
        ? response.status === 200 &&
            sameJson(text, {
              orderId: `ORDER-${index}`,
              tags: [`${index}-one`, `${index}-two`],
              note: undefined,
              correlation: `correlation-${index}`,
            })
        : response.status === 400 && text === '{"error":"invalid_request","source":"body"}';
    }),
  );
  log = await readLog(baseUrl);
  report(
    `${label} 24 overlapping form requests keep request and repeated-value data isolated`,
    mixed.every(Boolean),
  );
  report(
    `${label} observations and cleanups hold no form values or authorization canary`,
    !JSON.stringify(log).includes(CANARY),
  );

  await reset(baseUrl);
  const cleanupFailure = await post("/cleanup-fail", `secret=${CANARY}`);
  const cleanupText = await cleanupFailure.text();
  log = await readLog(baseUrl);
  report(
    `${label} cleanup failure keeps precedence over the safe input response`,
    cleanupFailure.status >= 500 &&
      !cleanupText.includes(CANARY) &&
      log.at(-1)?.observation?.outcome === "cleanup-failed" &&
      !JSON.stringify(log).includes(CANARY),
  );

  const native = await fetch(`${baseUrl}/api/native`);
  report(`${label} native Nitro routes still coexist`, native.status === 200);
  const unrelated = await fetch(`${baseUrl}/api/strata/validated/1?tag=x`);
  report(
    `${label} unrelated GET routes remain outside automatic form validation`,
    unrelated.status === 200,
  );
  report(
    `${label} process stays free from unhandled rejections`,
    !/UnhandledPromiseRejection|unhandled promise rejection/i.test(output()),
  );
}
