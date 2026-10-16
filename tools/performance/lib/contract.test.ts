import { describe, expect, it } from "vitest";

import { ARMS } from "./arms.ts";
import type { ArmId } from "./arms.ts";
import {
  EXPECTED_EVIDENCE,
  MARKERS,
  PAGE_SERVER_MARKERS,
  apiProblems,
  baselineIsolationProblems,
  browserStrataProblems,
  confidentialityProblems,
  expectationsFor,
  lockTuple,
  ssrProblems,
  strataSpecifiersIn,
  tupleMismatches,
} from "./contract.ts";

const arm = (id: ArmId) => ARMS.find((candidate) => candidate.id === id)!;
const ALL = Object.values(MARKERS);

/** A scan in which exactly `server` / `browser` markers were found (in one file each). */
const scan = (server: readonly string[], browser: readonly string[]) => ({
  server: Object.fromEntries(ALL.map((m) => [m, server.includes(m) ? ["s.js"] : []])),
  browser: Object.fromEntries(ALL.map((m) => [m, browser.includes(m) ? ["b.js"] : []])),
});

/** What a correct build of each arm contains. */
const correct = (id: ArmId) => {
  const spec = arm(id);
  const server = [
    ...PAGE_SERVER_MARKERS,
    spec.api === "controller" ? MARKERS.controller : MARKERS.native,
  ];
  const browser = [MARKERS.client, ...(spec.page === "plain" ? PAGE_SERVER_MARKERS : [])];

  return scan(server, browser);
};

describe("arm definitions", () => {
  it("are a 2×2 design over the same application", () => {
    expect(ARMS.map((a) => `${a.id}:${a.page}:${a.api}`)).toEqual([
      "A:plain:native",
      "B:plain:controller",
      "C:server-component:native",
      "D:server-component:controller",
    ]);
  });
});

describe("confidentiality matrix", () => {
  it.each(["A", "B", "C", "D"] as const)("accepts a correct build of arm %s", (id) => {
    expect(confidentialityProblems(arm(id), correct(id))).toEqual([]);
  });

  it("requires the Server Component graph to stay out of the browser (arms C and D)", () => {
    for (const id of ["C", "D"] as const) {
      const good = correct(id);
      const leaked = scan(
        Object.keys(good.server).filter((m) => good.server[m]!.length > 0),
        [MARKERS.client, MARKERS.privateNote],
      );

      expect(confidentialityProblems(arm(id), leaked).join()).toContain(
        `${MARKERS.privateNote} found in the browser output`,
      );
    }
  });

  it("treats the same markers as present in a plain Angular browser graph (scanner positive control)", () => {
    const withoutThem = scan(
      correct("A").server
        ? Object.keys(correct("A").server).filter((m) => correct("A").server[m]!.length)
        : [],
      [MARKERS.client],
    );

    expect(confidentialityProblems(arm("A"), withoutThem).join()).toContain(
      `${MARKERS.privateNote} missing from the browser output`,
    );
  });

  it("rejects a controller that reaches the browser (arms B and D)", () => {
    for (const id of ["B", "D"] as const) {
      const good = correct(id);
      const browser = [
        ...Object.keys(good.browser).filter((m) => good.browser[m]!.length),
        MARKERS.controller,
      ];
      const server = Object.keys(good.server).filter((m) => good.server[m]!.length);

      expect(confidentialityProblems(arm(id), scan(server, browser)).join()).toContain(
        `${MARKERS.controller} found in the browser output`,
      );
    }
  });

  it("rejects a missing server implementation and a missing island", () => {
    const good = correct("D");
    const server = Object.keys(good.server).filter(
      (m) => good.server[m]!.length && m !== MARKERS.implementation,
    );
    const browser = Object.keys(good.browser).filter(
      (m) => good.browser[m]!.length && m !== MARKERS.client,
    );
    const problems = confidentialityProblems(arm("D"), scan(server, browser)).join("\n");

    expect(problems).toContain(`${MARKERS.implementation} missing from the server output`);
    expect(problems).toContain(`${MARKERS.client} missing from the browser output`);
  });

  it("rejects the wrong API implementation in a server graph", () => {
    const wrong = scan(
      [...PAGE_SERVER_MARKERS, MARKERS.native, MARKERS.controller],
      [MARKERS.client, ...PAGE_SERVER_MARKERS],
    );

    expect(confidentialityProblems(arm("A"), wrong).join()).toContain(
      `${MARKERS.controller} found in the server output`,
    );
  });

  it("states a reason for every expectation", () => {
    for (const spec of ARMS)
      for (const e of expectationsFor(spec)) expect(e.reason.length).toBeGreaterThan(10);
  });
});

describe("Strata packages in the browser source maps", () => {
  it("allows only the island runtime, and only in the Server Component arms", () => {
    expect(browserStrataProblems(arm("A"), ["rxjs", "app"])).toEqual([]);
    expect(browserStrataProblems(arm("C"), ["@strata-sc/server-components"])).toEqual([]);
    expect(browserStrataProblems(arm("B"), ["@strata-sc/core"])).toHaveLength(1);
    expect(
      browserStrataProblems(arm("D"), ["@strata-sc/analog", "@strata-sc/server-components"]),
    ).toHaveLength(1);
    expect(browserStrataProblems(arm("A"), ["@strata-sc/server-components"])).toHaveLength(1);
  });
});

describe("baseline isolation", () => {
  const clean = {
    manifestDependencies: { "@angular/core": "22.1.7" },
    sources: { "src/server/catalog.ts": "export const x = 1;" },
    lockKeys: ["", "node_modules/@angular/core"],
    installedScopes: ["@angular"],
    built: { "server/index.mjs": "export {}" },
  };

  it("accepts a baseline without any Strata reference", () => {
    expect(baselineIsolationProblems(clean)).toEqual([]);
  });

  it("rejects a baseline that imports a Strata package", () => {
    const problems = baselineIsolationProblems({
      ...clean,
      sources: { "src/server/catalog.ts": 'import { Controller } from "@strata-sc/core";' },
    });

    expect(problems).toEqual(['src/server/catalog.ts imports "@strata-sc/core"']);
  });

  it("rejects a Strata dependency, lock entry, installed scope or built reference", () => {
    const problems = baselineIsolationProblems({
      manifestDependencies: { "@strata-sc/analog": "file:x.tgz" },
      sources: {},
      lockKeys: ["node_modules/@strata-sc/core"],
      installedScopes: ["@strata-sc"],
      built: { "server/x.mjs": 'import "@strata-sc/analog"' },
    });

    expect(problems).toHaveLength(4);
  });

  it("finds single-quoted, double-quoted and template specifiers", () => {
    expect(
      strataSpecifiersIn(`import "@strata-sc/a"; import('@strata-sc/b/vite'); x(\`@strata-sc/c\`)`),
    ).toHaveLength(3);
    expect(strataSpecifiersIn("// mention of strata-sc without scope")).toEqual([]);
  });
});

describe("dependency tuple", () => {
  const lock = {
    "": { version: "0.0.0" },
    "node_modules/rxjs": { version: "7.8.2", integrity: "sha512-a" },
    "node_modules/@strata-sc/core": { version: "0.2.2", integrity: "sha512-b" },
  };

  it("ignores the root and the Strata tarballs", () => {
    expect(lockTuple(lock)).toEqual({ "node_modules/rxjs": "7.8.2 sha512-a" });
  });

  it("accepts identical tuples", () => {
    const tuple = lockTuple(lock);

    expect(tupleMismatches({ A: tuple, B: { ...tuple }, C: { ...tuple } })).toEqual([]);
  });

  it("rejects a version, integrity or presence mismatch between arms", () => {
    const tuple = lockTuple(lock);

    expect(
      tupleMismatches({ A: tuple, B: { ...tuple, "node_modules/rxjs": "7.8.3 sha512-a" } }),
    ).toHaveLength(1);
    expect(
      tupleMismatches({ A: tuple, B: { ...tuple, "node_modules/extra": "1.0.0 -" } }),
    ).toHaveLength(1);
    expect(tupleMismatches({ A: tuple, B: {} })).toHaveLength(1);
  });

  it("refuses to certify an empty comparison", () => {
    expect(tupleMismatches({})).toEqual(["no dependency tuple recorded"]);
  });
});

describe("response correctness", () => {
  const good = JSON.stringify({ id: "42", name: "Product 42", available: true });

  it("accepts exactly the public JSON contract", () => {
    expect(apiProblems({ status: 200, body: good })).toEqual([]);
  });

  it("rejects errors, fallbacks and wrong shapes", () => {
    expect(apiProblems({ status: 500, body: good })).toEqual(["status 500"]);
    expect(apiProblems({ status: 200, body: "<!DOCTYPE html>" })).toEqual(["body is not JSON"]);
    expect(apiProblems({ status: 200, body: JSON.stringify({ id: "42" }) })).toHaveLength(1);
    expect(
      apiProblems({
        status: 200,
        body: JSON.stringify({ id: "42", name: "Product 42", available: true, extra: 1 }),
      }),
    ).toHaveLength(1);
  });

  const page = `<title>Strata performance baseline</title><article data-evidence="${EXPECTED_EVIDENCE}"><h1>Product 42</h1><p id="server-tier">Tier: premium</p><button type="button" data-product-id="42">Refresh</button><output>Availability: not checked</output></article>`;

  it("accepts the SSR document with server-computed content", () => {
    expect(ssrProblems({ status: 200, body: page })).toEqual([]);
  });

  it("rejects a document the server implementation did not produce", () => {
    expect(ssrProblems({ status: 200, body: page.replace(EXPECTED_EVIDENCE, "0.0.0.0") })).toEqual([
      "server evidence",
    ]);
    expect(
      ssrProblems({ status: 200, body: page.replace("Tier: premium", "Tier: standard") }),
    ).toEqual(["server-computed tier"]);
    expect(ssrProblems({ status: 404, body: page })).toEqual(["status 404"]);
    expect(ssrProblems({ status: 200, body: "<html></html>" }).length).toBeGreaterThan(3);
  });
});
