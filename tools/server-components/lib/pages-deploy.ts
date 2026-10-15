import { join } from "node:path";

import { run } from "../../consumer/lib/exec.ts";

import { COMPATIBILITY_DATE } from "./wrangler.ts";

/**
 * `wrangler pages deploy` of a built consumer to ONE named Pages project, with the
 * consumer's own wrangler. Credentials are passed by the caller in `env` for these
 * commands only; every returned string is redacted by the caller-supplied function.
 */

export interface PagesDeployment {
  readonly ok: boolean;
  readonly created: boolean;
  readonly url?: string;
  /** The deployment hash subdomain wrangler prints. */
  readonly hash?: string;
  /** The Cloudflare deployment UUID, when the deployment list could be read. */
  readonly id?: string;
  readonly output: string;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export function deployToPages(options: {
  readonly consumerDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly project: string;
  readonly branch: string;
  readonly outputDirectory: string;
  readonly redact: (text: string) => string;
}): PagesDeployment {
  const { consumerDir, env, project, branch, redact } = options;
  const wrangler = (args: readonly string[]) =>
    run(
      process.execPath,
      [join(consumerDir, "node_modules", "wrangler", "bin", "wrangler.js"), ...args],
      {
        cwd: consumerDir,
        env: { ...env, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
      },
    );

  // Idempotent: an existing project is fine, anything else is not.
  const created = wrangler([
    "pages",
    "project",
    "create",
    project,
    "--production-branch",
    "main",
    "--compatibility-date",
    COMPATIBILITY_DATE,
  ]);
  const createdOut = redact(`${created.stdout}\n${created.stderr}`);
  const exists = createdOut.includes("A project with this name already exists");

  if (created.status !== 0 && !exists) {
    return { ok: false, created: false, output: createdOut.slice(-800) };
  }

  const deploy = wrangler([
    "pages",
    "deploy",
    options.outputDirectory,
    "--project-name",
    project,
    "--branch",
    branch,
    "--commit-dirty=true",
  ]);
  const output = redact(`${deploy.stdout}\n${deploy.stderr}`);
  const match = new RegExp(`https://([a-z0-9]+)\\.${escape(project)}\\.pages\\.dev`).exec(output);

  if (deploy.status !== 0 || !match) {
    return { ok: false, created: created.status === 0, output: output.slice(-800) };
  }

  // Best effort: the deployment UUID, to tie the evidence to the Cloudflare record.
  let id: string | undefined;

  try {
    const listed = wrangler([
      "pages",
      "deployment",
      "list",
      "--project-name",
      project,
      "--environment",
      "preview",
      "--json",
    ]);
    const entries = JSON.parse(listed.stdout || "[]") as Record<string, unknown>[];
    const entry = entries.find((candidate) => JSON.stringify(candidate).includes(match[1]!));
    const found = UUID.exec(JSON.stringify(entry?.["Id"] ?? entry?.["id"] ?? ""));

    id = found?.[0];
  } catch {
    id = undefined;
  }

  return {
    ok: true,
    created: created.status === 0,
    url: match[0],
    hash: match[1]!,
    ...(id ? { id } : {}),
    output: output.slice(-400),
  };
}
