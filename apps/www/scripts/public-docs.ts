import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Public documentation of the official website, generated from the repository's own Markdown, so
 * no page has a second, drifting copy. `docs/` stays the source for Entwine; this selects what
 * readers may see. Internal reports, risks and state are deliberately not published: a link to
 * one becomes a link to the file on GitHub.
 *
 *   node --experimental-strip-types scripts/public-docs.ts          write the pages
 *   node --experimental-strip-types scripts/public-docs.ts --check  fail if they are stale
 */

const GITHUB_BLOB = "https://github.com/Andersseen/Strata/blob/main";
const BASE_PATH = "/docs";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const contentDir = join(repoRoot, "apps", "www", "src", "content", "docs");

interface PublicPage {
  /** The repository file this page is generated from. */
  readonly source: string;
  /** Path below the content directory, without `.md`; also the public URL. */
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly group: string;
  readonly order: number;
  /** Only these `##` sections of the source, in this order. Default: the whole file. */
  readonly sections?: readonly string[];
  /** `##` sections left out: repository maintenance, not reader documentation. */
  readonly omit?: readonly string[];
}

export const PUBLIC_PAGES: readonly PublicPage[] = [
  {
    source: "docs/GETTING-STARTED.md",
    slug: "getting-started",
    title: "Getting started",
    description: "What Strata publishes, what it needs, and where to begin.",
    group: "Start here",
    order: 1,
    omit: ["Maintaining these docs"],
  },
  {
    source: "docs/COMPATIBILITY.md",
    slug: "compatibility",
    title: "Compatibility",
    description: "What Strata supports today, and the versioning rules before 1.0.",
    group: "Start here",
    order: 2,
    sections: ["RC0 support contract", "Versioning, deprecation and migration policy (pre-1.0)"],
  },
  {
    source: "packages/server-components/README.md",
    slug: "packages/server-components",
    title: "Server Components",
    description: "Angular components that render on the server, with explicit client islands.",
    group: "Packages",
    order: 10,
  },
  {
    source: "packages/core/README.md",
    slug: "packages/core",
    title: "Core",
    description: "Standard-decorator controllers and route metadata.",
    group: "Packages",
    order: 11,
  },
  {
    source: "packages/analog/README.md",
    slug: "packages/analog",
    title: "Analog adapter",
    description: "Registers Strata controllers in an Analog and Nitro application.",
    group: "Packages",
    order: 12,
  },
  {
    source: "docs/INTEGRATIONS.md",
    slug: "integrations",
    title: "Integrations",
    description: "How controllers and Server Components attach to the runtimes you already own.",
    group: "Guides",
    order: 20,
  },
];

const pageBySource = new Map(PUBLIC_PAGES.map((page) => [page.source, page]));

function resolveLink(target: string, source: string): string {
  if (/^([a-z]+:|#|\/\/)/i.test(target)) return target;

  const [path = "", anchor] = target.split("#");
  const file = normalize(join(dirname(source), path));
  const suffix = anchor ? `#${anchor}` : "";
  const page = pageBySource.get(file);

  return page ? `${BASE_PATH}/${page.slug}${suffix}` : `${GITHUB_BLOB}/${file}${suffix}`;
}

/** Selects sections, drops the source's frontmatter and title, and retargets relative links. */
export function renderPage(page: PublicPage, markdown: string): string {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
  const lines = body.split("\n");
  const firstHeading = lines.findIndex((line) => line.startsWith("# "));
  const content = firstHeading === -1 ? lines : lines.slice(firstHeading + 1);
  const section = (heading: string): readonly [number, number] => {
    const start = content.indexOf(`## ${heading}`);
    if (start === -1) throw new Error(`${page.source} has no section "${heading}".`);
    const next = content.findIndex((line, index) => index > start && line.startsWith("## "));
    return [start, next === -1 ? content.length : next];
  };
  const omitted = (page.omit ?? []).map(section);
  const selected = page.sections
    ? page.sections.flatMap((heading) => content.slice(...section(heading)))
    : content.filter(
        (_line, index) => !omitted.some(([start, end]) => index >= start && index < end),
      );

  let fenced = false;
  const linked = selected.map((line) => {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) return line;
    return line.replace(
      /(\]\()([^)\s]+)(\))/g,
      (_match, open: string, target: string, close: string) =>
        `${open}${resolveLink(target, page.source)}${close}`,
    );
  });

  return [
    "---",
    `title: ${JSON.stringify(page.title)}`,
    `description: ${JSON.stringify(page.description)}`,
    `group: ${JSON.stringify(page.group)}`,
    `order: ${page.order}`,
    "---",
    "",
    `<!-- Generated from ${page.source} by apps/www/scripts/public-docs.ts. Do not edit. -->`,
    "",
    linked.join("\n").trim(),
    "",
  ].join("\n");
}

export const expectedPages = (): ReadonlyMap<string, string> =>
  new Map(
    PUBLIC_PAGES.map((page) => [
      `${page.slug}.md`,
      renderPage(page, readFileSync(join(repoRoot, page.source), "utf8")),
    ]),
  );

function currentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(contentDir, join(entry.parentPath, entry.name)));
}

/** Files that differ from what the sources generate. */
export function stalePages(): string[] {
  const expected = expectedPages();
  const files = currentFiles(contentDir);
  const extra = files.filter((file) => !expected.has(file));
  const changed = [...expected].flatMap(([file, text]) => {
    try {
      return readFileSync(join(contentDir, file), "utf8") === text ? [] : [file];
    } catch {
      return [file];
    }
  });

  return [...changed, ...extra];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale = stalePages();
    if (stale.length > 0) {
      console.error(`Stale public docs: ${stale.join(", ")}. Run pnpm www:docs:sync.`);
      process.exitCode = 1;
    }
  } else {
    rmSync(contentDir, { recursive: true, force: true });
    for (const [file, text] of expectedPages()) {
      const path = join(contentDir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
}
