import "@angular/compiler";
import { ErrorHandler, InjectionToken, Injector, createEnvironmentInjector } from "@angular/core";
import type { EnvironmentInjector } from "@angular/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STRATA_SSR_FAILURE_DOCUMENT,
  provideStrataSsrFailureHandler,
  withStrataSsrFailureContract,
} from "./failure-contract.js";
import type { StrataSsrFailure, StrataSsrResponse } from "./failure-contract.js";

const PRIVATE = "TENANT_SECRET_7f3a";

/** Node `ServerResponse`'s header surface, in memory. */
class FakeResponse implements StrataSsrResponse {
  statusCode = 200;
  private readonly headers = new Map<string, unknown>();
  setHeader(name: string, value: unknown): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  getHeader(name: string): unknown {
    return this.headers.get(name.toLowerCase());
  }
  getHeaderNames(): string[] {
    return [...this.headers.keys()];
  }
  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }
}

interface Context {
  readonly res: FakeResponse;
  readonly req: { readonly url: string };
}

/** Stand-in for Analog's public `RESPONSE` token. */
const RESPONSE = new InjectionToken<FakeResponse>("RESPONSE");

/**
 * A buffered render like Analog's: one application injector per request, providing that request's
 * response object; `body` runs "inside" the render with the application's ErrorHandler.
 */
function fakeRender(
  body: (handler: ErrorHandler, context: Context) => Promise<string> | string,
  injectors: EnvironmentInjector[] = [],
) {
  return async (_url: string, _document: string, context: Context): Promise<string> => {
    const injector = createEnvironmentInjector(
      [{ provide: RESPONSE, useValue: context.res }, provideStrataSsrFailureHandler(RESPONSE)],
      Injector.NULL as EnvironmentInjector,
    );
    injectors.push(injector);
    try {
      return await body(injector.get(ErrorHandler), context);
    } finally {
      injector.destroy();
    }
  };
}

const context = (url = "/"): Context => ({ res: new FakeResponse(), req: { url } });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.restoreAllMocks());

describe("withStrataSsrFailureContract", () => {
  it("passes a healthy render through untouched (status, headers, document)", async () => {
    const report = vi.fn();
    const render = withStrataSsrFailureContract(
      fakeRender(() => "<html>ok</html>"),
      { report },
    );
    const ctx = context();
    ctx.res.setHeader("x-request-id", "abc");

    await expect(render("/", "<html></html>", ctx)).resolves.toBe("<html>ok</html>");
    expect(ctx.res.statusCode).toBe(200);
    expect(ctx.res.getHeader("cache-control")).toBeUndefined();
    expect(ctx.res.getHeader("x-request-id")).toBe("abc");
    expect(report).not.toHaveBeenCalled();
  });

  it("keeps an application-owned status such as a 404 page", async () => {
    const render = withStrataSsrFailureContract(
      fakeRender((_handler, ctx) => {
        ctx.res.statusCode = 404;
        return "<html>not found</html>";
      }),
    );
    const ctx = context("/missing");

    await expect(render("/missing", "", ctx)).resolves.toBe("<html>not found</html>");
    expect(ctx.res.statusCode).toBe(404);
  });

  it("replaces a document whose render reported an error with a generic no-store 500", async () => {
    const report = vi.fn<(failure: StrataSsrFailure) => void>();
    const render = withStrataSsrFailureContract(
      fakeRender((handler) => {
        handler.handleError(new TypeError(`binding failed ${PRIVATE}`));
        return `<html><p>partial</p><script id="ng-state">${PRIVATE}</script></html>`;
      }),
      { report },
    );
    const ctx = context();
    const html = await render("/", "", ctx);

    expect(html).toBe(STRATA_SSR_FAILURE_DOCUMENT);
    expect(html).not.toContain(PRIVATE);
    expect(html).not.toMatch(/ng-state|ngh=|data-strata-/);
    expect(ctx.res.statusCode).toBe(500);
    expect(ctx.res.getHeader("cache-control")).toBe("no-store");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].phase).toBe("render");
    expect(report.mock.calls[0]![0].errorNames).toEqual(["TypeError"]);
    expect(Object.isFrozen(report.mock.calls[0]![0])).toBe(true);
  });

  it("treats a rejected render (bootstrap, initializer) as a failure, including a non-Error reason", async () => {
    const report = vi.fn<(failure: StrataSsrFailure) => void>();
    const render = withStrataSsrFailureContract(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the non-Error reason is the case under test
      fakeRender(() => Promise.reject(`initializer ${PRIVATE}`)),
      { report },
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe(STRATA_SSR_FAILURE_DOCUMENT);
    expect(ctx.res.statusCode).toBe(500);
    expect(report.mock.calls[0]![0]).toMatchObject({ phase: "rejection", errorNames: ["string"] });
  });

  it("reports one failure per request: repeated and handler-plus-rejection errors are de-duplicated", async () => {
    const report = vi.fn<(failure: StrataSsrFailure) => void>();
    const error = new Error(PRIVATE);
    const render = withStrataSsrFailureContract(
      fakeRender((handler) => {
        handler.handleError(error);
        handler.handleError(error);
        throw error;
      }),
      { report },
    );

    await render("/", "", context());
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0].errors).toEqual([error]);
    expect(report.mock.calls[0]![0].phase).toBe("rejection");
  });

  it("logs exactly one redacted line by default: class names only, no message, stack or URL", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const render = withStrataSsrFailureContract(
      fakeRender((handler) => {
        handler.handleError(new RangeError(`private ${PRIVATE}`));
        return "<html></html>";
      }),
    );

    await render(`/tenant/${PRIVATE}`, "", context(`/tenant/${PRIVATE}`));
    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls.flat().map(String).join(" ");
    expect(line).toBe(
      "[strata:ssr] unexpected render failure (RangeError; render); answered HTTP 500",
    );
    expect(line).not.toContain(PRIVATE);
  });

  it("negative control: the redaction assertion detects a private value when it is exposed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const leaky = withStrataSsrFailureContract(
      fakeRender((handler) => {
        handler.handleError(new Error(PRIVATE));
        return "";
      }),
      { report: ({ errors }) => console.error(String(errors[0])) },
    );

    await leaky("/", "", context());
    expect(log.mock.calls.flat().map(String).join(" ")).toContain(PRIVATE);
  });

  it("removes headers the failed render added and restores the ones it changed", async () => {
    const render = withStrataSsrFailureContract(
      fakeRender((handler, ctx) => {
        ctx.res.setHeader("x-tenant", PRIVATE);
        ctx.res.setHeader("set-cookie", [`session=${PRIVATE}`]);
        ctx.res.setHeader("x-request-id", "overwritten");
        handler.handleError(new Error("boom"));
        return "";
      }),
      { report: () => undefined },
    );
    const ctx = context();
    ctx.res.setHeader("x-request-id", "abc");
    ctx.res.setHeader("content-security-policy", "default-src 'self'");

    await render("/", "", ctx);
    expect(ctx.res.getHeaderNames().sort()).toEqual([
      "cache-control",
      "content-security-policy",
      "x-request-id",
    ]);
    expect(ctx.res.getHeader("x-request-id")).toBe("abc");
    expect(ctx.res.getHeader("cache-control")).toBe("no-store");
  });

  it("answers a configured static failure document and survives a throwing reporter", async () => {
    const render = withStrataSsrFailureContract(
      fakeRender(() => {
        throw new Error("boom");
      }),
      {
        failureDocument: "<!doctype html><title>Down</title>",
        report: () => {
          throw new Error("reporter down");
        },
      },
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe("<!doctype html><title>Down</title>");
    expect(ctx.res.statusCode).toBe(500);
  });

  it("keeps failures request-owned under interleaved concurrent renders", async () => {
    const render = withStrataSsrFailureContract(
      fakeRender(async (handler, ctx) => {
        await tick();
        if (ctx.req.url.startsWith("/fail")) handler.handleError(new Error(PRIVATE));
        await tick();
        return `<html>${ctx.req.url}</html>`;
      }),
      { report: () => undefined },
    );
    const contexts = Array.from({ length: 40 }, (_, index) =>
      context(index % 2 ? `/ok/${index}` : `/fail/${index}`),
    );
    const results = await Promise.all(contexts.map((ctx) => render(ctx.req.url, "", ctx)));

    contexts.forEach((ctx, index) => {
      const failed = ctx.req.url.startsWith("/fail");
      expect(ctx.res.statusCode, ctx.req.url).toBe(failed ? 500 : 200);
      expect(results[index]).toBe(
        failed ? STRATA_SSR_FAILURE_DOCUMENT : `<html>${ctx.req.url}</html>`,
      );
    });
  });

  it("does not poison the next request on the same render function", async () => {
    let fail = true;
    const render = withStrataSsrFailureContract(
      fakeRender((handler) => {
        if (fail) handler.handleError(new Error("first"));
        return "<html>second</html>";
      }),
      { report: () => undefined },
    );

    await render("/", "", context());
    fail = false;
    const next = context();
    await expect(render("/", "", next)).resolves.toBe("<html>second</html>");
    expect(next.res.statusCode).toBe(200);
  });
});

describe("provideStrataSsrFailureHandler", () => {
  it("refuses a render that has a response but no wrapper: it could only answer HTTP 200", () => {
    expect(() =>
      createEnvironmentInjector(
        [
          { provide: RESPONSE, useValue: new FakeResponse() },
          provideStrataSsrFailureHandler(RESPONSE),
        ],
        Injector.NULL as EnvironmentInjector,
      ),
    ).toThrow(/outside a compatible withStrataSsrFailureContract/);
  });

  it("keeps Angular's native ErrorHandler behaviour after the wrapper chose the response", async () => {
    const native = vi.spyOn(ErrorHandler.prototype, "handleError").mockImplementation(() => {});
    let late: ErrorHandler | undefined;
    const render = withStrataSsrFailureContract(
      fakeRender((handler) => {
        late = handler;
        return "<html>ok</html>";
      }),
      { report: () => undefined },
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe("<html>ok</html>");
    const error = new Error("late");
    late!.handleError(error);

    expect(native).toHaveBeenCalledWith(error);
    expect(ctx.res.statusCode).toBe(200);
  });

  it("falls back to native handling where the response token is absent (the browser)", () => {
    const native = vi.spyOn(ErrorHandler.prototype, "handleError").mockImplementation(() => {});
    const injector = createEnvironmentInjector(
      [provideStrataSsrFailureHandler(RESPONSE)],
      Injector.NULL as EnvironmentInjector,
    );

    injector.get(ErrorHandler).handleError(new Error("browser"));
    expect(native).toHaveBeenCalledTimes(1);
    injector.destroy();
  });

  it("records a failure only for the response the wrapper is rendering", async () => {
    const native = vi.spyOn(ErrorHandler.prototype, "handleError").mockImplementation(() => {});
    const other = context();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let unrelated: ErrorHandler | undefined;
    const quiet = { report: () => undefined };
    const otherRender = withStrataSsrFailureContract(
      fakeRender(async (handler) => {
        unrelated = handler;
        await held;
        return "<html>other</html>";
      }),
      quiet,
    )("/other", "", other);
    await tick();

    const render = withStrataSsrFailureContract(
      fakeRender(() => {
        // An error on ANOTHER request's injector while this one renders.
        unrelated!.handleError(new Error("elsewhere"));
        return "<html>ok</html>";
      }),
      quiet,
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe("<html>ok</html>");
    expect(ctx.res.statusCode).toBe(200);
    release();
    await expect(otherRender).resolves.toBe(STRATA_SSR_FAILURE_DOCUMENT);
    expect(other.res.statusCode).toBe(500);
    expect(native).not.toHaveBeenCalled();
  });
});

describe("integration integrity", () => {
  const SLOT = Symbol.for("@strata-sc/server-components:ssr-failure-contract");
  const unconnected = () => Promise.resolve("<html>looks fine</html>");

  /** Two independently evaluated copies of the module, as two installed packages produce. */
  async function twoCopies() {
    vi.resetModules();
    const first = await import("./failure-contract.js");
    vi.resetModules();
    const second = await import("./failure-contract.js");

    expect(first.withStrataSsrFailureContract).not.toBe(second.withStrataSsrFailureContract);

    return { first, second };
  }

  const renderWith =
    (provide: typeof provideStrataSsrFailureHandler, body: (handler: ErrorHandler) => string) =>
    (_url: string, _document: string, ctx: Context): Promise<string> => {
      const injector = createEnvironmentInjector(
        [{ provide: RESPONSE, useValue: ctx.res }, provide(RESPONSE)],
        Injector.NULL as EnvironmentInjector,
      );
      try {
        return Promise.resolve(body(injector.get(ErrorHandler)));
      } finally {
        injector.destroy();
      }
    };

  it("two copies of the package share one request's contract: a failure still answers 500", async () => {
    const { first, second } = await twoCopies();
    const report = vi.fn();
    const render = first.withStrataSsrFailureContract(
      renderWith(second.provideStrataSsrFailureHandler, (handler) => {
        handler.handleError(new Error(PRIVATE));
        return "<html>half</html>";
      }),
      { report },
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe(first.STRATA_SSR_FAILURE_DOCUMENT);
    expect(ctx.res.statusCode).toBe(500);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]![0]).toMatchObject({ phase: "render", errorNames: ["Error"] });
  });

  it("two copies of the package keep a healthy render healthy", async () => {
    const { first, second } = await twoCopies();
    const render = first.withStrataSsrFailureContract(
      renderWith(second.provideStrataSsrFailureHandler, () => "<html>ok</html>"),
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe("<html>ok</html>");
    expect(ctx.res.statusCode).toBe(200);
  });

  it("refuses a render no handler took part in, however healthy it looks", async () => {
    const reports: StrataSsrFailure[] = [];
    const render = withStrataSsrFailureContract(unconnected, {
      report: (failure) => reports.push(failure),
    });
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe(STRATA_SSR_FAILURE_DOCUMENT);
    expect(ctx.res.statusCode).toBe(500);
    expect(ctx.res.getHeader("cache-control")).toBe("no-store");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      phase: "integration",
      errorNames: ["StrataSsrIntegrationError"],
    });
  });

  it("names the broken integration in the default log line, with no request data", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = context(`/tenant/${PRIVATE}`);

    await withStrataSsrFailureContract(unconnected)(ctx.req.url, "", ctx);

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[strata:ssr\] no compatible provideStrata/);
    expect(String(log.mock.calls[0]![0])).not.toContain(PRIVATE);
  });

  it("refuses a provider given the wrong response token", async () => {
    const WRONG = new InjectionToken<FakeResponse>("WRONG");
    const render = withStrataSsrFailureContract(
      (_url: string, _document: string, ctx: Context) => {
        const injector = createEnvironmentInjector(
          [
            { provide: RESPONSE, useValue: ctx.res },
            { provide: WRONG, useValue: new FakeResponse() },
            provideStrataSsrFailureHandler(WRONG),
          ],
          Injector.NULL as EnvironmentInjector,
        );
        injector.destroy();
        return Promise.resolve("<html>unreachable</html>");
      },
      { report: () => undefined },
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe(STRATA_SSR_FAILURE_DOCUMENT);
    expect(ctx.res.statusCode).toBe(500);
  });

  it("refuses a provider that meets a contract of another protocol", () => {
    const res = new FakeResponse();
    Object.defineProperty(res, SLOT, { configurable: true, value: { protocol: 2 } });

    expect(() =>
      createEnvironmentInjector(
        [{ provide: RESPONSE, useValue: res }, provideStrataSsrFailureHandler(RESPONSE)],
        Injector.NULL as EnvironmentInjector,
      ),
    ).toThrow(/compatible/);
  });

  it("rejects a wrapper nested inside a wrapper of another protocol", async () => {
    const ctx = context();
    Object.defineProperty(ctx.res, SLOT, { configurable: true, value: { protocol: 2 } });

    await expect(withStrataSsrFailureContract(unconnected)("/", "", ctx)).rejects.toThrow(
      /incompatible versions/,
    );
  });

  it("nested wrappers keep one outcome and one report", async () => {
    const report = vi.fn();
    const inner = vi.fn();
    const render = withStrataSsrFailureContract(
      withStrataSsrFailureContract(
        fakeRender((handler) => {
          handler.handleError(new Error("once"));
          return "<html>half</html>";
        }),
        { report: inner },
      ),
      { report },
    );
    const ctx = context();

    await expect(render("/", "", ctx)).resolves.toBe(STRATA_SSR_FAILURE_DOCUMENT);
    expect(report).toHaveBeenCalledTimes(1);
    expect(inner).not.toHaveBeenCalled();
  });

  it("a bootstrap that fails before the handler connects stays a rejection", async () => {
    const reports: StrataSsrFailure[] = [];
    const render = withStrataSsrFailureContract(() => Promise.reject(new RangeError("bootstrap")), {
      report: (failure) => reports.push(failure),
    });
    const ctx = context();

    await render("/", "", ctx);

    expect(ctx.res.statusCode).toBe(500);
    expect(reports).toMatchObject([{ phase: "rejection", errorNames: ["RangeError"] }]);
  });

  it("the request state is non-enumerable while rendering and gone afterwards, on every path", async () => {
    const paths: readonly (() => Promise<string> | string)[] = [
      () => "<html>ok</html>",
      () => Promise.reject(new Error("rejected")),
    ];

    for (const outcome of paths) {
      let seen: readonly (string | symbol)[] | undefined;
      const render = withStrataSsrFailureContract(
        fakeRender((_handler, ctx) => {
          expect(Reflect.get(ctx.res, SLOT)).toBeDefined();
          seen = Object.keys(ctx.res);
          return outcome();
        }),
        { report: () => undefined },
      );
      const ctx = context();

      await render("/", "", ctx);

      expect(seen).not.toContain(SLOT);
      expect(JSON.stringify(ctx.res)).not.toContain("protocol");
      expect(Reflect.has(ctx.res, SLOT)).toBe(false);
    }
  });

  it("does not let a retained contract record into a finished request", async () => {
    let contract: { record(error: unknown): boolean } | undefined;
    const render = withStrataSsrFailureContract(
      fakeRender((_handler, ctx) => {
        contract = Reflect.get(ctx.res, SLOT) as typeof contract;
        return "<html>ok</html>";
      }),
    );
    const ctx = context();

    await render("/", "", ctx);

    expect(contract!.record(new Error("late"))).toBe(false);
    expect(ctx.res.statusCode).toBe(200);
  });

  it("failure, then concurrent success, then failure on one render function stay independent", async () => {
    const render = withStrataSsrFailureContract(
      fakeRender(async (handler, ctx) => {
        await tick();
        if (ctx.req.url === "/fail") handler.handleError(new Error(PRIVATE));
        return "<html>ok</html>";
      }),
      { report: () => undefined },
    );
    const sequence = ["/fail", "/ok", "/ok", "/fail", "/ok"].map((url) => context(url));

    for (const ctx of sequence.slice(0, 1)) await render(ctx.req.url, "", ctx);
    await Promise.all(sequence.slice(1).map((ctx) => render(ctx.req.url, "", ctx)));

    expect(sequence.map((ctx) => ctx.res.statusCode)).toEqual([500, 200, 200, 500, 200]);
  });
});
