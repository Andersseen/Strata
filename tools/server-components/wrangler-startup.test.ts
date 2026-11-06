import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { spawnManaged } from "../analog/lib/process.ts";
import type { ManagedProcess } from "../analog/lib/process.ts";

import { announcedPort, pagesDevArgs, resolveWrangler, startPagesDev } from "./lib/wrangler.ts";

/**
 * CI 42210806375: workerd died with `bind(): Address already in use` because the tools chose port
 * numbers for Wrangler. These tests run the real Wrangler and workerd; only the sockets are staged.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

const until = async (condition: () => boolean, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;

  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return condition();
};

/** Does anything accept a connection on `baseUrl` now? */
const answers = (baseUrl: string): Promise<boolean> =>
  fetch(baseUrl, { signal: AbortSignal.timeout(1_000) }).then(
    () => true,
    () => false,
  );

describe("announcedPort", () => {
  it("reads the port of the ready banner, and nothing else", () => {
    expect(announcedPort("[wrangler:info] Ready on http://127.0.0.1:49733\n")).toBe(49733);
    expect(announcedPort("noise\n⎔ Starting\nReady on https://localhost:8788")).toBe(8788);
    expect(announcedPort("Compiled http://127.0.0.1:3000/ in 2 s")).toBeNull();
    expect(announcedPort("Ready on http://127.0.0.1:0")).toBeNull();
    expect(announcedPort("")).toBeNull();
  });
});

describe("pagesDevArgs", () => {
  it("leaves every socket number to the kernel", () => {
    const args = pagesDevArgs("wrangler.js", "2026-09-21");

    expect(args[args.indexOf("--port") + 1]).toBe("0");
    expect(args[args.indexOf("--inspector-port") + 1]).toBe("0");
    // The banner the port is read from is an info-level message.
    expect(args[args.indexOf("--log-level") + 1]).toBe("info");
  });

  it("only passes a compatibility date when one is given", () => {
    expect(pagesDevArgs("wrangler.js")).not.toContain("--compatibility-date");
  });
});

describe("ManagedProcess.stop", { timeout: 30_000 }, () => {
  const script = (body: string): readonly string[] => ["--input-type=module", "-e", body];
  /** A child of the leader, in its process group, that ignores SIGTERM and reports its pid. */
  const STUBBORN_CHILD = `
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    console.log("child=" + child.pid);
  `;
  const childPid = async (server: ManagedProcess): Promise<number> => {
    await until(() => /child=\d+/.test(server.output()));

    return Number(/child=(\d+)/.exec(server.output())?.[1]);
  };

  it("removes a survivor of a leader that already exited", async () => {
    const server = spawnManaged(process.execPath, script(`${STUBBORN_CHILD} process.exit(1);`), {
      cwd: tmpdir(),
    });
    const pid = await childPid(server);

    expect(await until(() => server.hasExited())).toBe(true);
    expect(alive(pid)).toBe(true);

    await server.stop();

    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("removes a child that outlives the leader's SIGTERM", async () => {
    const server = spawnManaged(
      process.execPath,
      script(`${STUBBORN_CHILD} setInterval(() => {}, 1000);`),
      { cwd: tmpdir() },
    );
    const pid = await childPid(server);

    expect(alive(pid)).toBe(true);

    await server.stop();

    expect(server.hasExited()).toBe(true);
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("can be stopped twice", async () => {
    const server = spawnManaged(process.execPath, script("process.exit(0);"), { cwd: tmpdir() });

    await until(() => server.hasExited());
    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

describe("local workerd startup (real Wrangler)", { timeout: 120_000 }, () => {
  let dir: string;
  let bin: string;
  const start = () => startPagesDev({ bin, cwd: dir, readyPath: "/", timeoutMs: 60_000 });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "strata-wrangler-startup-"));
    bin = resolveWrangler().bin;
    mkdirSync(join(dir, "dist", "analog", "public"), { recursive: true });
    writeFileSync(join(dir, "dist", "analog", "public", "index.html"), "<p>up</p>");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("characterizes the collision: a chosen port that is taken kills workerd", async () => {
    const squatter: Server = createServer();
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const address = squatter.address();
    const taken = address && typeof address === "object" ? address.port : 0;
    const args = pagesDevArgs(bin).map((arg, index, all) =>
      all[index - 1] === "--port" ? String(taken) : arg,
    );
    const server = spawnManaged(process.execPath, args, {
      cwd: dir,
      env: { CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
    });

    try {
      expect(await until(() => server.hasExited(), 60_000)).toBe(true);
      expect(server.output()).toMatch(/Address already in use/);
    } finally {
      await server.stop();
      squatter.close();
    }
  });

  it("starts while the port a previous pick would have chosen is held", async () => {
    // Every socket the kernel hands out here is one workerd cannot be told to use.
    const held: Server[] = await Promise.all(
      Array.from({ length: 64 }, async () => {
        const socket = createServer();
        await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));

        return socket;
      }),
    );

    try {
      const server = await start();

      try {
        expect(await answers(server.baseUrl)).toBe(true);
      } finally {
        await server.stop();
      }
    } finally {
      for (const socket of held) socket.close();
    }
  });

  it("runs simultaneous instances without interference, and stops one alone", async () => {
    const servers = await Promise.all([start(), start(), start()]);

    try {
      expect(new Set(servers.map(({ baseUrl }) => baseUrl)).size).toBe(3);
      for (const { baseUrl } of servers) expect(await answers(baseUrl)).toBe(true);

      await servers[0].stop();

      expect(await answers(servers[0].baseUrl)).toBe(false);
      expect(await answers(servers[1].baseUrl)).toBe(true);
      expect(await answers(servers[2].baseUrl)).toBe(true);
    } finally {
      await Promise.all(servers.map((server) => server.stop()));
    }
  });

  it("starts again immediately after a stop, leaving nothing listening", async () => {
    for (let round = 0; round < 3; round++) {
      const server = await start();

      expect(await answers(server.baseUrl)).toBe(true);
      await server.stop();
      expect(await answers(server.baseUrl)).toBe(false);
    }
  });

  it("fails a real startup error once, with its diagnostics", async () => {
    // A Wrangler that counts its starts and dies for a reason that is not a port.
    const attempts = join(dir, "attempts");
    const fake = join(dir, "fake-wrangler.mjs");

    writeFileSync(
      fake,
      `import { appendFileSync } from "node:fs";
       appendFileSync(${JSON.stringify(attempts)}, "x");
       console.error("the worker threw while starting");
       process.exit(3);`,
    );

    await expect(startPagesDev({ bin: fake, cwd: dir, readyPath: "/" })).rejects.toThrow(
      /Wrangler exited during startup:[\s\S]*the worker threw while starting/,
    );
    expect(readFileSync(attempts, "utf8")).toBe("x");
  });
});
