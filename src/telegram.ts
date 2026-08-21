// Copilot Remote — Telegram Client (grammY)
import { Bot, GrammyError, HttpError, type Context, InputFile } from 'grammy';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import { autoRetry } from '@grammyjs/auto-retry';
import { hydrate, type HydrateFlavor } from '@grammyjs/hydrate';
import { hydrateFiles, type FileFlavor } from '@grammyjs/files';
import type { Transformer } from 'grammy';
import type { Update } from 'grammy/types';
import { markdownToHtml, markdownToText, markdownToTelegramChunks } from './format.js';
import { toTelegramReaction } from './emoji.js';
import { log } from './log.js';
import type { Client, MessageOptions, Button } from './client.js';
import { buildSenderEnvelope } from './inbound-envelope.js';
import {
  formatLogFields,
  summarizeTelegramApiCall,
  summarizeTelegramApiResult,
  summarizeTelegramUpdate,
  summarizeTextForLog,
} from './transport-log.js';

const MAX_MESSAGE_LENGTH = 4096;
const DRAFT_ID_MAX = 2_147_483_647;
const DRAFT_REQUEST_TIMEOUT_MS = 1200;
let nextDraftId = 0;

/**
 * Race a promise against a wall-clock timer. On timeout, rejects with an
 * AbortError-named Error and aborts the signal so the underlying call can
 * release fetch/transformer resources. The inner promise may still settle
 * later — its result will be ignored.
 *
 * Rejection ordering matters: we reject the timeout promise BEFORE aborting,
 * because some transformers (e.g. `@grammyjs/auto-retry` during a backoff
 * sleep) synchronously throw a plain `Error` when the signal aborts mid-wait,
 * which would lose the AbortError name that callers detect via `e.name`.
 */
export async function withAbortTimeout<T>(fn: (signal?: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Operation timed out after ${ms}ms`);
      err.name = 'AbortError';
      reject(err);
      ac.abort();
    }, ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default timeout for Telegram message-send/edit calls without an explicit
 * caller override. Telegram POSTs normally return in <1s; 30s gives ~30×
 * safety margin and prevents the bot from awaiting forever when an HTTPS
 * request silently hangs (observed once per ~1,500 sends in production).
 */
const DEFAULT_API_TIMEOUT_MS = 30_000;

/** Telegram's hard limit on `callback_data` byte length. Exceeding it makes Telegram reject the entire keyboard with `BUTTON_DATA_INVALID`. */
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/**
 * Timeout for fire-and-forget UX calls (reactions, typing indicators). These
 * are silent-failure-safe — dropping the 👀 reaction or a typing-dot frame
 * costs nothing visible, while letting them block forever can starve the
 * per-chat Bottleneck lane and delay user-visible sends (see the 2026-06-03
 * incident where a hung `setMessageReaction` blocked the placeholder
 * `sendMessage` for 132s). 10s = ~10× normal Telegram latency, generous
 * enough that slow but healthy networks don't drop these signals.
 */
const UX_CALL_TIMEOUT_MS = 10_000;

/**
 * Race a promise against a setTimeout. On timeout we abandon the awaited
 * call and continue — the underlying HTTPS request may still complete in
 * the background. Used for startup calls (`setMyCommands`, `deleteWebhook`,
 * `getMe`) that go through grammY's `auto-retry` plugin which would otherwise
 * retry indefinitely on transient Telegram failures and wedge daemon startup.
 */
async function withStartupTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T | null>([
      promise.catch((e) => {
        log.debug(`[Telegram] ${label} failed:`, (e as Error)?.message ?? e);
        return null;
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          log.warn(`[Telegram] ${label} timed out after ${ms}ms — skipping`);
          resolve(null);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type MyContext = HydrateFlavor<FileFlavor<Context>>;

export interface TelegramConfig {
  botToken: string;
  /** Telegram user IDs (numeric strings) that may interact with the bot. Empty = deny all. */
  allowedUsers: string[];
  /** Override jitter range (ms) for denial replies — `[min, max]`. Defaults to `[20_000, 120_000]`.
   *  Set to `[0, 0]` for synchronous replies (used by tests). */
  denialReplyJitterMs?: [number, number];
  profilePhoto?: string;
}

/** Min interval between denial replies sent to the same user (anti-oracle, anti-flood). */
const DENIAL_REPLY_INTERVAL_MS = 60_000;
/** Max age for entries in the denial-reply timestamp map. */
const DENIAL_MAP_TTL_MS = 60 * 60_000;
/** Jitter window for denial replies — randomized delay before sending kills the timing oracle that
 *  would otherwise let a probe distinguish "denied" (~ms) from "authorized & processing" (seconds). */
const DENIAL_REPLY_JITTER_MIN_MS = 20_000;
const DENIAL_REPLY_JITTER_MAX_MS = 120_000;

type RawApi = Record<string, (...args: unknown[]) => unknown>;

export class TelegramClient implements Client {
  readonly name = 'telegram';
  private bot: Bot<MyContext>;
  private runner: RunnerHandle | null = null;
  private allowedUsers: Set<string>;
  private denialReplyJitterMs: [number, number];
  private lastDenialReplyAt = new Map<string, number>();
  private topicNames = new Map<string, string>();
  private msgThreadMap = new Map<number, number>(); // msgId → threadId for callback resolution
  private updateSeq = 0;

  // Event handlers (set by bridge consumer)
  onMessage?: Client['onMessage'];
  onCallback?: Client['onCallback'];
  onReaction?: Client['onReaction'];
  onFile?: Client['onFile'];

  /** Expose bot API for draft stream integration. */
  get api() {
    return this.bot.api;
  }

  /** Typed accessor for raw API methods (avoids repeated casts). */
  private get raw(): RawApi {
    return this.bot.api.raw as RawApi;
  }

  // Bridge-injected sender envelope: every inbound prompt's first line is
  // `<sender>{telegram-id}</sender>`. Agents strip it (see stuff/AGENTS.md).
  private senderEnvelope(ctx: Context): string {
    return buildSenderEnvelope(this.senderIdOf(ctx));
  }
  private senderIdOf(ctx: Context): string {
    return String(ctx.from?.id ?? 'unknown');
  }

  constructor(private config: TelegramConfig) {
    this.bot = new Bot<MyContext>(config.botToken);

    // ── Plugins ──
    this.bot.api.config.use(apiThrottler());
    this.bot.api.config.use(autoRetry({ maxRetryAttempts: 5, maxDelaySeconds: 30 }));
    const defaultParseMode: Transformer = (prev, method, payload, signal) => {
      if (!('parse_mode' in payload)) {
        (payload as Record<string, unknown>).parse_mode = 'HTML';
      }
      return prev(method, payload, signal);
    };
    const apiLogger: Transformer = async (prev, method, payload, signal) => {
      const normalizedPayload = (payload ?? {}) as Record<string, unknown>;
      const startedAt = Date.now();
      const txSummary = summarizeTelegramApiCall(method, normalizedPayload);
      log.verbose('[Telegram API TX]', ...formatLogFields(txSummary));
      if (log.shouldLog('debug')) {
        log.debug('[Telegram API TX RAW]', `method=${method}`, `payload=${JSON.stringify(normalizedPayload)}`);
      }
      try {
        const result = await prev(method, payload, signal);
        // Pass raw `result` so summarizeTelegramApiResult can detect `{ok:false, ...}` envelopes
        // that grammY will throw on AFTER this transformer returns. Previously we passed
        // `result.result ?? result`, which discarded the envelope and hardcoded `ok:true`,
        // hiding all `BUTTON_DATA_INVALID` / `chat not found` / etc. failures from logs.
        const rxSummary = summarizeTelegramApiResult(method, result);
        const rxFields = formatLogFields({ ...rxSummary, ms: Date.now() - startedAt });
        if (rxSummary.ok === false) {
          log.warn('[Telegram API RX]', ...rxFields);
        } else {
          log.verbose('[Telegram API RX]', ...rxFields);
        }
        if (log.shouldLog('debug')) {
          log.debug('[Telegram API RX RAW]', `method=${method}`, `result=${JSON.stringify(result)}`);
        }
        return result;
      } catch (error) {
        log.warn(
          '[Telegram API ERR]',
          ...formatLogFields({
            ...txSummary,
            ms: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        throw error;
      }
    };
    this.bot.api.config.use(defaultParseMode);
    this.bot.api.config.use(apiLogger);
    this.bot.api.config.use(hydrateFiles(config.botToken));
    this.bot.use(hydrate());

    this.allowedUsers = new Set(config.allowedUsers.map((u) => u.trim()).filter(Boolean));
    this.denialReplyJitterMs = config.denialReplyJitterMs ?? [DENIAL_REPLY_JITTER_MIN_MS, DENIAL_REPLY_JITTER_MAX_MS];

    this.setupHandlers();

    this.bot.catch((err) => {
      const e = err.error;
      if (e instanceof GrammyError) {
        log.error('[Telegram] API error:', e.description);
      } else if (e instanceof HttpError) {
        log.error('[Telegram] Network error:', e.message);
      } else {
        log.error('[Telegram] Handler error:', e);
      }
    });
  }

  /**
   * Check whether an inbound update is allowed.
   * Default-deny: bots are always rejected; unknown users are rejected; empty allowlist denies all.
   */
  private isAllowed(
    userId: number | undefined,
    isBot: boolean | undefined,
  ): { allowed: boolean; reason?: string } {
    if (isBot === true) return { allowed: false, reason: 'bot-account' };
    if (userId === undefined) return { allowed: false, reason: 'no-user' };
    const uid = String(userId);

    if (this.allowedUsers.size === 0) return { allowed: false, reason: 'no-allowlist' };
    if (!this.allowedUsers.has(uid)) return { allowed: false, reason: 'user-not-allowed' };

    return { allowed: true };
  }

  /** Should we send a denial reply to this user right now? Rate-limited to one per DENIAL_REPLY_INTERVAL_MS. */
  private shouldSendDenialReply(userId: string): boolean {
    const now = Date.now();
    // Evict stale entries to bound memory growth.
    for (const [k, t] of this.lastDenialReplyAt) {
      if (now - t > DENIAL_MAP_TTL_MS) this.lastDenialReplyAt.delete(k);
    }
    const last = this.lastDenialReplyAt.get(userId);
    if (last !== undefined && now - last < DENIAL_REPLY_INTERVAL_MS) return false;
    this.lastDenialReplyAt.set(userId, now);
    return true;
  }

  private setupHandlers(): void {
    // Auth middleware
    this.bot.use(async (ctx, next) => {
      const update = ctx.update as Update;
      this.updateSeq += 1;
      const summary = summarizeTelegramUpdate(update);
      log.verbose('[Telegram UPDATE]', ...formatLogFields({ seq: this.updateSeq, ...summary }));
      if (log.shouldLog('debug')) {
        log.debug('[Telegram UPDATE RAW]', `seq=${this.updateSeq}`, `payload=${JSON.stringify(update)}`);
      }
      await next();
    });

    this.bot.use(async (ctx, next) => {
      const verdict = this.isAllowed(ctx.from?.id, ctx.from?.is_bot);
      if (!verdict.allowed) {
        log.warn(
          '[Telegram] Denied update',
          ...formatLogFields({
            reason: verdict.reason,
            userId: ctx.from?.id,
            chatId: ctx.chat?.id,
            chatType: ctx.chat?.type,
            isBot: ctx.from?.is_bot,
          }),
        );
        if (
          verdict.reason !== 'bot-account' &&
          ctx.chat?.type === 'private' &&
          ctx.from?.id !== undefined &&
          this.shouldSendDenialReply(String(ctx.from.id))
        ) {
          // Fire-and-forget with random jitter to defeat timing oracles. Do NOT await — the
          // attacker must not be able to learn anything from response timing of the inbound update.
          const [jMin, jMax] = this.denialReplyJitterMs;
          const delay = jMax > jMin ? jMin + Math.floor(Math.random() * (jMax - jMin)) : jMin;
          if (delay <= 0) {
            await ctx.reply('⛔ Not authorized.', { parse_mode: undefined }).catch(() => {});
          } else {
            setTimeout(() => {
              ctx.reply('⛔ Not authorized.', { parse_mode: undefined }).catch(() => {});
            }, delay).unref?.();
          }
        }
        return;
      }
      await next();
    });

    // Text messages — fire-and-forget to enable parallel thread processing
    this.bot.on('message:text', (ctx) => {
      const threadId = ctx.message.message_thread_id;
      if (threadId) {
        const topicKey = ctx.chat.id + ':' + threadId;
        const topicCreated = ctx.message.reply_to_message?.forum_topic_created;
        if (topicCreated?.name && !this.topicNames.has(topicKey)) {
          this.topicNames.set(topicKey, topicCreated.name);
        }
      }

      log.info(
        '[Telegram RX]',
        `chat=${ctx.chatId}`,
        `msg=${ctx.message.message_id}`,
        `thread=${threadId ?? '-'}`,
        `replyTo=${ctx.message.reply_to_message?.message_id ?? '-'}`,
        `text=${JSON.stringify(summarizeTextForLog(ctx.message.text))}`,
      );

      // Do NOT await — let handlePrompt run in background so other updates process immediately
      void this.onMessage?.(
        this.senderEnvelope(ctx) + ctx.message.text,
        String(ctx.chatId),
        ctx.message.message_id,
        ctx.message.reply_to_message?.text,
        ctx.message.reply_to_message?.message_id,
        threadId,
      );
    });

    // Photos, documents, voice, audio
    this.bot.on(['message:photo', 'message:document', 'message:voice', 'message:audio'], async (ctx) => {
      const msg = ctx.message;
      const fileId =
        msg.voice?.file_id ?? msg.audio?.file_id ?? msg.document?.file_id ?? msg.photo?.[msg.photo.length - 1]?.file_id;
      const fileName = msg.document?.file_name ?? msg.audio?.file_name ?? (msg.voice ? 'voice.oga' : 'photo.jpg');
      const caption = msg.caption ?? '';
      log.info(
        '[Telegram RX FILE]',
        `chat=${ctx.chatId}`,
        `msg=${msg.message_id}`,
        `thread=${msg.message_thread_id ?? '-'}`,
        `file=${JSON.stringify(fileName)}`,
        `caption=${JSON.stringify(summarizeTextForLog(caption))}`,
      );
      if (fileId) {
        this.onFile?.(fileId, fileName, caption, String(ctx.chatId), msg.message_id, msg.message_thread_id, this.senderIdOf(ctx));
      }
    });

    // Stickers → forward emoji/description as text
    this.bot.on('message:sticker', async (ctx) => {
      const sticker = ctx.message.sticker;
      const emoji = sticker.emoji ?? '';
      const desc = emoji ? `[Sticker: ${emoji}]` : '[Sticker]';
      const threadId = ctx.message.message_thread_id;
      log.info(
        '[Telegram RX STICKER]',
        `chat=${ctx.chatId}`,
        `msg=${ctx.message.message_id}`,
        `thread=${threadId ?? '-'}`,
        `emoji=${JSON.stringify(emoji || '<none>')}`,
      );
      this.onMessage?.(this.senderEnvelope(ctx) + desc, String(ctx.chatId), ctx.message.message_id, undefined, undefined, threadId);
    });

    // Video and video notes → download and forward as file
    this.bot.on(['message:video', 'message:video_note'], async (ctx) => {
      const msg = ctx.message;
      const video = msg.video ?? msg.video_note;
      if (!video) return;
      const fileId = video.file_id;
      const fileName = (msg.video as { file_name?: string })?.file_name ?? 'video.mp4';
      const caption = (msg as { caption?: string }).caption ?? '';
      log.info(
        '[Telegram RX VIDEO]',
        `chat=${ctx.chatId}`,
        `msg=${msg.message_id}`,
        `thread=${msg.message_thread_id ?? '-'}`,
        `file=${JSON.stringify(fileName)}`,
        `caption=${JSON.stringify(summarizeTextForLog(caption))}`,
      );
      this.onFile?.(fileId, fileName, caption, String(ctx.chatId), msg.message_id, msg.message_thread_id, this.senderIdOf(ctx));
    });

    // Location → forward as text
    this.bot.on('message:location', async (ctx) => {
      const loc = ctx.message.location;
      const text = `User shared location: ${loc.latitude}, ${loc.longitude}`;
      const threadId = ctx.message.message_thread_id;
      log.info(
        '[Telegram RX LOCATION]',
        `chat=${ctx.chatId}`,
        `msg=${ctx.message.message_id}`,
        `thread=${threadId ?? '-'}`,
        `lat=${loc.latitude}`,
        `lon=${loc.longitude}`,
      );
      this.onMessage?.(this.senderEnvelope(ctx) + text, String(ctx.chatId), ctx.message.message_id, undefined, undefined, threadId);
    });

    // Callback queries
    this.bot.on('callback_query:data', async (ctx) => {
      const chatId = String(ctx.chatId ?? '');
      const msg = ctx.msg;
      const msgId = msg?.message_id ?? 0;
      // msg.date > 0 means it's a full Message (not InaccessibleMessage), which has message_thread_id
      const grammyThreadId =
        msg && msg.date > 0 ? (msg as unknown as { message_thread_id?: number }).message_thread_id : undefined;
      const mapThreadId = this.msgThreadMap.get(msgId);
      const threadId = grammyThreadId ?? mapThreadId;
      log.info(
        `Callback: chat=${chatId} threadId=${threadId} (grammy=${grammyThreadId} map=${mapThreadId}) msgId=${msgId} data=${ctx.callbackQuery.data}`,
      );
      if (!chatId) {
        await ctx.answerCallbackQuery();
        return;
      }

      try {
        await this.onCallback?.(ctx.callbackQuery.id, ctx.callbackQuery.data, chatId, msg?.message_id ?? 0, threadId);
      } catch {
        /* ignore handler errors */
      }
      // Ack immediately after handler completes. If the handler already acked, Telegram
      // silently ignores the duplicate. Only late acks (>30s) cause "query is too old" errors,
      // so we keep this as a safety net for handlers that don't ack themselves.
      await ctx.answerCallbackQuery().catch(() => {});
    });

    // Reactions
    this.bot.on('message_reaction', async (ctx) => {
      const r = ctx.messageReaction;
      const chatId = String(ctx.chatId ?? '');
      const threadId = (r as unknown as Record<string, unknown>)?.message_thread_id as number | undefined;
      // Reactions don't go through the auth middleware in all cases; gate explicitly via isAllowed().
      // IMPORTANT: do NOT fall back to actor_chat.id — that's a *chat* id (anonymous group admins,
      // channels reacting as themselves), and treating it as a user id would break the allowlist
      // contract. If from.id is missing, refuse.
      const fromId = ctx.from?.id;
      const verdict = this.isAllowed(fromId, ctx.from?.is_bot);
      if (!verdict.allowed) {
        log.debug(
          '[Telegram] Denied reaction',
          ...formatLogFields({ reason: verdict.reason, userId: fromId, chatId: ctx.chatId, isBot: ctx.from?.is_bot }),
        );
        return;
      }
      if (!chatId) return;
      const emojis = (r.new_reaction ?? []).filter((e) => e.type === 'emoji').map((e) => e.emoji);
      for (const emoji of emojis) this.onReaction?.(emoji, chatId, r.message_id, threadId);
    });
  }

  async start(): Promise<void> {
    // Register bot command menu. Wrapped because grammY's auto-retry plugin
    // retries setMyCommands indefinitely on network errors, which can wedge
    // startup forever during a Telegram flake (observed in production).
    await withStartupTimeout(
      this.bot.api.setMyCommands([
        { command: 'ask', description: 'Quick side question (no history)' },
        { command: 'new', description: 'Start fresh session' },
        { command: 'attach', description: 'Attach a known Copilot session' },
        { command: 'config', description: 'Settings & preferences' },
        { command: 'status', description: 'Session info & quota' },
        { command: 'sessionid', description: 'Show a copy-friendly session id' },
        { command: 'sessions', description: 'List & resume sessions' },
        { command: 'agent', description: 'Switch agent' },
        { command: 'prompt', description: 'Run a prompt file' },
        { command: 'search', description: 'Search session history' },
        { command: 'tools', description: 'Manage tools' },
        { command: 'usage', description: 'Usage & token stats' },
        { command: 'research', description: 'Deep research a topic' },
        { command: 'cd', description: 'Change working directory' },
        { command: 'abort', description: 'Stop current turn, keep session' },
        { command: 'compact', description: 'Compress context window' },
        { command: 'plan', description: 'View/manage plan' },
        { command: 'diff', description: 'Review uncommitted changes' },
        { command: 'review', description: 'Code review recent changes' },
        { command: 'files', description: 'List workspace files' },
        { command: 'skills', description: 'List available skills' },
        { command: 'mcp', description: 'MCP server status' },
        { command: 'mcpreload', description: 'Reconnect all MCP servers if tools stop working' },
      ]),
      10_000,
      'setMyCommands',
    );

    if (this.allowedUsers.size > 0) {
      log.info('[Telegram] Starting polling — authorized users: ' + [...this.allowedUsers].join(', '));
    } else {
      log.warn(
        '[Telegram] ⚠️  allowedUsers is empty — bot will refuse ALL messages. ' +
          'Set "allowedUsers" in ~/.copilot-remote/config.json or COPILOT_REMOTE_ALLOWED_USERS env var.',
      );
    }

    await this.checkInlineMode();

    // Drop any stale getUpdates connections from previous instances.
    // Wrapped same as setMyCommands above — startup must not block forever.
    await withStartupTimeout(
      this.bot.api.deleteWebhook({ drop_pending_updates: false }),
      10_000,
      'deleteWebhook',
    );

    // Retry loop: grammY treats 409 (stale getUpdates from previous instance) as unrecoverable.
    // On tsx watch restarts or daemon respawns, the old long-poll may still be in-flight for up to 30s.
    const MAX_RETRIES = 6;
    const RETRY_DELAY = 5_000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      this.runner = run(this.bot, {
        runner: {
          fetch: {
            allowed_updates: ['message', 'callback_query', 'message_reaction'],
          },
        },
      });
      log.info('[Telegram] Polling runner launched');

      // Set profile photo if configured
      const photoPath = this.config.profilePhoto;
      if (photoPath) this.setMyProfilePhoto(photoPath).catch(() => {});

      try {
        await this.runner.task();
        return; // Clean exit
      } catch (err) {
        const is409 = err instanceof GrammyError && err.error_code === 409;
        if (!is409 || attempt >= MAX_RETRIES) throw err;
        log.warn(
          `[Telegram] Got 409 conflict (attempt ${attempt}/${MAX_RETRIES}), retrying in ${RETRY_DELAY / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAY));
      }
    }
  }

  stop(): void {
    if (this.runner?.isRunning()) {
      this.runner.stop();
    }
  }

  // ── Messaging (HTML with plain text fallback) ──

  async sendMessage(chatId: string, text: string, opts?: MessageOptions): Promise<number | null> {
    log.info(
      '[Telegram TX]',
      `chat=${chatId}`,
      `thread=${opts?.threadId ?? '-'}`,
      `replyTo=${opts?.replyTo ?? '-'}`,
      `text=${JSON.stringify(summarizeTextForLog(text))}`,
    );
    // Split at the markdown IR level to avoid breaking mid-HTML tag.
    // Ported from OpenClaw's renderTelegramChunksWithinHtmlLimit (MIT).
    const chunks = markdownToTelegramChunks(text, MAX_MESSAGE_LENGTH);
    let lastMsgId: number | null = null;
    const extra: Record<string, unknown> = {};
    if (opts?.replyTo) extra.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
    if (opts?.disableLinkPreview) extra.link_preview_options = { is_disabled: true };
    if (opts?.threadId) extra.message_thread_id = opts.threadId;
    if (opts?.disableNotification) extra.disable_notification = true;

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    const rawApi = this.raw;
    const callApi = async (params: Record<string, unknown>, signal?: AbortSignal) => {
      return rawApi['sendMessage'](params as Parameters<typeof rawApi['sendMessage']>[0], signal);
    };

    for (const chunk of chunks) {
      try {
        const params = { chat_id: chatId, ...extra, text: chunk.html, parse_mode: 'HTML' as const };
        // Pass signal through so grammY actually honours the abort when withAbortTimeout fires.
        // (Previously `() => callApi(params)` discarded the signal, so the awaited call
        // could hang forever even with timeoutMs set.)
        const res = await withAbortTimeout((signal) => callApi(params, signal), timeoutMs);
        lastMsgId = (res as { message_id?: number })?.message_id ?? null;
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          log.warn('[Telegram API TIMEOUT]', `method=sendMessage`, `chat=${chatId}`, `timeout=${timeoutMs}ms`);
          return null;
        }
        log.debug('[Telegram] sendMessage HTML failed:', (e as Error)?.message ?? e);
        // Fallback: send as plain text if HTML rendering failed. Skip on AbortError
        // to avoid doubling the timeout window AND avoid duplicating a message whose
        // ACK was lost in flight (Telegram may still have processed the original send).
        try {
          const params = { chat_id: chatId, ...extra, text: chunk.text, parse_mode: undefined };
          const res = await withAbortTimeout((signal) => callApi(params, signal), timeoutMs);
          lastMsgId = (res as { message_id?: number })?.message_id ?? null;
        } catch (e2) {
          if ((e2 as Error)?.name === 'AbortError') {
            log.warn('[Telegram API TIMEOUT]', `method=sendMessage(plain)`, `chat=${chatId}`, `timeout=${timeoutMs}ms`);
            return null;
          }
          log.debug('[Telegram] sendMessage plain text also failed:', (e2 as Error)?.message ?? e2);
        }
      }
    }
    log.info('[Telegram TX DONE]', `chat=${chatId}`, `msg=${lastMsgId ?? '-'}`);
    if (lastMsgId && opts?.threadId) this.msgThreadMap.set(lastMsgId, opts.threadId);
    return lastMsgId;
  }

  async editMessage(chatId: string, msgId: number, text: string): Promise<void> {
    log.info(
      '[Telegram TX EDIT]',
      `chat=${chatId}`,
      `msg=${msgId}`,
      `text=${JSON.stringify(summarizeTextForLog(text))}`,
    );
    // Render to HTML first, then check length. If too long, truncate at IR level.
    const chunks = markdownToTelegramChunks(text, MAX_MESSAGE_LENGTH);
    const chunk = chunks[0]; // edit can only update one message — use first chunk
    if (!chunk) return;
    const editApi = (params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> =>
      this.raw['editMessageText'](params as Parameters<typeof this.raw['editMessageText']>[0], signal) as Promise<unknown>;
    try {
      await withAbortTimeout(
        (signal) =>
          editApi({ chat_id: chatId, message_id: msgId, text: chunk.html, parse_mode: 'HTML' }, signal),
        DEFAULT_API_TIMEOUT_MS,
      );
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        log.warn(
          '[Telegram API TIMEOUT]',
          `method=editMessage`,
          `chat=${chatId}`,
          `msg=${msgId}`,
          `timeout=${DEFAULT_API_TIMEOUT_MS}ms`,
        );
        return;
      }
      // HTML render failed — try plain text. Skip on AbortError to avoid
      // doubling the timeout window. `parse_mode: undefined` is explicit so
      // grammY's defaultParseMode transformer doesn't re-add HTML.
      try {
        await withAbortTimeout(
          (signal) =>
            editApi({ chat_id: chatId, message_id: msgId, text: chunk.text, parse_mode: undefined }, signal),
          DEFAULT_API_TIMEOUT_MS,
        );
      } catch (e2) {
        if ((e2 as Error)?.name === 'AbortError') {
          log.warn(
            '[Telegram API TIMEOUT]',
            `method=editMessage(plain)`,
            `chat=${chatId}`,
            `msg=${msgId}`,
            `timeout=${DEFAULT_API_TIMEOUT_MS}ms`,
          );
          return;
        }
        log.debug('[Telegram] editMessage failed:', (e2 as Error)?.message ?? e2);
      }
    }
  }

  /** Lightweight edit for streaming — sends plain text, skips markdown→HTML pipeline. */
  async editMessageRaw(chatId: string, msgId: number, text: string, timeoutMs?: number): Promise<void> {
    const cut = text.slice(0, MAX_MESSAGE_LENGTH - 4);
    // Never end on a lone high surrogate: slice() cuts UTF-16 code units, so a
    // boundary inside an emoji leaves half a character and Telegram rejects the
    // whole edit with "strings must be encoded in UTF-8".
    const safe = /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
    const truncated = text.length > MAX_MESSAGE_LENGTH ? safe + ' ...' : text;
    log.info(
      '[Telegram TX EDIT RAW]',
      `chat=${chatId}`,
      `msg=${msgId}`,
      `text=${JSON.stringify(summarizeTextForLog(truncated))}`,
    );
    const effectiveTimeout = timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    try {
      const params = { chat_id: chatId, message_id: msgId, text: truncated, parse_mode: undefined as undefined };
      await withAbortTimeout(
        (signal) => this.raw['editMessageText'](params as Parameters<typeof this.raw['editMessageText']>[0], signal) as Promise<unknown>,
        effectiveTimeout,
      );
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        log.warn(
          '[Telegram API TIMEOUT]',
          `method=editMessageRaw`,
          `chat=${chatId}`,
          `msg=${msgId}`,
          `timeout=${effectiveTimeout}ms`,
        );
        return;
      }
      log.debug('[Telegram] editMessageRaw failed:', (e as Error)?.message ?? e);
    }
  }

  async sendButtons(chatId: string, text: string, buttons: Button[][], threadId?: number): Promise<number | null> {
    const markup = {
      inline_keyboard: this.toInlineKeyboard(buttons),
    };
    const res = await this.sendText(
      'sendMessage',
      { chat_id: chatId, reply_markup: markup, ...(threadId ? { message_thread_id: threadId } : {}) },
      text,
    );
    const msgId = res?.message_id ?? null;
    if (msgId && threadId) this.msgThreadMap.set(msgId, threadId);
    return msgId;
  }

  async editButtons(chatId: string, msgId: number, text: string, buttons: Button[][]): Promise<void> {
    const markup = buttons.length
      ? {
          inline_keyboard: this.toInlineKeyboard(buttons),
        }
      : { inline_keyboard: [] };
    await this.sendText('editMessageText', { chat_id: chatId, message_id: msgId, reply_markup: markup }, text);
  }

  // ── Draft streaming ──

  private draftDisabledChats = new Set<string>();

  async sendDraft(chatId: string, draftId: number, text: string, opts?: MessageOptions): Promise<'ok' | 'transient' | 'permanent'> {
    if (this.draftDisabledChats.has(chatId)) return 'permanent';
    try {
      const params: Record<string, unknown> = {
        chat_id: chatId,
        draft_id: draftId,
        text: markdownToHtml(text),
        parse_mode: 'HTML',
      };
      if (opts?.threadId) params.message_thread_id = opts.threadId;
      if (opts?.replyTo) params.reply_parameters = { message_id: opts.replyTo, allow_sending_without_reply: true };
      log.verbose(
        '[Telegram API TX]',
        ...formatLogFields({ ...summarizeTelegramApiCall('sendMessageDraft', params), transport: 'fetch' }),
      );
      if (log.shouldLog('debug')) {
        log.debug('[Telegram API TX RAW]', 'method=sendMessageDraft', `payload=${JSON.stringify(params)}`);
      }
      const startedAt = Date.now();
      const resp = await fetch(`https://api.telegram.org/bot${this.config.botToken}/sendMessageDraft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: globalThis.AbortSignal.timeout(DRAFT_REQUEST_TIMEOUT_MS), // fail fast to keep streaming responsive
      });
      const json = (await resp.json()) as { ok?: boolean; description?: string };
      if (!json.ok) throw new Error(json.description ?? 'sendMessageDraft failed');
      log.verbose(
        '[Telegram API RX]',
        ...formatLogFields({ method: 'sendMessageDraft', ok: true, ms: Date.now() - startedAt }),
      );
      if (log.shouldLog('debug')) {
        log.debug('[Telegram API RX RAW]', 'method=sendMessageDraft', `result=${JSON.stringify(json)}`);
      }
      return 'ok';
    } catch (e) {
      const msg = String(e);
      log.warn(
        '[Telegram API ERR]',
        ...formatLogFields({ method: 'sendMessageDraft', chat: chatId, draftId, error: msg }),
      );
      log.debug('sendMessageDraft failed:', msg);
      if (/unknown method|not (found|available|supported)|can't be used|can be used only|PEER_INVALID/i.test(msg)) {
        this.draftDisabledChats.add(chatId); // disable for THIS chat only
        return 'permanent';
      }
      // Network/timeout/5xx: request may have actually reached Telegram (response lost).
      // Falling back to sendMessage would create a duplicate. Skip this chunk; next
      // stream chunk will retry the draft naturally.
      return 'transient';
    }
  }

  allocateDraftId(): number {
    nextDraftId = nextDraftId >= DRAFT_ID_MAX ? 1 : nextDraftId + 1;
    return nextDraftId;
  }

  // ── Presence ──

  async sendTyping(chatId: string, threadId?: number): Promise<void> {
    await withAbortTimeout(
      (signal) =>
        this.raw['sendChatAction'](
          { chat_id: chatId, action: 'typing', message_thread_id: threadId } as Parameters<typeof this.raw['sendChatAction']>[0],
          signal,
        ) as Promise<unknown>,
      UX_CALL_TIMEOUT_MS,
    );
  }

  async setReaction(chatId: string, messageId: number, emoji: string): Promise<void> {
    const safe = toTelegramReaction(emoji);
    await withAbortTimeout(
      (signal) =>
        this.raw['setMessageReaction'](
          { chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji: safe as never }] } as Parameters<
            typeof this.raw['setMessageReaction']
          >[0],
          signal,
        ) as Promise<unknown>,
      UX_CALL_TIMEOUT_MS,
    );
  }

  async removeReaction(chatId: string, messageId: number): Promise<void> {
    await withAbortTimeout(
      (signal) =>
        this.raw['setMessageReaction'](
          { chat_id: chatId, message_id: messageId, reaction: [] } as Parameters<typeof this.raw['setMessageReaction']>[0],
          signal,
        ) as Promise<unknown>,
      UX_CALL_TIMEOUT_MS,
    );
  }

  // ── File operations ──

  async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      const url =
        // grammY hydrate plugin adds getUrl() at runtime
        (file as unknown as { getUrl?: () => string }).getUrl?.() ??
        (file.file_path ? 'https://api.telegram.org/file/bot' + this.config.botToken + '/' + file.file_path : null);
      return url ?? null;
    } catch {
      return null;
    }
  }

  async sendDocument(chatId: string, url: string, filename: string, caption?: string): Promise<number | null> {
    try {
      const res = await this.bot.api.sendDocument(chatId, url, { caption: caption ?? filename });
      return res.message_id;
    } catch {
      return null;
    }
  }

  async sendPhoto(
    chatId: string,
    fileOrUrl: string | Buffer,
    caption?: string,
    threadId?: number,
  ): Promise<number | null> {
    try {
      const source = Buffer.isBuffer(fileOrUrl)
        ? new InputFile(fileOrUrl, 'image.png')
        : fileOrUrl.startsWith('/')
          ? new InputFile(fileOrUrl)
          : fileOrUrl;
      const res = await this.bot.api.sendPhoto(chatId, source, {
        ...(caption ? { caption } : {}),
        ...(threadId ? { message_thread_id: threadId } : {}),
      });
      return res.message_id;
    } catch {
      return null;
    }
  }

  // ── Message actions ──

  async pinMessage(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.pinChatMessage(chatId, messageId, { disable_notification: true }).catch(() => {});
  }

  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(chatId, messageId).catch(() => {});
  }

  // ── Bot profile ──

  private profilePhotoSet = false;

  async setMyProfilePhoto(pathOrUrl: string): Promise<void> {
    if (this.profilePhotoSet) return;
    try {
      // Check if photo is already set
      const me = await this.bot.api.raw.getUserProfilePhotos({ user_id: this.bot.botInfo.id, limit: 1 });
      if (me.total_count > 0) {
        this.profilePhotoSet = true;
        return;
      }
      let buffer: Buffer;
      if (pathOrUrl.startsWith('http')) {
        const res = await fetch(pathOrUrl);
        buffer = Buffer.from(await res.arrayBuffer());
      } else {
        const fs = await import('fs');
        buffer = fs.readFileSync(pathOrUrl);
      }
      await this.bot.api.raw.setMyProfilePhoto({
        photo: { type: 'static', photo: new InputFile(buffer, 'avatar.jpg') },
      });
      this.profilePhotoSet = true;
    } catch (e) {
      log.debug('setMyProfilePhoto failed:', e);
    }
  }

  async answerCallback(callbackId: string, text?: string, showAlert = false): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackId, { text, show_alert: showAlert }).catch(() => {});
  }

  async editReplyMarkup(chatId: string, messageId: number, buttons: Button[][]): Promise<void> {
    await this.bot.api
      .editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: buttons as never } })
      .catch(() => {});
  }

  getTopicName(sessionKey: string): string | undefined {
    return this.topicNames.get(sessionKey);
  }

  /**
   * Inline-mode hygiene check. If the operator left "Inline Mode" enabled at @BotFather,
   * Telegram will deliver `inline_query` updates to this bot. We don't service those updates
   * (the inline handler was removed for security & perf reasons — answering them would spin up
   * a one-shot Session per query, with no auth context). Warn loudly so the operator can turn
   * inline off via @BotFather → /setinline → Turn off.
   */
  async checkInlineMode(): Promise<void> {
    try {
      // Wrap getMe — auto-retry would otherwise wedge startup on Telegram flakes.
      const me = await withStartupTimeout(this.bot.api.getMe(), 10_000, 'getMe(inline-check)');
      if (!me || !me.supports_inline_queries) return;
      log.warn(
        '[Telegram] ⚠️  Inline mode is ENABLED at @BotFather but this bot does NOT service inline queries. ' +
          'Disable it via @BotFather → /setinline → Turn off.',
      );
      const text =
        '⚠️ Inline mode is ENABLED at @BotFather but this bot does not service inline queries. ' +
        'Disable it via @BotFather → /setinline → Turn off.';
      for (const userId of this.allowedUsers) {
        await withStartupTimeout(
          this.bot.api.sendMessage(userId, text),
          10_000,
          `sendMessage(inline-warn:${userId})`,
        );
      }
    } catch (err) {
      log.debug('[Telegram] inline-mode check failed', err);
    }
  }

  // ── Internal ──

  private async sendText(
    method: string,
    params: Record<string, unknown>,
    text: string,
  ): Promise<{ message_id?: number } | null> {
    // NOTE: pass `parse_mode: undefined` explicitly. The grammY transformer
    // installed at construction time adds `parse_mode: 'HTML'` when the key
    // is missing — so we MUST include it (set to undefined) to actually
    // request the plain-text fallback path.
    const call = (textBody: string, parseMode: 'HTML' | undefined, signal?: AbortSignal) =>
      this.raw[method](
        { ...params, text: textBody, parse_mode: parseMode },
        signal,
      ) as Promise<{ message_id?: number } | null>;
    try {
      return await withAbortTimeout(
        (signal) => call(markdownToHtml(text), 'HTML', signal),
        DEFAULT_API_TIMEOUT_MS,
      );
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        log.warn('[Telegram API TIMEOUT]', `method=${method}`, `timeout=${DEFAULT_API_TIMEOUT_MS}ms`);
        return null;
      }
      // HTML rendering failed — try plain text. Skip on AbortError (above) to
      // avoid doubling the timeout window and potential duplicate sends.
      try {
        return await withAbortTimeout(
          (signal) => call(markdownToText(text), undefined, signal),
          DEFAULT_API_TIMEOUT_MS,
        );
      } catch (e2) {
        if ((e2 as Error)?.name === 'AbortError') {
          log.warn('[Telegram API TIMEOUT]', `method=${method}(plain)`, `timeout=${DEFAULT_API_TIMEOUT_MS}ms`);
        }
        return null;
      }
    }
  }

  private toInlineKeyboard(buttons: Button[][]): Array<Array<{ text: string; callback_data: string }>> {
    return buttons.map((row) =>
      row.map((btn) => {
        const byteLen = Buffer.byteLength(btn.data, 'utf8');
        if (byteLen > TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
          // Skip the `@<chatId>|` routing prefix (when present) so the logged kind reflects
          // the action namespace (e.g. `input`, `session`, `prompt`), not the chat ID.
          const payload =
            btn.data.startsWith('@') && btn.data.includes('|')
              ? btn.data.slice(btn.data.indexOf('|') + 1)
              : btn.data;
          const kind = payload.split(':', 1)[0] || '<unknown>';
          log.warn(
            '[Telegram] callback_data exceeds 64-byte limit',
            `bytes=${byteLen}`,
            `kind=${JSON.stringify(kind)}`,
            `text=${JSON.stringify(btn.text.slice(0, 32))}`,
          );
        }
        return { text: btn.text, callback_data: btn.data };
      }),
    );
  }
}
