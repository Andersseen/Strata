import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the non-publishing prerelease rehearsal starts from. Until 2026-11 it always performed the
 * RC entry itself and ran `changeset pre enter rc`, which Changesets refuses on a tree that is
 * already in pre mode ("pre enter cannot be run when in pre mode"). Once the entry reached `main`,
 * every scheduled Extended run failed (42617736998, 43866421681, 45189500731), and a superseding
 * `rc.N+1` could never be rehearsed.
 *
 * The rehearsal now reads the tree it was given and performs only the steps that tree still needs:
 *
 * | Tree                                   | Entry it performs                         | First version |
 * | -------------------------------------- | ----------------------------------------- | ------------- |
 * | `0.x`, not in pre mode                 | fixed group, major for all, `pre enter rc` | `1.0.0-rc.0`  |
 * | `0.x`, in `rc` pre mode (entry merged) | none: the pending entry is what is tested  | `1.0.0-rc.0`  |
 * | `1.0.0-rc.N`, in `rc` pre mode         | none; a one-package patch Changeset        | `1.0.0-rc.N+1`|
 *
 * Anything else (another pre tag, a pending `pre exit`, a split tuple, an entry without the fixed
 * group) is refused rather than repaired: the rehearsal must prove what the repository would do.
 */

export type RehearsalState = "0.x" | "entered" | "rc";

export interface PreModeFile {
  readonly mode: string;
  readonly tag: string;
}

export interface RehearsalInput {
  /** `.changeset/pre.json`, when present. */
  readonly pre: PreModeFile | undefined;
  /** Manifest versions of the RC packages, in `names` order. */
  readonly versions: readonly string[];
  /** `.changeset/config.json` `fixed`. */
  readonly fixed: readonly (readonly string[])[];
  /** Nonempty Changesets pending in `.changeset/`. */
  readonly pending: number;
  readonly names: readonly string[];
}

export type RehearsalPlan =
  | {
      readonly ok: true;
      readonly state: RehearsalState;
      readonly enterPre: boolean;
      readonly addFixedGroup: boolean;
      readonly writeEntry: boolean;
      readonly writeFix: boolean;
      /** The `next` dist-tag before the first rehearsed version. */
      readonly previousNext: string;
      readonly first: string;
      readonly next: string;
    }
  | { readonly ok: false; readonly reason: string };

const ZERO = /^0\.\d+\.\d+$/;
const RC = /^1\.0\.0-rc\.(\d+)$/;

const sameMembers = (group: readonly string[], names: readonly string[]): boolean =>
  group.length === names.length && names.every((name) => group.includes(name));

export function planRehearsal(input: RehearsalInput): RehearsalPlan {
  const { pre, versions, fixed, pending, names } = input;
  const refuse = (reason: string): RehearsalPlan => ({ ok: false, reason });
  const grouped = fixed.some((group) => sameMembers(group, names));

  if (versions.length !== names.length || versions.length === 0) {
    return refuse(
      `expected ${String(names.length)} RC package versions, read ${String(versions.length)}`,
    );
  }
  if (pre && pre.mode !== "pre") {
    return refuse(
      `.changeset/pre.json is in mode "${pre.mode}": a pending \`changeset pre exit\` would version stable releases`,
    );
  }
  if (pre && pre.tag !== "rc") {
    return refuse(`.changeset/pre.json uses tag "${pre.tag}", not "rc"`);
  }

  if (versions.every((version) => ZERO.test(version))) {
    if (!pre) {
      const highest = [...versions].sort((a, b) => compareZero(b, a))[0]!;
      return {
        ok: true,
        state: "0.x",
        enterPre: true,
        addFixedGroup: !grouped,
        writeEntry: true,
        writeFix: false,
        previousNext: highest,
        first: "1.0.0-rc.0",
        next: "1.0.0-rc.1",
      };
    }
    if (!grouped) return refuse("the RC entry is in pre mode without the fixed group of all three");
    if (pending === 0) return refuse("pre mode was entered, but no RC-entry Changeset is pending");
    const highest = [...versions].sort((a, b) => compareZero(b, a))[0]!;
    return {
      ok: true,
      state: "entered",
      enterPre: false,
      addFixedGroup: false,
      writeEntry: false,
      writeFix: false,
      previousNext: highest,
      first: "1.0.0-rc.0",
      next: "1.0.0-rc.1",
    };
  }

  const candidates = versions.map((version) => RC.exec(version)?.[1]);
  if (candidates.every((n) => n !== undefined) && new Set(candidates).size === 1) {
    if (!pre) {
      return refuse(
        `the packages are at ${versions[0]!} outside pre mode: the next version would be stable`,
      );
    }
    if (!grouped) return refuse("the RC line has no fixed group of all three");
    const n = Number(candidates[0]);
    return {
      ok: true,
      state: "rc",
      enterPre: false,
      addFixedGroup: false,
      writeEntry: false,
      writeFix: true,
      previousNext: versions[0]!,
      first: `1.0.0-rc.${String(n + 1)}`,
      next: `1.0.0-rc.${String(n + 2)}`,
    };
  }

  return refuse(`the RC packages are not one tuple: ${versions.join(", ")}`);
}

function compareZero(a: string, b: string): number {
  const [, am = 0, ap = 0] = a.split(".").map(Number);
  const [, bm = 0, bp = 0] = b.split(".").map(Number);
  return am - bm || ap - bp;
}

/** Reads a checkout's rehearsal input. `pending` comes from the caller's Changeset counter. */
export function readRehearsalInput(
  dir: string,
  names: readonly string[],
  versions: readonly string[],
  pending: number,
): RehearsalInput {
  const prePath = join(dir, ".changeset", "pre.json");
  const config = JSON.parse(readFileSync(join(dir, ".changeset", "config.json"), "utf8")) as {
    fixed?: string[][];
  };

  return {
    pre: existsSync(prePath)
      ? (JSON.parse(readFileSync(prePath, "utf8")) as PreModeFile)
      : undefined,
    versions,
    fixed: config.fixed ?? [],
    pending,
    names,
  };
}

/**
 * Performs the entry steps the plan asks for in a throwaway checkout, never in the repository:
 * the fixed group, the RC-entry or fix Changeset, and `changeset pre enter rc` only when the tree
 * is not in pre mode yet. `changeset` runs the Changesets CLI in that checkout.
 */
export function applyRehearsalEntry(
  dir: string,
  plan: Extract<RehearsalPlan, { ok: true }>,
  names: readonly string[],
  changeset: (...command: string[]) => void,
): void {
  const changesetDir = join(dir, ".changeset");

  if (plan.addFixedGroup) {
    const configPath = join(changesetDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, fixed: [names] }, null, 2));
  }
  if (plan.writeEntry) {
    writeFileSync(
      join(changesetDir, "rehearsal-rc-entry.md"),
      `---\n${names.map((name) => `"${name}": major`).join("\n")}\n---\n\nFirst release candidate.\n`,
    );
  }
  if (plan.writeFix) {
    writeFileSync(
      join(changesetDir, "rehearsal-rc-fix.md"),
      `---\n"${names[1] ?? names[0]!}": patch\n---\n\nRehearsed fix.\n`,
    );
  }
  if (plan.enterPre) changeset("pre", "enter", "rc");
}
