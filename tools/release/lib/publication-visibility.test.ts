import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DIST_TAG_VISIBILITY,
  PACKUMENT_PROPAGATION,
  VERSION_VISIBILITY,
  VersionVisibilityLag,
  awaitCompliantDistTags,
  awaitVersionVisible,
  boundMs,
  planDistTags,
} from "./dist-tags.ts";
import {
  createAuthoritativeReader,
  createRegistryReader,
  createTarballIntegrityReader,
  parseVersionDocument,
} from "./registry.ts";
import type { RegistryReader } from "./registry.ts";
import {
  classifyRelease,
  countChangesets,
  verifyPublication,
  verifyPublicationEventually,
} from "./release-state.ts";

/**
 * Release run 42181130222 on a virtual clock. t = 0 is changeset's "Successfully published"
 * (07:30:08); npm's own `time["0.15.0"]` is 07:31:24.522, so the version commits at t = 76 s. The
 * job gave up at 07:30:59 (t = 51 s). The packuments are CDN-cached (`max-age=300`).
 */
const NAME = "@strata-sc/server-components";
const OLD_BOUND = { attempts: 6, firstDelayMs: 2_000, maxDelayMs: 16_000 };
const COMMIT_AT_MS = 76_000;
const CDN_MAX_AGE_MS = 300_000;

const INTEGRITY = "sha512-AAAA";

function timeline(options: { commitAtMs?: number; provenance?: boolean } = {}) {
  const commitAt = options.commitAtMs ?? COMMIT_AT_MS;
  let now = 0;
  const wait = (ms: number) => {
    now += ms;
    return Promise.resolve();
  };
  const committed = () => now >= commitAt;
  const tags = () =>
    committed() ? { latest: "0.15.0", next: "0.14.0" } : { latest: "0.14.0", next: "0.14.0" };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  const fetchImpl = ((input: string | URL) => {
    const url = String(input);

    if (url.endsWith(`/-/package/${NAME.replace("/", "%2f")}/dist-tags`)) {
      return Promise.resolve(json(tags()));
    }
    if (url.endsWith("/0.15.0")) {
      if (!committed()) return Promise.resolve(new Response("version not found", { status: 404 }));
      return Promise.resolve(
        json({
          name: NAME,
          version: "0.15.0",
          dist: {
            integrity: INTEGRITY,
            tarball: "https://registry.npmjs.org/t.tgz",
            ...(options.provenance === false ? {} : { attestations: { provenance: {} } }),
          },
        }),
      );
    }
    // The cached packument: the state of one CDN lifetime ago at best.
    const fresh = now >= commitAt + CDN_MAX_AGE_MS;
    return Promise.resolve(
      json({
        name: NAME,
        "dist-tags": fresh ? { latest: "0.15.0", next: "0.15.0" } : { latest: "0.14.0" },
        versions: { "0.14.0": {}, ...(fresh ? { "0.15.0": {} } : {}) },
      }),
    );
  }) as typeof fetch;

  return { fetchImpl, wait, elapsed: () => now };
}

const pkg = { name: NAME, version: "0.15.0" };
const isVisible = (read: RegistryReader) => async () => {
  const lookup = await read(NAME, "0.15.0");
  return lookup.status === "found" && "0.15.0" in lookup.versions;
};

describe("publication visibility (Release run 42181130222)", () => {
  it("reproduces the failure: the previous bound gives up before npm commits the version", async () => {
    const { fetchImpl, wait, elapsed } = timeline();

    await expect(
      awaitVersionVisible(isVisible(createAuthoritativeReader(fetchImpl)), wait, OLD_BOUND),
    ).rejects.toThrow(VersionVisibilityLag);
    expect(elapsed()).toBeLessThan(COMMIT_AT_MS);
  });

  it("waits through the measured commit delay with the current bound", async () => {
    const { fetchImpl, wait, elapsed } = timeline();

    const reads = await awaitVersionVisible(isVisible(createAuthoritativeReader(fetchImpl)), wait);

    expect(reads).toBeGreaterThan(1);
    expect(elapsed()).toBeGreaterThanOrEqual(COMMIT_AT_MS);
    expect(elapsed()).toBeLessThan(boundMs(VERSION_VISIBILITY));
  });

  it("covers every measured delay with margin, and a whole CDN lifetime for propagation", () => {
    const worstMeasuredCommitMs = 96_000;

    expect(boundMs(VERSION_VISIBILITY)).toBeGreaterThan(worstMeasuredCommitMs * 5);
    expect(boundMs(PACKUMENT_PROPAGATION)).toBeGreaterThan(CDN_MAX_AGE_MS);
    expect(boundMs(DIST_TAG_VISIBILITY)).toBeGreaterThan(8_000);
    // Bounded: a run can never hang on the registry for more than a known time.
    expect(boundMs(VERSION_VISIBILITY)).toBeLessThan(15 * 60_000);
  });

  it("reports a version that never commits as lag with a re-run remedy, never as published", async () => {
    const { fetchImpl, wait } = timeline({ commitAtMs: Number.POSITIVE_INFINITY });

    const failure = await awaitVersionVisible(
      isVisible(createAuthoritativeReader(fetchImpl)),
      wait,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VersionVisibilityLag);
    expect(String(failure)).toMatch(/Do not republish/);
  });

  it("tells a registry outage apart from visibility lag", async () => {
    const failing = (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch;

    const failure = await awaitVersionVisible(
      isVisible(createAuthoritativeReader(failing)),
      () => Promise.resolve(),
      { attempts: 3, firstDelayMs: 1, maxDelayMs: 1 },
    ).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(VersionVisibilityLag);
    expect(String(failure)).toMatch(/unreadable.*503/);
  });

  it("survives transient read failures inside the bound", async () => {
    let reads = 0;
    const flaky = () => {
      reads++;
      if (reads === 1) return Promise.reject(new Error("socket hang up"));
      return Promise.resolve(reads >= 3);
    };

    await expect(awaitVersionVisible(flaky, () => Promise.resolve())).resolves.toBe(3);
  });
});

describe("authoritative decisions against a stale cached packument", () => {
  const committedNow = () => {
    const line = timeline();
    return line.wait(COMMIT_AT_MS).then(() => line);
  };

  it("the cached packument still says unpublished while the authoritative read says committed", async () => {
    const { fetchImpl } = await committedNow();

    const cached = await createRegistryReader(fetchImpl)(NAME, "0.15.0");
    const authoritative = await createAuthoritativeReader(fetchImpl)(NAME, "0.15.0");

    expect(cached.status === "found" && "0.15.0" in cached.versions).toBe(false);
    expect(authoritative.status === "found" && "0.15.0" in authoritative.versions).toBe(true);
  });

  it("never classifies a committed version as PUBLISH_REQUIRED, so a re-run cannot republish", async () => {
    const { fetchImpl } = await committedNow();

    const decision = await classifyRelease({
      changesets: { empty: 0, nonEmpty: 0 },
      packages: [pkg],
      readRegistry: createAuthoritativeReader(fetchImpl),
    });

    expect(decision.state).toBe("ALREADY_PUBLISHED");
  });

  it("plans the recovery from real tags: `next` behind, `latest` untouched", async () => {
    const { fetchImpl } = await committedNow();
    const lookup = await createAuthoritativeReader(fetchImpl)(NAME, "0.15.0");

    expect(lookup.status === "found" && planDistTags(lookup.distTags, "0.15.0")).toEqual([
      { tag: "next", from: "0.14.0", to: "0.15.0" },
    ]);
  });

  it("a stale read can never plan a backward move", () => {
    expect(planDistTags({ latest: "0.15.0", next: "0.16.0-rc.0" }, "0.15.0")).toEqual([]);
    expect(planDistTags({ latest: "0.16.0", next: "0.16.0" }, "0.15.0")).toEqual([]);
  });

  it("the align step reads dist-tags with a Promise and still fails closed", async () => {
    await expect(
      awaitCompliantDistTags(
        () => Promise.resolve({ latest: "0.15.0", next: "0.14.0" }),
        "0.15.0",
        () => Promise.resolve(),
        { attempts: 2, firstDelayMs: 1, maxDelayMs: 1 },
      ),
    ).rejects.toThrow(/out of policy/);
  });

  it("COMMITTED and PROPAGATED are separate verdicts on the same timeline", async () => {
    const { fetchImpl, wait, elapsed } = await committedNow();
    const fast = { attempts: 2, firstDelayMs: 1_000, maxDelayMs: 1_000 };
    const packages = [pkg];

    const propagatedTooSoon = await verifyPublicationEventually(
      () => verifyPublication({ packages, readRegistry: createRegistryReader(fetchImpl) }),
      wait,
      fast,
    );
    expect(propagatedTooSoon.ok).toBe(false);

    const propagated = await verifyPublicationEventually(
      () => verifyPublication({ packages, readRegistry: createRegistryReader(fetchImpl) }),
      wait,
      PACKUMENT_PROPAGATION,
    );
    expect(propagated.ok).toBe(true);
    expect(elapsed()).toBeGreaterThanOrEqual(COMMIT_AT_MS + CDN_MAX_AGE_MS);
  });
});

describe("integrity and provenance of a committed version", () => {
  const committed = (provenance = true) =>
    Promise.resolve(createAuthoritativeReader(timeline({ commitAtMs: 0, provenance }).fetchImpl));
  const tags =
    (reader: RegistryReader): RegistryReader =>
    async (name, version) => {
      const lookup = await reader(name, version);
      return lookup.status === "found"
        ? { ...lookup, distTags: { latest: "0.15.0", next: "0.15.0" } }
        : lookup;
    };

  it("passes with a matching tarball and a provenance attestation", async () => {
    const verdict = await verifyPublication({
      packages: [pkg],
      readRegistry: tags(await committed()),
      readTarballIntegrity: () => Promise.resolve(INTEGRITY),
      requireProvenance: new Set([NAME]),
    });

    expect(verdict).toEqual({ ok: true, problems: [] });
  });

  it("fails at once on a tarball that does not match, without treating it as lag", async () => {
    let reads = 0;
    const verdict = await verifyPublicationEventually(
      () => {
        reads++;
        return committed().then((reader) =>
          verifyPublication({
            packages: [pkg],
            readRegistry: tags(reader),
            readTarballIntegrity: () => Promise.resolve("sha512-BBBB"),
          }),
        );
      },
      () => Promise.resolve(),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.problems[0]).toMatch(/does not match/);
    expect(reads).toBe(1);
  });

  it("fails a just-published version without provenance, and only that one", async () => {
    const reader = tags(await committed(false));

    await expect(
      verifyPublication({
        packages: [pkg],
        readRegistry: reader,
        requireProvenance: new Set([NAME]),
      }),
    ).resolves.toMatchObject({ ok: false, problems: [expect.stringMatching(/no npm provenance/)] });
    await expect(verifyPublication({ packages: [pkg], readRegistry: reader })).resolves.toEqual({
      ok: true,
      problems: [],
    });
  });

  it("reports an unreadable tarball as a problem, never as a pass", async () => {
    const verdict = await verifyPublication({
      packages: [pkg],
      readRegistry: tags(await committed()),
      readTarballIntegrity: () => Promise.reject(new Error("timeout")),
    });

    expect(verdict.problems[0]).toMatch(/tarball unreadable \(timeout\)/);
  });

  it("computes the same SRI value npm records", async () => {
    const bytes = new TextEncoder().encode("hello");
    const reply = (() => Promise.resolve(new Response(bytes))) as typeof fetch;

    await expect(createTarballIntegrityReader(reply)("https://x/t.tgz")).resolves.toBe(
      "sha512-m3HSJL1i83hdltRq0+o9czGb+8KJDKra4t/3JRlnPKcjI8PZm6XBHXx6zG4UuMXaDEZjR1wuXDre9G9zvN7AQw==",
    );
  });

  it("refuses a version document for another package or version, or without dist", () => {
    const dist = { integrity: "sha512-A", tarball: "https://x" };

    expect(() =>
      parseVersionDocument({ name: "other", version: "1.0.0", dist }, NAME, "1.0.0"),
    ).toThrow(/Malformed/);
    expect(() =>
      parseVersionDocument({ name: NAME, version: "2.0.0", dist }, NAME, "1.0.0"),
    ).toThrow(/Malformed/);
    expect(() => parseVersionDocument({ name: NAME, version: "1.0.0" }, NAME, "1.0.0")).toThrow(
      /no dist/,
    );
  });

  it.each([401, 429, 500])(
    "an authoritative read never turns HTTP %i into 'missing'",
    async (status) => {
      const reply = (() => Promise.resolve(new Response(null, { status }))) as typeof fetch;

      await expect(createAuthoritativeReader(reply)(NAME, "0.15.0")).rejects.toThrow(
        String(status),
      );
    },
  );

  it("answers missing only when both the version and the package are 404", async () => {
    const none = (() => Promise.resolve(new Response(null, { status: 404 }))) as typeof fetch;

    await expect(createAuthoritativeReader(none)(NAME, "0.15.0")).resolves.toEqual({
      status: "missing",
    });
  });
});

describe("Changesets pre mode (layout of @changesets/cli 3, measured by the prerelease dry run)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("does not count Changesets a prerelease version moved to .changeset/pre/", () => {
    const changesets = join(mkdtempSync(join(tmpdir(), "strata-pre-")), ".changeset");
    dirs.push(dirname(changesets));
    mkdirSync(join(changesets, "pre"), { recursive: true });
    writeFileSync(join(changesets, "pre.json"), '{"mode":"pre","tag":"rc"}');
    writeFileSync(
      join(changesets, "pre", "consumed.md"),
      '---\n"@strata-sc/core": major\n---\n\nRC.\n',
    );

    expect(countChangesets(changesets)).toMatchObject({ empty: 0, nonEmpty: 0 });

    writeFileSync(join(changesets, "new.md"), '---\n"@strata-sc/core": patch\n---\n\nFix.\n');
    expect(countChangesets(changesets).nonEmpty).toBe(1);
  });
});

describe("stable 1.x guard (General Availability is a separate decision)", () => {
  const none = { empty: 0, nonEmpty: 0 };
  const missing: RegistryReader = () => Promise.resolve({ status: "missing" });

  it.each(["1.0.0", "1.2.3", "2.0.0"])("blocks a stable %s", async (version) => {
    const decision = await classifyRelease({
      changesets: none,
      packages: [{ name: NAME, version }],
      readRegistry: missing,
    });

    expect(decision.state).toBe("BLOCKED");
    expect(decision.reason).toMatch(/STRATA_RELEASE_STABLE_1_0/);
  });

  it.each(["1.0.0-rc.0", "1.0.0-rc.12", "0.16.0"])("publishes %s", async (version) => {
    const decision = await classifyRelease({
      changesets: none,
      packages: [{ name: NAME, version }],
      readRegistry: missing,
    });

    expect(decision.state).toBe("PUBLISH_REQUIRED");
  });

  it("lets a stable version through only with the explicit authorization", async () => {
    const decision = await classifyRelease({
      changesets: none,
      packages: [{ name: NAME, version: "1.0.0" }],
      readRegistry: missing,
      stableAuthorized: true,
    });

    expect(decision.state).toBe("PUBLISH_REQUIRED");
  });

  it("does not block a Version Packages PR, only the publication of its result", async () => {
    const decision = await classifyRelease({
      changesets: { empty: 0, nonEmpty: 1 },
      packages: [{ name: NAME, version: "1.0.0" }],
      readRegistry: missing,
    });

    expect(decision.state).toBe("VERSION_REQUIRED");
  });
});
