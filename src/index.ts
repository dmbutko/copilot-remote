// Copilot Remote — Telegram ↔ Copilot SDK bridge
import { Session } from './session.js';
import type {
  FileAttachment,
  SessionStreamEvent,
  AssistantPlanEvent,
  SubagentStartEvent,
} from './session.js';
import type { Client, MessageOptions, Button } from './client.js';
import type { PermissionRequest } from '@github/copilot-sdk';
import { MockTelegramHarness } from './testing/mock-telegram-harness.js';
import { TelegramClient } from './telegram.js';
import { SessionStore } from './store.js';
import { SessionRegistry } from './session-registry.js';
import { ConfigStore, type ChatConfig, type PermKind } from './config-store.js';
import { discoverAgents } from './agent-discovery.js';
import { loadMcpServers, formatServerConfigDetails, getConfigPaths } from './mcp-config.js';
import { handleAgentCallback } from './agent-menu.js';
import { attachSessionById, formatSessionIdMessage, handleSessionCallback } from './session-menu.js';
import { handleCdCommand } from './cd-command.js';
import { handleIncomingFileUpload } from './file-intake.js';
import { splitEnvelope } from './inbound-envelope.js';
import { log } from './log.js';
import { formatPromptLogText } from './prompt-log.js';
import { formatPromptTimeline, type PromptTimelineEntry } from './prompt-timeline.js';
import { resolveProviderConfig } from './provider-config.js';
import {
  RestartManager,
  consumeRestartNotice,
  filterRestartRecipients,
  persistRestartNotice,
} from './restart-manager.js';
import { acquireSingleInstanceLock, createInstanceOwner } from './single-instance.js';
import { finalizeStreamResponse } from './stream-lifecycle.js';
import {
  extractAssistantPlan,
  formatSubagentStatus,
  formatToolStatus,
  reasoningTail,
} from './status-summary.js';
import { ToolStatusState } from './tool-status-state.js';
import {
  PROMPT_COMMANDS,
  LIFECYCLE_REACTIONS,
  PERM_ICONS,
  MODE_ICONS,
  type ToolEvent,
  type UserInputRequest,
} from './constants.js';
import { sendConfigMenu, handleConfigCallback, type ConfigMenuDeps } from './config-menu.js';
import * as fs from 'fs';
import { atomicWriteSync } from './util/atomic-write.js';
import * as path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { performance } from 'node:perf_hooks';
import * as readline from 'readline';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');
let nextPromptTraceId = 0;

function createPromptTraceId(msgId: number): string {
  nextPromptTraceId = (nextPromptTraceId + 1) % Number.MAX_SAFE_INTEGER;
  return `${msgId.toString(36)}-${Date.now().toString(36)}-${nextPromptTraceId.toString(36)}`;
}

function findBin(name: string): string | undefined {
  try {
    const found = execSync('which ' + name, { encoding: 'utf-8' }).trim();
    // Skip VS Code's Electron wrapper scripts — the SDK's bundled CLI is better
    if (found) {
      const content = fs.readFileSync(found, 'utf-8').slice(0, 200);
      if (content.includes('ELECTRON_RUN_AS_NODE')) return undefined;
    }
    return found || undefined;
  } catch {
    return undefined;
  }
}

function loadConfig() {
  // Load from ~/.copilot-remote/config.json or .copilot-remote.json in cwd
  const homeCfg = path.join(process.env.HOME ?? '.', '.copilot-remote', 'config.json');
  const cwdCfg = path.join(process.cwd(), '.copilot-remote.json');
  const cfgPath = fs.existsSync(homeCfg) ? homeCfg : fs.existsSync(cwdCfg) ? cwdCfg : null;
  const file = cfgPath ? JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) : {};

  // CLI args override config: --bot-token xxx
  const args = process.argv.slice(2);
  const botTokenIdx = args.indexOf('--bot-token');
  const botTokenArg = botTokenIdx >= 0 ? args[botTokenIdx + 1] : undefined;
  const cliUrlIdx = args.indexOf('--cli-url');
  const cliUrlArg = cliUrlIdx >= 0 ? args[cliUrlIdx + 1] : undefined;
  const fakeTelegram =
    args.includes('--fake-telegram') || file.fakeTelegram === true || process.env.COPILOT_REMOTE_FAKE_TELEGRAM === '1';

  const botToken = botTokenArg ?? file.botToken ?? process.env.COPILOT_REMOTE_BOT_TOKEN;
  const cliUrl = cliUrlArg ?? file.cliUrl ?? process.env.COPILOT_REMOTE_CLI_URL;
  const provider = resolveProviderConfig(file.provider);
  const githubToken =
    cliUrl || provider ? undefined : (file.githubToken ?? process.env.GITHUB_TOKEN ?? resolveGhToken());
  const allowedUsersRaw = (file.allowedUsers ?? process.env.COPILOT_REMOTE_ALLOWED_USERS?.split(',') ?? []) as string[];
  const allowedUsers = allowedUsersRaw.map((u) => String(u).trim()).filter(Boolean);
  const userIdRe = /^\d{1,20}$/;
  for (const u of allowedUsers) {
    if (!userIdRe.test(u)) {
      throw new Error(
        `Invalid allowedUsers entry: ${JSON.stringify(u)} — must be a numeric Telegram user ID (e.g. "123456789").`,
      );
    }
  }

  const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
  const turnTimeoutRaw = file.turnTimeoutMs ?? process.env.COPILOT_REMOTE_TURN_TIMEOUT_MS;
  let turnTimeoutMs: number = DEFAULT_TURN_TIMEOUT_MS;
  if (turnTimeoutRaw !== undefined && turnTimeoutRaw !== null && turnTimeoutRaw !== '') {
    const parsed = Number(turnTimeoutRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `Invalid turnTimeoutMs: ${JSON.stringify(turnTimeoutRaw)} — must be a non-negative integer (ms). 0 = SDK default (60_000).`,
      );
    }
    turnTimeoutMs = parsed;
  }

  return {
    botToken,
    allowedUsers,
    turnTimeoutMs,
    workDir: file.workDir ?? process.env.COPILOT_REMOTE_WORKDIR ?? process.cwd(),
    copilotBinary: file.copilotBinary ?? process.env.COPILOT_REMOTE_BINARY,
    cliUrl,
    fakeTelegram,
    provider,
    githubToken,
    profilePhoto: file.profilePhoto,
    uploadDir: typeof file.uploadDir === 'string' ? file.uploadDir : undefined,
    _cfgPath: cfgPath ?? homeCfg,
    _file: file,
  };
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

async function ensureBotToken(config: ReturnType<typeof loadConfig>): Promise<string> {
  if (config.botToken) return config.botToken;

  // Interactive first-run setup
  console.log('\n🤖 copilot-remote — first-time setup\n');
  console.log('You need a Telegram bot token. Get one from @BotFather: https://t.me/BotFather\n');
  const token = await prompt('Paste your bot token: ');
  if (!token) {
    console.error('No token provided. Exiting.');
    process.exit(1);
  }

  // Save to config
  const cfgDir = path.dirname(config._cfgPath);
  fs.mkdirSync(cfgDir, { recursive: true });
  const newFile = { ...config._file, botToken: token };
  atomicWriteSync(config._cfgPath, JSON.stringify(newFile, null, 2) + '\n', { mode: 0o600 });
  console.log(`\n✅ Saved to ${config._cfgPath}\n`);
  return token;
}

function resolveGhToken(): string | undefined {
  try {
    return execSync('gh auth token 2>/dev/null', { encoding: 'utf-8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const configuredLogLevel = config._file?.logging?.level ?? config._file?.logLevel;
  if (configuredLogLevel) {
    log.setLevel(configuredLogLevel);
  } else if (config._file?.debug) {
    log.setDebug(true);
  }

  const lockDir = path.join(process.env.HOME ?? '.', '.copilot-remote', 'copilot-remote.lock');
  const lockResult = acquireSingleInstanceLock(lockDir, createInstanceOwner());
  if (!lockResult.acquired) {
    const existing = lockResult.failure.existing;
    log.warn(
      '[singleton] Another copilot-remote instance is already running.',
      existing
        ? `pid=${existing.pid} cwd=${existing.cwd || '-'} argv=${JSON.stringify(existing.argv.slice(0, 4))}`
        : `lockDir=${lockResult.failure.lockDir}`,
    );
    return;
  }
  const instanceLock = lockResult.lock;
  process.on('exit', () => {
    instanceLock.release();
  });

  const botToken = config.fakeTelegram ? 'mock-telegram-token' : await ensureBotToken(config);
  const bin = config.copilotBinary ?? findBin('copilot');

  const selfDev = config._file?.selfDevelopment?.enabled === true;
  log.info(
    '🚀 Copilot Remote v' +
      version +
      (selfDev ? ' (self-dev enabled)' : '') +
      ' | dir: ' +
      config.workDir +
      (config.fakeTelegram ? ' | transport: mock-telegram-harness' : '') +
      (config.cliUrl ? ' | cli: ' + config.cliUrl : ' | cli: stdio'),
  );
  log.info('[logger] level=' + log.getLevel());

  const client: Client = config.fakeTelegram
    ? new MockTelegramHarness()
    : new TelegramClient({
        botToken,
        allowedUsers: config.allowedUsers,
        profilePhoto: config.profilePhoto,
      });

  void Session.prewarmSharedClient({
    binary: bin,
    cliUrl: config.cliUrl,
    githubToken: config.githubToken,
    provider: config.provider,
  })
    .then(() => {
      log.info('Prewarmed Copilot client');
    })
    .catch((e) => {
      log.debug('Copilot client prewarm failed:', e);
    });

  // ── Per-chat state ──
  // ── Config ──
  const configStore = new ConfigStore();

  const cfg = (key: string) => configStore.get(key);
  const setCfg = (key: string, updates: Partial<ChatConfig>) => configStore.set(key, updates, true);

  const sessions = new Map<string, Session>();
  _globalSessions = sessions;
  _globalClient = client;
  const sessionStore = new SessionStore();
  const workDirs = new Map<string, string>(sessionStore.getAllWorkDirs());
  // Pending state: composite key `${chatId}:${msgId}` matches Telegram's
  // per-chat msgId identity model. `chatId` MUST be the normalized form used
  // for `sessions.get(chatId)` (i.e. sessionKey(rawChatId, threadId) when
  // threaded). Never parse keys — only construct via pendingKey() and
  // prefix-match via `${chatId}:`.
  const pendingPerms = new Set<string>();
  const pendingInputs = new Set<string>();
  const pendingKey = (chatId: string, msgId: number) => `${chatId}:${msgId}`;
  // chatId-scoped match: `${chatId}:` prefix AND the next colon (separating
  // chatId from msgId) is at exactly chatId.length. Required because chatId
  // for threaded chats has the form `${rawChatId}:${threadId}` and we must
  // NOT have a DM clear (chatId=`X`) sweep thread entries (chatId=`X:Y`).
  // msgIds are always numeric, so the boundary colon is unambiguous.
  const matchesChat = (k: string, chatId: string) =>
    k.startsWith(`${chatId}:`) && k.lastIndexOf(':') === chatId.length;
  const setPendingPerm = (chatId: string, msgId: number) => pendingPerms.add(pendingKey(chatId, msgId));
  const hasPendingPerm = (chatId: string, msgId: number) => pendingPerms.has(pendingKey(chatId, msgId));
  const clearPendingPerm = (chatId: string, msgId: number) => pendingPerms.delete(pendingKey(chatId, msgId));
  const setPendingInput = (chatId: string, msgId: number) => pendingInputs.add(pendingKey(chatId, msgId));
  const hasPendingInput = (chatId: string, msgId: number) => pendingInputs.has(pendingKey(chatId, msgId));
  const clearPendingInput = (chatId: string, msgId: number) => pendingInputs.delete(pendingKey(chatId, msgId));
  const threadMap = new Map<string, number>(); // sessionKey → threadId
  let shuttingDown = false;
  let pendingRestartReason: string | null = null;
  // Per-session usage tracking (keyed by session key)
  const lastUsageMap = new Map<
    string,
    { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; duration: number }
  >();
  const contextInfoMap = new Map<string, { tokenLimit: number; currentTokens: number; messagesLength: number }>();

  const collectRestartRecipients = (preferredChatId?: string): string[] => {
    const recipients = new Set<string>();
    if (preferredChatId) recipients.add(preferredChatId);
    for (const chatKey of sessions.keys()) recipients.add(chatKey);
    return filterRestartRecipients(recipients, restartManager.getStatus().notifyDmsOnly);
  };

  const requestSelfRestart = (reason: string, recipients: Iterable<string> = []) => {
    try {
      persistRestartNotice({ reason, recipients });
    } catch (error) {
      log.warn('[restart] Failed to persist restart notice:', error instanceof Error ? error.message : String(error));
    }
    pendingRestartReason = reason;
    log.info('[restart] Requested:', reason);
    process.kill(process.pid, 'SIGUSR1');
  };

  const restartManager = new RestartManager({
    workDirs: [config.workDir],
    config: configStore.raw(),
    onRestartRequired: ({ reason, changedPath }) => {
      const status = restartManager.getStatus();
      const details = changedPath ? `\n\nChanged: \`${changedPath}\`` : '';
      const action = status.supervisor
        ? '\n\nSupervisor detected — automatic restart is available.'
        : '\n\nUse /restart to reload now.';
      const recipients = filterRestartRecipients(sessions.keys(), status.notifyDmsOnly);
      for (const chatKey of recipients) {
        client.sendMessage(chatKey, `♻️ ${reason}${details}${action}`).catch(() => {});
      }
    },
    onRequestRestart: ({ reason }) => {
      const recipients = collectRestartRecipients();
      for (const chatKey of recipients) {
        client.sendMessage(chatKey, `♻️ Restarting to load updated capabilities…\n\n${reason}`).catch(() => {});
      }
      requestSelfRestart(reason, recipients);
    },
  });

  // Session key: "chatId" or "chatId:threadId" for forum topics
  const sessionKey = (chatId: string, threadId?: number) => (threadId ? chatId + ':' + threadId : chatId);

  // Wrap client methods to auto-resolve session keys (chatId:threadId → chatId + threadId param)
  const resolveKey = (key: string): [string, number | undefined] => {
    const [cid, rawThreadId] = key.split(':', 2);
    const parsedThreadId = rawThreadId ? Number(rawThreadId) : undefined;
    const tid = threadMap.get(key) ?? (Number.isFinite(parsedThreadId) ? parsedThreadId : undefined);
    return [cid, tid];
  };

  // Proxy client methods to resolve composite session keys automatically
  const proxyMethods = [
    'sendMessage',
    'sendButtons',
    'editMessage',
    'editButtons',
    'sendTyping',
    'setReaction',
    'removeReaction',
  ] as const;
  type ProxiedMethod = (typeof proxyMethods)[number];
  const originals = Object.fromEntries(
    proxyMethods.map((m) => [m, (client[m] as (...args: unknown[]) => unknown).bind(client)]),
  ) as Record<ProxiedMethod, (...args: unknown[]) => unknown>;

  client.sendMessage = (key: string, text: string, opts?: MessageOptions) => {
    const [cid, tid] = resolveKey(key);
    return (originals.sendMessage as typeof client.sendMessage)(cid, text, { ...opts, threadId: tid });
  };
  client.sendButtons = (key: string, text: string, buttons: Button[][], _tid?: number) => {
    const [cid, tid] = resolveKey(key);
    return (originals.sendButtons as typeof client.sendButtons)(cid, text, buttons, tid);
  };
  client.editMessage = (key: string, msgId: number, text: string) => {
    const [cid] = resolveKey(key);
    return (originals.editMessage as typeof client.editMessage)(cid, msgId, text);
  };
  client.editButtons = (key: string, msgId: number, text: string, buttons: Button[][]) => {
    const [cid] = resolveKey(key);
    return (originals.editButtons as typeof client.editButtons)(cid, msgId, text, buttons);
  };
  client.sendTyping = (key: string) => {
    const [cid, tid] = resolveKey(key);
    return (originals.sendTyping as typeof client.sendTyping)(cid, tid);
  };
  client.setReaction = (key: string, msgId: number, emoji: string) => {
    const [cid] = resolveKey(key);
    return (originals.setReaction as typeof client.setReaction)(cid, msgId, emoji);
  };
  client.removeReaction = (key: string, msgId: number) => {
    const [cid] = resolveKey(key);
    return (originals.removeReaction as typeof client.removeReaction)(cid, msgId);
  };

  if (client.sendDraft) {
    const origSendDraft = client.sendDraft.bind(client);
    client.sendDraft = (key: string, draftId: number, text: string, opts?: MessageOptions) => {
      const [cid, tid] = resolveKey(key);
      return origSendDraft(cid, draftId, text, { ...opts, threadId: tid ?? opts?.threadId });
    };
  }

  if (client.sendPhoto) {
    const origSendPhoto = client.sendPhoto.bind(client);
    client.sendPhoto = (key: string, fileOrUrl: string | Buffer, caption?: string) => {
      const [cid, tid] = resolveKey(key);
      return origSendPhoto(cid, fileOrUrl, caption, tid);
    };
  }

  const workDir = (id: string) => workDirs.get(id) ?? config.workDir;

  // SessionRegistry (owns sessions/workDirs lifecycle: getSession with race-lock,
  // suspendSession, archiveSession, invalidate*) is instantiated after
  // buildSessionOptions and registerSessionListeners are defined below.
  // Thin delegates (suspendSession/archiveSession/getSession) are wired there too.

  // Get or create session
  // Register persistent listeners on a session (called once per session, not per message)
  function registerSessionListeners(session: Session, chatId: string) {
    session.on('usage', (u: Record<string, unknown>) => {
      lastUsageMap.set(chatId, {
        model: u.model as string,
        inputTokens: u.inputTokens as number,
        outputTokens: u.outputTokens as number,
        cacheReadTokens: u.cacheReadTokens as number,
        duration: u.duration as number,
      });
    });
    session.on('context_info', (info: { tokenLimit: number; currentTokens: number; messagesLength: number }) => {
      contextInfoMap.set(chatId, info);
    });
    session.on('turn_start', () => {});
    session.on('permission_timeout', () => {
      for (const k of pendingPerms) {
        if (!matchesChat(k, chatId)) continue;
        const id = Number(k.slice(chatId.length + 1));
        pendingPerms.delete(k);
        client.editButtons(chatId, id, '⏰ Expired (denied)', []).catch(() => {});
        setTimeout(() => {
          client.deleteMessage?.(chatId, id).catch(() => {});
        }, 8_000);
      }
    });
    // SDK's handleUserInput times out after 5 min; without sweeping pendingInputs
    // the old "❓ Question" buttons stay clickable and could answer a future
    // ask_user prompt by mistake. Same pattern as permission_timeout above.
    session.on('user_input_timeout', () => {
      for (const k of pendingInputs) {
        if (!matchesChat(k, chatId)) continue;
        const id = Number(k.slice(chatId.length + 1));
        pendingInputs.delete(k);
        client.editButtons(chatId, id, '⏰ Timed out', []).catch(() => {});
        setTimeout(() => {
          client.deleteMessage?.(chatId, id).catch(() => {});
        }, 8_000);
      }
    });
    session.on('notification', async (text: string) => {
      await client.sendMessage(chatId, `🔔 ${text}`);
    });

    // Helper: resolve bot API + numeric chat ID for direct Telegram API calls
    type BotApi = Record<string, (...args: unknown[]) => unknown>;
    const getBotApi = (): { tc: BotApi; numericId: number; threadOpts: { message_thread_id?: number } } => {
      const tc = (client as unknown as { bot?: { api: BotApi } }).bot?.api;
      if (!tc) throw new Error('No bot API');
      const [chatPart, threadPart] = chatId.includes(':') ? chatId.split(':') : [chatId];
      const numericId = Number(chatPart);
      const threadOpts = threadPart ? { message_thread_id: Number(threadPart) } : {};
      return { tc, numericId, threadOpts };
    };

    // Helper: wrap a tool event handler with standard error reporting
    const toolHandler = <T>(event: string, handler: (info: T) => Promise<void>) => {
      session.on(event, async (info: T) => {
        try {
          await handler(info);
        } catch (e) {
          await client.sendMessage(chatId, `❌ Failed to ${event.replace('_', ' ')}: ${e}`);
        }
      });
    };

    toolHandler<{ path: string; caption?: string }>('file', async (info) => {
      const { InputFile } = await import('grammy');
      const { tc, numericId, threadOpts } = getBotApi();
      const ext = info.path.split('.').pop()?.toLowerCase() ?? '';
      const file = new InputFile(info.path);
      const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
      const videoExts = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
      if (audioExts.includes(ext)) await tc.sendAudio(numericId, file, { caption: info.caption, ...threadOpts });
      else if (imageExts.includes(ext)) await tc.sendPhoto(numericId, file, { caption: info.caption, ...threadOpts });
      else if (videoExts.includes(ext)) await tc.sendVideo(numericId, file, { caption: info.caption, ...threadOpts });
      else await tc.sendDocument(numericId, file, { caption: info.caption, ...threadOpts });
    });

    toolHandler<{ path: string; caption?: string }>('photo', async (info) => {
      const { InputFile } = await import('grammy');
      const { tc, numericId, threadOpts } = getBotApi();
      const source = info.path.startsWith('http') ? info.path : new InputFile(info.path);
      await tc.sendPhoto(numericId, source, { caption: info.caption, ...threadOpts });
    });

    toolHandler<{ lat: number; lon: number; title?: string }>('location', async (info) => {
      const { tc, numericId, threadOpts } = getBotApi();
      if (info.title) await tc.sendVenue(numericId, info.lat, info.lon, info.title, '', threadOpts);
      else await tc.sendLocation(numericId, info.lat, info.lon, threadOpts);
    });

    toolHandler<{ path: string; caption?: string }>('voice', async (info) => {
      const { InputFile } = await import('grammy');
      const { tc, numericId, threadOpts } = getBotApi();
      await tc.sendVoice(numericId, new InputFile(info.path), { caption: info.caption, ...threadOpts });
    });

    toolHandler<{ messageId: number }>('pin', async (info) => {
      const { tc, numericId } = getBotApi();
      await tc.pinChatMessage(numericId, info.messageId);
    });

    session.on('create_topic', async (info: { name: string; iconColor?: number; resolve: (id: number) => void }) => {
      try {
        const { tc, numericId } = getBotApi();
        const result = await tc.createForumTopic(numericId, info.name, { icon_color: info.iconColor });
        info.resolve((result as { message_thread_id: number }).message_thread_id);
      } catch (e) {
        await client.sendMessage(chatId, `❌ Failed to create topic: ${e}`);
        info.resolve(0);
      }
    });

    session.on('react_to', async (info: { messageId: number; emoji: string }) => {
      client.setReaction(chatId, info.messageId, info.emoji).catch(() => {});
    });

    toolHandler<{ phone: string; firstName: string; lastName?: string }>('contact', async (info) => {
      const { tc, numericId, threadOpts } = getBotApi();
      await tc.sendContact(numericId, info.phone, info.firstName, { last_name: info.lastName, ...threadOpts });
    });

    session.on(
      'poll',
      async (info: {
        question: string;
        options: string[];
        isAnonymous?: boolean;
        allowsMultiple?: boolean;
        resolve: (id: number) => void;
      }) => {
        const { tc, numericId, threadOpts } = getBotApi();
        const msg = (await tc.sendPoll(numericId, info.question, info.options, {
          is_anonymous: info.isAnonymous ?? true,
          allows_multiple_answers: info.allowsMultiple ?? false,
          ...threadOpts,
        })) as { message_id: number };
        info.resolve(msg.message_id);
      },
    );

    session.on('hook:error', async (info: { error?: unknown; message?: string }) => {
      const msg =
        info.message ?? (info.error instanceof Error ? info.error.message : String(info.error ?? 'Unknown error'));
      await client.sendMessage(chatId, `⚠️ *SDK Error:* ${msg}`);
    });
    session.on('hook:session_start', () => log.debug('[hook] Session started for chat', chatId));
    session.on('hook:session_end', () => log.debug('[hook] Session ended for chat', chatId));
  }

  function buildSessionOptions(chatId: string, cwdOverride?: string, sessionIdOverride?: string) {
    const c = cfg(chatId);
    const globalCfg = configStore.raw();
    const cwd = cwdOverride ?? workDir(chatId);

    return {
      cwd,
      sessionId: sessionIdOverride ?? SessionStore.deterministicSessionId(chatId),
      binary: bin,
      cliUrl: config.cliUrl,
      model: c.model,
      autopilot: c.autopilot,
      reasoningEffort: c.reasoningEffort ? (c.reasoningEffort as 'low' | 'medium' | 'high' | 'xhigh') : undefined,
      contextTier: c.contextTier,
      agent: c.agent ?? undefined,
      topicContext: client.getTopicName?.(chatId),
      githubToken: config.githubToken,
      infiniteSessions: c.infiniteSessions,
      messageMode: c.messageMode || undefined,
      turnTimeoutMs: config.turnTimeoutMs,
      provider: globalCfg.provider ?? config.provider,
      mcpServers: (() => {
        const { merged, sources } = loadMcpServers(globalCfg.mcpServers, cwd);
        if (sources.length) log.info(`Loaded MCP servers from ${sources.map((s) => s.name).join(', ')}`);
        // Warn if a user-defined `github-mcp-server` entry will shadow the CLI's
        // built-in authenticated config. The user-defined version typically points
        // at the same URL but lacks the auto-injected Authorization header, so it
        // gets stashed as `pendingGitHubMcpServers` and never connects in SDK mode.
        // See plan.md, section "Why the prior manual attempt failed".
        if ('github-mcp-server' in merged) {
          log.warn(
            '[mcp] Detected a user-defined `github-mcp-server` entry. This overrides ' +
              'the built-in authenticated config and likely breaks github-mcp loading. ' +
              'Remove it from ~/.copilot/mcp-config.json (or .vscode/mcp.json / .mcp.json) ' +
              'to use the auto-injected version.',
          );
        }
        return Object.keys(merged).length ? merged : undefined;
      })(),
      // Activate the CLI's built-in github-mcp injection + MCP/plugin/disabled-* discovery.
      // Default on, opt-out via `enableCliConfigDiscovery: false` in config.json (e.g. for
      // BYOK provider users who don't want the discovery side effects).
      enableConfigDiscovery: globalCfg.enableCliConfigDiscovery !== false,
      customAgents: (() => {
        const discovered = discoverAgents(cwd);
        const configAgents = (globalCfg.customAgents ?? []) as Array<{ name: string }>;
        const configNames = new Set(configAgents.map((a) => a.name));
        const merged = [...configAgents, ...discovered.filter((a) => !configNames.has(a.name))];
        if (discovered.length)
          log.info(`Discovered ${discovered.length} agent(s): ${discovered.map((a) => a.name).join(', ')}`);
        return merged.length ? merged : undefined;
      })(),
      skillDirectories: (() => {
        const dirs = [...(globalCfg.skillDirectories ?? [])];
        const home = process.env.HOME ?? '';
        const candidates = [path.join(home, '.copilot', 'skills'), path.join(home, '.github', 'skills')];
        for (const d of candidates) {
          if (fs.existsSync(d) && !dirs.includes(d)) {
            dirs.push(d);
            log.info('Auto-discovered skill directory:', d);
          }
        }
        return dirs.length ? dirs : undefined;
      })(),
      disabledSkills: globalCfg.disabledSkills,
      systemInstructions: globalCfg.systemInstructions,
      promptContextProvider: globalCfg.promptContextProvider,
      availableTools: globalCfg.availableTools,
      excludedTools: [...new Set([...(globalCfg.excludedTools ?? []), ...(c.excludedTools ?? [])])].length
        ? [...new Set([...(globalCfg.excludedTools ?? []), ...(c.excludedTools ?? [])])]
        : undefined,
    };
  }

  const sessionRegistry = new SessionRegistry({
    sessions,
    workDirs,
    sessionStore,
    restartManager,
    config,
    buildSessionOptions,
    registerSessionListeners,
  });

  const getSession = (chatId: string) => sessionRegistry.getSession(chatId);
  const suspendSession = (chatId: string) => sessionRegistry.suspendSession(chatId);
  const archiveSession = (chatId: string, explicitSessionId?: string) =>
    sessionRegistry.archiveSession(chatId, explicitSessionId);

  // ── Config menu dependencies (shared with config-menu module) ──
  const configMenuDeps: ConfigMenuDeps = {
    client,
    configStore,
    sessions,
    sessionStore,
    listModels: () =>
      Session.listModelsShared({
        binary: bin,
        cliUrl: config.cliUrl,
        githubToken: config.githubToken,
        provider: config.provider,
      }),
    getSession,
    workDir: (id: string) => workDir(id),
    bin,
    suspendSession,
  };

  // ── Prompt handler (streaming + reactions) ──
  async function handlePrompt(
    chatId: string,
    msgId: number,
    prompt: string,
    attachments?: FileAttachment[],
    attempt = 1,
    promptTraceId = createPromptTraceId(msgId),
    opts?: { askMode?: boolean },
  ): Promise<void> {
    log.info(
      '[prompt:start]',
      `req=${promptTraceId}`,
      `attempt=${attempt}`,
      `chat=${chatId}`,
      `msg=${msgId}`,
      `attachments=${attachments?.length ?? 0}`,
      `text=${JSON.stringify(prompt.replace(/\s+/g, ' ').trim().slice(0, 200))}`,
    );
    const turnStartedAt = performance.now();
    const timelineEntries: PromptTimelineEntry[] = [{ label: 'start', atMs: 0 }];
    const markTimeline = (label: string, detail?: string, at = performance.now()) => {
      timelineEntries.push({ label, atMs: at - turnStartedAt, detail });
    };
    const logPromptTimeline = (status: string, detail?: string) => {
      const timeline = detail
        ? [...timelineEntries, { label: status, atMs: performance.now() - turnStartedAt, detail }]
        : timelineEntries;
      log.info(
        '[prompt:timeline]',
        `req=${promptTraceId}`,
        `attempt=${attempt}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `status=${status}`,
        `timeline=${JSON.stringify(formatPromptTimeline(timeline))}`,
      );
    };
    const responseMessageOpts: MessageOptions = { disableLinkPreview: true, replyTo: msgId };
    const sendTypingSafe = () => {
      // Rejections are swallowed: a transient failure must not disable the indicator
      // for the rest of a long turn.
      client.sendTyping(chatId).catch(() => {});
    };
    // Show typing immediately — session creation can take seconds
    sendTypingSafe();
    let typingInterval: ReturnType<typeof setInterval> | null = setInterval(() => sendTypingSafe(), 4000);
    const c = cfg(chatId);
    const showThinking = c.showThinking;
    const showTools = c.showTools;
    // Define react() and fire the "received" reaction BEFORE any awaited Telegram
    // call (placeholder send, getSession, etc.) so the user sees acknowledgment
    // on their message even if a subsequent Telegram API call hangs.
    const react = c.showReactions
      ? (e: string) => {
          client.setReaction(chatId, msgId, e).catch(() => {});
        }
      : () => {};
    react(LIFECYCLE_REACTIONS.received);
    let streamMsgId: number | null = null;
    let responseText = '';
    let thinkingLogText = '';
    let thinkingSeen = false;
    let intentText = '';
    const toolLines: string[] = [];
    let activeToolStatus = '';
    const activeToolStatuses = new ToolStatusState();
    const activeToolCallIds = new Set<string>();
    let progressMaterializing = false;
    const PROGRESS_INTERVAL_MS = 30_000; // max one progress update per 30s
    let lastProgressAt = 0;
    let sessionReadyAt: number | undefined;
    let firstDeltaAt: number | null = null;
    let firstVisibleAt: number | null = null;
    let firstStreamPhase: 'thinking' | 'response' | null = null;
    let telegramApiCalls = 0;
    let telegramApiMs = 0;

    const noteTelegramCall = (startedAt: number, visible = false) => {
      telegramApiCalls++;
      telegramApiMs += performance.now() - startedAt;
      if (visible && firstVisibleAt === null) {
        firstVisibleAt = performance.now();
        markTimeline('first_visible');
      }
    };

    // ── Placeholder → Status → Final model ──
    // Instead of streaming edits, we: send one placeholder, update status rarely, send final once.

    const progressDisplay = () => {
      const elapsedS = Math.round((performance.now() - turnStartedAt) / 1000);
      const elapsed = elapsedS < 60 ? `${elapsedS}s` : `${Math.floor(elapsedS / 60)}m${elapsedS % 60}s`;
      const p: string[] = [];
      if (intentText) p.push('*' + intentText + '*');
      // Only while there's no tool activity to show: once tools run, they are
      // the better narrative and the bubble would otherwise get very tall.
      if (showThinking && !toolLines.length) {
        const thinking = reasoningTail(thinkingLogText);
        if (thinking) p.push('🧠 ' + thinking);
      }
      if (toolLines.length && showTools) p.push(toolLines.slice(-5).join('\n'));
      if (activeToolStatus) p.push('⏳ ' + activeToolStatus);
      // Elapsed trails as a footer, and the body is bounded here so
      // editMessageRaw's 4096 truncation can never reach it: tool partial
      // output is unbounded, and losing the footer would take the timer with
      // it — leaving consecutive renders identical, which Telegram rejects as
      // "message is not modified". Clipped surrogate-safe so a cut inside an
      // emoji can't emit invalid UTF-8.
      const MAX_BODY = 3800;
      let body = p.join('\n\n') || '⏳ Working…';
      if (body.length > MAX_BODY) {
        body = body.slice(0, MAX_BODY).replace(/[\uD800-\uDBFF]$/, '') + '…';
      }
      return `${body}\n\n⏱ ${elapsed}`;
    };

    const sendPlaceholder = async () => {
      if (streamMsgId || progressMaterializing) return;
      progressMaterializing = true;
      try {
        const text = progressDisplay();
        const tgStart = performance.now();
        const sentMsgId = await client.sendMessage(chatId, text, {
          ...responseMessageOpts,
          disableNotification: true,
        });
        noteTelegramCall(tgStart, sentMsgId !== null);
        streamMsgId = sentMsgId;
        if (streamMsgId !== null) {
          markTimeline('progress_visible', 'message');
          log.debug('Placeholder sent:', streamMsgId, 'for', chatId);
        }
      } finally {
        progressMaterializing = false;
      }
    };

    const updateProgress = async () => {
      if (!streamMsgId) {
        await sendPlaceholder();
        return;
      }
      if (Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
      lastProgressAt = Date.now();
      const text = progressDisplay();
      const [cid] = resolveKey(chatId);
      const tc = client as unknown as { editMessageRaw?: (c: string, m: number, t: string) => Promise<void> };
      const tgStart = performance.now();
      const editFn = tc.editMessageRaw
        ? tc.editMessageRaw.call(client, cid, streamMsgId, text)
        : client.editMessage(chatId, streamMsgId, text);
      editFn
        .then(() => noteTelegramCall(tgStart))
        .catch((e) => log.debug('Progress edit failed:', e));
    };

    let session: Session;
    try {
      if (!sessions.get(chatId)?.alive) {
        await sendPlaceholder();
      }
      session = await getSession(chatId);
      sessionReadyAt = performance.now();
      markTimeline('session', `id=${session.sessionId ?? '-'}`, sessionReadyAt);
      log.info(
        '[prompt:session]',
        `req=${promptTraceId}`,
        `attempt=${attempt}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `sessionId=${session.sessionId ?? '-'}`,
        `busy=${session.busy}`,
      );
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err);
      const lower = msg.toLowerCase();
      // If an unsupported per-model setting was requested, reset it and retry once.
      const unsupportedReasoning = msg.includes('reasoning effort');
      const unsupportedContextTier =
        lower.includes('long_context') || (lower.includes('context') && lower.includes('tier'));
      if (unsupportedReasoning || unsupportedContextTier) {
        if (unsupportedReasoning) c.reasoningEffort = '';
        if (unsupportedContextTier) c.contextTier = 'default';
        setCfg(chatId, c);
        // Log the raw error so we capture the real (currently-unproven) message
        // strings — the contextTier matcher above is a best-guess until we see one.
        log.warn(
          '[prompt:session] unsupported per-model option — reset + retry',
          `reasoning=${unsupportedReasoning}`,
          `contextTier=${unsupportedContextTier}`,
          `error=${msg}`,
        );
        const retryTag = unsupportedReasoning ? 'no-reasoning-effort' : 'default-context-tier';
        try {
          session = await getSession(chatId);
          sessionReadyAt = performance.now();
          markTimeline('session', `id=${session.sessionId ?? '-'};retry=${retryTag}`, sessionReadyAt);
          log.info(
            '[prompt:session]',
            `req=${promptTraceId}`,
            `attempt=${attempt}`,
            `chat=${chatId}`,
            `msg=${msgId}`,
            `sessionId=${session.sessionId ?? '-'}`,
            `busy=${session.busy}`,
            `retry=${retryTag}`,
          );
        } catch (err2: unknown) {
          if (typingInterval) clearInterval(typingInterval);
          await client.sendMessage(chatId, '❌ Session failed: ' + ((err2 as Error)?.message ?? String(err2)), {
            replyTo: msgId,
          });
          return;
        }
      } else {
        if (typingInterval) clearInterval(typingInterval);
        await client.sendMessage(chatId, '❌ Session failed: ' + msg, { replyTo: msgId });
        return;
      }
    }
    // Keep relay semantics simple: queue by default, and only steer an in-flight turn
    // when the user explicitly opts into immediate mode. /ask must NOT steer — it needs
    // its own queued turn so we can capture the user.message id and truncate atomically.
    if (!opts?.askMode && session.busy && c.messageMode === 'immediate') {
      if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
      react('⚡');
      try {
        await session.sendImmediate(prompt, attachments);
        react('✅');
      } catch (e) {
        react('❌');
        log.debug('Immediate send failed:', e);
      }
      return;
    }
    // Send placeholder immediately so user knows we're working
    await sendPlaceholder();
    // One heartbeat for both jobs: keep the typing indicator alive AND tick the progress
    // bubble. Typing renders in the chat header, so it is the only indicator that cannot
    // be buried when the agent sends media (26-Aug: ten photos pushed the bubble out of
    // view and the user had no sign a 21-min turn was running). 4s, not 3s — the group
    // throttler allows 20 calls/min total and every chat_id call counts, so a 3s pulse
    // would eat the whole budget; 4s still beats Telegram's ~5s typing expiry.
    // updateProgress() self-rate-limits to PROGRESS_INTERVAL_MS.
    if (streamMsgId && typingInterval) {
      clearInterval(typingInterval);
      typingInterval = setInterval(() => {
        sendTypingSafe();
        void updateProgress();
      }, 4000);
    }
    const turnReservation = session.reserveTurn();

    const noteFirstStreamEvent = (phase: 'thinking' | 'response', chunk: string) => {
      if (firstStreamPhase) return;
      firstStreamPhase = phase;
      markTimeline('first_delta', phase);
      log.info(
        '[prompt:first-delta]',
        `req=${promptTraceId}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `phase=${phase}`,
        `turnId=${turnReservation.currentTurnId ?? '-'}`,
        `chars=${chunk.length}`,
      );
    };

    const logCopilotChunk = (kind: 'thinking' | 'response', turnId: string | null | undefined, text: string) => {
      if (log.shouldLog('debug')) {
        log.debug(
          `[copilot:${kind}:chunk]`,
          `req=${promptTraceId}`,
          `chat=${chatId}`,
          `msg=${msgId}`,
          `turnId=${turnId ?? '-'}`,
          `chars=${text.length}`,
          `text=${JSON.stringify(text)}`,
        );
        return;
      }

      log.verbose(
        `[copilot:${kind}:chunk]`,
        `req=${promptTraceId}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `turnId=${turnId ?? '-'}`,
        `chars=${text.length}`,
        `text=${JSON.stringify(formatPromptLogText(text, 400))}`,
      );
    };

    const logCopilotFinal = (kind: 'thinking' | 'response', text: string, maxChars: number) => {
      const payload = log.shouldLog('debug') ? text : formatPromptLogText(text, maxChars);
      log.info(
        `[copilot:${kind}]`,
        `req=${promptTraceId}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `sessionId=${session.sessionId ?? '-'}`,
        `turnId=${turnReservation.currentTurnId ?? '-'}`,
        `chars=${text.length}`,
        `text=${JSON.stringify(payload)}`,
      );
    };

    const ownsTurn = (turnId: string | null | undefined) => !!turnId && turnReservation.ownedTurnIds.has(turnId);

    const onThink = ({ turnId, text }: SessionStreamEvent) => {
      if (!ownsTurn(turnId)) return;
      if (firstDeltaAt === null) firstDeltaAt = performance.now();
      noteFirstStreamEvent('thinking', text);
      thinkingLogText += text;
      logCopilotChunk('thinking', turnId, text);
      // First reasoning of the turn: let the next heartbeat render it rather
      // than waiting out the remaining rate-limit window.
      if (showThinking && !thinkingSeen) {
        thinkingSeen = true;
        lastProgressAt = 0;
      }
    };

    const onDelta = ({ turnId, text }: SessionStreamEvent) => {
      if (!ownsTurn(turnId)) return;
      if (firstDeltaAt === null) firstDeltaAt = performance.now();
      noteFirstStreamEvent('response', text);
      logCopilotChunk('response', turnId, text);
      responseText += text;
    };
    const toolStartTimes = new Map<string, number>();
    const toolLineIndexByCallId = new Map<string, number>();
    const onAssistantPlan = (plan: AssistantPlanEvent) => {
      if (!ownsTurn(plan.turnId)) return;
      const summary = extractAssistantPlan(plan);
      if (summary.intentText && !intentText) intentText = summary.intentText;
      if (summary.activeToolStatus && !activeToolStatus) {
        activeToolStatus = summary.activeToolStatus;
      }
      if (summary.intentText || summary.activeToolStatus) {
        void updateProgress();
      }
    };
    const onToolStart = (t: ToolEvent & { turnId?: string | null }) => {
      if (!ownsTurn(t.turnId)) return;
      if (t.toolCallId) toolStartTimes.set(t.toolCallId, Date.now());
      if (t.toolCallId) activeToolCallIds.add(t.toolCallId);
      // ask_user has its own UI (buttons/reply prompt) — suppress from tool display
      if (t.toolName === 'ask_user') return;
      // report_intent: update internal state for progress display
      if (t.toolName === 'report_intent') {
        const intent = t.arguments?.intent ?? t.arguments?.message ?? '';
        if (intent) {
          intentText = String(intent);
          void updateProgress();
        }
        return;
      }
      const statusSummary = formatToolStatus(t.toolName, t.arguments);
      activeToolStatuses.set(t.toolCallId, statusSummary.statusLine);
      activeToolStatus = statusSummary.statusLine;
      void updateProgress();

      if (!showTools) return;
      const lineIndex = toolLines.push(statusSummary.statusLine) - 1;
      if (t.toolCallId) toolLineIndexByCallId.set(t.toolCallId, lineIndex);
    };
    const toolOutputBuffers = new Map<string, string[]>();
    const MAX_PARTIAL_LINES = 3;
    const onToolOutput = (t: { turnId?: string | null; toolCallId?: string; toolName: string; content: unknown }) => {
      if (!ownsTurn(t.turnId)) return;
      if (!showTools) return;
      const text = typeof t.content === 'string' ? t.content : JSON.stringify(t.content ?? '');
      if (!text.trim()) return;
      const key = t.toolCallId ?? t.toolName;
      const lines = toolOutputBuffers.get(key) ?? [];
      for (const line of text.split('\n')) {
        if (line.trim()) lines.push(line);
      }
      const tail = lines.slice(-MAX_PARTIAL_LINES);
      toolOutputBuffers.set(key, tail);
      const lineIndex = t.toolCallId ? toolLineIndexByCallId.get(t.toolCallId) : undefined;
      const targetIndex = lineIndex ?? (toolLines.length ? toolLines.length - 1 : -1);
      if (targetIndex >= 0) {
        const baseLine = toolLines[targetIndex].split('\n')[0];
        toolLines[targetIndex] = baseLine + '\n```\n' + tail.join('\n') + '\n```';
        void updateProgress();
      }
    };
    const onSubagentStart = (event: SubagentStartEvent) => {
      if (!ownsTurn(event.turnId)) return;
      const status = formatSubagentStatus(event);
      activeToolStatuses.set(event.toolCallId, status.statusLine);
      activeToolStatus = status.statusLine;
      if (showTools && event.toolCallId) {
        const lineIndex = toolLineIndexByCallId.get(event.toolCallId);
        if (lineIndex !== undefined && lineIndex >= 0 && lineIndex < toolLines.length) {
          toolLines[lineIndex] = status.statusLine;
        } else {
          toolLines.push(status.statusLine);
        }
      }
      void updateProgress();
    };
    const onTurnStart = ({ turnId }: { turnId: string | null }) => {
      if (!ownsTurn(turnId)) return;
      // Intentionally a no-op for now. Keeping the hook wired preserves the full
      // event scaffold so we can add turn-start UX later without re-threading it.
    };
    const onToolEnd = (t: ToolEvent & { turnId?: string | null }) => {
      if (!ownsTurn(t.turnId)) return;
      const key = t.toolCallId ?? t.toolName;
      toolOutputBuffers.delete(key);
      if (t.toolCallId) activeToolCallIds.delete(t.toolCallId);
      activeToolStatuses.delete(t.toolCallId);
      activeToolStatus =
        activeToolStatuses.current() || (activeToolCallIds.size === 0 && !responseText ? '🧠 Reviewing results' : '');
      if (t.toolName === 'report_intent' || t.toolName === 'ask_user') return;
      if (!showTools || !toolLines.length) return;
      const lineIndex = t.toolCallId ? toolLineIndexByCallId.get(t.toolCallId) : undefined;
      const targetIndex = lineIndex ?? toolLines.length - 1;
      if (targetIndex < 0 || targetIndex >= toolLines.length) return;
      toolLines[targetIndex] = toolLines[targetIndex].split('\n')[0];
      const elapsed = t.toolCallId ? toolStartTimes.get(t.toolCallId) : undefined;
      const duration = elapsed ? ` ${((Date.now() - elapsed) / 1000).toFixed(1)}s` : '';
      if (t.toolCallId) toolStartTimes.delete(t.toolCallId);
      toolLines[targetIndex] += (t.success !== false ? ' ✓' : ' ✗') + duration;
      if (t.toolCallId) toolLineIndexByCallId.delete(t.toolCallId);

      // Send any generated images as Telegram photos
      if (t.images?.length && client.sendPhoto) {
        for (const base64 of t.images) {
          const buffer = Buffer.from(base64, 'base64');
          client.sendPhoto(chatId, buffer).catch(() => {});
        }
      }
    };
    const onPerm = async (req: PermissionRequest & { turnId?: string | null }) => {
      if (!ownsTurn(req.turnId)) return;
      const p = (req as PermissionRequest & { permissionRequest?: PermissionRequest }).permissionRequest ?? req;
      const kind = p.kind as PermKind;
      log.debug('onPerm:', `kind=${kind}`, `autoApprove=${c.autoApprove[kind]}`);

      // Auto-approve if this kind is allowed
      if (c.autoApprove[kind]) {
        session.approve();
        return;
      }

      const icon = PERM_ICONS[kind] ?? '🔐';
      const title =
        p.kind === 'shell'
          ? 'Run command'
          : p.kind === 'url'
            ? 'Fetch URL'
            : p.kind === 'write'
              ? 'Write file'
              : p.kind;
      const pAny = p as unknown as Record<string, unknown>;
      let detail =
        p.kind === 'shell'
          ? '```\n' + String(pAny.fullCommandText ?? '').slice(0, 300) + '\n```'
          : p.kind === 'url'
            ? '`' + String(pAny.url ?? '').slice(0, 200) + '`'
            : ((pAny.intention as string) ?? '');
      if (pAny.intention && p.kind !== detail) detail += '\n_' + pAny.intention + '_';
      const pfx = (d: string) => '@' + chatId + '|' + d;
      const id = await client.sendButtons(chatId, icon + ' *' + title + '*\n' + detail, [
        [
          { text: '✅ Approve', data: pfx('perm:yes'), style: 'success' },
          { text: '❌ Deny', data: pfx('perm:no'), style: 'danger' },
          { text: '✅ All', data: pfx('perm:all') },
        ],
      ]);
      if (id) setPendingPerm(chatId, id);
    };

    const onUserInput = async (req: UserInputRequest & { turnId?: string | null }) => {
      if (!ownsTurn(req.turnId)) return;
      const question = req.question ?? (typeof req === 'string' ? req : JSON.stringify(req));
      const choices = req.choices as string[] | undefined;
      if (choices?.length) {
        const buttons = choices.map((c: string) => [{ text: c, data: '@' + chatId + '|input:' + c }]);
        const id = await client.sendButtons(chatId, '❓ ' + question, buttons);
        if (id) setPendingInput(chatId, id);
      } else {
        const id = await client.sendMessage(chatId, '❓ ' + question + '\n\n_Reply to this message to answer_');
        if (id) setPendingInput(chatId, id);
      }
    };

    session.on('assistant_plan', onAssistantPlan);
    session.on('thinking_event', onThink);
    session.on('delta_event', onDelta);
    session.on('turn_start', onTurnStart);
    session.on('tool_start', onToolStart);
    session.on('subagent_start', onSubagentStart);
    session.on('tool_output', onToolOutput);
    session.on('tool_complete', onToolEnd);
    session.on('permission_request', onPerm);
    session.on('user_input_request', onUserInput);
    // Persistent listeners (usage, hooks, notifications) registered once in registerSessionListeners()

    const cleanup = () => {
      session.off('assistant_plan', onAssistantPlan);
      session.off('thinking_event', onThink);
      session.off('delta_event', onDelta);
      session.off('turn_start', onTurnStart);
      session.off('tool_start', onToolStart);
      session.off('subagent_start', onSubagentStart);
      session.off('tool_output', onToolOutput);
      session.off('tool_complete', onToolEnd);
      session.off('permission_request', onPerm);
      session.off('user_input_request', onUserInput);
    };

    let res: { content: string };
    try {
      log.info(
        '[prompt:send]',
        `req=${promptTraceId}`,
        `attempt=${attempt}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `sessionId=${session.sessionId ?? '-'}`,
        `mode=${session.messageMode ?? 'enqueue'}`,
      );
      markTimeline('send', `mode=${session.messageMode ?? 'enqueue'}`);
      res = await session.send(prompt, attachments, turnReservation, opts);
    } catch (sendErr) {
      log.error('[prompt:error]', sendErr);
      cleanup();
      if (typingInterval) clearInterval(typingInterval);
      const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      const isTimeout = errMsg.toLowerCase().includes('timeout');
      const hadNoCopilotEvents = firstDeltaAt === null && firstStreamPhase === null;
      const shouldRetryFresh = isTimeout && hadNoCopilotEvents && attempt < 2;

      if (shouldRetryFresh) {
        // Delete orphaned placeholder from failed attempt
        if (streamMsgId) {
          await client.deleteMessage?.(chatId, streamMsgId).catch(() => {});
        }
        markTimeline('retry_fresh', 'no-sdk-events-before-timeout');
        logPromptTimeline('retry_fresh');
        log.warn(
          '[prompt:retry-fresh]',
          `req=${promptTraceId}`,
          `attempt=${attempt}`,
          `chat=${chatId}`,
          `msg=${msgId}`,
          `sessionId=${session.sessionId ?? '-'}`,
          'reason=no-sdk-events-before-timeout',
        );
        try {
          session.kill();
        } catch {
          /* ignore */
        }
        sessions.delete(chatId);
        suspendSession(chatId);
        await Session.resetSharedClient(`timeout-no-events req=${promptTraceId} chat=${chatId}`);
        log.info(
          '[prompt:retrying]',
          `req=${promptTraceId}`,
          `attempt=${attempt + 1}`,
          `chat=${chatId}`,
          `msg=${msgId}`,
        );
        return handlePrompt(chatId, msgId, prompt, attachments, attempt + 1, promptTraceId, opts);
      }

      // Kill the broken session so it doesn't linger
      // EXCEPTION: a turn-timeout AFTER first delta means the agent was actively producing
      // events and is just doing slow work, so we keep the session (SDK abort leaves it valid
      // and the conversation intact). But we MUST abort the turn: `sendAndWait`'s timeout only
      // stops waiting, it does not abort in-flight agent work, and this handler's stream
      // listeners are torn down below — so an un-aborted turn keeps running and burning
      // credits with nothing relaying it, holding `busy` true and swallowing every later
      // message as steering. That wedged the bot for 2h on 2026-08-21.
      const isPostDeltaTimeout = isTimeout && !hadNoCopilotEvents;
      const isSessionNotFound = errMsg.includes('Session not found');
      let abortFailed = false;
      if (!isPostDeltaTimeout) {
        // Suspend: kill in-memory but preserve disk for resume on next message.
        suspendSession(chatId);
      } else {
        try {
          const stopped = await session.abort();
          if (!stopped) throw new Error('runtime declined abort');
        } catch (e) {
          // Abort didn't land, so the turn may still be running and `busy` may still be
          // true. Suspending drops the in-memory session (disk history is kept) — without
          // it we'd be back in the zombie state this fix exists to prevent.
          abortFailed = true;
          log.warn('[prompt:timeout-abort-failed]', `req=${promptTraceId}`, String(e));
          suspendSession(chatId);
        }
      }

      // Auto-retry on "Session not found": the session was evicted from CLI memory
      // but disk state is intact. Resume from disk and replay the user's message
      // transparently instead of asking them to send it again.
      if (isSessionNotFound && attempt < 2) {
        // Delete orphaned placeholder from failed attempt
        if (streamMsgId) {
          await client.deleteMessage?.(chatId, streamMsgId).catch(() => {});
        }
        markTimeline('retry_resume', 'session-not-found');
        logPromptTimeline('retry_resume');
        log.info(
          '[prompt:retry-resume]',
          `req=${promptTraceId}`,
          `attempt=${attempt + 1}`,
          `chat=${chatId}`,
          `msg=${msgId}`,
          'reason=session-evicted-from-memory',
        );
        return handlePrompt(chatId, msgId, prompt, attachments, attempt + 1, promptTraceId, opts);
      }

      if (errMsg.toLowerCase().includes('timeout')) {
        logPromptTimeline('timeout', firstStreamPhase ?? 'none');
        log.warn(
          '[prompt:timeout]',
          `req=${promptTraceId}`,
          `attempt=${attempt}`,
          `chat=${chatId}`,
          `msg=${msgId}`,
          `sessionId=${session.sessionId ?? '-'}`,
          `elapsed=${Math.round(performance.now() - turnStartedAt)}ms`,
          `phase=${firstStreamPhase ?? 'none'}`,
          `sessionPreserved=${isPostDeltaTimeout}`,
        );
      } else {
        logPromptTimeline('failed', errMsg.slice(0, 80));
        log.warn(
          '[prompt:failed]',
          `req=${promptTraceId}`,
          `attempt=${attempt}`,
          `chat=${chatId}`,
          `msg=${msgId}`,
          `sessionId=${session.sessionId ?? '-'}`,
          `elapsed=${Math.round(performance.now() - turnStartedAt)}ms`,
          `phase=${firstStreamPhase ?? 'none'}`,
          `error=${JSON.stringify(errMsg.slice(0, 200))}`,
        );
      }
      react(LIFECYCLE_REACTIONS.error);
      const timeoutMins = config.turnTimeoutMs ? Math.round(config.turnTimeoutMs / 60_000) : 1;
      const userMsg = errMsg.includes('STREAM_DESTROYED')
        ? '💀 Lost connection to Copilot. Send a message to reconnect.'
        : isPostDeltaTimeout
          ? abortFailed
            ? `⏱️ Turn exceeded ${timeoutMins} min. Stop could not be confirmed, so the session was disconnected — your history is preserved. Send another message to resume.`
            : `⏱️ Turn exceeded ${timeoutMins} min and was stopped. Your session and history are intact — send another message to continue.`
          : errMsg.includes('timeout')
            ? '⏱️ Request timed out. Send a message to try again.'
            : isSessionNotFound
              ? '🔄 Session expired from memory — send another message to resume from disk.'
              : '❌ `' + errMsg.slice(0, 200) + '`\nSend a message to start a new session.';
      await client.sendMessage(chatId, userMsg, { replyTo: msgId });
      return;
    }
    try {
      cleanup();
      if (typingInterval) clearInterval(typingInterval);

      const final = res.content;
      log.debug('[finalize] streamMsgId:', streamMsgId, 'final length:', final.length);
      const tgStart = performance.now();
      const finalization = await finalizeStreamResponse({
        client,
        chatId,
        streamMsgId,
        final,
        responseMessageOpts,
        // Edits are silent on Telegram; in steering mode the answer must arrive
        // as a fresh (notifying) message below any mid-turn steer.
        forceResend: c.messageMode === 'immediate',
      });
      if (finalization === 'edited') log.debug('[finalize] edited placeholder msgId:', streamMsgId);
      else if (finalization === 'resent') log.debug('[finalize] multi-chunk: delete + resend');
      else log.debug('[finalize] no placeholder, sending fresh');
      noteTelegramCall(tgStart, true);
      markTimeline('done', `final=${finalization}`);
      if (thinkingLogText.trim()) {
        logCopilotFinal('thinking', thinkingLogText, 2000);
      }
      logCopilotFinal('response', final, 4000);
      logPromptTimeline('done');
      react(LIFECYCLE_REACTIONS.complete);
      log.info(
        '[perf]',
        `req=${promptTraceId}`,
        `total=${Math.round(performance.now() - turnStartedAt)}ms`,
        `session=${Math.round((sessionReadyAt ?? turnStartedAt) - turnStartedAt)}ms`,
        `ttfd=${firstDeltaAt === null ? '-' : Math.round(firstDeltaAt - turnStartedAt) + 'ms'}`,
        `ttfv=${firstVisibleAt === null ? '-' : Math.round(firstVisibleAt - turnStartedAt) + 'ms'}`,
        `tgApi=${telegramApiCalls}(${Math.round(telegramApiMs)}ms)`,
      );
      log.info(
        '[prompt:done]',
        `req=${promptTraceId}`,
        `attempt=${attempt}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `sessionId=${session.sessionId ?? '-'}`,
        `turnId=${turnReservation.currentTurnId ?? '-'}`,
        `responseChars=${final.length}`,
        `phase=${firstStreamPhase ?? 'none'}`,
      );
    } catch (err) {
      log.error('[finalize] error:', err);
      cleanup();
      if (typingInterval) clearInterval(typingInterval);
      logPromptTimeline('finalize_failed', err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80));
      log.warn(
        '[prompt:finalize-failed]',
        `req=${promptTraceId}`,
        `attempt=${attempt}`,
        `chat=${chatId}`,
        `msg=${msgId}`,
        `sessionId=${session.sessionId ?? '-'}`,
        `turnId=${turnReservation.currentTurnId ?? '-'}`,
      );
      react(LIFECYCLE_REACTIONS.error);
      await client.sendMessage(chatId, '❌ ' + String(err), { replyTo: msgId });
    }
  }

  // ── Message handler ──
  client.onMessage = async (text, chatId, messageId, replyText, replyToMsgId, threadId) => {
    const key = sessionKey(chatId, threadId);
    if (threadId) threadMap.set(key, threadId);

    // Strip the Telegram transport's `<sender>{id}</sender>\n` envelope so
    // bridge-local routing (slash commands, yes/no perm replies, ask_user
    // answers) matches on the raw body. Envelope is re-prepended on prompts
    // that reach Copilot. See `src/inbound-envelope.ts`.
    const { envelope, body } = splitEnvelope(text);

    // Reply to permission message
    if (replyToMsgId && hasPendingPerm(key, replyToMsgId)) {
      const lower = body.toLowerCase().trim();
      const s = sessions.get(key);
      if (s?.alive) {
        if (['yes', 'y', 'approve', '👍'].includes(lower)) {
          s.approve();
          clearPendingPerm(key, replyToMsgId);
          await client.deleteMessage?.(chatId, replyToMsgId);
          return;
        }
        if (['no', 'n', 'deny', '👎'].includes(lower)) {
          s.deny();
          clearPendingPerm(key, replyToMsgId);
          await client.editButtons(chatId, replyToMsgId, '❌ Denied', []);
          return;
        }
      }
    }

    if (replyToMsgId && hasPendingInput(key, replyToMsgId)) {
      const s = sessions.get(key);
      if (s?.alive) {
        clearPendingInput(key, replyToMsgId);
        s.answerInput(body);
        return;
      }
    }

    if (body.startsWith('/')) return handleCommand(body, key, messageId, envelope);

    let prompt = body;
    if (replyText) prompt = 'Context (replying to):\n"""\n' + replyText + '\n"""\n\nMy message: ' + body;
    await handlePrompt(key, messageId, envelope + prompt);
  };

  // ── Command handler ──
  async function handleCommand(text: string, chatId: string, msgId: number, envelope = ''): Promise<void> {
    const [rawCmd, ...args] = text.split(' ');
    const cmd = rawCmd.replace(/@\w+$/, ''); // strip @botname suffix
    const argStr = args.join(' ');

    // Passthrough prompt commands
    const pc = PROMPT_COMMANDS[cmd];
    if (pc) {
      if (pc.usage && !argStr) {
        await client.sendMessage(chatId, 'Usage: ' + pc.usage);
        return;
      }
      let s = sessions.get(chatId);
      if (!s?.alive) {
        s = await getSession(chatId);
      }
      // For /research, activate the research agent before sending the prompt
      if (cmd === '/research' && s?.alive) {
        try {
          await s.selectAgent('research');
        } catch (e) {
          log.debug('Failed to select research agent:', e);
        }
      }
      return handlePrompt(chatId, msgId, envelope + pc.prompt(argStr));
    }

    switch (cmd) {
      case '/attach': {
        if (!argStr.trim()) {
          await client.sendMessage(
            chatId,
            '🔗 Usage: `/attach <session-id>`\nYou can also paste `copilot --resume <session-id>`.',
            { replyTo: msgId },
          );
          break;
        }

        const result = await attachSessionById(argStr, chatId, {
          client,
          sessions,
          sessionStore,
          getWorkDir: workDir,
          rememberWorkDir: (targetChatId: string, cwd: string) => {
            workDirs.set(targetChatId, cwd);
            sessionStore.setWorkDir(targetChatId, cwd);
            restartManager.addWorkDir(cwd);
          },
          createSession: () => new Session(),
          buildResumeOptions: (targetChatId: string, cwd: string, sessionId: string) =>
            buildSessionOptions(targetChatId, cwd, sessionId),
          registerSessionListeners: (session, targetChatId) =>
            registerSessionListeners(session as Session, targetChatId),
        });
        await client.sendMessage(chatId, result.message, { replyTo: msgId });
        break;
      }
      case '/start':
      case '/new': {
        if (args[0] && cmd === '/start') {
          const dir = args[0].replace(/^~/, process.env.HOME ?? '~');
          workDirs.set(chatId, dir);
          sessionStore.setWorkDir(chatId, dir);
        }
        const old = sessions.get(chatId);
        await archiveSession(chatId, old?.sessionId ?? undefined);
        await getSession(chatId);
        await client.sendMessage(chatId, cmd === '/new' ? '🆕 New session.' : '✅ Ready in `' + workDir(chatId) + '`');
        break;
      }
      case '/stop':
      case '/clear': {
        const s = sessions.get(chatId);
        if (s?.alive) {
          // Disconnect preserves session on disk for resume
          await s.disconnect();
        }
        sessions.delete(chatId);
        await client.sendMessage(chatId, '🛑 Session paused. Send a message to resume.');
        break;
      }
      case '/resume': {
        if (argStr.trim()) {
          const result = await attachSessionById(argStr, chatId, {
            client,
            sessions,
            sessionStore,
            getWorkDir: workDir,
            rememberWorkDir: (targetChatId: string, cwd: string) => {
              workDirs.set(targetChatId, cwd);
              sessionStore.setWorkDir(targetChatId, cwd);
              restartManager.addWorkDir(cwd);
            },
            createSession: () => new Session(),
            buildResumeOptions: (targetChatId: string, cwd: string, sessionId: string) =>
              buildSessionOptions(targetChatId, cwd, sessionId),
            registerSessionListeners: (session, targetChatId) =>
              registerSessionListeners(session as Session, targetChatId),
          });
          await client.sendMessage(chatId, result.message, { replyTo: msgId });
          break;
        }

        const saved = sessionStore.list();
        if (!saved.length) {
          await client.sendMessage(chatId, 'No saved sessions.');
          break;
        }
        const lines = saved.slice(0, 10).map(([id, e]) => {
          const age = Math.round((Date.now() - e.lastUsed) / 60000);
          const ageStr = age < 60 ? age + 'm ago' : Math.round(age / 60) + 'h ago';
          return (
            '• `' + e.cwd.replace(process.env.HOME ?? '', '~') + '` — ' + ageStr + (id === chatId ? ' *(current)*' : '')
          );
        });
        await client.sendMessage(
          chatId,
          '📋 *Sessions*\n' + lines.join('\n') + '\n\nSend a message to auto-resume your session.',
        );
        break;
      }
      case '/cd': {
        await handleCdCommand(args[0], chatId, { client, sessions, workDirs, getSession });
        sessionStore.setWorkDir(chatId, workDir(chatId));
        restartManager.addWorkDir(workDir(chatId));
        break;
      }
      case '/sessions': {
        const all = sessionStore.list();
        if (!all.length) {
          await client.sendMessage(chatId, '📋 No sessions yet.');
          break;
        }
        const now = Date.now();
        const ago = (ts: number) => {
          const m = Math.floor((now - ts) / 60000);
          if (m < 1) return 'just now';
          if (m < 60) return m + 'm ago';
          const h = Math.floor(m / 60);
          if (h < 24) return h + 'h ago';
          return Math.floor(h / 24) + 'd ago';
        };
        const current = sessions.get(chatId)?.sessionId;
        // Collect all active session IDs across all chats
        const activeSessions = new Set<string>();
        for (const [, s] of sessions) {
          if (s.alive && s.sessionId) activeSessions.add(s.sessionId);
        }
        const buttons: Button[][] = [];
        for (const [, entry] of all.slice(0, 10)) {
          const summary = sessionStore.getSummary(entry.sessionId)?.slice(0, 60) ?? entry.model;
          const turns = sessionStore.getTurnCount(entry.sessionId);
          const isCurrent = entry.sessionId === current;
          const isActive = !isCurrent && activeSessions.has(entry.sessionId);
          const label =
            (isCurrent ? '▶️ ' : isActive ? '🟢 ' : '🔁 ') +
            summary +
            (turns ? ' · ' + turns + ' turns' : '') +
            ' · ' +
            ago(entry.lastUsed);
          buttons.push([
            {
              text: label,
              data: '@' + chatId + '|session:' + entry.sessionId,
              ...(isCurrent ? { style: 'success' } : isActive ? { style: 'primary' } : {}),
            },
            {
              text: '🆔',
              data: '@' + chatId + '|sessionid:' + entry.sessionId,
            },
          ]);
        }
        await client.sendButtons(
          chatId,
          '📋 *Sessions*\nTap a row to attach it, or 🆔 to export the raw session id.',
          buttons,
        );
        break;
      }
      case '/sessionid':
      case '/id': {
        const selectedSessionId = argStr.trim() || sessions.get(chatId)?.sessionId;
        if (!selectedSessionId) {
          await client.sendMessage(chatId, '🆔 No active session. Use `/sessionid <session-id>` or start one first.', {
            replyTo: msgId,
          });
          break;
        }

        const entry = sessionStore.getBySessionId(selectedSessionId);
        await client.sendMessage(chatId, formatSessionIdMessage(selectedSessionId, entry?.cwd || workDir(chatId)), {
          replyTo: msgId,
        });
        break;
      }
      case '/status': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, '⚪ No active session — send a message to start one!');
          break;
        }
        const dir = workDir(chatId);
        const lines: string[] = [];

        // Resume command at the bottom
        const transportLine = config.cliUrl ? '🔌 External CLI `' + config.cliUrl + '`' : '🖥️ Local CLI `' + bin + '`';

        const resumeCmd = s.sessionId ? '\n```\ncopilot --resume ' + s.sessionId + '\n```' : '';

        // Git branch
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir, timeout: 3000 }).toString().trim();
          lines.push('📂 `' + dir + '` [⎇ ' + branch + ']');
        } catch {
          lines.push('📂 `' + dir + '`');
        }

        lines.push(transportLine);

        try {
          const [model, mode, agent] = await Promise.all([
            s.getCurrentModel().catch(() => null),
            s.getMode().catch(() => null),
            s.getCurrentAgent().catch(() => null),
          ]);
          if (model?.modelId) lines.push('🤖 `' + model.modelId + '`');
          if (mode) lines.push((MODE_ICONS[mode] ?? '⚙️') + ' ' + mode);
          if (agent?.agent?.name) lines.push('🎭 `' + agent.agent.name + '`');
        } catch {
          /* ignore */
        }

        // Context usage (like Copilot CLI)
        const ci = contextInfoMap.get(chatId);
        if (ci) {
          const pct = ci.tokenLimit ? Math.round((ci.currentTokens / ci.tokenLimit) * 100) : 0;
          const fmt = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
          lines.push('');
          lines.push('**Context Usage**');
          lines.push(
            '`' +
              fmt(ci.currentTokens) +
              '/' +
              fmt(ci.tokenLimit) +
              ' tokens (' +
              pct +
              '%)` · ' +
              ci.messagesLength +
              ' messages',
          );
        }

        // Last turn usage
        const lu = lastUsageMap.get(chatId);
        if (lu) {
          const parts: string[] = [];
          if (lu.inputTokens || lu.outputTokens) parts.push(`${lu.inputTokens ?? 0}→${lu.outputTokens ?? 0} tokens`);
          if (lu.cacheReadTokens) parts.push(`${lu.cacheReadTokens} cached`);
          if (lu.duration) parts.push(`${(lu.duration / 1000).toFixed(1)}s`);
          if (parts.length) {
            lines.push('');
            lines.push('**Last Turn**');
            lines.push('`' + parts.join(' · ') + '`');
          }
        }

        // Quota
        try {
          const q = await s.getQuota();
          const snap = q?.quotaSnapshots;
          log.debug('Quota snapshots:', JSON.stringify(snap));
          if (snap) {
            const chat = snap.chat;
            const completions = snap.completions;
            if (chat || completions) {
              lines.push('');
              lines.push('**Quota**');
              if (chat) {
                if (chat.isUnlimitedEntitlement) {
                  lines.push('💬 Chat: ♾️ Unlimited');
                } else {
                  lines.push(
                    '💬 Chat: `' +
                      (chat.usedRequests ?? '?') +
                      '/' +
                      (chat.entitlementRequests ?? '?') +
                      '` (' +
                      (chat.remainingPercentage ?? '?') +
                      '% left)',
                  );
                }
              }
              if (completions) {
                if (completions.isUnlimitedEntitlement) {
                  lines.push('⚡ Completions: ♾️ Unlimited');
                } else {
                  lines.push(
                    '⚡ Completions: `' +
                      (completions.usedRequests ?? '?') +
                      '/' +
                      (completions.entitlementRequests ?? '?') +
                      '` (' +
                      (completions.remainingPercentage ?? '?') +
                      '% left)',
                  );
                }
              }
            }
          }
        } catch {
          /* ignore */
        }

        const statusText = lines.join('\n') + resumeCmd;
        if (s.sessionId) {
          await client.sendButtons(chatId, statusText, [
            [{ text: '🆔 Session ID', data: '@' + chatId + '|sessionid:' + s.sessionId }],
          ]);
        } else {
          await client.sendMessage(chatId, statusText);
        }
        break;
      }
      case '/mcpreload': {
        // Reconnect all MCP servers for this session — recovers a dead remote MCP
        // session (e.g. github-mcp `invalid session`, which kills web_search) without
        // a full process restart. See TROUBLESHOOTING.md / the 2026-07-15 incident.
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, '⚠️ No active session. Send a message first, then /mcpreload.');
          break;
        }
        if (s.busy) {
          await client.sendMessage(chatId, '⏳ A turn is in progress — wait for it to finish, then /mcpreload.');
          break;
        }
        await client.sendMessage(chatId, '♻️ Reloading all MCP server connections for this session…');
        try {
          await s.reloadMcpServers();
        } catch (e) {
          await client.sendMessage(chatId, '❌ Reload failed: ' + (e instanceof Error ? e.message : String(e)));
          break;
        }
        await client.sendMessage(chatId, '✅ MCP servers reloaded. Run a real search to confirm recovery.');
        break;
      }
      case '/mcp': {
        // Unified MCP view: merge runtime status (session.rpc.mcp.list) with
        // configured details (mcp-config.json, .vscode/mcp.json, .mcp.json).
        // Without an active session, fall back to configured-only.
        const STATUS_EMOJI: Record<string, string> = {
          connected: '✅',
          failed: '❌',
          'needs-auth': '🔐',
          pending: '⏳',
          disabled: '⏸️',
          not_configured: '⚪',
        };
        const { merged: configured, sources } = loadMcpServers(configStore.raw().mcpServers, workDir(chatId));
        const s = sessions.get(chatId);

        // Short timeout — never block the chat on a sluggish MCP host init.
        const runtime = s?.alive
          ? await Promise.race([
              s.listMcpServers().then((r) => r.servers ?? []),
              new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 4000)),
            ])
          : null;
        const rtMap = new Map(Array.isArray(runtime) ? runtime.map((r) => [r.name, r]) : []);
        const names = [...new Set([...rtMap.keys(), ...Object.keys(configured)])].sort();

        if (!names.length) {
          await client.sendMessage(
            chatId,
            '🔌 No MCP servers configured.\n\nAdd to any of:\n' +
              getConfigPaths(workDir(chatId))
                .map((p) => '`' + p.replace(process.env.HOME ?? '', '~') + '`')
                .join('\n'),
          );
          break;
        }

        let header = '';
        if (runtime === 'timeout') {
          header = '⚠️ Runtime status unavailable (timeout) — showing configured only.\n\n';
        } else if (runtime == null) {
          header =
            '_No active session — showing configured only. Start one to see runtime status and built-ins like `github-mcp-server`._\n\n';
        }

        const rows = names.map((n) => {
          const rt = rtMap.get(n);
          const cfg = configured[n];
          const emoji = rt ? (STATUS_EMOJI[rt.status] ?? '❔') : '⚪';
          // Status text:
          // - runtime entry → SDK status (connected/failed/etc.)
          // - configured + active session but no runtime entry → it wasn't loaded
          // - configured + no session → just say "configured"
          const status = rt?.status ?? (runtime ? 'configured, not running' : 'configured');
          const sourceLabel = rt?.source ? ' _' + rt.source + '_' : '';
          const errLine = rt?.error ? '\n   _' + rt.error + '_' : '';
          const detailLine = cfg ? '\n   ' + formatServerConfigDetails(cfg) : '';
          return emoji + ' `' + n + '` — ' + status + sourceLabel + errLine + detailLine;
        });

        const footer = sources.length
          ? '\n\n_Config sources: ' + sources.map((src) => '`' + src.name + '`').join(', ') + '_'
          : '';
        await client.sendMessage(
          chatId,
          header + '🔌 *MCP Servers* (' + names.length + ')\n' + rows.join('\n') + footer,
        );
        break;
      }
      case '/yes':
      case '/y': {
        sessions.get(chatId)?.approve();
        break;
      }
      case '/no':
      case '/n': {
        sessions.get(chatId)?.deny();
        break;
      }
      case '/abort': {
        // SDK abort cancels the running turn and its spawned sub-agents while leaving the
        // session valid and the conversation intact. Use /new to start fresh instead.
        const s = sessions.get(chatId);
        if (s?.alive) {
          try {
            const stopped = await s.abort();
            if (!stopped) throw new Error('runtime declined abort');
            await client.sendMessage(chatId, '🛑 Turn stopped. Session and history are intact.');
          } catch (e) {
            // Same reasoning as the timeout path: an unconfirmed abort may leave the turn
            // running and `busy` stuck, so drop the in-memory session (disk history kept).
            suspendSession(chatId);
            log.warn('[abort:failed]', `chat=${chatId}`, String(e));
            await client.sendMessage(
              chatId,
              '⚠️ Stop could not be confirmed — session disconnected, history preserved. Send a message to resume.',
            );
          }
        } else {
          await client.sendMessage(chatId, '⚪ No active session.');
        }
        break;
      }
      case '/debug':
      case '/autopilot':
      case '/allowall': {
        await client.sendMessage(chatId, 'Use /config to change settings.');
        break;
      }
      case '/agent': {
        const s = sessions.get(chatId);
        if (!args[0]) {
          const discoveredAgents = discoverAgents(workDir(chatId));
          // List available agents with buttons
          if (s?.alive) {
            try {
              const r = await s.listAgents();
              const listedAgents = r?.agents ?? [];
              const mergedAgents = [
                ...listedAgents,
                ...discoveredAgents.filter(
                  (candidate) => !listedAgents.some((agent) => (agent.name ?? String(agent)) === candidate.name),
                ),
              ];
              const agentPfx = (d: string) => `@${chatId}|${d}`;
              // Also show current agent
              let currentName = '';
              try {
                const cur = await s.getCurrentAgent();
                currentName = cur?.agent?.name ?? '';
              } catch {
                /* ignore */
              }
              if (!mergedAgents.length) {
                await client.sendMessage(chatId, '🤖 No agents found.');
                break;
              }
              const buttons: Button[][] = [];
              for (let i = 0; i < mergedAgents.length; i += 2) {
                const row: Button[] = [];
                for (let j = i; j < Math.min(i + 2, mergedAgents.length); j++) {
                  const a = mergedAgents[j];
                  const name = a.name ?? String(a);
                  const label = name === currentName ? '✅ ' + name : name;
                  row.push({ text: label, data: agentPfx('agent:' + name) });
                }
                buttons.push(row);
              }
              if (currentName) {
                buttons.push([{ text: '❌ Deselect agent', data: agentPfx('agent:__deselect__') }]);
              }
              await client.sendButtons(
                chatId,
                '🤖 *Agents*' + (currentName ? ' (current: `' + currentName + '`)' : ''),
                buttons,
              );
            } catch (e) {
              await client.sendMessage(chatId, '❌ ' + e);
            }
          } else {
            // No active session — show configured custom agents plus locally discovered repo agents
            const g = configStore.raw();
            const configuredAgents = (g.customAgents ?? []) as Array<{ name?: string }>;
            const custom = [
              ...configuredAgents,
              ...discoveredAgents.filter(
                (candidate) => !configuredAgents.some((agent) => agent.name === candidate.name),
              ),
            ];
            if (custom.length) {
              const lines = custom.map((a: unknown) => {
                const agent = a as { name?: string };
                return '• `' + (agent.name ?? String(a)) + '`';
              });
              await client.sendMessage(
                chatId,
                '🤖 *Custom Agents*\n' + lines.join('\n') + '\n\nStart a session first to list all agents.',
              );
            } else {
              await client.sendMessage(
                chatId,
                '🤖 No agents configured. Start a session first to list available agents.',
              );
            }
          }
          break;
        }
        if (args[0] && s?.alive) {
          try {
            await s.selectAgent(args[0]);
            await client.sendMessage(chatId, '🤖 Agent: `' + args[0] + '`');
          } catch (e) {
            await client.sendMessage(chatId, '❌ ' + e);
          }
        } else if (args[0]) {
          const c = cfg(chatId);
          c.agent = args[0];
          setCfg(chatId, c);
          await client.sendMessage(chatId, '🤖 Agent `' + args[0] + '` set for next session.');
        }
        break;
      }
      case '/prompt': {
        const dir = workDir(chatId);
        // Scan for .prompt.md files in .github/prompts/ (repo) and ~/.copilot/prompts/ (personal)
        const promptDirs = [
          path.join(dir, '.github', 'prompts'),
          path.join(process.env.HOME ?? '', '.copilot', 'prompts'),
          path.join(process.env.HOME ?? '', '.github', 'prompts'),
        ];
        const prompts: { name: string; path: string; description: string }[] = [];
        for (const pd of promptDirs) {
          try {
            if (!fs.existsSync(pd)) continue;
            for (const f of fs.readdirSync(pd)) {
              if (!f.endsWith('.prompt.md')) continue;
              const name = f.replace('.prompt.md', '');
              const content = fs.readFileSync(path.join(pd, f), 'utf-8');
              // Extract description from YAML frontmatter or first line
              const descMatch =
                content.match(/^---\n[\s\S]*?description:\s*(.+)\n[\s\S]*?---/) ?? content.match(/^#\s*(.+)/m);
              const desc = descMatch?.[1]?.trim() ?? '';
              prompts.push({ name, path: path.join(pd, f), description: desc });
            }
          } catch {
            /* skip */
          }
        }

        if (!argStr) {
          // List available prompts
          if (!prompts.length) {
            await client.sendMessage(
              chatId,
              '📝 No prompt files found.\n\nCreate `.prompt.md` files in:\n• `.github/prompts/` (repo)\n• `~/.copilot/prompts/` (personal)',
            );
            break;
          }
          const buttons: Button[][] = prompts.map((p) => [
            {
              text: p.name + (p.description ? ' — ' + p.description.slice(0, 40) : ''),
              data: '@' + chatId + '|prompt:' + p.name,
            },
          ]);
          await client.sendButtons(chatId, '📝 *Prompt Files*', buttons);
          break;
        }

        // Run a specific prompt
        const match = prompts.find((p) => p.name === argStr || p.name === args[0]);
        if (!match) {
          await client.sendMessage(chatId, '❌ Prompt `' + argStr + '` not found.');
          break;
        }
        let content = fs.readFileSync(match.path, 'utf-8');
        // Strip YAML frontmatter
        content = content.replace(/^---\n[\s\S]*?---\n/, '').trim();
        // Replace variable placeholders {{variable}} with remaining args
        const vars = args.slice(1);
        let varIdx = 0;
        content = content.replace(/\{\{(\w+)\}\}/g, (_, name) => {
          return vars[varIdx++] ?? '{{' + name + '}}';
        });
        await handlePrompt(chatId, msgId, envelope + content);
        break;
      }
      case '/plan': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await getSession(chatId);
          return handleCommand(text, chatId, msgId, envelope);
        }
        try {
          if (args[0] === 'show') {
            const p = await s.readPlan();
            await client.sendMessage(chatId, p?.content ? '📋 ' + p.content.slice(0, 3800) : '📋 No plan.');
          } else if (args[0] === 'delete') {
            await s.deletePlan();
            await client.sendMessage(chatId, '🗑 Plan deleted.');
          } else if (argStr) {
            await s.setMode('plan');
            await handlePrompt(chatId, msgId, envelope + argStr);
          } else {
            const cur = await s.getMode();
            const next = cur === 'plan' ? 'interactive' : 'plan';
            await s.setMode(next);
            await client.sendMessage(chatId, next === 'plan' ? '📋 Plan mode ON' : '⚡ Interactive');
          }
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/fleet': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          const r = await s.startFleet(argStr || undefined);
          await client.sendMessage(chatId, '🚀 Fleet: ' + JSON.stringify(r));
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/search': {
        if (!argStr) {
          await client.sendMessage(chatId, '🔍 Usage: `/search <query>`\nSearches across all session history.');
          break;
        }
        const results = sessionStore.search(argStr, 5);
        if (!results.length) {
          await client.sendMessage(chatId, '🔍 No results for "' + argStr + '"');
          break;
        }
        const buttons: Button[][] = results.map((r) => [
          {
            text:
              (r.summary?.slice(0, 50) ?? r.sessionId.slice(0, 8)) +
              ' — ' +
              r.snippet.replace(/<\/?b>/g, '').slice(0, 40),
            data: '@' + chatId + '|session:' + r.sessionId,
          },
        ]);
        await client.sendButtons(chatId, '🔍 *Results for "' + argStr + '"*', buttons);
        break;
      }
      case '/compact': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          client.setReaction(chatId, msgId, '👍').catch(() => {});
          client.sendTyping(chatId).catch(() => {});
          const r = await s.compact();
          const info = contextInfoMap.get(chatId);
          const pct = info ? ' (' + Math.round((info.currentTokens / info.tokenLimit) * 100) + '% used)' : '';
          client.setReaction(chatId, msgId, '✅').catch(() => {});
          await client.sendMessage(chatId, '🗜️ Compacted — ' + (r?.tokensRemoved ?? 0) + ' tokens freed' + pct);
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/context': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        const msgs = await s.getMessages();
        const types: Record<string, number> = {};
        for (const m of msgs) types[m.type] = (types[m.type] ?? 0) + 1;
        const lines = ['📊 *Context* (' + msgs.length + ' events)'];
        for (const [t, n] of Object.entries(types)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10))
          lines.push('  `' + t + '`: ' + n);
        await client.sendMessage(chatId, lines.join('\n'));
        break;
      }
      case '/usage': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          const q = await s.getQuota();
          const snaps = q?.quotaSnapshots;
          const lines: string[] = [];
          if (snaps && typeof snaps === 'object') {
            for (const [name, snap] of Object.entries(snaps)) {
              if (!snap) continue;
              const used = snap.usedRequests ?? 0;
              const total = snap.entitlementRequests ?? 0;
              const pct = snap.remainingPercentage ?? 100;
              const reset = snap.resetDate ? new Date(snap.resetDate).toLocaleDateString() : '';
              lines.push(`*${name}*: ${used}/${total} used · ${pct}% remaining${reset ? ' · resets ' + reset : ''}`);
            }
          }
          // Add context info if available
          const ci = contextInfoMap.get(chatId);
          if (ci) {
            const pct = ci.tokenLimit ? Math.round((ci.currentTokens / ci.tokenLimit) * 100) : 0;
            lines.push(`📊 ${pct}% context · ${ci.messagesLength} msgs`);
          }

          if (lines.length) {
            await client.sendMessage(chatId, '📊 *Usage*\n' + lines.join('\n'));
          } else {
            await client.sendMessage(chatId, '📊 No usage data available.');
          }
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/restart': {
        const status = restartManager.getStatus();
        const reason = argStr || status.pending?.reason || 'Manual restart requested';
        await client.sendMessage(chatId, `♻️ Restart requested.\n\n${reason}`);
        requestSelfRestart(reason, collectRestartRecipients(chatId));
        break;
      }
      case '/selfdev': {
        const status = restartManager.getStatus();
        const lines = [
          '🧬 *Self Development*',
          `Enabled: ${status.enabled ? 'yes' : 'no'}`,
          `Supervisor: ${status.supervisor ?? 'none detected'}`,
          `Auto-restart: ${status.autoRestart ? 'yes' : 'no'}`,
          `DM-only notices: ${status.notifyDmsOnly ? 'yes' : 'no'}`,
          `Watched paths: ${status.watchedPaths.length}`,
        ];
        if (status.pending?.reason) lines.push(`Pending restart: ${status.pending.reason}`);
        if (status.watchedPaths.length) {
          lines.push('', '*Watching*');
          lines.push(...status.watchedPaths.slice(0, 8).map((target) => `• \`${target}\``));
          if (status.watchedPaths.length > 8) lines.push(`• …and ${status.watchedPaths.length - 8} more`);
        }
        await client.sendMessage(chatId, lines.join('\n'));
        break;
      }
      case '/tools': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          const r = await s.listTools();
          const tools = r?.tools ?? [];
          if (tools.length) {
            const lines = tools.slice(0, 30).map((t) => '• `' + (t.name ?? t) + '`');
            await client.sendMessage(chatId, '🔧 *Tools* (' + tools.length + ')\n' + lines.join('\n'));
          } else await client.sendMessage(chatId, '🔧 No tools.');
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/files': {
        const s = sessions.get(chatId);
        if (!s?.alive) {
          await client.sendMessage(chatId, 'No session.');
          break;
        }
        try {
          if (args[0] === 'read' && args[1]) {
            const content = await s.readFile(args[1]);
            await client.sendMessage(chatId, '📄 `' + args[1] + '`\n```\n' + content.slice(0, 3800) + '\n```');
          } else {
            const files = await s.listFiles();
            const lines = files.slice(0, 40).map((f: string) => '• `' + f + '`');
            await client.sendMessage(chatId, '📂 ' + files.length + ' files\n' + lines.join('\n'));
          }
        } catch (e) {
          await client.sendMessage(chatId, '❌ ' + e);
        }
        break;
      }
      case '/config': {
        await sendConfigMenu(chatId, configMenuDeps);
        break;
      }
      case '/ask': {
        if (!argStr) {
          await client.sendMessage(chatId, 'Usage: `/ask <question>`\nAsk a quick side question — answered with current context, then removed from history.');
          break;
        }
        let s = sessions.get(chatId);
        if (!s?.alive) {
          s = await getSession(chatId);
        }
        await handlePrompt(chatId, msgId, envelope + argStr, undefined, 1, undefined, { askMode: true });
        break;
      }
      case '/help':
      default: {
        await client.sendMessage(
          chatId,
          [
            '⚡ *Copilot Remote* v' + version,
            '',
            '*💬 Session*',
            '`/new` — Fresh session',
            '`/stop` — Kill session',
            '`/attach <session-id>` — Attach any known Copilot session',
            '`/cd <dir>` — Change working directory',
            '`/status` — Model, mode, cwd, quota',
            '`/sessionid [session-id]` — Export a copy-friendly session id',
            '`/compact` — Compress context window',
            '`/abort` — Stop the current turn (session & history kept)',
            '',
            '*🧠 Modes*',
            '`/plan [task]` — Toggle plan mode or plan a task',
            '`/fleet [task]` — Spawn parallel sub-agents',
            '',
            '*💻 Coding*',
            '`/research <topic>` — Deep research',
            '`/ask <question>` — Quick side question (no history)',
            '`/diff` — Show uncommitted changes',
            '`/review` — Code review current changes',
            '`/init` — Generate copilot-instructions.md',
            '',
            '*🔧 Tools & Agents*',
            '`/agent [name]` — Switch or list agents',
            '`/tools` — List available tools',
            '`/mcp` — MCP servers and runtime status',
            '`/mcpreload` — Reconnect all MCP servers if tools stop working',
            '`/files` — Browse workspace files',
            '`/usage` — Token quota info',
            '',
            '*⚙️ Config*',
            '`/config` — Settings menu (model, mode, security, display)',
            '`/selfdev` — Watcher status and pending restart info',
            '`/restart` — Restart bridge to load new capabilities',
            '`/yes` `/no` — Approve/deny tool permission',
            '',
            '*📎 Tips*',
            '• Send images, files, or voice messages',
            '• Reply to a message to provide context',
            '• Use topics for separate workspaces',
          ].join('\n'),
        );
        break;
      }
    }
  }

  // ── Config menu ──
  client.onReaction = async (emoji, rawChatId, msgId, threadId) => {
    const chatId = threadId ? sessionKey(rawChatId, threadId) : rawChatId;
    if (!hasPendingPerm(chatId, msgId)) return;
    const s = sessions.get(chatId);
    if (!s?.alive) return;
    if (emoji === '👍' || emoji === '✅') {
      s.approve();
      clearPendingPerm(chatId, msgId);
      await client.deleteMessage?.(chatId, msgId);
    } else if (emoji === '👎' || emoji === '❌') {
      s.deny();
      clearPendingPerm(chatId, msgId);
      await client.editButtons(chatId, msgId, '❌ Denied', []);
    }
  };

  // ── File handler — download and pass to Copilot ──
  client.onFile = async (fileId, fileName, caption, rawChatId, msgId, threadId, senderId) => {
    const chatId = threadId ? sessionKey(rawChatId, threadId) : rawChatId;
    if (!client.getFileUrl) return;
    await handleIncomingFileUpload(
      { fileId, fileName, caption, chatId, msgId, senderId },
      {
        resolveFileUrl: (incomingFileId) => client.getFileUrl!(incomingFileId),
        download: async (url) => {
          // Retry up to 3 times — Azure VM has intermittent fetch failures
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const res = await fetch(url);
              return new Uint8Array(await res.arrayBuffer());
            } catch {
              if (attempt === 2) throw new Error('File download failed after 3 attempts');
              await new Promise(r => setTimeout(r, 1000));
            }
          }
          throw new Error('File download failed');
        },
        ensureTempDir: (dirPath) => {
          fs.mkdirSync(dirPath, { recursive: true });
        },
        writeFile: (filePath, data) => {
          fs.writeFileSync(filePath, Buffer.from(data));
        },
        transcribeAudio: async (filePath) => {
          const wavPath = filePath.replace(/\.(oga|ogg)$/i, '.wav');
          execSync('ffmpeg -y -i ' + JSON.stringify(filePath) + ' ' + JSON.stringify(wavPath), { timeout: 10000 });
          return execSync(
            'gemini -p "Transcribe this audio file exactly. Return ONLY the transcription text, nothing else." ' +
              JSON.stringify(wavPath),
            { timeout: 30000, encoding: 'utf-8' },
          ).trim();
        },
        handlePrompt,
        sendMessage: (targetChatId, text) => client.sendMessage(targetChatId, text).then(() => {}),
        logDebug: (message, error) => {
          log.debug(message, error);
        },
        uploadDir: config.uploadDir,
      },
    );
  };

  client.onCallback = async (callbackId, data, rawChatId, msgId, threadId) => {
    // Always answer callback to dismiss loading spinner
    client.answerCallback?.(callbackId);

    // Extract session key from callback data prefix: @sessionKey|actualData
    let chatId: string;
    if (data.startsWith('@') && data.includes('|')) {
      const pipeIdx = data.indexOf('|');
      chatId = data.slice(1, pipeIdx);
      data = data.slice(pipeIdx + 1);
    } else {
      // Legacy callbacks or permission buttons without prefix
      chatId = threadId ? sessionKey(rawChatId, threadId) : rawChatId;
    }

    if (data.startsWith('perm:')) {
      if (data === 'perm:all') {
        // perm:all approves the clicked prompt + sweeps all other pending in chat
        if (!hasPendingPerm(chatId, msgId)) return;
        const s = sessions.get(chatId);
        if (!s?.alive) return;
        s.approve();
        for (const k of pendingPerms) {
          if (!matchesChat(k, chatId)) continue;
          const id = Number(k.slice(chatId.length + 1));
          s.approve();
          pendingPerms.delete(k);
          if (id !== msgId) client.deleteMessage?.(chatId, id).catch(() => {});
        }
        await client.deleteMessage?.(chatId, msgId);
      } else {
        // Stale-button guard: if the prompt isn't pending, the top-of-handler
        // answerCallback() already stopped the spinner — do NOT edit buttons
        // (they may already show ✅/❌ from a prior accept).
        if (!hasPendingPerm(chatId, msgId)) return;
        const s = sessions.get(chatId);
        if (!s?.alive) return;
        const ok = data === 'perm:yes';
        clearPendingPerm(chatId, msgId);
        if (ok) s.approve();
        else s.deny();
        if (ok) {
          await client.deleteMessage?.(chatId, msgId);
        } else {
          await client.editButtons(chatId, msgId, '❌', []);
        }
      }
      return;
    }
    // Delegate config-related callbacks to config-menu module
    if (await handleConfigCallback(data, chatId, msgId, callbackId, configMenuDeps)) return;
    if (await handleAgentCallback(data, chatId, msgId, callbackId, { client, configStore, sessions, getSession }))
      return;
    if (
      await handleSessionCallback(data, chatId, msgId, callbackId, {
        client,
        sessions,
        sessionStore,
        getWorkDir: workDir,
        rememberWorkDir: (targetChatId: string, cwd: string) => {
          workDirs.set(targetChatId, cwd);
          sessionStore.setWorkDir(targetChatId, cwd);
          restartManager.addWorkDir(cwd);
        },
        createSession: () => new Session(),
        buildResumeOptions: (targetChatId: string, cwd: string, sessionId: string) =>
          buildSessionOptions(targetChatId, cwd, sessionId),
        registerSessionListeners: (session, targetChatId) => registerSessionListeners(session as Session, targetChatId),
      })
    )
      return;

    // Handle user input responses (from ask_user tool)
    if (data.startsWith('input:')) {
      const answer = data.slice('input:'.length);
      // Stale-button guard: if no pending entry, the top-of-handler
      // answerCallback() already stopped the spinner — do NOT edit
      // buttons (they may already show ✅ from a prior accept).
      if (!hasPendingInput(chatId, msgId)) return;
      const s = sessions.get(chatId);
      if (!s?.alive) return;
      clearPendingInput(chatId, msgId);
      s.answerInput(answer);
      await client.editButtons(chatId, msgId, '✅ ' + answer, []);
      return;
    }
  };

  // ── Shutdown ──
  const shutdown = async (restart = false) => {
    if (shuttingDown) return;
    shuttingDown = true;
    restartManager.stop();
    client.stop();
    await Promise.allSettled([...sessions.values()].map((s) => s.disconnect().catch(() => {})));
    instanceLock.release();
    process.exit(restart ? 75 : 0);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('SIGUSR1', () => {
    log.info('[restart] Graceful restart:', pendingRestartReason ?? 'SIGUSR1');
    void shutdown(true);
  });

  const pendingRestartNotice = consumeRestartNotice();
  if (pendingRestartNotice) {
    const recipients = filterRestartRecipients(
      pendingRestartNotice.recipients,
      restartManager.getStatus().notifyDmsOnly,
    );
    for (const recipient of recipients) {
      client
        .sendMessage(recipient, `✅ Daemon restarted and back online.\n\n${pendingRestartNotice.reason}`)
        .catch(() => {});
    }
  }

  await client.start();
}

// Global error handlers — capture crashes and notify all active sessions
let _globalClient: Client | undefined;
let _globalSessions: Map<string, Session> | undefined;

function notifyActiveSessions(msg: string) {
  if (!_globalClient || !_globalSessions) return;
  for (const chatId of _globalSessions.keys()) {
    _globalClient.sendMessage(chatId, msg).catch(() => {});
  }
}

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err.message);
  notifyActiveSessions('⚠️ *Internal error:* `' + err.message.slice(0, 200) + '`\nSession may need a `/new` restart.');
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  log.error('Unhandled rejection:', msg);
  // Only notify on serious errors, not routine ones
  if (msg.includes('STREAM_DESTROYED') || msg.includes('ECONNRESET') || msg.includes('session')) {
    notifyActiveSessions('⚠️ *Connection lost:* `' + msg.slice(0, 200) + '`\nSend a message to reconnect.');
  }
});

main().catch((e) => {
  log.error('Fatal:', e);
  process.exit(1);
});
