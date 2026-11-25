import { EventEmitter } from "node:events";

import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { trackFailedRequests } from "./lib/package-consumer.ts";

/** Just enough of Playwright's Page and Request to replay an event sequence. */
function harness() {
  const page = new EventEmitter() as EventEmitter & { mainFrame(): object };
  const main = {};
  page.mainFrame = () => main;
  const tracked = trackFailedRequests(page as unknown as Page);
  const request = (url: string, navigation = false) => ({
    url: () => url,
    resourceType: () => (navigation ? "document" : "script"),
    isNavigationRequest: () => navigation,
    frame: () => main,
    failure: () => ({ errorText: "net::ERR_ABORTED" }),
  });

  return {
    tracked,
    issue: (r: ReturnType<typeof request>) => page.emit("request", r),
    fail: (r: ReturnType<typeof request>) => page.emit("requestfailed", r),
    commit: () => page.emit("framenavigated", main),
    request,
  };
}

describe("trackFailedRequests", () => {
  it("reports an abort as replaced when the next navigation was requested (the 2026-11-24 trace)", () => {
    const h = harness();
    h.issue(h.request("/protected/beta?tenant=alpha", true));
    h.commit();
    const chunk = h.request("/assets/islands.js");
    h.issue(chunk);
    h.issue(h.request("/protected/beta", true));
    h.fail(chunk); // Chromium reports the abort before `framenavigated`.
    h.commit();

    expect(h.tracked.failedRequests).toEqual([]);
    expect(h.tracked.abortedByNavigation).toHaveLength(1);
  });

  it("also when the old document issued the request after the next navigation was requested", () => {
    const h = harness();
    h.issue(h.request("/a", true));
    h.commit();
    h.issue(h.request("/b", true));
    const late = h.request("/assets/late.js");
    h.issue(late);
    h.fail(late);

    expect(h.tracked.abortedByNavigation).toHaveLength(1);
  });

  it("keeps an abort within the same document a failure", () => {
    const h = harness();
    h.issue(h.request("/a", true));
    h.commit();
    const chunk = h.request("/assets/a.js");
    h.issue(chunk);
    h.fail(chunk);

    expect(h.tracked.failedRequests).toHaveLength(1);
    expect(h.tracked.abortedByNavigation).toEqual([]);
  });

  it("is not fooled by redirect hops or a navigation that never committed", () => {
    const h = harness();
    h.issue(h.request("/a", true));
    h.issue(h.request("/a-redirected", true)); // a redirect hop is a second navigation request
    h.commit();
    const chunk = h.request("/assets/a.js");
    h.issue(chunk);
    h.fail(chunk);

    expect(h.tracked.failedRequests).toHaveLength(1);
  });

  it("never reclassifies a failed navigation or another error", () => {
    const h = harness();
    h.issue(h.request("/a", true));
    h.commit();
    const nav = h.request("/b", true);
    h.issue(nav);
    h.fail(nav);
    const reset = {
      ...h.request("/assets/x.js"),
      failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
    };
    h.issue(reset);
    h.fail(reset);

    expect(h.tracked.failedRequests).toHaveLength(2);
  });
});
