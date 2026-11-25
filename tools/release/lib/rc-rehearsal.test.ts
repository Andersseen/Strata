import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { applyRehearsalEntry, planRehearsal, readRehearsalInput } from "./rc-rehearsal.ts";
import type { RehearsalInput } from "./rc-rehearsal.ts";
import { countChangesets } from "./release-state.ts";

const NAMES = ["@strata-sc/core", "@strata-sc/analog", "@strata-sc/server-components"] as const;
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const CLI = join(repoRoot, "node_modules", "@changesets", "cli", "bin.js");

const input = (overrides: Partial<RehearsalInput>): RehearsalInput => ({
  pre: undefined,
  versions: ["0.2.2", "0.13.0", "0.17.0"],
  fixed: [],
  pending: 0,
  names: NAMES,
  ...overrides,
});

describe("planRehearsal", () => {
  it("enters pre mode, adds the fixed group and the entry from a 0.x line", () => {
    expect(planRehearsal(input({ pending: 2 }))).toEqual({
      ok: true,
      state: "0.x",
      enterPre: true,
      addFixedGroup: true,
      writeEntry: true,
      writeFix: false,
      previousNext: "0.17.0",
      first: "1.0.0-rc.0",
      next: "1.0.0-rc.1",
    });
  });

  it("never runs `pre enter` on a tree that already entered the RC line", () => {
    const plan = planRehearsal(
      input({ pre: { mode: "pre", tag: "rc" }, fixed: [[...NAMES]], pending: 1 }),
    );

    expect(plan).toMatchObject({ ok: true, state: "entered", enterPre: false, writeEntry: false });
    expect(plan).toMatchObject({ first: "1.0.0-rc.0", next: "1.0.0-rc.1" });
  });

  it("prepares rc.N+1 from an RC line, with a one-package fix and no entry", () => {
    expect(
      planRehearsal(
        input({
          pre: { mode: "pre", tag: "rc" },
          fixed: [[...NAMES]],
          versions: ["1.0.0-rc.3", "1.0.0-rc.3", "1.0.0-rc.3"],
        }),
      ),
    ).toEqual({
      ok: true,
      state: "rc",
      enterPre: false,
      addFixedGroup: false,
      writeEntry: false,
      writeFix: true,
      previousNext: "1.0.0-rc.3",
      first: "1.0.0-rc.4",
      next: "1.0.0-rc.5",
    });
  });

  it.each([
    [
      "a pending pre exit",
      input({ pre: { mode: "exit", tag: "rc" }, fixed: [[...NAMES]], pending: 1 }),
      /pre exit/,
    ],
    ["another pre tag", input({ pre: { mode: "pre", tag: "beta" }, pending: 1 }), /"beta"/],
    [
      "an entry without the fixed group",
      input({ pre: { mode: "pre", tag: "rc" }, pending: 1 }),
      /fixed group/,
    ],
    [
      "pre mode with nothing to version",
      input({ pre: { mode: "pre", tag: "rc" }, fixed: [[...NAMES]] }),
      /no RC-entry Changeset/,
    ],
    [
      "an RC line outside pre mode",
      input({ fixed: [[...NAMES]], versions: ["1.0.0-rc.0", "1.0.0-rc.0", "1.0.0-rc.0"] }),
      /stable/,
    ],
    [
      "a split tuple",
      input({
        pre: { mode: "pre", tag: "rc" },
        fixed: [[...NAMES]],
        versions: ["1.0.0-rc.1", "1.0.0-rc.0", "1.0.0-rc.1"],
      }),
      /not one tuple/,
    ],
    ["a stable version", input({ versions: ["1.0.0", "1.0.0", "1.0.0"] }), /not one tuple/],
  ])("refuses %s instead of repairing it", (_, state, reason) => {
    const plan = planRehearsal(state);
    expect(plan.ok).toBe(false);
    expect(plan.ok ? "" : plan.reason).toMatch(reason);
  });
});

/**
 * The real Changesets 3 CLI on a three-package pnpm workspace shaped like the repository's: the
 * same commands the rehearsal runs, from each state it must accept.
 */
describe("the rehearsal entry against Changesets", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function workspace(versions: readonly string[] = ["0.2.2", "0.13.0", "0.17.0"]): {
    dir: string;
    changeset: (...command: string[]) => string;
    versions: () => string[];
    plan: () => ReturnType<typeof planRehearsal>;
    commit: (message: string) => void;
  } {
    const dir = mkdtempSync(join(tmpdir(), "strata-rc-rehearsal-test-"));
    dirs.push(dir);
    const write = (path: string, value: unknown) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(
        join(dir, path),
        typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
      );
    };
    write("package.json", { name: "rehearsal-root", private: true, version: "0.0.0" });
    write("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
    NAMES.forEach((name, index) => {
      write(`packages/${name.split("/")[1]!}/package.json`, {
        name,
        version: versions[index],
        ...(index === 0 ? {} : { dependencies: { "@strata-sc/core": "workspace:*" } }),
      });
    });
    write(".changeset/config.json", {
      changelog: false,
      commit: false,
      fixed: [],
      linked: [],
      access: "public",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: [],
    });
    write(".changeset/pending-minor.md", '---\n"@strata-sc/analog": minor\n---\n\nA 0.x change.\n');

    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd: dir,
        stdio: "pipe",
      });
    git("init", "--quiet", "--initial-branch=main");
    const commit = (message: string) => {
      git("add", "-A");
      git("commit", "--quiet", "--allow-empty", "-m", message);
    };
    commit("initial");

    const versionsOf = () =>
      NAMES.map(
        (name) =>
          (
            JSON.parse(
              readFileSync(join(dir, "packages", name.split("/")[1]!, "package.json"), "utf8"),
            ) as { version: string }
          ).version,
      );

    return {
      dir,
      changeset: (...command) =>
        execFileSync(process.execPath, [CLI, ...command], {
          cwd: dir,
          stdio: "pipe",
          encoding: "utf8",
          env: { ...process.env, CI: "true" },
          timeout: 60_000,
        }),
      versions: versionsOf,
      plan: () =>
        planRehearsal(
          readRehearsalInput(
            dir,
            NAMES,
            versionsOf(),
            countChangesets(join(dir, ".changeset")).nonEmpty,
          ),
        ),
      commit,
    };
  }

  it("reproduces the scheduled Extended failure: `pre enter` is refused in pre mode", () => {
    const repo = workspace();
    repo.changeset("pre", "enter", "rc");
    repo.commit("entered");

    let output = "";
    try {
      repo.changeset("pre", "enter", "rc");
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string };
      output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
    }
    expect(output).toMatch(/cannot be run when in pre mode/);
  }, 60_000);

  it("rehearses RC0 from a normal 0.x line", () => {
    const repo = workspace();
    const plan = repo.plan();
    if (!plan.ok) throw new Error(plan.reason);

    applyRehearsalEntry(repo.dir, plan, NAMES, (...command) => void repo.changeset(...command));
    repo.changeset("version");

    expect(plan.state).toBe("0.x");
    expect(repo.versions()).toEqual(["1.0.0-rc.0", "1.0.0-rc.0", "1.0.0-rc.0"]);
  }, 60_000);

  it("rehearses RC0 from a tree that already entered pre mode, without `pre enter`", () => {
    const repo = workspace();
    const entry = repo.plan();
    if (!entry.ok) throw new Error(entry.reason);
    applyRehearsalEntry(repo.dir, entry, NAMES, (...command) => void repo.changeset(...command));
    repo.commit("the RC entry, as merged on main");

    const plan = repo.plan();
    if (!plan.ok) throw new Error(plan.reason);
    const calls: string[][] = [];
    applyRehearsalEntry(repo.dir, plan, NAMES, (...command) => {
      calls.push(command);
      repo.changeset(...command);
    });
    repo.changeset("version");

    expect(plan.state).toBe("entered");
    expect(calls).toEqual([]);
    expect(repo.versions()).toEqual(["1.0.0-rc.0", "1.0.0-rc.0", "1.0.0-rc.0"]);
  }, 60_000);

  it("rehearses a subsequent RC from a published RC line", () => {
    const repo = workspace();
    const entry = repo.plan();
    if (!entry.ok) throw new Error(entry.reason);
    applyRehearsalEntry(repo.dir, entry, NAMES, (...command) => void repo.changeset(...command));
    repo.changeset("version");
    repo.commit("version packages (rc.0)");

    const plan = repo.plan();
    if (!plan.ok) throw new Error(plan.reason);
    applyRehearsalEntry(repo.dir, plan, NAMES, (...command) => void repo.changeset(...command));
    repo.changeset("version");

    expect(plan).toMatchObject({ state: "rc", first: "1.0.0-rc.1", previousNext: "1.0.0-rc.0" });
    expect(repo.versions()).toEqual(["1.0.0-rc.1", "1.0.0-rc.1", "1.0.0-rc.1"]);
  }, 60_000);

  it("refuses a tree with a pending `pre exit`, which would version a stable 1.0.0", () => {
    const repo = workspace(["1.0.0-rc.0", "1.0.0-rc.0", "1.0.0-rc.0"]);
    writeFileSync(join(repo.dir, ".changeset", "pre.json"), '{"mode":"exit","tag":"rc"}');

    const plan = repo.plan();
    expect(plan.ok).toBe(false);
  });
});
