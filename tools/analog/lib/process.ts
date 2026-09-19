import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";

const OUTPUT_LIMIT = 256 * 1024;

export interface ManagedProcess {
  readonly command: string;
  output(): string;
  hasExited(): boolean;
  stop(): Promise<void>;
}

export interface HttpResult {
  status: number;
  contentType: string | null;
  body: string;
}

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

  return {
    command: `${command} ${args.join(" ")}`,
    output: () => output,
    hasExited: () => exited,
    async stop(): Promise<void> {
      if (exited) return;

      const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));

      signal("SIGTERM");

      const timer = setTimeout(() => signal("SIGKILL"), 5_000);

      await done;
      clearTimeout(timer);
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
