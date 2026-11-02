import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRegistryReader, parsePackument } from "./registry.js";
import type { RegistryLookup, RegistryReader } from "./registry.js";
import {
  classifyRelease,
  countChangesets,
  discardEmptyChangesets,
  isEmptyChangeset,
  verifyPublication,
} from "./release-state.js";
import type { LocalPackage } from "./release-state.js";

const core: LocalPackage = { name: "@strata-sc/core", version: "0.2.2" };
const analog: LocalPackage = {
  name: "@strata-sc/analog",
  version: "0.12.0",
  dependencies: { "@strata-sc/core": "workspace:*" },
};
const sc: LocalPackage = { name: "@strata-sc/server-components", version: "0.14.0" };
const h3: LocalPackage = { name: "@strata-sc/h3", version: "0.1.0", private: true };
const all = [core, analog, sc, h3];

const none = { empty: 0, nonEmpty: 0 };

function found(
  versions: Record<string, Record<string, string>>,
  distTags: Record<string, string>,
): RegistryLookup {
  return {
    status: "found",
    name: "x",
    versions: Object.fromEntries(
      Object.entries(versions).map(([v, dependencies]) => [v, { dependencies }]),
    ),
    distTags,
  };
}

/** Registry holding exactly the given name → lookup; anything else is a 404. */
function registry(state: Record<string, RegistryLookup>): RegistryReader & { calls: string[] } {
  const calls: string[] = [];
  const reader = ((name: string) => {
    calls.push(name);
    return Promise.resolve(state[name] ?? { status: "missing" });
  }) as RegistryReader & { calls: string[] };
  reader.calls = calls;
  return reader;
}

const published = {
  "@strata-sc/core": found({ "0.2.2": {} }, { latest: "0.2.2", next: "0.2.2" }),
  "@strata-sc/analog": found({ "0.12.0": { "@strata-sc/core": "0.2.2" } }, { latest: "0.12.0" }),
};
const withSc = {
  ...published,
  "@strata-sc/server-components": found({ "0.13.0": {} }, { latest: "0.13.0" }),
};

describe("changesets/action gating (the observed failure)", () => {
  // changesets/action@v2 runs its publish script only when no Changeset file
  // exists at all; empty-only files yield hasChangesets=true, "All changesets
  // are empty. Not creating PR" and no publication.
  const actionPublishes = (files: number) => files === 0;

  it("legacy gating skips publishing when only empty Changesets remain", async () => {
    expect(actionPublishes(2)).toBe(false);

    const decision = await classifyRelease({
      changesets: { empty: 2, nonEmpty: 0 },
      packages: all,
      readRegistry: registry(withSc),
    });
    expect(decision.state).toBe("PUBLISH_REQUIRED");
    expect(decision.unpublished).toEqual(["@strata-sc/server-components"]);
  });
});

describe("classifyRelease", () => {
  it("routes pending nonempty Changesets to the Version Packages PR without touching the registry", async () => {
    const reader = registry({});
    const decision = await classifyRelease({
      changesets: { empty: 1, nonEmpty: 1 },
      packages: all,
      readRegistry: reader,
    });
    expect(decision.state).toBe("VERSION_REQUIRED");
    expect(reader.calls).toEqual([]);
  });

  it("publishes when no Changesets exist and a version is unpublished", async () => {
    const decision = await classifyRelease({
      changesets: none,
      packages: all,
      readRegistry: registry(withSc),
    });
    expect(decision.state).toBe("PUBLISH_REQUIRED");
  });

  it("is an explicit no-op when every public version is already on npm", async () => {
    const decision = await classifyRelease({
      changesets: { empty: 2, nonEmpty: 0 },
      packages: all,
      readRegistry: registry({
        ...withSc,
        "@strata-sc/server-components": found({ "0.14.0": {} }, { latest: "0.14.0" }),
      }),
    });
    expect(decision).toMatchObject({ state: "ALREADY_PUBLISHED", unpublished: [] });
  });

  it("reports a partial release and resumes only the missing packages", async () => {
    const decision = await classifyRelease({
      changesets: none,
      packages: all,
      readRegistry: registry({ "@strata-sc/core": published["@strata-sc/core"] }),
    });
    expect(decision.state).toBe("PUBLISH_REQUIRED");
    expect(decision.published).toEqual(["@strata-sc/core"]);
    expect(decision.unpublished).toEqual(["@strata-sc/analog", "@strata-sc/server-components"]);
    expect(decision.reason).toContain("partial release");
  });

  it("treats a never-published package (404) as unpublished", async () => {
    const decision = await classifyRelease({
      changesets: none,
      packages: [sc],
      readRegistry: registry({}),
    });
    expect(decision.state).toBe("PUBLISH_REQUIRED");
  });

  it.each([
    ["timeout", new DOMException("timed out", "TimeoutError")],
    ["authentication failure", new Error("npm registry returned 401 for x.")],
    ["malformed metadata", new Error("Malformed registry metadata: versions is not an object.")],
  ])("blocks on a registry %s instead of reading it as unpublished", async (_label, failure) => {
    const decision = await classifyRelease({
      changesets: none,
      packages: all,
      readRegistry: () => Promise.reject(failure),
    });
    expect(decision.state).toBe("BLOCKED");
    expect(decision.unpublished).toEqual([]);
  });

  it("never selects or queries the private @strata-sc/h3", async () => {
    const reader = registry(withSc);
    const decision = await classifyRelease({
      changesets: none,
      packages: all,
      readRegistry: reader,
    });
    expect(reader.calls).not.toContain("@strata-sc/h3");
    expect([...decision.published, ...decision.unpublished]).not.toContain("@strata-sc/h3");
  });

  it("blocks an unpublished package whose internal dependency range mismatches the workspace", async () => {
    const decision = await classifyRelease({
      changesets: none,
      packages: [core, { ...analog, dependencies: { "@strata-sc/core": "0.1.0" } }],
      readRegistry: registry({ "@strata-sc/core": published["@strata-sc/core"] }),
    });
    expect(decision.state).toBe("BLOCKED");
    expect(decision.reason).toContain("dependency mismatch");
  });

  it("blocks a package still at the placeholder version", async () => {
    const decision = await classifyRelease({
      changesets: none,
      packages: [{ name: "@strata-sc/core", version: "0.0.0" }],
      readRegistry: registry({}),
    });
    expect(decision.state).toBe("BLOCKED");
  });

  it("is idempotent: once published, a repeated run is a no-op", async () => {
    const afterPublish = {
      ...withSc,
      "@strata-sc/server-components": found({ "0.13.0": {}, "0.14.0": {} }, { latest: "0.14.0" }),
    };
    for (let run = 0; run < 2; run++) {
      const decision = await classifyRelease({
        changesets: { empty: 2, nonEmpty: 0 },
        packages: all,
        readRegistry: registry(afterPublish),
      });
      expect(decision.state).toBe("ALREADY_PUBLISHED");
    }
  });
});

describe("Changeset files", () => {
  it("distinguishes empty from nonempty frontmatter", () => {
    expect(isEmptyChangeset("---\n---\n")).toBe(true);
    expect(isEmptyChangeset("---\n---\n\nQualification only.\n")).toBe(true);
    expect(isEmptyChangeset('---\n"@strata-sc/core": patch\n---\n\nFix.\n')).toBe(false);
    expect(() => isEmptyChangeset("no frontmatter")).toThrow();
  });

  it("counts a mixed directory and discards only the empty files", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-changesets-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# docs\n");
    writeFileSync(join(dir, "config.json"), "{}");
    writeFileSync(join(dir, "a.md"), "---\n---\n");
    writeFileSync(join(dir, "b.md"), "---\n---\n");
    writeFileSync(join(dir, "c.md"), '---\n"@strata-sc/core": minor\n---\n\nFeature.\n');

    const counts = countChangesets(dir);
    expect(counts).toMatchObject({ empty: 2, nonEmpty: 1 });

    discardEmptyChangesets(counts.emptyFiles);
    expect(readdirSync(dir).sort()).toEqual(["README.md", "c.md", "config.json"]);
  });
});

describe("verifyPublication", () => {
  const complete = {
    ...published,
    "@strata-sc/server-components": found({ "0.14.0": {} }, { latest: "0.14.0" }),
  };

  it("passes when every public package is on npm with correct dependencies and tags", async () => {
    await expect(
      verifyPublication({ packages: all, readRegistry: registry(complete) }),
    ).resolves.toEqual({ ok: true, problems: [] });
  });

  it("fails a publish step that did nothing (version still missing)", async () => {
    const verdict = await verifyPublication({ packages: all, readRegistry: registry(withSc) });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain(
      "@strata-sc/server-components@0.14.0 is not on the npm registry",
    );
  });

  it("detects a wrong internal dependency version in the published manifest", async () => {
    const verdict = await verifyPublication({
      packages: all,
      readRegistry: registry({
        ...complete,
        "@strata-sc/analog": found(
          { "0.12.0": { "@strata-sc/core": "0.2.1" } },
          { latest: "0.12.0" },
        ),
      }),
    });
    expect(verdict.problems.join()).toContain("depends on @strata-sc/core@0.2.1, expected 0.2.2");
  });

  it("detects off-policy dist-tags, including a stable version missing from latest", async () => {
    const verdict = await verifyPublication({
      packages: all,
      readRegistry: registry({
        ...complete,
        "@strata-sc/server-components": found(
          { "0.14.0": {} },
          { latest: "0.13.0", next: "0.2.0" },
        ),
      }),
    });
    expect(verdict.problems.join()).toContain('"latest" is 0.13.0, expected 0.14.0');
  });

  it("expects prereleases on next", async () => {
    const pre = { name: "@strata-sc/core", version: "1.0.0-rc.1" };
    const ok = await verifyPublication({
      packages: [pre],
      readRegistry: registry({
        "@strata-sc/core": found({ "1.0.0-rc.1": {} }, { latest: "0.2.2", next: "1.0.0-rc.1" }),
      }),
    });
    expect(ok.ok).toBe(true);
    const bad = await verifyPublication({
      packages: [pre],
      readRegistry: registry({
        "@strata-sc/core": found({ "1.0.0-rc.1": {} }, { latest: "0.2.2" }),
      }),
    });
    expect(bad.ok).toBe(false);
  });

  it("fails when the registry cannot be read", async () => {
    const verdict = await verifyPublication({
      packages: [core],
      readRegistry: () => Promise.reject(new Error("socket hang up")),
    });
    expect(verdict.ok).toBe(false);
  });
});

describe("registry reader", () => {
  const body = {
    name: "@strata-sc/core",
    "dist-tags": { latest: "0.2.2" },
    versions: { "0.2.2": { dependencies: { a: "1.0.0" } }, "0.2.1": {} },
  };
  const reply = (status: number, json?: unknown) =>
    (() =>
      Promise.resolve(
        new Response(json === undefined ? null : JSON.stringify(json), { status }),
      )) as typeof fetch;

  it("maps 404 to missing and 200 to parsed metadata", async () => {
    await expect(createRegistryReader(reply(404))("@strata-sc/core")).resolves.toEqual({
      status: "missing",
    });
    await expect(createRegistryReader(reply(200, body))("@strata-sc/core")).resolves.toMatchObject({
      status: "found",
      distTags: { latest: "0.2.2" },
    });
  });

  it.each([401, 403, 429, 500, 503])("throws on HTTP %i", async (status) => {
    await expect(createRegistryReader(reply(status))("@strata-sc/core")).rejects.toThrow(
      String(status),
    );
  });

  it("throws on a network failure and on malformed or mismatched metadata", async () => {
    const failing = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    await expect(createRegistryReader(failing)("@strata-sc/core")).rejects.toThrow("fetch failed");
    expect(() => parsePackument({ name: "other", versions: {} }, "@strata-sc/core")).toThrow();
    expect(() =>
      parsePackument({ name: "@strata-sc/core", versions: [] }, "@strata-sc/core"),
    ).toThrow();
    expect(() =>
      parsePackument(
        { name: "@strata-sc/core", versions: {}, "dist-tags": { latest: 1 } },
        "@strata-sc/core",
      ),
    ).toThrow();
  });
});
