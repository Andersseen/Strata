import { chromium } from "playwright";

import {
  AUTHORIZATION_COOKIE_NAME,
  AUTHORIZATION_CREDENTIALS,
  PRIVATE_RESOURCE_CANARIES,
} from "../../apps/analog-fixture/src/app/server-component-authorization/authorization-contract.ts";
import type { AuthorizationTenant } from "../../apps/analog-fixture/src/app/server-component-authorization/authorization-contract.ts";
import type { HttpResult } from "../analog/lib/process.ts";

import {
  BROWSER_DIRS,
  build,
  check,
  dirGraph,
  finish,
  graphFilesWith,
  section,
  startProductionServer,
} from "./lib/harness.ts";
import type { ProductionServer } from "./lib/harness.ts";
import { printFrameworkTuple } from "./lib/security.ts";
import type { RuntimeTarget } from "./lib/security.ts";
import { resolveWrangler, startWranglerPages } from "./lib/wrangler.ts";

const TITLE = "Server Component request-bound authorization isolation";
const ROUTE = "/server-component-authorized";
const RECOVERY_ROUTE = "/server-component-ssr-recovery?mode=unavailable";
const PRIVATE_VALUES = Object.values(PRIVATE_RESOURCE_CANARIES);
const CREDENTIAL_VALUES = Object.values(AUTHORIZATION_CREDENTIALS);
const stop = (): never => finish(TITLE);

interface CapturedResponse extends HttpResult {
  readonly headers: Headers;
}

interface RequestOptions {
  readonly cookie?: string;
  readonly headers?: Record<string, string>;
}

type ExpectedState = "authorized" | "unauthenticated" | "forbidden" | "not-found";

const resourceUrl = (baseUrl: string, tenant: string, query = ""): string =>
  `${baseUrl}${ROUTE}/${tenant}${query}`;

const credentialCookie = (tenant: AuthorizationTenant): string =>
  `${AUTHORIZATION_COOKIE_NAME}=${AUTHORIZATION_CREDENTIALS[tenant]}`;

const request = async (
  url: string,
  options: RequestOptions = {},
  timeoutMs = 10_000,
): Promise<CapturedResponse> => {
  const headers = new Headers(options.headers);
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
    headers: response.headers,
  };
};

const containsMarker = (body: string, name: string, value: string): boolean =>
  body.includes(`${name}="${value}"`);

const publicResponse = (response: CapturedResponse): boolean => {
  const headerText = [...response.headers.entries()]
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  const publicText = `${response.body}\n${headerText}`;

  return (
    PRIVATE_VALUES.every((value) => !publicText.includes(value)) &&
    CREDENTIAL_VALUES.every((value) => !publicText.includes(value)) &&
    !publicText.includes("AuthorizationRepository") &&
    !publicText.includes("authorization-context")
  );
};

const expectedResponse = (
  response: CapturedResponse,
  expectedStatus: number,
  state: ExpectedState,
  readTenant: AuthorizationTenant | "none",
): boolean =>
  response.status === expectedStatus &&
  response.contentType?.includes("text/html") === true &&
  response.headers.get("cache-control") === "no-store" &&
  containsMarker(response.body, "data-auth-state", state) &&
  containsMarker(response.body, "data-resource-read", readTenant) &&
  !response.body.includes('data-auth-state="loading"') &&
  publicResponse(response);

const authorizedResponse = (response: CapturedResponse, tenant: AuthorizationTenant): boolean =>
  expectedResponse(response, 200, "authorized", tenant) &&
  containsMarker(response.body, "data-auth-principal", tenant) &&
  response.body.includes(`${tenant === "alpha" ? "Alpha" : "Beta"} resource is available`) &&
  response.body.includes('data-strata-client="authorization-island"') &&
  response.body.includes("data-strata-props=");

const deniedResponse = (
  response: CapturedResponse,
  status: 401 | 403 | 404,
  state: Exclude<ExpectedState, "authorized">,
): boolean =>
  expectedResponse(response, status, state, "none") &&
  !response.body.includes('data-strata-client="authorization-island"') &&
  !response.body.includes("resource is available");

async function checkHttpContract(target: RuntimeTarget): Promise<boolean> {
  section(`${target.name}: authorization and access ordering`);

  const alphaAlpha = await request(resourceUrl(target.baseUrl, "alpha"), {
    cookie: credentialCookie("alpha"),
  });
  const betaBeta = await request(resourceUrl(target.baseUrl, "beta"), {
    cookie: credentialCookie("beta"),
  });
  const alphaBeta = await request(resourceUrl(target.baseUrl, "beta"), {
    cookie: credentialCookie("alpha"),
  });
  const betaAlpha = await request(resourceUrl(target.baseUrl, "alpha"), {
    cookie: credentialCookie("beta"),
  });
  const anonymous = await request(resourceUrl(target.baseUrl, "alpha"));
  const unknownCredential = await request(resourceUrl(target.baseUrl, "alpha"), {
    cookie: `${AUTHORIZATION_COOKIE_NAME}=not-a-real-credential`,
  });
  const malformedCredential = await request(resourceUrl(target.baseUrl, "alpha"), {
    cookie: AUTHORIZATION_COOKIE_NAME,
  });
  const duplicateCredential = await request(resourceUrl(target.baseUrl, "alpha"), {
    cookie: `${credentialCookie("alpha")}; ${credentialCookie("beta")}`,
  });
  const queryOverride = await request(
    resourceUrl(target.baseUrl, "alpha", "?principal=beta&tenant=beta&resource=beta"),
    { cookie: credentialCookie("alpha") },
  );
  const headerOverride = await request(resourceUrl(target.baseUrl, "alpha"), {
    headers: { "x-user": "alpha", "x-tenant": "alpha" },
  });
  const unknownResource = await request(resourceUrl(target.baseUrl, "gamma"), {
    cookie: credentialCookie("alpha"),
  });
  const malformedResource = await request(resourceUrl(target.baseUrl, "%20alpha"), {
    cookie: credentialCookie("alpha"),
  });

  const checks = [
    check("alpha credential reads alpha resource", authorizedResponse(alphaAlpha, "alpha")),
    check("beta credential reads beta resource", authorizedResponse(betaBeta, "beta")),
    check(
      "alpha credential is forbidden from beta and repository read trace is empty",
      deniedResponse(alphaBeta, 403, "forbidden"),
    ),
    check(
      "beta credential is forbidden from alpha and repository read trace is empty",
      deniedResponse(betaAlpha, 403, "forbidden"),
    ),
    check(
      "missing credential is HTTP 401 and does not read tenant data",
      deniedResponse(anonymous, 401, "unauthenticated"),
    ),
    check(
      "unknown credential is HTTP 401 and does not read tenant data",
      deniedResponse(unknownCredential, 401, "unauthenticated"),
    ),
    check(
      "malformed credential is HTTP 401 and does not read tenant data",
      deniedResponse(malformedCredential, 401, "unauthenticated"),
    ),
    check(
      "duplicate credentials are rejected as ambiguous",
      deniedResponse(duplicateCredential, 401, "unauthenticated"),
    ),
    check(
      "query principal/resource overrides cannot change the verified alpha principal",
      authorizedResponse(queryOverride, "alpha") &&
        !containsMarker(queryOverride.body, "data-auth-principal", "beta") &&
        !containsMarker(queryOverride.body, "data-resource-read", "beta"),
    ),
    check(
      "untrusted identity headers cannot authenticate a request",
      deniedResponse(headerOverride, 401, "unauthenticated"),
    ),
    check(
      "unknown resource fails closed as HTTP 404 without resource disclosure",
      deniedResponse(unknownResource, 404, "not-found"),
    ),
    check(
      "malformed resource fails closed as HTTP 404 without resource disclosure",
      deniedResponse(malformedResource, 404, "not-found"),
    ),
  ];

  const deniedThenAllowed = await request(resourceUrl(target.baseUrl, "beta"), {
    cookie: credentialCookie("alpha"),
  });
  const afterDenied = await request(resourceUrl(target.baseUrl, "alpha"), {
    cookie: credentialCookie("alpha"),
  });
  const expectedFailure = await request(`${target.baseUrl}${RECOVERY_ROUTE}`);
  const afterExpectedFailure = await request(resourceUrl(target.baseUrl, "alpha"), {
    cookie: credentialCookie("alpha"),
  });

  checks.push(
    check(
      "a successful request after a denied request remains isolated",
      deniedResponse(deniedThenAllowed, 403, "forbidden") &&
        authorizedResponse(afterDenied, "alpha"),
    ),
    check(
      "a successful request after an expected service failure remains authorized",
      expectedFailure.status === 503 && authorizedResponse(afterExpectedFailure, "alpha"),
    ),
  );

  return checks.every(Boolean);
}

interface ConcurrentCase {
  readonly tenant: string;
  readonly cookie?: string;
  readonly expectedStatus: number;
  readonly expectedState: ExpectedState;
  readonly expectedRead: AuthorizationTenant | "none";
}

const concurrentCases: readonly ConcurrentCase[] = [
  {
    tenant: "alpha",
    cookie: credentialCookie("alpha"),
    expectedStatus: 200,
    expectedState: "authorized",
    expectedRead: "alpha",
  },
  {
    tenant: "beta",
    cookie: credentialCookie("beta"),
    expectedStatus: 200,
    expectedState: "authorized",
    expectedRead: "beta",
  },
  {
    tenant: "beta",
    cookie: credentialCookie("alpha"),
    expectedStatus: 403,
    expectedState: "forbidden",
    expectedRead: "none",
  },
  {
    tenant: "alpha",
    cookie: credentialCookie("beta"),
    expectedStatus: 403,
    expectedState: "forbidden",
    expectedRead: "none",
  },
  { tenant: "alpha", expectedStatus: 401, expectedState: "unauthenticated", expectedRead: "none" },
  {
    tenant: "beta",
    cookie: `${AUTHORIZATION_COOKIE_NAME}=unknown`,
    expectedStatus: 401,
    expectedState: "unauthenticated",
    expectedRead: "none",
  },
].flatMap((entry) => Array.from({ length: 4 }, () => entry));

async function checkConcurrentIsolation(target: RuntimeTarget, reverse: boolean): Promise<boolean> {
  const cases = reverse ? [...concurrentCases].reverse() : concurrentCases;
  const startedAt = performance.now();
  const responses = await Promise.all(
    cases.map((entry) =>
      request(resourceUrl(target.baseUrl, entry.tenant), { cookie: entry.cookie }),
    ),
  );
  const elapsedMs = performance.now() - startedAt;
  const isolated = responses.every((response, index) => {
    const expected = cases[index];
    return (
      expectedResponse(
        response,
        expected.expectedStatus,
        expected.expectedState,
        expected.expectedRead,
      ) &&
      (expected.expectedState !== "authorized" ||
        authorizedResponse(response, expected.expectedRead as AuthorizationTenant))
    );
  });

  return check(
    `${target.name}: ${reverse ? "reverse" : "forward"} 24-request authorization overlap is isolated`,
    isolated && elapsedMs < 4_000,
    `${Math.round(elapsedMs)}ms; statuses ${responses.map(({ status }) => status).join(",")}`,
  );
}

async function checkBrowserNavigation(target: RuntimeTarget): Promise<boolean> {
  section(`${target.name}: browser SSR, cookies and document navigation`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const origin = new URL(target.baseUrl);

  try {
    const anonymousContext = await browser.newContext();
    try {
      const anonymousPage = await anonymousContext.newPage();
      const anonymous = await anonymousPage.goto(resourceUrl(target.baseUrl, "alpha"), {
        waitUntil: "load",
        timeout: 15_000,
      });
      const anonymousState = await anonymousPage
        .locator("[data-auth-state]")
        .getAttribute("data-auth-state");
      check(
        "direct browser load without authorization is HTTP 401 with no island",
        anonymous?.status() === 401 &&
          anonymousState === "unauthenticated" &&
          (await anonymousPage.locator("[data-authorization-island]").count()) === 0,
        `${anonymous?.status()}/${anonymousState}`,
      );
    } finally {
      await anonymousContext.close();
    }

    await context.addCookies([
      {
        name: AUTHORIZATION_COOKIE_NAME,
        value: AUTHORIZATION_CREDENTIALS.alpha,
        domain: origin.hostname,
        path: "/",
        httpOnly: true,
        secure: false,
      },
    ]);

    const authorized = await page.goto(resourceUrl(target.baseUrl, "alpha"), {
      waitUntil: "load",
      timeout: 15_000,
    });
    const authorizedState = await page.locator("[data-auth-state]").getAttribute("data-auth-state");
    const authorizedRead = await page
      .locator("[data-resource-read]")
      .getAttribute("data-resource-read");
    const island = page.locator("[data-authorization-island]");
    const cookieVisibleToJs = String(await page.evaluate("document.cookie"));
    await island.click();
    await page.waitForFunction(
      "document.querySelector('[data-authorization-island]')?.textContent?.includes('interaction 1') === true",
      undefined,
      { timeout: 5_000 },
    );
    const interaction = await island.textContent();

    const forbiddenResponsePromise = page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        new URL(response.url()).pathname === `${ROUTE}/beta`,
    );
    await page.locator(`a[href="${ROUTE}/beta"]`).click();
    const forbidden = await forbiddenResponsePromise;
    await page.waitForLoadState("load");
    const forbiddenState = await page.locator("[data-auth-state]").getAttribute("data-auth-state");
    const forbiddenRead = await page
      .locator("[data-resource-read]")
      .getAttribute("data-resource-read");
    const forbiddenIslandCount = await page.locator("[data-authorization-island]").count();

    const back = await page.goBack({ waitUntil: "load", timeout: 15_000 });
    const backState = await page.locator("[data-auth-state]").getAttribute("data-auth-state");
    const backReload =
      back?.status() === undefined
        ? await page.reload({ waitUntil: "load", timeout: 15_000 })
        : undefined;
    const backStatus = back?.status() ?? backReload?.status();
    const forward = await page.goForward({ waitUntil: "load", timeout: 15_000 });
    const forwardState = await page.locator("[data-auth-state]").getAttribute("data-auth-state");
    const forwardReload =
      forward?.status() === undefined
        ? await page.reload({ waitUntil: "load", timeout: 15_000 })
        : undefined;
    const forwardStatus = forward?.status() ?? forwardReload?.status();
    const refreshed = await page.reload({ waitUntil: "load", timeout: 15_000 });
    const refreshState = await page.locator("[data-auth-state]").getAttribute("data-auth-state");

    await page.goto(resourceUrl(target.baseUrl, "alpha"), { waitUntil: "load", timeout: 15_000 });
    const reentryState = await page.locator("[data-auth-state]").getAttribute("data-auth-state");

    const results = [
      check(
        "HttpOnly alpha cookie loads authorized SSR with a hydrated island",
        authorized?.status() === 200 &&
          authorizedState === "authorized" &&
          authorizedRead === "alpha" &&
          interaction?.includes("interaction 1") === true,
        `${authorized?.status()}/${authorizedState}/${authorizedRead}/${interaction}`,
      ),
      check(
        "browser JavaScript cannot read the HttpOnly credential",
        !cookieVisibleToJs.includes(AUTHORIZATION_CREDENTIALS.alpha),
        cookieVisibleToJs,
      ),
      check(
        "document navigation to another tenant receives HTTP 403 and no island",
        forbidden.status() === 403 &&
          forbiddenState === "forbidden" &&
          forbiddenRead === "none" &&
          forbiddenIslandCount === 0,
        `${forbidden.status()}/${forbiddenState}/${forbiddenRead}/islands=${forbiddenIslandCount}`,
      ),
      check(
        "Back returns to authorized SSR and Forward returns to forbidden SSR",
        backStatus === 200 &&
          backState === "authorized" &&
          forwardStatus === 403 &&
          forwardState === "forbidden",
        `${backStatus}/${backState}; ${forwardStatus}/${forwardState}`,
      ),
      check(
        "refresh preserves the denied document status and re-entry restores authorization",
        refreshed?.status() === 403 &&
          refreshState === "forbidden" &&
          reentryState === "authorized",
        `${refreshed?.status()}/${refreshState}/${reentryState}`,
      ),
      check(
        "browser navigation has no console/page errors",
        pageErrors.length === 0,
        pageErrors.join(" | "),
      ),
    ];

    return results.every(Boolean);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runTarget(target: RuntimeTarget): Promise<void> {
  await checkHttpContract(target);
  await checkConcurrentIsolation(target, false);
  await checkConcurrentIsolation(target, true);
  await checkBrowserNavigation(target);
}

printFrameworkTuple();

section("Production build (Nitro node-server)");
build("production", {}, stop);
const nodeBrowser = dirGraph("Node browser output", BROWSER_DIRS);
const nodeServer = dirGraph("Node server output", ["ssr", "analog/server"]);
check(
  "authorization credentials and private records are absent from Node browser output",
  [...CREDENTIAL_VALUES, ...PRIVATE_VALUES].every(
    (value) => graphFilesWith(nodeBrowser, value).length === 0,
  ),
);
check(
  "authorization credentials and private records are present in the Node server graph",
  [...CREDENTIAL_VALUES, ...PRIVATE_VALUES].every(
    (value) => graphFilesWith(nodeServer, value).length > 0,
  ),
);

const nitro: ProductionServer = await startProductionServer();
try {
  await runTarget({
    name: "Nitro node-server",
    baseUrl: nitro.baseUrl,
    output: () => nitro.output(),
  });
} finally {
  await nitro.stop();
}

section("Cloudflare build: BUILD_PRESET=cloudflare-pages");
build("Cloudflare", { BUILD_PRESET: "cloudflare-pages" }, stop);
const worker = await startWranglerPages(resolveWrangler()).catch((error: unknown) => {
  check("wrangler pages dev boots and answers", false, String(error).slice(0, 2_000));
  return stop();
});

try {
  await runTarget({
    name: "Wrangler Pages (workerd)",
    baseUrl: worker.baseUrl,
    output: () => worker.output(),
  });
} finally {
  await worker.stop();
}

stop();
