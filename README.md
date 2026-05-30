# pi-session-viewer

Local browser viewer for [pi coding-agent](https://pi.dev) sessions. Read-only by default; surgical content prune (per-image / per-tool-output) when you need it. No auth, loopback only.

```
session list   →   session detail (turn tree)   →   prune snapshot
   forest          GitHub-style diffs                per-item checkboxes
   filters         inline images                     writes a NEW file
   facet tags      tool calls + results              original is untouched
   trash purge     hide entries (reversible)
```

## Install

```bash
git clone https://github.com/anjanpoonacha/pi-session-viewer.git ~/pi-session-viewer
cd ~/pi-session-viewer
bun install                  # one-time, installs hono
bun run install:ext          # register the /sessions slash command in pi
```

That's it. The server reads `~/.pi/agent/sessions/` (or `~/.config/pi/sessions/`) — nothing else to configure.

`install:ext` adds the extension's absolute path to pi's `settings.json` `extensions` array (creating it if missing). It's idempotent and won't touch anything else in your config. Undo with `bun run uninstall:ext`.

### Run from inside pi (`/sessions` slash command)

After `install:ext` above, restart pi (or `/reload` in an open session). Type `/sessions` — the server spawns, your browser opens. Reused across calls; pi shutdown stops it.

### Run from the shell (no pi required)

```bash
bun run start                # http://127.0.0.1:7777/
# or
./bin/pi-sessions            # same thing, suitable for adding to $PATH
```

## Filter syntax

```
has:image  has:diff  has:error  partial  subagent  intercom
tool:edit  tool:bash  cwd:<substr>  peer:<substr>  <bare-word>
```

All terms AND together. Bare words match name / cwd / id / model.

## Three deletion semantics

| Action | What it does | Reversible? | Touches JSONL? |
|---|---|---|---|
| **🗑 purge** (whole session) | move file to system trash | via `trash --restore` or Finder | yes — moves the file |
| **🪦 hide** (per entry) | sidecar tombstone | yes, via in-toast undo | no |
| **✂ prune snapshot** | write `<name>.pruned-<ts>.jsonl` next to original | yes, delete the new file | no — original untouched |

Audit logs land at `~/.pi/session-viewer/purge-log/<ISO>.json`.

## Project layout

```
src/
  parser/        JSONL → Header / Entry[] / Summary
              turns.ts   user→assistant→tool grouping
  engine/        store · filter · forest · prune · purge · audit · tombstones
  views/         layout · list · detail · prune · diff · blocks · format
  server.tsx     Hono routes
  cli.ts         arg parsing + boot
client/          static .js + styles.css served as-is
extension/       pi `/sessions` slash command
bin/             pi-sessions launcher
```

## Notes

- Bun preferred (runs `.tsx` directly, fastest). Node ≥ 24 fallback works with `@hono/node-server` installed.
- No auth on purpose — bound to `127.0.0.1`. Don't expose it.
- Whole-session purge refuses sessions modified within the last 60 s (likely live). Prune does **not** refuse — it writes a new file regardless and shows a "heads up" toast.

## License

MIT
