import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const OUTPUT_LIMIT = 256 * 1024;

export interface ManagedProcess {
  readonly command: string;
  output(): string;
  hasExited(): boolean;
  /** Stops the process and everything in its group; a survivor after SIGKILL is an error. */
  stop(): Promise<void>;
}

export interface HttpResult {
  status: number;
  contentType: string | null;
  body: string;
}

/**
 * A port that was free a moment ago. It is released before the caller's server binds it, so it
 * only suits a server that binds it at once and opens no other socket first. A server that cannot
 * meet that (Wrangler: see startPagesDev) must bind port 0 and announce the port it got.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Could not determine a free port."));
        }
      });
    });
  });
}

/**
 * Starts a long-running process (a dev or production server) in its own
 * process group, so stopping it also stops anything a package-manager wrapper
 * spawned on its behalf.
 */
/**
 * With `STRATA_DIAGNOSTICS_DIR` set (CI sets it), keeps what a server printed so a failed run can be
 * inspected afterwards: the log is the only record of an SSR error the page itself does not show.
 */
function keepServerLog(command: string, output: string): void {
  const directory = process.env["STRATA_DIAGNOSTICS_DIR"];

  if (!directory) return;

  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(
        directory,
        `server-${Date.now()}-${command.replace(/[^a-z0-9]+/gi, "_").slice(-60)}.log`,
      ),
      output,
    );
  } catch {
    // Diagnostics must never change the result of a run.
  }
}

export function spawnManaged(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): ManagedProcess {
  const child: ChildProcess = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let exited = false;

  const collect = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
  };

  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("exit", () => {
    exited = true;
  });

  const signal = (name: NodeJS.Signals): void => {
    if (child.pid === undefined) return;

    try {
      process.kill(-child.pid, name);
    } catch {
      // The group is already gone.
    }
  };
  const groupAlive = (): boolean => {
    if (child.pid === undefined) return false;

    try {
      process.kill(-child.pid, 0);

      return true;
    } catch {
      return false;
    }
  };
  const groupGone = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;

    while (groupAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    return !groupAlive();
  };

  return {
    command: `${command} ${args.join(" ")}`,
    output: () => output,
    hasExited: () => exited,
    async stop(): Promise<void> {
      if (!exited) {
        const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));

        signal("SIGTERM");

        const timer = setTimeout(() => signal("SIGKILL"), 5_000);

        await done;
        clearTimeout(timer);
      }

      // The leader's exit says nothing about its group: Wrangler can die during startup and leave a
      // workerd behind, holding its sockets into the next phase.
      if (!(await groupGone(2_000))) {
        signal("SIGKILL");
        if (!(await groupGone(2_000))) {
          keepServerLog(`${command} ${args.join(" ")}`, output);
          throw new Error(
            `Process group of "${command}" survived SIGKILL:\n${output.slice(-2_000)}`,
          );
        }
      }

      keepServerLog(`${command} ${args.join(" ")}`, output);
    },
  };
}

export async function httpGet(url: string, timeoutMs = 30_000): Promise<HttpResult> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/** Sends one request with any method; `json` becomes a JSON request body. */
export async function httpRequest(
  url: string,
  init: { method: string; json?: unknown },
  timeoutMs = 30_000,
): Promise<HttpResult> {
  const response = await fetch(url, {
    method: init.method,
    signal: AbortSignal.timeout(timeoutMs),
    ...(init.json === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.json) }),
  });

  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

/**
 * Resolves once `url` answers with any HTTP response. Rejects, carrying the
 * process output, if the server exits first or the deadline passes.
 */
export async function waitForHttp(
  url: string,
  server: ManagedProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (server.hasExited()) {
      throw new Error(`Server exited before answering ${url}:\n${server.output()}`);
    }

    try {
      await httpGet(url, 2_000);

      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Timed out waiting for ${url}:\n${server.output()}`);
}
