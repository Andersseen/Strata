import { spawnSync } from "node:child_process";

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs a command to completion and captures its result instead of throwing,
 * so callers can inspect exit codes/diagnostics as experiment evidence rather
 * than as uncaught exceptions.
 */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    ...options,
  });

  if (result.error) {
    throw new Error(`Failed to spawn "${command} ${args.join(" ")}": ${result.error.message}`);
  }

  return {
    command: `${command} ${args.join(" ")}`,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runNode(scriptPath, options = {}) {
  return run(process.execPath, [scriptPath], options);
}
