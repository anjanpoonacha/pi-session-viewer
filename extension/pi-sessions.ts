/**
 * pi-session-viewer — pi extension that adds a /sessions slash command.
 *
 * On first /sessions: spawns `pi-sessions` (the bin from this repo) and
 * opens the default browser at http://127.0.0.1:7777/. Subsequent /sessions
 * reuses the running server. Best-effort cleanup on session_end.
 *
 * Install:
 *   ln -s /path/to/pi-session-viewer/extension/pi-sessions.ts \
 *         ~/.pi/agent/extensions/pi-sessions.ts
 *
 * Or copy the file into ~/.pi/agent/extensions/ — pi auto-discovers it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 7777;
const URL = `http://127.0.0.1:${PORT}/`;

let child: ChildProcess | null = null;

/**
 * Resolve the project root from this file's location. Walks up to three levels,
 * following symlinks so installs that link `extension/pi-sessions.ts` into
 * `~/.pi/agent/extensions/` still resolve to the real project root.
 */
function findProjectRoot(): string | null {
  let here: string;
  try {
    here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  } catch {
    here = dirname(fileURLToPath(import.meta.url));
  }
  for (const up of ["..", "../..", "../../.."]) {
    const candidate = resolve(here, up);
    if (
      existsSync(join(candidate, "package.json")) &&
      existsSync(join(candidate, "bin", "pi-sessions"))
    ) {
      return candidate;
    }
  }
  return null;
}

async function isUp(): Promise<boolean> {
  return new Promise((resolveUp) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 250);
    fetch(URL, { signal: ctrl.signal })
      .then(() => { clearTimeout(t); resolveUp(true); })
      .catch(() => { clearTimeout(t); resolveUp(false); });
  });
}

async function spawnServer(projectRoot: string): Promise<void> {
  const bin = join(projectRoot, "bin", "pi-sessions");
  child = spawn(bin, [], {
    cwd: projectRoot,
    detached: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    if (await isUp()) return;
  }
  throw new Error("server did not become ready within 3s");
}

function openBrowser(target: string): void {
  const cmd =
    process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start"
    : "xdg-open";
  const proc = spawn(cmd, [target], { stdio: "ignore", detached: true });
  proc.unref();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description: "Open the pi session viewer in your browser",
    handler: async (args, ctx) => {
      const root = findProjectRoot();
      if (!root) {
        ctx.ui.notify(
          "pi-session-viewer not found near this extension. Check the symlink/install.",
          "error",
        );
        return;
      }
      const target = args?.trim() ? `${URL}s/${args.trim()}` : URL;
      try {
        if (!(await isUp())) {
          ctx.ui.notify("starting session viewer…", "info");
          await spawnServer(root);
        }
        openBrowser(target);
        ctx.ui.notify(`opened ${target}`, "info");
      } catch (err) {
        ctx.ui.notify(`/sessions failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.on("session_end", async () => {
    if (child && !child.killed) {
      try { child.kill("SIGTERM"); } catch { /* best-effort */ }
    }
  });
}
