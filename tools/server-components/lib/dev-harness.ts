import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { Browser, Page, Request } from "playwright";

import { findFreePort, httpGet, spawnManaged, waitForHttp } from "../../analog/lib/process.ts";
import type { HttpResult, ManagedProcess } from "../../analog/lib/process.ts";

import { check, fixtureDir } from "./harness.ts";

/**
 * Harness of `pnpm test:server-component-dev`
 * (docs/research/server-component-dev-hmr.md): the REAL Analog/Vite dev server
 * on a free port, the files the scenarios edit (restored byte for byte), and
 * a Chromium page whose requests are recorded so a document reload can be told
 * from a module update by what the browser actually did. Private to the repo.
 */

export const DEV_ROUTE = "/server-component-dev";
export const DEV_DIR = join(fixtureDir, "src", "app", "server-component-dev");
export const GENERATED_DIR = join(fixtureDir, "src", "generated", "server-components");
export const PAGE_FILE = join(fixtureDir, "src", "app", "pages", "server-component-dev.page.ts");

/** Synthetic canaries of the dev fixture (`server-component-dev/*.ts`). */
export const CANARIES = {
  shared: "STRATA_DEV_SHARED_CANARY_5B2C9E71D4A8",
  lazy: "STRATA_DEV_LAZY_CANARY_C61F0A9D83E2",
  repository: "STRATA_DEV_REPOSITORY_CANARY_93A4D7B1E605",
} as const;

const SERVER_ONLY_IMPORT = `import "@strata-sc/server-components/server-only";`;
export { SERVER_ONLY_IMPORT };

/** Fixture-relative path under `server-component-dev/`. */
export const devFile = (name: string): string => join(DEV_DIR, name);

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns a truthy value; returns it, or `undefined` after `timeoutMs`. */
export async function until<T>(
  probe: () => T | Promise<T>,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<Exclude<T, false | 0 | "" | null | undefined> | undefined> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();

    if (value) return value as Exclude<T, false | 0 | "" | null | undefined>;
    if (Date.now() >= deadline) return undefined;

    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// The dev server

export interface DevServer {
  readonly baseUrl: string;
  /** The server's console output so far, ANSI stripped. */
  output(): string;
  /** Output produced after `mark()` was called. */
  since(mark: number): string;
  mark(): number;
  stop(): Promise<void>;
  readonly process: ManagedProcess;
}

export async function startDevServer(env: NodeJS.ProcessEnv = {}): Promise<DevServer> {
  const port = await findFreePort();
  const server = spawnManaged(
    "pnpm",
    ["exec", "vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: fixtureDir, env },
  );
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = (): string => stripVTControlCharacters(server.output());

  try {
    await waitForHttp(`${baseUrl}/`, server, 90_000);
  } catch (error) {
    await server.stop();
    throw error;
  }

  return {
    baseUrl,
    output,
    mark: () => output().length,
    since: (mark) => output().slice(mark),
    stop: () => server.stop(),
    process: server,
  };
}

// ---------------------------------------------------------------------------
// Edited files

/**
 * Every source file a scenario edits, creates or deletes, with its original
 * bytes, so `restore()` can put the working tree back even after a failure.
 */
export class Edits {
  private readonly originals = new Map<string, Buffer | null>();

  private remember(path: string): void {
    if (!this.originals.has(path)) {
      this.originals.set(path, existsSync(path) ? readFileSync(path) : null);
    }
  }

  read(path: string): string {
    return readFileSync(path, "utf8");
  }

  /** The contents `path` had before the first edit (`path` must have existed). */
  original(path: string): string {
    const bytes = this.originals.get(path) ?? readFileSync(path);

    if (bytes === null) throw new Error(`${path} did not exist`);

    return bytes.toString("utf8");
  }

  /** Overwrites (or creates) `path`. */
  write(path: string, text: string): void {
    this.remember(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  /** Replaces `from` with `to` in `path`; the file must contain `from`. */
  replace(path: string, from: string, to: string): void {
    const text = readFileSync(path, "utf8");

    if (!text.includes(from)) throw new Error(`${path} does not contain ${JSON.stringify(from)}`);

    this.write(path, text.replace(from, to));
  }

  delete(path: string): void {
    this.remember(path);
    rmSync(path, { force: true });
  }

  /** Puts every touched path back: rewrites originals, removes what did not exist. */
  restore(): void {
    for (const [path, original] of this.originals) {
      if (original === null) rmSync(path, { force: true });
      else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, original);
      }
    }
  }

  /** Whether every touched path is back to its original bytes (and created ones are gone). */
  verifyRestored(): string[] {
    const problems: string[] = [];

    for (const [path, original] of this.originals) {
      const now = existsSync(path) ? readFileSync(path) : null;

      if (original === null ? now !== null : now === null || !now.equals(original)) {
        problems.push(relative(fixtureDir, path));
      }
    }

    return problems;
  }

  get touched(): string[] {
    return [...this.originals.keys()].map((path) => relative(fixtureDir, path));
  }
}

/** Relative path → contents of every file under `dir`. */
export function snapshotDir(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    if (!existsSync(current)) return;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) walk(path);
      else files.set(relative(dir, path), readFileSync(path, "utf8"));
    }
  };

  walk(dir);

  return files;
}

export function sameSnapshot(a: Map<string, string>, b: Map<string, string>): string[] {
  const names = new Set([...a.keys(), ...b.keys()]);

  return [...names].filter((name) => a.get(name) !== b.get(name)).sort();
}

// ---------------------------------------------------------------------------
// The page under test

export interface LoggedResponse {
  readonly seq: number;
  readonly type: string;
  readonly url: string;
  readonly status: number;
  readonly body: string;
}

export interface RequestLog {
  /** Resource type and URL, in the order the browser issued them. */
  readonly entries: { readonly type: string; readonly url: string; status?: number }[];
  /** Script, fetch, xhr and document responses, in arrival order, bodies included. */
  readonly responses: LoggedResponse[];
  /** Every WebSocket frame the page received (the HMR transport), for leak scans only. */
  readonly frames: { readonly seq: number; readonly text: string }[];
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
  /** A position in the shared response/frame sequence; pass it to `logContains`. */
  mark(): number;
}

export interface DevPage {
  readonly page: Page;
  readonly log: RequestLog;
  documentRequests(): number;
  /** Marks the current JS realm; true while it has not been replaced by a document load. */
  markRealm(): Promise<void>;
  realmSurvives(): Promise<boolean>;
  /** The SSR HTML of the route as a plain HTTP client sees it. */
  ssr(): Promise<HttpResult>;
  close(): Promise<void>;
}

declare const window: { __STRATA_DEV_REALM__?: string };

export async function openDevPage(
  browser: Browser,
  server: DevServer,
  route = DEV_ROUTE,
): Promise<DevPage> {
  const context = await browser.newContext();
  const page = await context.newPage();
  let seq = 0;
  const log: RequestLog = {
    entries: [],
    responses: [],
    frames: [],
    consoleErrors: [],
    pageErrors: [],
    mark: () => seq,
  };

  page.on("request", (request: Request) => {
    log.entries.push({ type: request.resourceType(), url: request.url() });
  });
  page.on("response", async (response) => {
    const type = response.request().resourceType();
    const entry = log.entries.findLast((candidate) => candidate.url === response.url());

    if (entry) entry.status = response.status();
    if (["script", "fetch", "xhr", "document"].includes(type)) {
      const body = await response.text().catch(() => "");

      log.responses.push({
        seq: seq++,
        type,
        url: response.url(),
        status: response.status(),
        body,
      });
    }
  });
  page.on("websocket", (socket) => {
    socket.on("framereceived", (frame) =>
      log.frames.push({ seq: seq++, text: String(frame.payload) }),
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") log.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => log.pageErrors.push(error.message));

  await page.goto(`${server.baseUrl}${route}`, { waitUntil: "load" });

  return {
    page,
    log,
    documentRequests: () => log.entries.filter((entry) => entry.type === "document").length,
    markRealm: async () => {
      await page.evaluate(() => {
        window.__STRATA_DEV_REALM__ = "old";
      });
    },
    realmSurvives: async () =>
      (await page.evaluate(() => window.__STRATA_DEV_REALM__ === "old").catch(() => false)) ===
      true,
    ssr: () => httpGet(`${server.baseUrl}${route}`),
    close: async () => {
      await context.close();
    },
  };
}

/** URLs of the responses (and HMR frames) after `since` whose body contains `needle`. */
export function logContains(log: RequestLog, needle: string, since = 0): string[] {
  return [
    ...log.responses
      .filter((response) => response.seq >= since && response.body.includes(needle))
      .map((response) => response.url),
    ...log.frames
      .filter((frame) => frame.seq >= since && frame.text.includes(needle))
      .map(() => "(hmr websocket frame)"),
  ];
}

/** Script requests of the log after position `from`, as paths. */
export function requestsSince(log: RequestLog, from: number): RequestLog["entries"] {
  return log.entries.slice(from);
}

export function strataLogLines(output: string): string[] {
  return output.split("\n").filter((line) => line.includes("[strata]"));
}

/** `check`, but returns the passed flag for aggregation. */
export function expectThat(name: string, passed: boolean, detail = ""): boolean {
  return check(name, passed, detail);
}
