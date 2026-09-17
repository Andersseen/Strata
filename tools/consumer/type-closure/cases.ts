/**
 * SPEC-002 fixed tuple and A–D matrix definitions. Versions here are the
 * spec's mandated pins, not discovered values; the runner asserts actual
 * resolved versions against these constants and reports drift instead of
 * silently substituting a different release.
 */
export const FIXED_VERSIONS = {
  node: "22.23.0",
  pnpm: "10.30.1",
  typescript: "6.0.3",
  typesNode: "22.20.3",
  vite: "8.3.0",
  rolldown: "1.2.8",
  h3: "2.0.1-rc.32",
  srvx: "1.0.5",
  rou3: "0.9.2",
  crossws: "0.4.12",
  typesBun: "1.4.2",
  bunTypes: "1.4.2",
  cloudflareWorkersTypes: "5.20260917.1",
} as const;

const BASE_LIB = ["ES2023", "DOM", "DOM.Iterable", "esnext.decorators"];
const BASE_LIB_WITH_ESNEXT_ERROR = [...BASE_LIB, "esnext.error"];

export interface MatrixCase {
  id: string;
  label: string;
  lib: string[];
  types: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  /**
   * True only for the D variant that lists Bun/Workers packages in
   * `compilerOptions.types`. Per SPEC-002's stop rule, such a candidate is
   * never eligible for the Node contract regardless of its exit code.
   */
  activatesForeignRuntimeTypes: boolean;
  purpose: string;
}

export const MATRIX_CASES: MatrixCase[] = [
  {
    id: "A",
    label: "historical control",
    lib: BASE_LIB,
    types: ["node"],
    dependencies: {},
    devDependencies: {},
    activatesForeignRuntimeTypes: false,
    purpose:
      "Reproduce TS4113 (H3 HTTPError.isError) and TS2307 (crossws) without any Strata source access.",
  },
  {
    id: "B",
    label: "narrow lib",
    lib: BASE_LIB_WITH_ESNEXT_ERROR,
    types: ["node"],
    dependencies: {},
    devDependencies: {},
    activatesForeignRuntimeTypes: false,
    purpose:
      "Prove TS4113 disappears with esnext.error while the independent crossws error remains.",
  },
  {
    id: "C",
    label: "published peer",
    lib: BASE_LIB_WITH_ESNEXT_ERROR,
    types: ["node"],
    dependencies: { crossws: FIXED_VERSIONS.crossws },
    devDependencies: {},
    activatesForeignRuntimeTypes: false,
    purpose:
      "Test whether declaring crossws as an explicit peer alone closes the Node declaration graph.",
  },
  {
    id: "D-node-only",
    label: "provider diagnostic — installed, Node-only types",
    lib: BASE_LIB_WITH_ESNEXT_ERROR,
    types: ["node"],
    dependencies: { crossws: FIXED_VERSIONS.crossws },
    devDependencies: {
      "@types/bun": FIXED_VERSIONS.typesBun,
      "bun-types": FIXED_VERSIONS.bunTypes,
      "@cloudflare/workers-types": FIXED_VERSIONS.cloudflareWorkersTypes,
    },
    activatesForeignRuntimeTypes: false,
    purpose:
      "Install Bun/Workers type providers without activating them, to see whether crossws's own module " +
      "resolution (not `types` inclusion) already leaks them into the Node-only program.",
  },
  {
    id: "D-full-providers",
    label: "provider diagnostic — Node + Bun + Workers types activated",
    lib: BASE_LIB_WITH_ESNEXT_ERROR,
    types: ["node", "bun", "@cloudflare/workers-types"],
    dependencies: { crossws: FIXED_VERSIONS.crossws },
    devDependencies: {
      "@types/bun": FIXED_VERSIONS.typesBun,
      "bun-types": FIXED_VERSIONS.bunTypes,
      "@cloudflare/workers-types": FIXED_VERSIONS.cloudflareWorkersTypes,
    },
    activatesForeignRuntimeTypes: true,
    purpose:
      "Activate Bun and Workers ambient globals alongside Node/DOM. Ineligible for the Node contract " +
      "by SPEC-002's stop rule even if it typechecked cleanly.",
  },
];
