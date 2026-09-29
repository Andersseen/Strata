import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const serverOnlyMarkers = [
  "RELAY_SERVER_ONLY_OPERATIONS_INTELLIGENCE_7C21",
  "RELAY_OPERATIONS_BRIEFING_SERVER_IMPLEMENTATION_4D18",
  "RELAY_RELEASE_GATE_SERVER_IMPLEMENTATION_1F37",
];
const clientMarkers = [
  "RELAY_BRIEFING_CLIENT_ISLAND_2A91",
  "RELAY_BRIEFING_WINDOW_CLIENT_ISLAND_68B4",
  "RELAY_ROLLOUT_CLIENT_ISLAND_91E3",
];

const client = await readOutput(join(root, "dist/client"));
const server = await readOutput(join(root, "dist/analog/server"));

for (const marker of serverOnlyMarkers) {
  assert(server.includes(marker), `server output is missing ${marker}`);
  assert(!client.includes(marker), `server-only marker leaked into the browser: ${marker}`);
}

for (const marker of clientMarkers) {
  assert(client.includes(marker), `client island is missing from browser output: ${marker}`);
}

console.log(
  `Server Component graph verified: ${serverOnlyMarkers.length} server-only markers excluded, ${clientMarkers.length} client island markers present.`,
);

async function readOutput(directory: string): Promise<string> {
  const chunks: string[] = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) chunks.push(await readOutput(path));
    else if ([".js", ".mjs", ".html"].includes(extname(entry.name))) {
      chunks.push(await readFile(path, "utf8"));
    }
  }

  return chunks.join("\n");
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
