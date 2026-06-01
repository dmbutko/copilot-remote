# copilot-remote

> *Maintained collaboratively by Copilot CLI sessions working in this repo
> and by humans. Future agents: when you rediscover something painful, add
> it here so the next session doesn't repeat the dig. Humans: edit freely;
> comments and corrections welcome.*

> *Treat this file as the durable source of truth for repo conventions and
> rediscovered plumbing. Copilot Memory expires after 28 days — record
> long-lived facts here, not just in `store_memory`.*

## Operating rules

- `npm run build` IS the deploy. Writing `dist/index.js` triggers an
  auto-restart via `RestartManager`. **Never** run `systemctl restart
  copilot-remote` — it bypasses capability notifications and may race
  with an in-flight debounce.
- `npm test` = `tsx --test src/**/*.test.ts` (~10 s). Pre-existing lint
  errors are noise.
- **Approval discipline (from `~/stuff/AGENTS.md` "Code Changes" rule):**
  obtain explicit user approval before any code change. If the user
  approves a scoped set of items (e.g. "do items 1-3 + 5"), stay within
  that scope. Centralizing helpers, refactoring sibling files, or
  extracting modules are SEPARATE changes that require their own
  approval — even when "byte-equivalent" or "obviously good". `npm run
  build` deploys live, so scope creep ships before review. Process
  breach on 2026-06-01 (commit `3d12536`) was ratified one-time; future
  unapproved expansions must be reverted, not ratified.
- `~/.copilot-remote/config.json` contains the bot token and other
  secrets. **Never** `cat` the whole file in shared/log output —
  inspect specific keys only.
- Local dev without Telegram: `npm run dev:mock` (or `--fake-telegram`
  flag, or `COPILOT_REMOTE_FAKE_TELEGRAM=1`) — uses `MockTelegramHarness`
  with a `mock-telegram>` REPL.
- After a build/restart, **do not** `sleep`/poll for the bridge to come
  back. The cycle is ~70 s (debounce + respawn + startup); end the turn
  and let the user re-engage once they observe the restart in Telegram.

## Architecture invariants (don't violate)

- The bridge spawns Copilot CLI as a **JSON-RPC server over stdio**.
  There is no TUI. CLI TUI slash commands like `/ask`, `/diff`, `/help`
  are TUI dialogs — they are NOT wire RPCs. The bridge re-implements
  them by composing SDK primitives.
- Pattern for new bridge slash commands: SDK state mutation
  (`session.rpc.*`) + `session.send`. See `/research`, `/plan`, `/ask`
  for examples.
- Telegram transport prepends a `<sender>{telegramId}</sender>\n`
  envelope to every inbound text. `onMessage` in `src/index.ts` strips
  it via `splitEnvelope` from `src/inbound-envelope.ts` before routing
  bridge-local decisions (slash commands, yes/no permission replies,
  ask_user freeform answers) and re-prepends it on prompts that reach
  Copilot. Symbols to grep: `buildSenderEnvelope`, `splitEnvelope`,
  `client.onMessage`, `SENDER_ENVELOPE_REGEX`.
- **When you change inbound message transformation (envelope, prefix,
  prepend, anything touching `text` before it reaches `onMessage`):**
  also survey ALL consumers — `client.onMessage` routing in
  `src/index.ts`, `handleCommand`, `handlePrompt`, `s.answerInput`,
  `client.onFile` + `handleIncomingFileUpload`. Update + run
  `src/__tests__/inbound-envelope.test.ts` and the matching
  file-intake tests. Looking at the transport alone is how the
  May-27 `/config` regression shipped (commit `3ea8cc1` → fix
  `2970645`).

## Logs (two sources — both useful)

**Bridge process** — Telegram I/O, session lifecycle, SDK event proxy:

```sh
journalctl --user -u copilot-remote --no-pager -n 100
journalctl --user -u copilot-remote --since "5 min ago" --no-pager
```

Key log markers: `[Telegram RX]`, `[prompt:start|done]`, `[SDK event]`,
`[copilot:response]`, `[ask] truncated history`. On Linux/systemd the
file log at `logs/copilot-remote.log` is empty — the journal is the
truth.

**CLI server process** — raw SDK internals, telemetry, MCP I/O:

```sh
ls -t ~/.copilot/logs/process-*.log | head -1
```

Often 50 MB+. Useful when SDK behaviour is surprising and bridge logs
are quiet.

## Restart mechanism

`RestartManager` (`src/restart-manager.ts`) polls watched paths via
`watchFile({ interval: 1250 })`. Watched targets include
`dist/index.js`, `config.json`, MCP/agents/skills/prompts dirs.

Flow on stat change: debounce
(`selfDevelopment.debounceMs` from `config.json`, may be tens of seconds)
→ notify in-memory active sessions → `SIGUSR1` → graceful `exit(75)` →
systemd `Restart=always RestartSec=5` respawns.

- Total wall time from `npm run build` to live: roughly
  `debounceMs + 5 s + ~3 s`. Don't poll "is it back yet?" sooner than
  that.
- Restart notifications only reach chats with a **currently active
  in-memory session**. After respawn that set is empty until a user
  sends a message.
- `/restart` Telegram command bypasses debounce — instant graceful
  restart.
- Manual confirmation: `journalctl --user -u copilot-remote -n 5` →
  look for `🚀 Copilot Remote vX.Y.Z`. Live PID lives in the
  single-instance lock (next section).
- Systemd unit: `~/.config/systemd/user/copilot-remote.service`
  (user unit; no root needed).

## Single-instance lock

`~/.copilot-remote/copilot-remote.lock/owner.json` records
`{pid, cwd, argv, startedAt}`. A stale lock will block startup.
Implemented in `src/single-instance.ts`.

## Sessions & state files

- `~/.copilot/session-store.db` — shared SQLite session store.
- `~/.copilot/session-state/<sessionId>/` — per-session workspace
  (events, plan.md, checkpoints, files/).
- `~/.copilot-remote/work-dirs.json` — chat → cwd mapping.
- `~/.copilot-remote/chat-sessions.json` — legacy chat → sessionId
  mapping.
- Bridge session keys: `telegram-<telegramId>` for DMs;
  `telegram-<groupId>` for groups; `:<threadId>` suffix for forum
  topics.

## Code map (where things live)

- `src/index.ts` — `runBot()` entry. Closures: `onMessage` (routing,
  envelope split), `handleCommand` (slash command switch),
  `handlePrompt` (Telegram stream UI). The `/help` text and the
  `setMyCommands` list both live near these closures — grep for
  `setMyCommands` or `case '/help'` to jump.
- `src/session.ts` — `Session` wraps SDK `CopilotSession`. `send()`
  runs inside `runInSendQueue` serializer; `sendImmediate()` BYPASSES
  the queue (mid-turn steering). `ask()` = `send()` with
  `history.truncate` after.
- `src/telegram.ts` — grammY adapter. Grep `senderEnvelope` for the
  `<sender>` prepend; grep `setMyCommands` for the Telegram bot menu
  registration.
- `src/constants.ts` — `PROMPT_COMMANDS` table (passthrough slash
  commands like `/research`, `/diff`).
- `src/restart-manager.ts` — file watcher + debounce + signal
  supervisor.
- `src/mcp-config.ts` — MCP config loading + merging (see MCP section).
- `src/testing/mock-telegram-harness.ts` — REPL replacement for grammY
  when `--fake-telegram`.
- SDK type defs (handy for capability lookup):
  `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts` and
  `session-events.d.ts`.

## SDK RPCs the bridge uses (or could use)

Wire-exposed (real, callable):

- `session.rpc.mode.set` — used by `/plan`.
- `session.rpc.agent.select` — used by `/research`.
- `session.rpc.history.compact` — used by `/compact`.
- `session.rpc.history.truncate` *@experimental* — used by `/ask`.
- `session.rpc.fleet.start` — used by `/fleet`.
- `client.rpc.sessions.fork` *@experimental* — not currently used.

TUI-only (NOT wire RPCs — don't try to invoke):
`/ask`, `/diff`, `/help`, `/ide`, `/copy`, `/theme`, and other
`show-dialog`-kind commands. The CLI's TUI dispatches these locally
via `session.instance.commands.invoke` which isn't on the JSON-RPC
surface.

## MCP gotchas

- `enableCliConfigDiscovery` defaults to `true` → the CLI auto-injects
  its built-in `github-mcp-server` with bearer-token auth.
- A user-defined `github-mcp-server` entry in `config.json` or VS Code
  MCP config will **shadow** the built-in one and break the auth flow.
  The bridge logs a `[mcp]` warning when detected — grep
  `Detected a user-defined .github-mcp-server.` in `src/index.ts`.
- Config sources merged (in precedence order): bridge
  `config.json.mcpServers` → `~/.copilot/mcp-config.json` →
  `~/.vscode/mcp.json` → CLI built-ins. Use `/mcp` in Telegram to
  inspect runtime state.

## Network gotchas

- The bot has historically wedged on IPv6. The systemd unit sets
  `NODE_OPTIONS=--dns-result-order=ipv4first` to avoid it.
- If Telegram polling appears stuck (no
  `[Telegram API RX] method="getUpdates"` for >30 s), suspect
  network/IPv6 before suspecting code.
