# copilot-remote

> *Maintained collaboratively by Copilot CLI sessions working in this repo
> and by humans. Future agents: when you rediscover something painful, add
> it here so the next session doesn't repeat the dig. Humans: edit freely;
> comments and corrections welcome.*

> *Treat this file as the durable source of truth for repo conventions and
> rediscovered plumbing. Copilot Memory expires after 28 days — record
> long-lived facts here, not just in `store_memory`.*

## Project scope

Small personal deployment, not production. Prefer the simplest viable change:
deletion over abstraction, no defense-in-depth or speculative generality unless
clearly needed. When a fix and a refactor both solve it, ship the fix.

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
- **Diagnose before you patch.** When asked to investigate, explain, or plan,
  produce findings only — don't edit or even scope a patch until explicitly told
  to. Drive design decisions and post-patch review through the rubber-duck
  agent; the user expects it in the loop, especially around code changes.
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
- **SDK RPC pattern (1.0+):** `session.rpc.X.Y()` and `client.rpc.X.Y()`
  are typed public getters. Don't wrap in `as unknown as { rpc: ... }`
  casts — that pattern is dead. For wrapper method return types, use
  `ReturnType<SDKSession['rpc']['X']['Y']>` (NOT deep imports from
  `dist/generated/`). Required because `tsconfig.declaration: true`
  enforces portable inferred types.
- **`handleEvent` narrowing (1.0+):** `src/session.ts` `handleEvent`
  narrows on the SDK's discriminated `SessionEvent` union. Don't
  reintroduce a `SessionEventData` index-signature wrapper around
  `e.data` — it hides field-name mismatches. Cost us partial-output
  (read non-existent `result/content/text` instead of `partialOutput`)
  and image-block (read `result.content` string as if it were an
  array; real image blocks are under `result.contents`) bugs once
  already, plus a `success` field misread that rendered failed tools
  as ✓. Add a case per `e.type`; let TS narrow.
- **`toolNameByCallId` map**: events
  `tool.execution_partial_result` and `tool.execution_complete`
  don't carry `toolName` in SDK 1.0. Bridge maintains a per-Session
  `Map<string,string>` keyed by `toolCallId`, populated in
  `tool.execution_start`, drained in `tool.execution_complete`, and
  **cleared on lifecycle methods** (`disconnect`, `kill`, `newSession`)
  to avoid leaks across resumes/aborts.
- **MCP `tools: []` flipped in SDK 1.0**: was "all tools" (v0), now
  "no tools". Bridge defaults missing `tools` to `['*']` in
  `coerceServerConfig` (`src/mcp-config.ts:98`), so bridge itself never
  emits `[]`. But a user config with explicit `tools: []` will silently
  lose all tools under 1.0. If you see "no tools" complaints, check
  the user's `mcp-config.json` / `.vscode/mcp.json` first.

## Validation gates (don't skip)

- `npm run typecheck` (`tsc --noEmit`) is the real type gate.
  `npm test` is `tsx --test` — **transpile-only, no type checking**.
  We almost shipped type-broken code mid-SDK-1.0-migration because
  of this. Always typecheck before `npm run build` (which IS deploy).
- `npm run build` IS the deploy (debounced ~70s → SIGUSR1 → systemd
  respawn). Never run without explicit user permission.

## Dependency pinning — the CLI is a deliberate direct dep

`@github/copilot` (the CLI) is a **direct** dependency on purpose — it is the
lever that controls which CLI version the SDK actually runs. Do not treat it as
"just a transitive of `@github/copilot-sdk`".

- The SDK spawns the CLI with `--no-auto-update`, so the SDK-spawned subprocess
  runs whatever `@github/copilot` npm resolved into `node_modules` **forever**
  (it never shadow-updates like the TUI does). Whatever is pinned in
  `package-lock.json` is what runs every turn.
- When it was only a transitive (`@github/copilot-sdk@0.3.0` → `^1.0.36-0`) it
  froze at 1.0.36, and a CLI-internal hardcoded model map (`KMe.gpt.high`)
  silently routed rubber-duck / high-effort subagents to the wrong model
  (gpt-5.4 instead of gpt-5.5). Fix was promoting it to a direct dep
  (commit `efe9bf8`, `@github/copilot: ^1.0.48`), later `^1.0.60`.
- **Upgrade footgun:** bumping the CLI can silently change model routing and
  behaviour between patch versions. After ANY CLI bump, smoke-test model
  routing (esp. subagents/rubber-duck) — see the May-18 incident.
- Caret range is deliberate: allows patch/minor within 1.x but **excludes
  prereleases** (`1.0.NN-M` are not picked by `npm update`/`@latest`).
- `@github/copilot-sdk`'s own version is comparatively incidental (bump it only
  for a specific SDK fix/feature); the SDK declares a CLI floor
  (e.g. 1.0.5 needs `@github/copilot ^1.0.67`), so an SDK bump may force a CLI
  bump too — re-smoke-test routing when it does.

### Upgrade runbook (learned the hard way, Aug-15 CLI 1.0.60 → 1.0.80)

- **`config.json.copilotBinary` must point at the platform binary**, i.e.
  `node_modules/@github/copilot-linux-x64/copilot`. The CLI npm package
  **stopped shipping `index.js` at ~1.0.64** (runtime moved to the platform
  package; the main package is just `npm-loader.js`). A plain `npm install`
  with the old `@github/copilot/index.js` path makes the SDK throw
  "Copilot CLI not found" and the bridge won't start. Change the path FIRST,
  verify on the OLD version, and only then bump — that isolates a path
  failure from a version failure.
  Don't point it at `npm-loader.js`: it `spawnSync`s the native binary, so
  the real CLI becomes a *grandchild* and can orphan on teardown. Don't unset
  it either — `findBin()` falls back to `which copilot`, silently un-pinning
  onto the global install. `--no-auto-update` still honours the npm pin with
  the direct path (the bare binary self-resolves to a newer cached build
  without it).
- **Pair the SDK with the CLI; don't move one alone.** The historical thrash
  (`a063805`, `ec6bb88`, `0cf1158`) was always a *pairing* mismatch, never the
  version number, and it failed **silently** — permission RPC kind renames
  surfaced as "tool not responding", and a missing attachment `displayName`
  corrupted sessions on resume. Protocol-version negotiation only catches
  gross mismatches; semantic drift inside one protocol version sails through.
- **Rollback is not free.** CLI 1.0.80 writes `assistant.turn_start.data.model`,
  which 1.0.60's schema rejects (`additionalProperties: false`) — sessions
  touched by the new CLI are **unresumable if you downgrade**. Snapshot
  `~/.copilot/session-state/` + `session-store.db` (use the SQLite backup API,
  the CLI holds it open) before the first turn on a new CLI.
- **Post-upgrade smoke test** (silent failures need active probing): permission
  approve/reject with autopilot off; an attachment round-trip (checks
  `displayName`); resume after a full restart; `/mcp` + `/mcpreload`; and a
  grep sweep for `protocol version mismatch`, `Unhandled permission result`,
  `Session file is corrupted`, `displayName: Required`, `Method not found`,
  `tool not responding`.
- **Deferred tools (the reason for this upgrade).** Above ~30 tools the CLI
  marks the surplus `defer_loading: true` — the model gets the name but not
  the definition, and must call `tool_search_tool_regex` to use them.
  **CLI < 1.0.77 never told the model deferred tools existed**, so playwright
  and scrapling were invisible and it silently fell back to `web_fetch` on
  blocked pages. 1.0.77+ emits an explicit deferred-tools reminder. If tools
  "exist but are never used", check for the reminder in the CLI log before
  blaming prompts.

## Known SDK 1.0 bugs to watch

- **[#1562](https://github.com/github/copilot-sdk/issues/1562)** —
  Copilot Memory facts are NOT injected into the system message on
  `session.create`; only injected on `session.resume`. **For this
  bridge that means**: every code path that hits `createSession`
  starts Memory-less for the lifetime of that session (until next
  bridge restart causes a resume). Triggers: first-ever message in
  a chat/topic (no prior `sessionStore` entry); after `/new` or
  `/start <dir>` (archives + creates fresh); after 3 consecutive
  resume failures → automatic archive → next message creates fresh.
  Pending upstream fix. Workaround: rebuild to force resume.
- **`AbortEvent` unhandled** in `handleEvent` switch
  (`src/session.ts`). SDK emits it on turn-abort but bridge has no
  case. The `toolNameByCallId` map is already covered by lifecycle
  clears (`disconnect`, `kill`, `newSession`), so this is purely
  "could add the case for completeness." Low priority.
- **`toolName: 'unknown'` fallback** in `tool_complete` triggers if
  SDK ever emits `tool.execution_complete` before the matching
  `tool.execution_start` (race). SDK contract says this shouldn't
  happen.

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

**Live-host troubleshooting:** when diagnosing the *running* bot, read the local
gitignored `TROUBLESHOOTING.md` if present (health-check commands + playbooks).

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

### Upgrading scrapling (browser fetchers break silently)

`scrapling` is a pipx install (`scrapling[all]`, `~/.local/bin/scrapling`)
exposed to the bot as an MCP server. Upgrading it drags playwright and
patchright along, and **their browser binaries are not upgraded with them** —
scraping then fails at fetch time, not install time:

```
BrowserType.launch_persistent_context: Executable doesn't exist at
  ~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
```

- **`scrapling install` does NOT fix this.** It reports *"The dependencies are
  already installed"* — it only checks that browsers exist, never that the
  revision matches the installed playwright. Run the real thing instead:
  ```sh
  pipx upgrade scrapling
  ~/.local/pipx/venvs/scrapling/bin/python -m playwright install \
      chromium chromium-headless-shell        # ~115 MB
  ```
- **Static fetching keeps working**, so a quick `scrapling extract get` smoke
  test passes while both browser fetchers are dead. Test with `fetch` and
  `stealthy-fetch`, and prove JS actually rendered — `get` vs `fetch` on
  `https://quotes.toscrape.com/js/` returns 0 chars vs ~935 chars.
- **Never prune `~/.cache/ms-playwright` by "latest revision wins", and don't
  run `playwright uninstall --unused`.** playwright and patchright pin
  *different* chromium revisions (Aug-17: playwright 1.62.0 → 1234,
  patchright 1.61.2 → **1228**), and `--unused` is evaluated per-package, so it
  will happily delete the build the other one needs. `chromium-1234` serves
  `DynamicFetcher`/`fetch`; `chromium-1228` serves `StealthyFetcher`/
  `stealthy-fetch`. The `mcp-chrome-*` dirs belong to the node
  `@playwright/mcp` server, which is separately pointed at system
  `/usr/bin/chromium` via `--executable-path`.
- The bot holds the scrapling MCP server as a child process, so it keeps
  running the pre-upgrade code until `/restart`.

## Network gotchas

- The bot has historically wedged on IPv6. The systemd unit sets
  `NODE_OPTIONS=--dns-result-order=ipv4first` to avoid it.
- If Telegram polling appears stuck (no
  `[Telegram API RX] method="getUpdates"` for >30 s), suspect
  network/IPv6 before suspecting code.
