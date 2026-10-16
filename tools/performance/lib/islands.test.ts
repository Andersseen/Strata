import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ARMS, ISLAND_COUNTS, VARIANT_TOKEN, assembleArm, parseIslandCount } from "./arms.ts";
import type { ArmSpec, IslandCount } from "./arms.ts";
import {
  MARKERS,
  boundaryProblems,
  canariesIn,
  canaryProblems,
  clientMarkersFor,
  confidentialityProblems,
  exactJsonProblems,
  expectationsFor,
  islandInteractionProblems,
  islandsFor,
  ssrProblems,
} from "./contract.ts";
import type { IslandObservation } from "./contract.ts";

const spec = (id: string): ArmSpec => ARMS.find((a) => a.id === id)!;
const tarballs = {
  "@strata-sc/core": "/t/core.tgz",
  "@strata-sc/analog": "/t/analog.tgz",
  "@strata-sc/server-components": "/t/sc.tgz",
};

/** A miniature fixture with a one-island layout plus an `islands-3` profile. */
function miniTemplate(): string {
  const root = mkdtempSync(join(tmpdir(), "perf-islands-test-"));
  const put = (path: string, text: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };

  put("common/package.json", JSON.stringify({ dependencies: { h3: "1.0.0" } }));
  put("common/src/repo.ts", `${VARIANT_TOKEN}\n\nexport const x = 1;\n`);
  put("variants/page-plain/src/details.ts", "plain-1");
  put("variants/page-server-component/src/details.ts", "sc-1");
  put("variants/api-native/src/api.ts", "native-1");
  put("variants/api-controller/src/api.ts", "controller-1");
  put("islands-3/common/src/fulfilment.ts", `${VARIANT_TOKEN}\n\nexport const y = 2;\n`);
  put("islands-3/page-plain/src/details.ts", "plain-3");
  put("islands-3/page-server-component/src/details.ts", "sc-3");
  put("islands-3/api-native/src/stock.ts", "native-stock");
  put("islands-3/api-controller/src/api.ts", "controller-3");

  return root;
}

const assemble = (arm: ArmSpec, islands?: IslandCount, template = miniTemplate()) => {
  const destination = mkdtempSync(join(tmpdir(), "perf-islands-out-"));
  const result = assembleArm({
    template,
    destination,
    arm,
    tarballs,
    ...(islands === undefined ? {} : { islands }),
  });

  return { destination, ...result };
};
const text = (dir: string, path: string): string => readFileSync(join(dir, path), "utf8");

describe("island count", () => {
  it("defaults to one when unset or empty", () => {
    expect(parseIslandCount(undefined)).toBe(1);
    expect(parseIslandCount("")).toBe(1);
  });

  it("accepts exactly the listed profiles", () => {
    expect(ISLAND_COUNTS).toEqual([1, 3]);
    expect(parseIslandCount("1")).toBe(1);
    expect(parseIslandCount("3")).toBe(3);
  });

  it.each(["0", "2", "4", "-1", "abc", "1.5", "999", "3x"])("rejects %s", (value) => {
    expect(() => parseIslandCount(value)).toThrow(/STRATA_PERF_ISLANDS/);
  });
});

describe("assembleArm with islands", () => {
  it("is byte-identical to the one-island assembly when islands is 1 or omitted", () => {
    const template = miniTemplate();
    const implicit = assemble(spec("D"), undefined, template);
    const explicit = assemble(spec("D"), 1, template);

    expect(explicit.files).toEqual(implicit.files);
    expect(text(explicit.destination, "src/details.ts")).toBe("sc-1");
    expect(existsSync(join(explicit.destination, "src/fulfilment.ts"))).toBe(false);
  });

  it("places the same profile files in all four arms and the profile's own page and API", () => {
    const template = miniTemplate();

    for (const arm of ARMS) {
      const { destination, files } = assemble(arm, 3, template);

      expect(files).toContain("src/fulfilment.ts");
      expect(text(destination, "src/details.ts")).toBe(arm.page === "plain" ? "plain-3" : "sc-3");
      expect(text(destination, "src/api.ts")).toBe(
        arm.api === "controller" ? "controller-3" : "native-1",
      );
      expect(existsSync(join(destination, "src/stock.ts"))).toBe(arm.api === "native");
    }
  });

  it("keeps the baseline free of Strata at three islands, and installs packages per arm", () => {
    const template = miniTemplate();

    expect(Object.keys(assemble(spec("A"), 3, template).dependencies)).toEqual(["h3"]);
    expect(Object.keys(assemble(spec("B"), 3, template).dependencies)).toEqual([
      "h3",
      "@strata-sc/core",
      "@strata-sc/analog",
    ]);
    expect(Object.keys(assemble(spec("C"), 3, template).dependencies)).toEqual([
      "h3",
      "@strata-sc/server-components",
    ]);
    expect(Object.keys(assemble(spec("D"), 3, template).dependencies)).toHaveLength(4);
  });

  it("resolves the server-only token in profile files only for Server Component arms", () => {
    const template = miniTemplate();

    expect(text(assemble(spec("C"), 3, template).destination, "src/fulfilment.ts")).toContain(
      "server-only",
    );
    expect(text(assemble(spec("B"), 3, template).destination, "src/fulfilment.ts")).not.toContain(
      "server-only",
    );
  });

  it("never lets a profile file replace a common file", () => {
    const template = miniTemplate();

    writeFileSync(join(template, "islands-3", "page-plain", "package.json"), "{}");
    expect(() => assemble(spec("A"), 3, template)).toThrow(/overrides another file: package.json/);
  });

  it("still refuses an overlap between two ordinary variants", () => {
    const template = miniTemplate();

    writeFileSync(join(template, "variants", "api-native", "src", "details.ts"), "dup");
    expect(() => assemble(spec("A"), 1, template)).toThrow(/overrides another file/);
  });

  it("rejects the object-return diagnostic outside the one-island profile", () => {
    expect(() =>
      assembleArm({
        template: miniTemplate(),
        destination: mkdtempSync(join(tmpdir(), "perf-islands-out-")),
        arm: spec("A"),
        tarballs,
        nativeStyle: "object",
        islands: 3,
      }),
    ).toThrow(/one-island/);
  });
});

// ---------------------------------------------------------------------------

const ssrHtml = (
  opts: { strata: boolean; selectors?: string[]; extra?: string } = { strata: true },
) => {
  const selectors = opts.selectors ?? ["product-availability", "product-stock", "product-delivery"];
  const initial: Record<string, string> = {
    "product-availability": "Availability: not checked",
    "product-stock": "Stock: not checked",
    "product-delivery": "Delivery: not estimated",
  };

  return `<title>Strata performance baseline</title><article data-evidence="x"><h1>Product 42</h1>${selectors
    .map(
      (s) =>
        `<${s}${opts.strata ? ` data-strata-client="${s}" data-strata-protocol="1" data-strata-props="{&quot;productId&quot;:&quot;42&quot;}"` : ""}><button data-product-id="42">go</button><output>${initial[s]}</output></${s}>`,
    )
    .join("")}${opts.extra ?? ""}</article>`;
};

describe("boundaryProblems", () => {
  it("accepts one boundary per island with distinct identities", () => {
    expect(boundaryProblems(ssrHtml(), true, 3)).toEqual([]);
    expect(
      boundaryProblems(ssrHtml({ strata: true, selectors: ["product-availability"] }), true, 1),
    ).toEqual([]);
  });

  it("expects no boundary at all in a plain-Angular arm", () => {
    expect(boundaryProblems(ssrHtml({ strata: false }), false, 3)).toEqual([]);
    expect(boundaryProblems(ssrHtml(), false, 3)).toContain("unexpected Strata boundary");
  });

  it("rejects a missing island", () => {
    const html = ssrHtml({ strata: true, selectors: ["product-availability", "product-delivery"] });

    expect(boundaryProblems(html, true, 3)).toEqual(
      expect.arrayContaining(["2 boundaries, expected 3", "no boundary for product-stock"]),
    );
  });

  it("rejects two islands sharing a boundary identity", () => {
    const html = ssrHtml().replace(
      'data-strata-client="product-stock"',
      'data-strata-client="product-delivery"',
    );

    expect(boundaryProblems(html, true, 3)).toEqual(
      expect.arrayContaining([expect.stringContaining("duplicate boundary identity")]),
    );
  });

  it("rejects a private canary in serialized props", () => {
    const html = ssrHtml().replace("&quot;productId&quot;", MARKERS.privateWarehouse);

    expect(boundaryProblems(html, true, 3)).toContain("a private canary is in a boundary's props");
  });
});

describe("ssrProblems by island count", () => {
  const goodOne = [
    "<title>Strata performance baseline</title>",
    "<h1>Product 42</h1>",
    '<p id="server-tier">Tier: premium</p>',
    '<button data-product-id="42">x</button>',
    "Availability: not checked",
  ];

  it("leaves the one-island contract exactly as before", () => {
    const body = `${goodOne.join("")}<x data-evidence="${"EVIDENCE"}">`;

    expect(ssrProblems({ status: 200, body }, 1)).toEqual(["server evidence"]);
    expect(ssrProblems({ status: 200, body })).toEqual(["server evidence"]);
  });

  it("additionally requires every island, the region and the fulfilment evidence at three", () => {
    const problems = ssrProblems({ status: 200, body: goodOne.join("") }, 3);

    expect(problems).toEqual(
      expect.arrayContaining([
        "product-stock is not rendered exactly once",
        "product-delivery is not rendered exactly once",
        "three island buttons",
        "server-chosen region",
        "fulfilment server evidence",
      ]),
    );
  });

  it("rejects a duplicated island at three", () => {
    const body = ssrHtml({
      strata: false,
      selectors: ["product-availability", "product-stock", "product-stock", "product-delivery"],
    });

    expect(ssrProblems({ status: 200, body }, 3)).toContain(
      "product-stock is not rendered exactly once",
    );
  });
});

describe("island expectations", () => {
  it("lists one client marker at one island and three at three", () => {
    expect(clientMarkersFor(1)).toHaveLength(1);
    expect(clientMarkersFor(3)).toEqual([
      MARKERS.client,
      MARKERS.stockClient,
      MARKERS.deliveryClient,
    ]);
    expect(islandsFor(3).map((i) => i.selector)).toEqual([
      "product-availability",
      "product-stock",
      "product-delivery",
    ]);
    expect(new Set(islandsFor(3).map((i) => i.clientMarker)).size).toBe(3);
  });

  it("adds the fulfilment server markers only at three islands", () => {
    const markers = (n: IslandCount) =>
      expectationsFor(spec("D"), n)
        .filter((e) => e.where === "server")
        .map((e) => e.marker);

    expect(markers(1)).not.toContain(MARKERS.privateWarehouse);
    expect(markers(3)).toContain(MARKERS.privateWarehouse);
  });

  const scanFor = (arm: string, islands: IslandCount, browserHas: string[] = []) => {
    const present = expectationsFor(spec(arm), islands);
    const make = (where: "server" | "browser") =>
      Object.fromEntries(
        present
          .filter((e) => e.where === where && e.present)
          .map((e) => [e.marker, ["file.js"]] as const),
      );
    const browser = make("browser");

    for (const marker of browserHas) browser[marker] = ["leak.js"];

    return { server: make("server"), browser };
  };

  it("accepts the expected scan of every arm at three islands", () => {
    for (const arm of ARMS) expect(confidentialityProblems(arm, scanFor(arm.id, 3), 3)).toEqual([]);
  });

  it("detects a server-only canary leaked into a browser chunk of a Server Component arm", () => {
    const problems = confidentialityProblems(
      spec("D"),
      scanFor("D", 3, [MARKERS.privateWarehouse]),
      3,
    );

    expect(problems.join(";")).toContain(`${MARKERS.privateWarehouse} found in the browser output`);
  });

  it("treats the canary in a plain-Angular browser as the expected scanner control", () => {
    expect(
      confidentialityProblems(spec("A"), scanFor("A", 3), 3).some((p) => p.includes("found in")),
    ).toBe(false);
  });

  it("detects a missing second island in the browser output", () => {
    const scan = scanFor("C", 3);
    const browser = { ...scan.browser };

    delete browser[MARKERS.stockClient];
    expect(confidentialityProblems(spec("C"), { ...scan, browser }, 3)).toEqual([
      expect.stringContaining(`${MARKERS.stockClient} missing from the browser output`),
    ]);
  });
});

describe("canaries and API bodies", () => {
  it("finds every private canary and nothing public", () => {
    expect(
      canariesIn(`a ${MARKERS.privateNote} ${MARKERS.privateWarehouse} ${MARKERS.privateCost}`),
    ).toHaveLength(3);
    expect(canariesIn(`{"id":"42","units":12}`)).toEqual([]);
    expect(canaryProblems("API response", MARKERS.privateWarehouse)).toEqual([
      `API response exposes ${MARKERS.privateWarehouse}`,
    ]);
  });

  it("requires exactly the public JSON object", () => {
    const expected = { id: "42", units: 12 };

    expect(exactJsonProblems({ status: 200, body: '{"id":"42","units":12}' }, expected)).toEqual(
      [],
    );
    expect(
      exactJsonProblems({ status: 200, body: '{"id":"42","units":12,"cost":1}' }, expected),
    ).toHaveLength(1);
    expect(
      exactJsonProblems({ status: 200, body: '{"id":"42","units":13}' }, expected),
    ).toHaveLength(1);
    expect(exactJsonProblems({ status: 500, body: "" }, expected)).toEqual(["status 500"]);
    expect(exactJsonProblems({ status: 200, body: "nope" }, expected)).toEqual([
      "body is not JSON",
    ]);
  });
});

describe("islandInteractionProblems", () => {
  const specs = islandsFor(3);
  const finalStatuses = (upTo: number): Record<string, string> =>
    Object.fromEntries(specs.map((s, i) => [s.id, i <= upTo ? s.afterClick : s.initial]));
  const good = (): IslandObservation[] =>
    specs.map((s, i) => ({
      id: s.id,
      count: 1,
      reused: true,
      before: s.initial,
      statusesAfterClick: finalStatuses(i),
      requests: 1,
    }));
  const withOverride = (index: number, patch: Partial<IslandObservation>): IslandObservation[] =>
    good().map((o, i) => (i === index ? { ...o, ...patch } : o));

  it("accepts three hydrated, independently updating islands", () => {
    expect(islandInteractionProblems(specs, good())).toEqual([]);
  });

  it("rejects a missing island", () => {
    expect(islandInteractionProblems(specs, good().slice(0, 2))).toEqual([
      "delivery: island missing from the page",
    ]);
    expect(islandInteractionProblems(specs, withOverride(1, { count: 0 }))).toContain(
      "stock: island missing from the page",
    );
  });

  it("rejects a duplicated island", () => {
    expect(islandInteractionProblems(specs, withOverride(1, { count: 2 }))).toContain(
      "stock: duplicate island (2 elements)",
    );
  });

  it("rejects hydration that did not reuse the SSR nodes", () => {
    expect(islandInteractionProblems(specs, withOverride(2, { reused: false }))).toEqual([
      "delivery: hydration did not reuse the SSR nodes",
    ]);
  });

  it("rejects a button that issued no request, or more than one", () => {
    expect(islandInteractionProblems(specs, withOverride(1, { requests: 0 }))).toContain(
      "stock: 0 API request(s), expected exactly 1",
    );
    expect(islandInteractionProblems(specs, withOverride(1, { requests: 2 }))).toContain(
      "stock: 2 API request(s), expected exactly 1",
    );
  });

  it("rejects an island whose state did not update", () => {
    const stuck = { ...finalStatuses(1), stock: "Stock: network error" };

    expect(
      islandInteractionProblems(specs, withOverride(1, { statusesAfterClick: stuck })),
    ).toEqual(['stock click: stock shows "Stock: network error", expected "Stock: 12 units"']);
  });

  it("rejects one island's click corrupting another island's state", () => {
    const corrupted = { ...finalStatuses(0), delivery: "Delivery: 3 days" };

    expect(
      islandInteractionProblems(specs, withOverride(0, { statusesAfterClick: corrupted })),
    ).toEqual([
      'availability click: delivery shows "Delivery: 3 days", expected "Delivery: not estimated"',
    ]);
  });

  it("rejects a wrong initial state", () => {
    expect(
      islandInteractionProblems(specs, withOverride(0, { before: "Availability: available" })),
    ).toEqual(['availability: initial state "Availability: available"']);
  });
});
