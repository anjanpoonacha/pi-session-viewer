// src/cli.ts — argument parsing and server boot.

import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { defaultSessionsDir } from "./engine/store.ts";
import { buildApp } from "./server.tsx";

type Args = { port: number; sessionsDir: string; help: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 7777, sessionsDir: defaultSessionsDir(), help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1]) args.port = parseInt(argv[++i], 10);
    else if (a === "--sessions-dir" && argv[i + 1]) {
      args.sessionsDir = resolve(argv[++i].replace(/^~/, homedir()));
    } else if (a === "-h" || a === "--help") args.help = true;
  }
  return args;
}

function printHelp(): void {
  console.log(`pi-sessions — local browser viewer for pi sessions

Usage:
  pi-sessions [--port <n>] [--sessions-dir <path>]

Options:
  --port <n>            TCP port to bind on 127.0.0.1 (default: 7777)
  --sessions-dir <path> Sessions directory
                        (default: ~/.pi/agent/sessions or ~/.config/pi/sessions)
  -h, --help            Show this help

The server is read-only by default. Whole-session purge moves to trash; per-entry
hide is reversible (sidecar tombstones). Prune snapshot writes a new sibling JSONL
and never modifies the original.

Loopback only — no authentication.`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

if (!existsSync(args.sessionsDir)) {
  console.warn(`[warn] sessions dir does not exist: ${args.sessionsDir}`);
}

const app = buildApp({ sessionsDir: args.sessionsDir });

const banner = `
  pi-sessions
  ───────────
  sessions:  ${args.sessionsDir}
  url:       http://127.0.0.1:${args.port}/

  read-only by default · loopback only · no auth
  Ctrl+C to stop
`;
console.log(banner);

declare const Bun: any;
if (typeof Bun !== "undefined" && Bun.serve) {
  Bun.serve({ hostname: "127.0.0.1", port: args.port, fetch: app.fetch });
} else {
  const { serve } = await import("@hono/node-server").catch(() => ({ serve: null as any }));
  if (!serve) {
    console.error("Node fallback requires @hono/node-server (npm i @hono/node-server) — or run with bun.");
    process.exit(1);
  }
  serve({ fetch: app.fetch, hostname: "127.0.0.1", port: args.port });
}
