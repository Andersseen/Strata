---
type: guide
---

# Documentation workflow

These documents are plain Markdown in `docs/`, compiled to a static site by
[Entwine](https://github.com/Andersseen/Entwine). Markdown stays the source of truth. Entwine does
not generate API documentation from code and does not decide what is true: the rules in the
[documentation index](README.md#sources-of-truth) still apply.

The site is separate from the official Analog website in [`apps/www`](../apps/www/package.json), which is
deployed to Cloudflare Pages and is unaffected by this workflow.

## Published site

Pull requests run `entwine check` only. A push to `main` rebuilds and publishes to GitHub Pages
through [`entwine.yml`](../.github/workflows/entwine.yml). Live at <https://andersseen.github.io/Strata/>. The repository's Pages source is **GitHub Actions** (Settings → Pages → Build and deployment); if it is ever disabled, the deploy job fails with a 404 until it is set again.

## Local commands

The pinned CLI is `@entwine/cli@0.5.1` (the version in `entwine.yml`). Run it without installing:

```bash
npx --yes @entwine/cli@0.5.1 check       # validate links, anchors, repository references
npx --yes @entwine/cli@0.5.1 build       # write dist/ (git-ignored)
npx --yes @entwine/cli@0.5.1 dev         # preview with rebuild on change
npx --yes @entwine/cli@0.5.1 context --json   # machine-readable model of the documentation
```

`check` fails on broken links and missing repository files; missing recommended knowledge areas are
warnings. Do not weaken validation to hide a broken reference: fix the reference.

## Configuration

[`entwine.toml`](../entwine.toml) enables discovery of agent instructions and skills so tools can
see them through `context --json` and the MCP server, and sets
`include_agent_knowledge = false` so they are **never published** on the site. The landing page is
`docs/README.md`; there is deliberately no `docs/index.md`. ADRs under `docs/adr/` carry
`type: decision` frontmatter so Entwine recognises them without renaming historic files.

## Agent skills

Three first-party skills are installed (copies, with provenance in `skills-lock.json`) for Codex in
`.agents/skills/` and for Claude Code in `.claude/skills/`: `entwine-get-started`,
`entwine-knowledge`, `entwine-deployment`. Do not hand-edit them; reinstalling replaces them:

```bash
npx --yes skills@1.7.2 add https://github.com/Andersseen/Entwine/tree/main/skills \
  --skill entwine-get-started entwine-knowledge entwine-deployment \
  --agent codex claude-code --copy -y
```

## MCP server (read-only, local, not yet on npm)

`@entwine/mcp` gives a coding agent read-only access to documents, relationships and validation. It
has seven tools (`entwine_project_overview`, `entwine_list_documents`, `entwine_read_document`,
`entwine_related_documents`, `entwine_check`, `entwine_init_preview`, `entwine_setup_preview`). It
cannot write files or deploy. It is a development aid, not a dependency of any Strata package.

`@entwine/mcp` is **not published to npm** (`npm view @entwine/mcp` returns 404), so no committed
configuration references it. Use a local registration from a pinned source checkout. Requires Node 22 and pnpm:

```bash
git clone https://github.com/Andersseen/Entwine.git ~/entwine-src
git -C ~/entwine-src checkout fa59dab25e5b12e5bd4c1acde60e3e73caf9bca6
pnpm --dir ~/entwine-src install --frozen-lockfile --filter @entwine/mcp...
pnpm --dir ~/entwine-src --filter @entwine/mcp build
npm install --no-save --prefix ~/entwine-cli @entwine/cli@0.5.1

# run from the Strata checkout; options before the name, command after --
# (Codex: add an equivalent [mcp_servers.entwine] entry with the same command, args and env)
claude mcp add --scope local \
  --env ENTWINE_BIN="$HOME/entwine-cli/node_modules/@entwine/cli-darwin-arm64/bin/entwine" \
  entwine -- node "$HOME/entwine-src/packages/mcp/dist/cli.js" --root "$PWD"
```

Adjust the platform package name (`cli-darwin-arm64`) for your OS. That commit's MCP reads context
schema `0.4`, which CLI 0.5.1 emits. This combination was verified with a real MCP client. Once a
compatible `@entwine/mcp` release is on npm, replace the registration with
`npx --yes @entwine/mcp --root .` and pin the CLI and MCP to the same version.

## Regenerating the Pages workflow after an Entwine upgrade

`entwine setup` never overwrites an existing file. To adopt a new CLI version, delete
`.github/workflows/entwine.yml`, run `npx --yes @entwine/cli@<version> setup --dry-run`, review the
plan against the other workflows, then run it without `--dry-run`.
