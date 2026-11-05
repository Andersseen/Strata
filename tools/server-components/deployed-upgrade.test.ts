import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  AliasOrigin,
  DEFAULT_UPGRADE_BRANCH,
  UPGRADE_DEPLOY_PROJECT,
  branchAliasUrl,
  buildStamps,
  deployTargetProblems,
  servesBuild,
} from "./lib/deployed-upgrade.ts";

describe("deployment target allowlist", () => {
  it("allows exactly the isolated qualification project on a preview branch", () => {
    expect(
      deployTargetProblems({ project: UPGRADE_DEPLOY_PROJECT, branch: DEFAULT_UPGRADE_BRANCH }),
    ).toEqual([]);
    expect(branchAliasUrl(UPGRADE_DEPLOY_PROJECT, DEFAULT_UPGRADE_BRANCH)).toBe(
      "https://m5-upgrade-rollback.strata-fullstack-qualification.pages.dev",
    );
  });

  it.each(["strata-www", "strata-sc-qualification", "forgecms", "strata-fullstack-qualification2"])(
    "refuses the project %s",
    (project) => {
      expect(deployTargetProblems({ project, branch: DEFAULT_UPGRADE_BRANCH })).not.toEqual([]);
    },
  );

  it("names a protected project as protected", () => {
    expect(deployTargetProblems({ project: "strata-www", branch: "x" })[0]).toMatch(/protected/);
  });

  it.each(["main", "production", "Upper", "has/slash", "a".repeat(29), ""])(
    "refuses the branch %j",
    (branch) => {
      expect(deployTargetProblems({ project: UPGRADE_DEPLOY_PROJECT, branch })).not.toEqual([]);
    },
  );
});

describe("build identity of a served document", () => {
  const doc = (...ids: string[]): string =>
    ids.map((id) => `<product-details data-strata-build="${id}"></product-details>`).join("");

  it("requires at least one stamp and only the expected one", () => {
    expect(buildStamps(doc("a", "b"))).toEqual(["a", "b"]);
    expect(servesBuild(doc("a", "a"), "a")).toBe(true);
    expect(servesBuild(doc("a", "b"), "a")).toBe(false);
    expect(servesBuild("<html>edge 404</html>", "a")).toBe(false);
  });
});

describe("AliasOrigin (local stand-in for a branch alias)", () => {
  const servers: Server[] = [];
  let alias: AliasOrigin | undefined;

  afterEach(async () => {
    await alias?.stop();
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const upstream = async (name: string): Promise<string> => {
    const server = createServer((request, response) => {
      let body = "";

      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        response.setHeader("content-type", "text/plain");
        response.setHeader("set-cookie", [`${name}-one=1; Path=/`, `${name}-two=2; Path=/`]);
        response.end(`${name} ${request.method} ${request.url} ${body}`);
      });
    });

    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const address = server.address();

    return `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  };

  it("answers 404 before the first deployment, then forwards everything to the current one", async () => {
    alias = new AliasOrigin();
    await alias.start();
    expect((await fetch(`${alias.baseUrl}/`)).status).toBe(404);

    const a = await upstream("A");
    const b = await upstream("B");

    alias.point(a);
    expect(await (await fetch(`${alias.baseUrl}/assets/entry.js?x=1`)).text()).toBe(
      "A GET /assets/entry.js?x=1 ",
    );
    expect(
      (await fetch(`${alias.baseUrl}/`)).headers.getSetCookie(),
      "each cookie remains a separate header",
    ).toEqual(["A-one=1; Path=/", "A-two=2; Path=/"]);
    alias.point(b);
    expect(
      await (await fetch(`${alias.baseUrl}/api/echo`, { method: "POST", body: "payload" })).text(),
    ).toBe("B POST /api/echo payload");
  });
});
