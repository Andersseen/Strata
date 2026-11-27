import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  analogContractSatisfied,
  installedAnalogContract,
  predates,
  predatesSsrEntry,
  predatesSsrProtocol,
} from "./lib/ssr-recipe-bridge.ts";

/**
 * The published-tuple runners adapt to what an installed version contains. A prerelease must
 * exercise every contract the 0.x line introduced, and a published artifact that lacks one it
 * should carry must fail rather than be skipped.
 */

describe("version precedence for capability detection", () => {
  it("places a prerelease before its own release and after every earlier release", () => {
    expect(predates("0.13.0-rc.0", "0.13.0")).toBe(true);
    expect(predates("1.0.0-rc.0", "1.0.0")).toBe(true);
    expect(predates("1.0.0-rc.0", "0.17.0")).toBe(false);
    expect(predates("1.0.0-rc.0", "0.13.0")).toBe(false);
    expect(predates("0.13.0", "0.13.0")).toBe(false);
    expect(predates("0.12.1", "0.13.0")).toBe(true);
    expect(predates("0.17.0", "0.15.0")).toBe(false);
    expect(predates("0.10.0", "0.9.0")).toBe(false);
  });

  it("never treats 1.0.0-rc.N as predating the /ssr entry or its 0.17.0 types", () => {
    for (const version of ["1.0.0-rc.0", "1.0.0-rc.7"]) {
      expect(predatesSsrEntry(version)).toBe(false);
      expect(predatesSsrProtocol(version)).toBe(false);
    }
    expect(predatesSsrEntry("0.14.0")).toBe(true);
    expect(predatesSsrProtocol("0.16.0")).toBe(true);
    expect(predatesSsrProtocol("0.17.0")).toBe(false);
  });
});

describe("installed @strata-sc/analog S-1/S-2 contract", () => {
  const root = mkdtempSync(join(tmpdir(), "strata-analog-contract-"));
  const WITH = [
    "export type ControllerConstructor<T> = new (...args: never[]) => T;",
    "export interface Options { readonly publicOrigin?: string }",
  ].join("\n");
  const WITHOUT = "export declare function registerControllers(router: unknown): void;";

  const installed = (name: string, version: string, declarations: string): string => {
    const dir = join(root, name);

    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ version, exports: { ".": { types: "./dist/index.d.ts" } } }),
    );
    writeFileSync(join(dir, "dist", "index.d.ts"), declarations);

    return dir;
  };

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("requires it from every published version since 0.13.0, the RC included", () => {
    for (const version of ["0.13.0", "1.0.0-rc.0"]) {
      const presence = installedAnalogContract(installed(`declares-${version}`, version, WITH));

      expect(presence).toEqual({ version, declared: true, required: true });
      expect(analogContractSatisfied(presence)).toBe(true);
    }
  });

  it("fails a published RC whose declarations lack it, instead of skipping S-1", () => {
    const presence = installedAnalogContract(installed("rc-missing", "1.0.0-rc.0", WITHOUT));

    expect(presence).toEqual({ version: "1.0.0-rc.0", declared: false, required: true });
    expect(analogContractSatisfied(presence)).toBe(false);
  });

  it("lets only a tuple older than 0.13.0 run without it", () => {
    const presence = installedAnalogContract(installed("old", "0.12.1", WITHOUT));

    expect(presence).toEqual({ version: "0.12.1", declared: false, required: false });
    expect(analogContractSatisfied(presence)).toBe(true);
  });

  it("does not accept half of it: publicOrigin without ControllerConstructor", () => {
    const presence = installedAnalogContract(
      installed(
        "half",
        "1.0.0-rc.0",
        "export interface Options { readonly publicOrigin?: string }",
      ),
    );

    expect(analogContractSatisfied(presence)).toBe(false);
  });
});
