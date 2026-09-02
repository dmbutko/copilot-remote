// Copilot Remote — Session (SDK wrapper)
import {
  CopilotClient,
  CopilotSession as SDKSession,
  RuntimeConnection,
  approveAll,
  type SessionEvent,
  type ModelInfo,
  type ContextTier,
  type PermissionRequest,
  type PermissionRequestResult,
  type SessionConfig,
  type CopilotClientOptions,
  type MessageOptions,
} from '@github/copilot-sdk';

/** SDK-compatible file attachment */
export type FileAttachment = NonNullable<MessageOptions['attachments']>[number];
import { EventEmitter } from 'events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { log } from './log.js';
import type { RemoteProviderConfig } from './provider-config.js';
import type { MCPServerConfig } from './mcp-config.js';
import { createTelegramTools } from './tools.js';
import { formatLogFields, summarizeSdkEvent } from './transport-log.js';

/**
 * Thrown when the configured model cannot be applied to a resumed session.
 * Distinct from a resume-load failure so the registry does not treat a bad
 * model id as session corruption and archive a healthy conversation.
 */
export class ModelUnavailableError extends Error {
  constructor(
    readonly model: string,
    readonly cause: unknown,
  ) {
    super(
      `Configured model "${model}" could not be applied: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'ModelUnavailableError';
  }
}

/** Reasoning effort levels supported by the SDK */
type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** User input request from the agent (ask_user tool) */
interface UserInputRequest {
  question: string;
  choices?: string[];
}

export interface SessionOptions {
  cwd: string;
  sessionId?: string;
  binary?: string;
  cliUrl?: string;
  model?: string;
  autopilot?: boolean;
  agent?: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: ContextTier;
  topicContext?: string;
  githubToken?: string;
  infiniteSessions?: boolean;
  messageMode?: 'enqueue' | 'immediate';
  // Global config passthrough
  provider?: RemoteProviderConfig;
  mcpServers?: Record<string, MCPServerConfig>;
  customAgents?: unknown[];
  skillDirectories?: string[];
  disabledSkills?: string[];
  systemInstructions?: string;
  availableTools?: string[];
  excludedTools?: string[];
  /** External command run per prompt; its stdout is prepended to the prompt via modifiedPrompt. See GlobalConfig.promptContextProvider. */
  promptContextProvider?: { command: string; timeoutMs?: number; maxBytes?: number };
  /**
   * Passes through to `SessionConfig.enableConfigDiscovery`. When true, the CLI
   * auto-injects `github-mcp-server` (with bearer-token Authorization header
   * already populated), exposes the `web_search` tool, and discovers MCP servers,
   * plugins, and disabled-skills/MCP settings from the standard CLI config
   * locations (~/.copilot/mcp-config.json, .vscode/mcp.json, .mcp.json,
   * ~/.copilot/plugins/). When undefined or false, the CLI does none of that —
   * explicit `mcpServers` in this options bag still flow through.
   */
  enableConfigDiscovery?: boolean;
  /**
   * Per-turn timeout in ms passed as the second arg to SDK `sendAndWait`.
   * The SDK rejects the awaited promise if `session.idle` doesn't arrive in time
   * (the agent itself is NOT killed — see SDK doc on `sendAndWait`).
   * 0 / undefined => SDK default (60_000ms, too short for tool-heavy turns).
   * Recommended: 1_800_000 (30 min). Set higher for very long autopilot work.
   */
  turnTimeoutMs?: number;
}

export interface CopilotMessage {
  content: string;
  usage?: { inputTokens?: number; outputTokens?: number; model?: string };
}

export interface SessionTurnReservation {
  turnId: Promise<string>;
  currentTurnId: string | null;
  ownedTurnIds: Set<string>;
}

export interface SessionStreamEvent {
  turnId: string | null;
  text: string;
}

export interface AssistantPlanToolRequest {
  toolCallId?: string;
  name: string;
  arguments?: Record<string, unknown>;
  type?: string;
}

export interface AssistantPlanEvent {
  turnId: string | null;
  content?: string;
  reasoningText?: string;
  toolRequests: AssistantPlanToolRequest[];
}

export interface SubagentStartEvent {
  turnId: string | null;
  toolCallId?: string;
  agentName?: string;
  agentDisplayName?: string;
  agentDescription?: string;
}

interface PendingTurnReservation {
  reservation: SessionTurnReservation;
  resolve: (turnId: string) => void;
  reject: (error: Error) => void;
}

export class Session extends EventEmitter {
  // Shared CopilotClient — one CLI process for all sessions
  private static sharedClient: CopilotClient | null = null;
  private static sharedClientStarting: Promise<void> | null = null;
  private static sharedClientSignature: string | null = null;
  private static clientRefCount = 0;

  private static buildSharedClientOptions(opts?: {
    binary?: string;
    cliUrl?: string;
    githubToken?: string;
    provider?: RemoteProviderConfig;
  }): CopilotClientOptions {
    // forUri is mutually exclusive with gitHubToken/useLoggedInUser (external server
    // manages its own auth). Keep this branch first to avoid pairing them.
    if (opts?.cliUrl) {
      return { connection: RuntimeConnection.forUri(opts.cliUrl) };
    }

    const clientOpts: CopilotClientOptions = {
      connection: RuntimeConnection.forStdio(opts?.binary ? { path: opts.binary } : undefined),
      ...(opts?.provider ? { useLoggedInUser: false } : {}),
    };
    if (opts?.githubToken && !opts.provider) clientOpts.gitHubToken = opts.githubToken;
    return clientOpts;
  }

  private static getSharedClientSignature(opts?: {
    binary?: string;
    cliUrl?: string;
    githubToken?: string;
    provider?: RemoteProviderConfig;
  }): string {
    return JSON.stringify(Session.buildSharedClientOptions(opts));
  }

  private static async getSharedClient(
    opts?: { binary?: string; cliUrl?: string; githubToken?: string; provider?: RemoteProviderConfig },
    retain = true,
  ): Promise<CopilotClient> {
    const signature = Session.getSharedClientSignature(opts);

    if (Session.sharedClient) {
      if (Session.sharedClientSignature !== signature) {
        throw new Error(
          'Shared Copilot client already initialized with a different transport config. Restart copilot-remote to switch transports.',
        );
      }
      if (retain) Session.clientRefCount++;
      return Session.sharedClient;
    }
    if (Session.sharedClientStarting) {
      await Session.sharedClientStarting;
      if (Session.sharedClientSignature !== signature) {
        throw new Error(
          'Shared Copilot client already initialized with a different transport config. Restart copilot-remote to switch transports.',
        );
      }
      if (retain) Session.clientRefCount++;
      return Session.sharedClient!;
    }
    const clientOpts = Session.buildSharedClientOptions(opts);
    const client = new CopilotClient(clientOpts);
    Session.sharedClientSignature = signature;
    Session.sharedClientStarting = client
      .start()
      .then(() => {
        Session.sharedClient = client;
        Session.sharedClientStarting = null;
      })
      .catch((error) => {
        Session.sharedClientStarting = null;
        Session.sharedClientSignature = null;
        throw error;
      });
    await Session.sharedClientStarting;
    if (retain) Session.clientRefCount++;
    return client;
  }

  static async prewarmSharedClient(opts?: {
    binary?: string;
    cliUrl?: string;
    githubToken?: string;
    provider?: RemoteProviderConfig;
  }): Promise<void> {
    await Session.getSharedClient(opts, false);
  }

  /**
   * List available models via the shared client WITHOUT creating or resuming a
   * chat session. Models are account-level, so the picker must not depend on a
   * (possibly broken) per-chat session. Uses getSharedClient so it awaits an
   * in-flight prewarm and recreates after a reset.
   */
  static async listModelsShared(opts?: {
    binary?: string;
    cliUrl?: string;
    githubToken?: string;
    provider?: RemoteProviderConfig;
  }): Promise<ModelInfo[]> {
    const client = await Session.getSharedClient(opts, false);
    return client.listModels();
  }

  static async deletePersistedSession(
    sessionId: string,
    opts?: { binary?: string; cliUrl?: string; githubToken?: string; provider?: RemoteProviderConfig },
  ): Promise<void> {
    const client = await Session.getSharedClient(opts, false);
    await client.deleteSession(sessionId);
  }

  static async resetSharedClient(reason = 'unknown'): Promise<void> {
    const client = Session.sharedClient;
    const pending = Session.sharedClientStarting;

    Session.sharedClient = null;
    Session.sharedClientStarting = null;
    Session.sharedClientSignature = null;
    Session.clientRefCount = 0;

    if (client) {
      try {
        const stopPromise = client.stop();
        const stopTimedOut = await Promise.race([
          stopPromise.then(() => false),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5000)),
        ]);
        if (stopTimedOut) {
          log.warn('[shared-client] stop timed out, force stopping:', reason);
          await client.forceStop();
        }
      } catch (error) {
        log.warn('[shared-client] reset failed, force stopping:', reason, error);
        try {
          await client.forceStop();
        } catch {
          /* ignore */
        }
      }
      return;
    }

    if (pending) {
      try {
        await pending;
      } catch {
        /* ignore */
      }
    }
  }

  private static releaseClient() {
    Session.clientRefCount--;
    // Don't stop — keep the process alive for future sessions
  }

  private client: CopilotClient | null = null;
  private session: SDKSession | null = null;
  private _alive = false;
  private _turnActive = false;
  private _autopilot = false;
  private _messageMode: 'enqueue' | 'immediate' | undefined = undefined;
  private _turnTimeoutMs: number | undefined = undefined;
  private cwd = '';
  private activeTurnId: string | null = null;
  private activeSendReservation: SessionTurnReservation | null = null;
  private pendingTurnReservations: PendingTurnReservation[] = [];
  private sendChain: Promise<void> = Promise.resolve();
  private sdkEventSeq = 0;
  private lastSdkEventAt: number | null = null;
  private toolNameByCallId = new Map<string, string>();

  get alive() {
    return this._alive;
  }
  /** Whether a turn is currently in progress (driven by SDK turn_start/turn_end events) */
  get busy() {
    return this._turnActive;
  }
  get sessionId() {
    return this.session?.sessionId ?? null;
  }
  get autopilot() {
    return this._autopilot;
  }
  set autopilot(v: boolean) {
    this._autopilot = v;
  }
  get messageMode() {
    return this._messageMode;
  }
  set messageMode(v: 'enqueue' | 'immediate' | undefined) {
    this._messageMode = v;
  }

  reserveTurn(): SessionTurnReservation {
    let resolve!: (turnId: string) => void;
    let reject!: (error: Error) => void;
    const turnId = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void turnId.catch(() => undefined);
    const reservation: SessionTurnReservation = {
      currentTurnId: null,
      ownedTurnIds: new Set<string>(),
      turnId,
    };
    this.pendingTurnReservations.push({ reservation, resolve, reject });
    return reservation;
  }

  private cancelTurnReservation(reservation: SessionTurnReservation, reason: string): void {
    const index = this.pendingTurnReservations.findIndex((entry) => entry.reservation === reservation);
    if (index === -1) return;
    const [entry] = this.pendingTurnReservations.splice(index, 1);
    entry.reject(new Error(reason));
  }

  private clearPendingTurnReservations(reason: string): void {
    const error = new Error(reason);
    for (const entry of this.pendingTurnReservations.splice(0)) {
      entry.reject(error);
    }
  }

  private claimActiveReservationTurn(turnId: string): void {
    const reservation = this.activeSendReservation;
    if (!reservation) return;

    reservation.currentTurnId = turnId;
    reservation.ownedTurnIds.add(turnId);

    const pendingIndex = this.pendingTurnReservations.findIndex((entry) => entry.reservation === reservation);
    if (pendingIndex !== -1) {
      const [entry] = this.pendingTurnReservations.splice(pendingIndex, 1);
      entry.resolve(turnId);
    }
  }

  private runInSendQueue<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.sendChain.catch(() => {});
    let release!: () => void;
    this.sendChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prior.then(operation).finally(() => release());
  }

  private buildConfig(opts: SessionOptions): Partial<SessionConfig> {
    const systemLines = [
      'You are being accessed via a Telegram bot bridge called copilot-remote.',
      'The user is chatting with you from their phone. Keep responses concise but complete.',
      'You have full access to the filesystem, shell, and all tools. Use them proactively.',
      "When asked to do something, do it — don't just explain how.",
      'Show your work: mention files you read, commands you ran, changes you made.',
      'Format responses with markdown (bold, code blocks, lists) — it renders in Telegram.',
      'You are running via copilot-remote, a Telegram bridge for GitHub Copilot CLI.',
      'You have custom Telegram tools: send_notification, send_file, send_photo, send_location, send_voice, pin_message, create_topic, react, send_contact, create_poll.',
      'Use these tools when the user asks to send files, photos, locations, or when you want to push rich content back to the chat.',
      'Never claim you already delivered something the user says they did not receive. If a background agent result was delayed or dropped, say so plainly and deliver it now.',
      ...(opts.topicContext
        ? [`This conversation is in a Telegram forum topic: "${opts.topicContext}". Stay focused on this subject.`]
        : []),
    ];
    if (opts.systemInstructions) systemLines.push(opts.systemInstructions);
    // Inject runtime config context
    const configContext = [
      `Working directory: ${this.cwd}`,
      `Mode: ${opts.autopilot ? 'autopilot (auto-approve all actions)' : 'interactive (ask before acting)'}`,
      ...(opts.model ? [`Model: ${opts.model}`] : []),
      ...(opts.agent ? [`Agent: ${opts.agent}`] : []),
    ];
    systemLines.push('Current config: ' + configContext.join(', ') + '.');

    return {
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      clientName: 'vscode',
      streaming: true,
      workingDirectory: this.cwd,
      systemMessage: {
        mode: 'append',
        content: systemLines.join('\n'),
      },
      onPermissionRequest: this._autopilot ? approveAll : (req: PermissionRequest) => this.handlePermission(req),
      onUserInputRequest: (req: UserInputRequest) => this.handleUserInput(req),
      includeSubAgentStreamingEvents: false,
      infiniteSessions:
        opts.infiniteSessions === false
          ? { enabled: false }
          : { enabled: true, backgroundCompactionThreshold: 0.8, bufferExhaustionThreshold: 0.95 },
      tools: createTelegramTools({
        sendNotification: async (text) => {
          this.emit('notification', text);
        },
        sendFile: async (path, caption) => {
          this.emit('file', { path, caption });
        },
        sendPhoto: async (path, caption) => {
          this.emit('photo', { path, caption });
        },
        sendLocation: async (lat, lon, title) => {
          this.emit('location', { lat, lon, title });
        },
        sendVoice: async (path, caption) => {
          this.emit('voice', { path, caption });
        },
        pinMessage: async (messageId) => {
          this.emit('pin', { messageId });
        },
        createTopic: async (name, iconColor) => {
          return new Promise((resolve) => {
            this.emit('create_topic', { name, iconColor, resolve });
          });
        },
        react: async (messageId, emoji) => {
          this.emit('react_to', { messageId, emoji });
        },
        sendContact: async (phone, firstName, lastName) => {
          this.emit('contact', { phone, firstName, lastName });
        },
        sendPoll: async (question, options, isAnonymous, allowsMultiple) => {
          return new Promise((resolve) => {
            this.emit('poll', { question, options, isAnonymous, allowsMultiple, resolve });
          });
        },
      }),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      ...(opts.contextTier ? { contextTier: opts.contextTier } : {}),
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      ...(opts.customAgents ? { customAgents: opts.customAgents as SessionConfig['customAgents'] } : {}),
      ...(opts.skillDirectories ? { skillDirectories: opts.skillDirectories } : {}),
      ...(opts.disabledSkills ? { disabledSkills: opts.disabledSkills } : {}),
      ...(opts.availableTools ? { availableTools: opts.availableTools } : {}),
      ...(opts.excludedTools ? { excludedTools: opts.excludedTools } : {}),
      // enableConfigDiscovery activates the CLI's built-in github-mcp injection AND
      // discovery of MCP/plugin/disabled-* settings. NOTE: the CLI gate also requires
      // `!r.gitHubToken` (session-level) and `!r.provider`. copilot-remote passes the
      // GitHub token at CopilotClient level (not session level) — do NOT add
      // `gitHubToken: ...` to this returned config or built-in github-mcp will silently
      // stop loading. See plan.md for full context.
      ...(opts.enableConfigDiscovery ? { enableConfigDiscovery: true } : {}),
      hooks: {
        onSessionStart: async (_input: unknown, invocation: { sessionId: string }) => {
          this.emit('hook:session_start');
          // Inject runtime context as additional instructions
          const preamble = [
            'You are running via copilot-remote on Telegram.',
            'Use your custom Telegram tools (send_file, send_photo, send_location, send_voice, pin_message, create_topic, react, send_contact, create_poll) when appropriate.',
            `Session ID: ${invocation.sessionId}`,
          ].join(' ');
          // Scoped context provider (see GlobalConfig.promptContextProvider) —
          // runs ONCE per session start/resume, not per prompt.
          //
          // WHY HERE AND NOT onUserPromptSubmitted: context returned from *this*
          // hook is prepended by the CLI as a hidden request message that is NOT
          // persisted as a normal `user.message`, so it is rebuilt on each connect
          // and cannot pile up. The previous per-prompt path used modifiedPrompt,
          // which DOES land in `user.message` — permanent conversation history —
          // and appended a fresh full copy every time the provider's output
          // changed. One 3.5-month session accumulated 16 copies (~276KB / ~69k
          // tokens) of near-duplicate context, which measurably degrades recall of
          // the *current* version (arxiv 2603.12271, 2307.03172).
          //
          // NOTE the inverse asymmetry that forced the old design: the host CLI
          // silently DROPS additionalContext from onUserPromptSubmitted (verified
          // through CLI 1.0.64) but honours it here — canary-verified on 1.0.81.
          // Do not "simplify" this back to the prompt hook.
          //
          // Provider contract is versioned: argv is [sessionId, 'session-start-v1'].
          // The extra arg tells the provider we get exactly one shot per connection
          // so it must not self-suppress "unchanged" output. Older providers ignore
          // it, so bridge and provider can deploy in either order and roll back
          // safely.
          //
          // invocation.sessionId is the deterministic `telegram-<chatId>` id the
          // provider maps to an actor (see SessionStore.deterministicSessionId).
          // Fail-open: any error / timeout / non-zero exit / empty output ⇒ no
          // extra context. Never block session start.
          const provider = opts.promptContextProvider;
          if (provider?.command) {
            const startedAt = Date.now();
            try {
              const { stdout } = await execFileAsync(
                provider.command,
                [invocation.sessionId, 'session-start-v1'],
                {
                  timeout: provider.timeoutMs ?? 2000,
                  maxBuffer: provider.maxBytes ?? 65536,
                },
              );
              const ctx = stdout.trim();
              // Positive telemetry: an empty-but-successful run is the silent
              // failure mode (unmapped chat, self-suppressing provider), so log
              // the outcome either way. Never log the context itself.
              log.info(
                '[promptContextProvider]',
                `session=${invocation.sessionId}`,
                `result=${ctx ? 'loaded' : 'empty'}`,
                `bytes=${Buffer.byteLength(ctx)}`,
                `ms=${Date.now() - startedAt}`,
              );
              if (ctx) return { additionalContext: `${preamble}\n\n${ctx}` };
            } catch (e) {
              log.warn(
                '[promptContextProvider]',
                `session=${invocation.sessionId}`,
                'result=failed',
                `ms=${Date.now() - startedAt}`,
                (e as Error)?.message ?? e,
              );
            }
          }
          return { additionalContext: preamble };
        },
        onSessionEnd: async () => {
          this.emit('hook:session_end');
        },
        onPreToolUse: async (input: { toolName?: string; arguments?: unknown }) => {
          this.emit('hook:pre_tool', { toolName: input.toolName, arguments: input.arguments });
        },
        onPostToolUse: async (input: { toolName?: string; result?: unknown }) => {
          this.emit('hook:post_tool', { toolName: input.toolName, result: input.result });
        },
        onErrorOccurred: async (input: { errorContext?: string; recoverable?: boolean }) => {
          // Deliberately no user-facing notification — see AGENTS.md. CLI 1.0.80
          // discards this hook's return value (app.js:2416), so the retry below is
          // inert; the real retry is CLI-native.
          if (input.errorContext === 'model_call') {
            return { errorHandling: 'retry' as const, retryCount: 3 };
          }
          // Skip recoverable tool errors
          if (input.errorContext === 'tool_execution' && input.recoverable) {
            return { errorHandling: 'skip' as const };
          }
          return undefined;
        },
        onUserPromptSubmitted: async (input: { prompt?: string }) => {
          this.emit('hook:user_prompt', { prompt: input.prompt });
          // Context injection moved to onSessionStart (see comment there): doing it
          // per-prompt via modifiedPrompt wrote a fresh copy into `user.message`
          // history every time the provider output changed, accumulating 16 copies
          // in one long-lived session. Nothing to do here now.
          return undefined;
        },
      },
    };
  }

  async start(opts: SessionOptions): Promise<void> {
    this.cwd = opts.cwd;
    this._autopilot = opts.autopilot ?? false;
    this._messageMode = opts.messageMode;
    this._turnTimeoutMs = opts.turnTimeoutMs && opts.turnTimeoutMs > 0 ? opts.turnTimeoutMs : undefined;

    this.client = await Session.getSharedClient({
      binary: opts.binary,
      cliUrl: opts.cliUrl,
      githubToken: opts.githubToken,
      provider: opts.provider,
    });

    this.session = await this.client.createSession(this.buildConfig(opts) as SessionConfig);
    this._alive = true;
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  private handleEvent(e: SessionEvent): void {
    const now = Date.now();
    this.sdkEventSeq += 1;
    const sinceLastEventMs = this.lastSdkEventAt === null ? undefined : now - this.lastSdkEventAt;
    this.lastSdkEventAt = now;
    const eventData = (e.data as Record<string, unknown> | undefined) ?? {};
    log.verbose(
      '[SDK event]',
      ...formatLogFields({ seq: this.sdkEventSeq, sinceLastEventMs, ...summarizeSdkEvent(e.type, eventData) }),
    );
    switch (e.type) {
      case 'assistant.message_delta': {
        const text = e.data.deltaContent;
        this.emit('delta', text);
        this.emit('delta_event', { turnId: this.activeTurnId, text } satisfies SessionStreamEvent);
        break;
      }
      case 'assistant.reasoning_delta': {
        const text = e.data.deltaContent;
        this.emit('thinking', text);
        this.emit('thinking_event', { turnId: this.activeTurnId, text } satisfies SessionStreamEvent);
        break;
      }
      case 'assistant.reasoning': {
        const text = e.data.content;
        if (text) {
          this.emit('thinking_summary', { turnId: this.activeTurnId, text } satisfies SessionStreamEvent);
        }
        break;
      }
      case 'assistant.message': {
        const content = e.data.content;
        const reasoningText = e.data.reasoningText;
        const rawToolRequests = e.data.toolRequests ?? [];
        const toolRequests = rawToolRequests.flatMap<AssistantPlanToolRequest>((req) => {
          if (!req?.name) return [];
          return [
            {
              toolCallId: req.toolCallId,
              name: req.name,
              arguments: req.arguments,
              type: req.type,
            },
          ];
        });

        this.emit('message', content);
        if (reasoningText) {
          this.emit('thinking_summary', { turnId: this.activeTurnId, text: reasoningText } satisfies SessionStreamEvent);
        }
        if (content || reasoningText || toolRequests.length) {
          this.emit('assistant_plan', {
            turnId: this.activeTurnId,
            content: content || undefined,
            reasoningText,
            toolRequests,
          } satisfies AssistantPlanEvent);
        }
        break;
      }
      case 'assistant.usage':
        this.emit('usage', e.data);
        break;
      case 'assistant.turn_start':
        this._turnActive = true;
        this.activeTurnId = e.data.turnId;
        this.claimActiveReservationTurn(e.data.turnId);
        this.emit('turn_start', { turnId: e.data.turnId, interactionId: e.data.interactionId });
        break;
      case 'assistant.turn_end':
        this._turnActive = false;
        if (this.activeTurnId === e.data.turnId) this.activeTurnId = null;
        this.emit('turn_end', { turnId: e.data.turnId });
        break;
      case 'session.usage_info':
        this.emit('context_info', {
          tokenLimit: e.data.tokenLimit,
          currentTokens: e.data.currentTokens,
          messagesLength: e.data.messagesLength,
        });
        break;
      case 'tool.execution_start':
        this.toolNameByCallId.set(e.data.toolCallId, e.data.toolName);
        this.emit('tool_start', {
          turnId: this.activeTurnId,
          toolCallId: e.data.toolCallId,
          toolName: e.data.toolName,
          arguments: e.data.arguments as Record<string, string> | undefined,
        });
        break;
      case 'tool.execution_partial_result':
        this.emit('tool_output', {
          turnId: this.activeTurnId,
          toolCallId: e.data.toolCallId,
          toolName: this.toolNameByCallId.get(e.data.toolCallId) ?? 'unknown',
          content: e.data.partialOutput ?? '',
        });
        break;
      case 'tool.execution_complete': {
        const callId = e.data.toolCallId;
        const toolName =
          this.toolNameByCallId.get(callId) ?? e.data.toolDescription?.name ?? 'unknown';
        this.toolNameByCallId.delete(callId);
        this.emit('tool_complete', {
          turnId: this.activeTurnId,
          toolCallId: callId,
          toolName,
          success: e.data.success,
          detailedContent: e.data.result?.detailedContent ?? e.data.result?.content,
        });
        break;
      }
      case 'subagent.started':
        this.emit('subagent_start', {
          turnId: this.activeTurnId,
          toolCallId: e.data.toolCallId,
          agentName: e.data.agentName,
          agentDisplayName: e.data.agentDisplayName,
          agentDescription: e.data.agentDescription,
        } satisfies SubagentStartEvent);
        break;
      case 'permission.requested':
        // Don't emit here — handlePermission() already emits permission_request
        // and waits for the response. Emitting from both causes duplicate prompts.
        break;
      case 'session.idle':
        log.info('[SDK idle]', JSON.stringify(e.data));
        // Root idle is the ONE reliable terminal signal: no root turn is running, so
        // nothing is steerable. Reason-specific signals are path-dependent and cannot be
        // relied on — a 24-Aug timeout abort emitted `abort` + idle{aborted:true}, while a
        // 26-Aug manual /abort emitted no `abort` event and a bare idle `{}`. Gating on
        // those left `busy` stuck true and silently swallowed the next message as steering.
        if (!e.agentId) {
          this._turnActive = false;
          this.activeTurnId = null;
        }
        this.emit('idle');
        break;
      case 'session.title_changed':
        this.emit('title_changed', { title: e.data.title });
        break;
      case 'session.error':
        this.emit('error', e.data.message ?? 'Unknown error');
        break;
    }
  }

  private async handlePermission(req: PermissionRequest): Promise<PermissionRequestResult> {
    return new Promise<PermissionRequestResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const handler = (approved: boolean) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve({ kind: approved ? 'approve-once' : 'reject' } as unknown as PermissionRequestResult);
      };
      // Register listener BEFORE emitting permission_request so that synchronous
      // auto-approve (which calls session.approve() → emit('permission_response'))
      // can be caught. Previously the listener was registered after the emit,
      // causing auto-approved permissions to fire into the void and time out.
      this.once('permission_response', handler);
      this.emit('permission_request', { ...(req as unknown as Record<string, unknown>), turnId: this.activeTurnId });
      timer = setTimeout(() => {
        timer = null;
        this.off('permission_response', handler);
        this.emit('permission_timeout');
        resolve({ kind: 'user-not-available' } as unknown as PermissionRequestResult);
      }, 120_000);
    });
  }

  private async handleUserInput(req: UserInputRequest): Promise<{ answer: string; wasFreeform: boolean }> {
    this.emit('user_input_request', { ...req, turnId: this.activeTurnId });
    log.debug('User input request:', req.question);
    return new Promise<{ answer: string; wasFreeform: boolean }>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const handler = (answer: string) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        resolve({ answer, wasFreeform: !req.choices?.length });
      };
      this.once('user_input_response', handler);
      timer = setTimeout(() => {
        timer = null;
        this.off('user_input_response', handler);
        // Notify the bridge so it can sweep stale pendingInputs entries and
        // edit any "❓ Question" buttons to show "⏰ Timed out". Without this,
        // old buttons stay clickable and could answer a future ask_user prompt.
        this.emit('user_input_timeout', { turnId: this.activeTurnId });
        resolve({ answer: '', wasFreeform: true }); // Empty response on timeout
      }, 30_000); // 30s — short enough that an unanswered ask_user doesn't wedge the chat on mobile UX
    });
  }

  answerInput(answer: string) {
    this.emit('user_input_response', answer);
  }

  // ── Core ──

  async send(
    prompt: string,
    attachments?: FileAttachment[],
    reservation = this.reserveTurn(),
    opts?: { askMode?: boolean },
  ): Promise<CopilotMessage> {
    if (!this._alive) throw new Error('Session not started');

    return this.runInSendQueue(async () => {
      const turnStartedAtMs = Date.now();
      let onDelta: ((event: SessionStreamEvent) => void) | null = null;
      let errorHandler: ((msg: string) => void) | null = null;
      let rawUnsub: (() => void) | null = null;

      let askUserMsgId: string | null = null;
      const unsubscribeAskUserMsg = opts?.askMode
        ? this.session!.on('user.message', (ev) => {
            if (!askUserMsgId) askUserMsgId = ev.id;
          })
        : null;

      try {
        this.activeSendReservation = reservation;
        let text = '';
        onDelta = (event: SessionStreamEvent) => {
          if (!event.turnId || !reservation.ownedTurnIds.has(event.turnId)) return;
          text += event.text;
        };
        this.on('delta_event', onDelta);

        // Background-agent follow-up capture. Since CLI 1.0.60 the runtime returns
        // control at the first `session.idle` when a background agent is launched,
        // then fires a `system.notification` (agent_completed/idle) that triggers a
        // NEW interaction (read_agent + synthesis) AFTER `sendAndWait` has resolved.
        // That synthesis is the answer the user wants, but it lands too late for the
        // normal return path. We watch raw SDK events to detect the completion and
        // capture the follow-up interaction's final message. See captureBackgroundFollowups.
        const bg = {
          sawActivity: false,
          aborted: false,
          completions: 0,
          idles: 0,
          turnStarts: 0,
          capturing: false,
          followupId: null as string | null,
          followupContent: '',
          wake: null as (() => void) | null,
        };
        const wakeBg = () => {
          const w = bg.wake;
          bg.wake = null;
          w?.();
        };
        rawUnsub = this.session!.on((ev: SessionEvent) => {
          switch (ev.type) {
            case 'subagent.started':
            case 'session.background_tasks_changed':
              bg.sawActivity = true;
              break;
            case 'system.notification':
              if (!ev.agentId && (ev.data.kind.type === 'agent_completed' || ev.data.kind.type === 'agent_idle')) {
                bg.sawActivity = true;
                bg.completions += 1;
                wakeBg();
              }
              break;
            case 'assistant.turn_start':
              if (!ev.agentId) {
                bg.turnStarts += 1;
                // A newly started root turn is live again; don't let a previous turn's
                // abort suppress this one's synthesis.
                bg.aborted = false;
                if (bg.capturing && !bg.followupId) bg.followupId = ev.data.interactionId ?? null;
                wakeBg();
              }
              break;
            case 'abort':
              // Root abort ends this send's agentic work: no follow-up interaction will
              // ever start, so wake any in-flight wait instead of stalling the send queue.
              if (!ev.agentId) {
                bg.aborted = true;
                wakeBg();
              }
              break;
            case 'assistant.message':
              // While capturing a follow-up, keep the latest non-empty message from
              // that interaction (filtered by interactionId) as the synthesis to deliver.
              if (!ev.agentId && bg.capturing && ev.data.content && (!bg.followupId || ev.data.interactionId === bg.followupId)) {
                bg.followupContent = ev.data.content;
              }
              break;
            case 'session.idle':
              // Only the root agent's idle matters; sub-agent idles carry an agentId.
              if (!ev.agentId) {
                bg.idles += 1;
                if (ev.data?.aborted) bg.aborted = true;
                wakeBg();
              }
              break;
          }
        });

        // Reject if session emits an error (e.g. auth failure)
        const errorPromise = new Promise<never>((_, rej) => {
          errorHandler = (msg: string) => rej(new Error(msg));
          this.once('error', errorHandler);
        });

        const sendOpts: MessageOptions = { prompt };
        // Keep SDK queue mode for compatibility, but serialize locally so per-turn listeners stay isolated.
        if (this._messageMode) sendOpts.mode = this._messageMode;
        if (attachments?.length) sendOpts.attachments = attachments;

        log.verbose(
          '[SDK sendAndWait:start]',
          ...formatLogFields({
            sessionId: this.sessionId,
            mode: sendOpts.mode ?? 'default',
            attachments: attachments?.length ?? 0,
            promptChars: prompt.length,
            turnTimeoutMs: this._turnTimeoutMs ?? 'sdk-default',
            askMode: opts?.askMode ? true : undefined,
          }),
        );

        const result = await Promise.race([this.session!.sendAndWait(sendOpts, this._turnTimeoutMs), errorPromise]);
        const resultContent =
          (result as { data?: { content?: string }; content?: string } | undefined)?.data?.content ??
          (result as { content?: string } | undefined)?.content ??
          '';
        log.verbose(
          '[SDK sendAndWait:done]',
          ...formatLogFields({ sessionId: this.sessionId, resultChars: resultContent.length || undefined }),
        );
        log.debug('sendAndWait result:', JSON.stringify(result));

        const resultObj = result as unknown as Record<string, unknown>;
        const resultData = (resultObj?.data as Record<string, unknown>) ?? {};

        let content =
          text.trim() ||
          (typeof resultData?.content === 'string' ? resultData.content : '') ||
          (typeof resultObj?.content === 'string' ? resultObj.content : '') ||
          (typeof result === 'string' ? result : '') ||
          '_(no response)_';

        // If a background agent ran this turn, the real answer may be produced in a
        // post-idle follow-up interaction. Wait for and prefer that synthesis; if none
        // is captured, prefer the SDK's final result over a bare "hang tight" placeholder.
        // Skip when the turn was aborted: the follow-up interactions it waits for will
        // never start, so it would hold the send queue for up to turnTimeoutMs and delay
        // the user's next message.
        if (bg.sawActivity && !bg.aborted) {
          const followup = await this.captureBackgroundFollowups(bg, turnStartedAtMs);
          if (followup) {
            content = followup;
          } else {
            const sdkContent = typeof resultData?.content === 'string' ? resultData.content.trim() : '';
            if (sdkContent.length > content.trim().length) content = sdkContent;
          }
        }

        return { content };
      } catch (error) {
        if (!reservation.currentTurnId) {
          this.cancelTurnReservation(reservation, error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        if (this.activeSendReservation === reservation) {
          this.activeSendReservation = null;
        }
        if (onDelta) this.off('delta_event', onDelta);
        if (errorHandler) this.off('error', errorHandler);
        if (rawUnsub) rawUnsub();
        // /ask: drop the ask turn (user msg + assistant reply + tool events) from session history
        // so it doesn't pollute future context. Best-effort; truncate is @experimental in SDK.
        if (opts?.askMode && askUserMsgId) {
          try {
            const r = await this.session!.rpc.history.truncate({ eventId: askUserMsgId });
            log.info('[ask] truncated history', ...formatLogFields({ eventsRemoved: r.eventsRemoved }));
          } catch (e) {
            log.warn('[ask] history.truncate failed:', e);
          }
        }
        unsubscribeAskUserMsg?.();
      }
    });
  }

  /**
   * After `sendAndWait` resolves on the first `session.idle`, a background agent that
   * finished may have triggered (via a post-idle agent-completion `system.notification`)
   * a fresh CLI interaction that runs `read_agent` and synthesizes the real answer.
   * That interaction lands after `sendAndWait` returned, so its output is otherwise
   * dropped. This waits for those follow-up interaction(s) and returns the final
   * synthesis. Only invoked when a background agent was active this turn, so normal
   * turns pay zero latency. The `bg` state is mutated by the raw SDK listener in send().
   */
  private async captureBackgroundFollowups(
    bg: {
      aborted: boolean;
      completions: number;
      idles: number;
      turnStarts: number;
      capturing: boolean;
      followupId: string | null;
      followupContent: string;
      wake: (() => void) | null;
    },
    turnStartedAtMs: number,
  ): Promise<string | null> {
    const NOTIFICATION_GRACE_MS = 2_000; // wait this long after an idle for an agent-completion notification
    const FOLLOWUP_START_GRACE_MS = 8_000; // wait this long for the model to start the read_agent follow-up
    const SYNTHESIS_TIMEOUT_MS = 180_000; // max wait for one follow-up interaction to reach idle
    const OVERALL_CAP_MS = this._turnTimeoutMs ?? 30 * 60 * 1000;

    const waitUntil = (pred: () => boolean, timeoutMs: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        // Treat an abort as terminal: the awaited follow-up can never arrive, and holding
        // the wait would keep the send queue closed against the user's next message.
        const done = () => pred() || bg.aborted;
        if (done()) {
          resolve(pred());
          return;
        }
        let timer: ReturnType<typeof setTimeout> | null = null;
        const check = () => {
          if (done()) {
            if (timer) clearTimeout(timer);
            bg.wake = null;
            resolve(pred());
          } else {
            bg.wake = check; // re-arm for the next event
          }
        };
        bg.wake = check;
        timer = setTimeout(() => {
          bg.wake = null;
          resolve(false);
        }, timeoutMs);
      });

    const results: string[] = [];
    let completionsConsumed = 0;
    let idlesConsumed = bg.idles;
    let turnStartsConsumed = bg.turnStarts;

    // Loop while background agents keep completing; bounded by the notification grace
    // (gives up when no further completion arrives) and the overall turn cap.
    while (!bg.aborted && Date.now() - turnStartedAtMs < OVERALL_CAP_MS) {
      const gotCompletion = await waitUntil(() => bg.completions > completionsConsumed, NOTIFICATION_GRACE_MS);
      if (!gotCompletion) break;
      completionsConsumed += 1;

      bg.capturing = true;
      bg.followupId = null;
      bg.followupContent = '';
      // Only block on a synthesis if the model actually starts a follow-up interaction;
      // a completion with no follow-up turn must not stall the turn for the full timeout.
      const started = await waitUntil(() => bg.turnStarts > turnStartsConsumed, FOLLOWUP_START_GRACE_MS);
      if (started) {
        const synthesized = await waitUntil(() => bg.idles > idlesConsumed, SYNTHESIS_TIMEOUT_MS);
        idlesConsumed = bg.idles;
        if (!synthesized) {
          log.warn(
            '[followup] synthesis wait timed out',
            ...formatLogFields({ sessionId: this.sessionId, capMs: SYNTHESIS_TIMEOUT_MS }),
          );
        }
      }
      bg.capturing = false;
      turnStartsConsumed = bg.turnStarts;
      if (bg.followupContent.trim()) results.push(bg.followupContent.trim());
    }
    return results.length ? results.join('\n\n---\n\n') : null;
  }

  /** Send a side question whose user message and response are removed from session history. */
  async ask(
    prompt: string,
    attachments?: FileAttachment[],
    reservation = this.reserveTurn(),
  ): Promise<CopilotMessage> {
    return this.send(prompt, attachments, reservation, { askMode: true });
  }

  /** Send with mode: 'immediate' to steer the agent mid-turn (bypasses queue) */
  async sendImmediate(prompt: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this._alive) throw new Error('Session not started');
    const opts: MessageOptions = { prompt, mode: 'immediate' };
    if (attachments?.length) opts.attachments = attachments;
    // Fire-and-forget: immediate messages steer the current turn, no separate response
    await this.session!.send(opts);
  }

  approve() {
    this.emit('permission_response', true);
  }
  deny() {
    this.emit('permission_response', false);
  }
  /**
   * Cancels the running turn and its sub-agents; the session and history stay valid.
   * Returns false when the runtime declined the abort — the SDK's `session.abort()`
   * helper discards the RPC result, so a soft `{success:false}` would otherwise look
   * like success and leave the turn running (the 2026-08-21 wedge).
   */
  async abort(): Promise<boolean> {
    if (!this.session) throw new Error('Session not started');
    const result = await this.session.rpc.abort({ reason: 'user_initiated' });
    if (result.error) throw new Error(result.error);
    return result.success;
  }

  // ── SDK RPCs ──

  async setModel(model: string) {
    this.session?.setModel(model);
  }
  async listModels(): Promise<ModelInfo[]> {
    return this.client?.listModels() ?? [];
  }
  async setMode(mode: string) {
    await this.session!.rpc.mode.set({ mode: mode as 'interactive' | 'plan' | 'autopilot' });
  }
  async getMode(): Promise<ReturnType<SDKSession['rpc']['mode']['get']>> {
    return await this.session!.rpc.mode.get();
  }
  async compact(): ReturnType<SDKSession['rpc']['history']['compact']> {
    return this.session!.rpc.history.compact();
  }
  async startFleet(prompt?: string): ReturnType<SDKSession['rpc']['fleet']['start']> {
    return this.session!.rpc.fleet.start({ prompt });
  }
  async listAgents(): ReturnType<SDKSession['rpc']['agent']['list']> {
    return this.session!.rpc.agent.list();
  }
  async selectAgent(name: string): ReturnType<SDKSession['rpc']['agent']['select']> {
    return this.session!.rpc.agent.select({ name });
  }
  async deselectAgent(): ReturnType<SDKSession['rpc']['agent']['deselect']> {
    return this.session!.rpc.agent.deselect();
  }
  async getCurrentModel(): ReturnType<SDKSession['rpc']['model']['getCurrent']> {
    return this.session!.rpc.model.getCurrent();
  }
  async getCurrentAgent(): ReturnType<SDKSession['rpc']['agent']['getCurrent']> {
    return this.session!.rpc.agent.getCurrent();
  }
  async readPlan(): ReturnType<SDKSession['rpc']['plan']['read']> {
    return this.session!.rpc.plan.read();
  }
  async deletePlan(): ReturnType<SDKSession['rpc']['plan']['delete']> {
    return this.session!.rpc.plan.delete();
  }
  async listTools(): ReturnType<CopilotClient['rpc']['tools']['list']> {
    return this.client!.rpc.tools.list({});
  }
  /**
   * List MCP servers attached to the current session, with their status.
   * This is the right RPC for inventory — `listTools()` does NOT include MCP tools.
   */
  async listMcpServers(): ReturnType<SDKSession['rpc']['mcp']['list']> {
    if (!this.session) return { servers: [] };
    return this.session.rpc.mcp.list();
  }
  /**
   * Reload (reconnect) ALL MCP server connections for this session. Recovers a dead
   * remote MCP session (e.g. github-mcp `invalid session`) without a full process
   * restart. Runs in the send queue so it can't interleave with an in-flight turn's
   * tool calls; the alive/session check is atomic inside the queue.
   */
  reloadMcpServers(): ReturnType<SDKSession['rpc']['mcp']['reload']> {
    return this.runInSendQueue(() => {
      const session = this.session;
      if (!this._alive || !session) throw new Error('Session not started');
      return session.rpc.mcp.reload();
    });
  }
  async getQuota(): ReturnType<CopilotClient['rpc']['account']['getQuota']> {
    return this.client!.rpc.account.getQuota({});
  }
  async getMessages(): Promise<SessionEvent[]> {
    return this.session?.getEvents() ?? [];
  }
  async listFiles(): Promise<string[]> {
    return (await this.session!.rpc.workspaces.listFiles()).files ?? [];
  }
  async readFile(path: string): Promise<string> {
    return (await this.session!.rpc.workspaces.readFile({ path })).content ?? '';
  }

  async newSession(opts?: Partial<SessionOptions>): Promise<void> {
    if (this.session) await this.session.disconnect();
    this.toolNameByCallId.clear();
    const config = this.buildConfig({
      cwd: this.cwd,
      autopilot: this._autopilot,
      ...opts,
    });
    this.session = await this.client!.createSession(config as SessionConfig);
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  // ── Session management ──

  async disconnect(): Promise<void> {
    // Disconnect but preserve session data on disk for resume
    this._alive = false;
    this._turnActive = false;
    this.activeTurnId = null;
    this.clearPendingTurnReservations('Session disconnected');
    this.toolNameByCallId.clear();
    try {
      await this.session?.disconnect();
    } catch {
      /* ignore */
    }
    this.session = null;
    // Keep client alive for resume
    return;
  }

  async resume(sessionId: string, opts: SessionOptions): Promise<void> {
    this.cwd = opts.cwd;
    this._autopilot = opts.autopilot ?? false;
    this._messageMode = opts.messageMode;
    this._turnTimeoutMs = opts.turnTimeoutMs && opts.turnTimeoutMs > 0 ? opts.turnTimeoutMs : undefined;

    if (!this.client) {
      this.client = await Session.getSharedClient({
        binary: opts.binary,
        cliUrl: opts.cliUrl,
        githubToken: opts.githubToken,
        provider: opts.provider,
      });
    }

    this.session = await this.client.resumeSession(sessionId, this.buildConfig(opts) as SessionConfig);

    // Config is authoritative over the session's persisted model. A journal can
    // name a retired model id (e.g. claude-opus-4.7-1m-internal); the SDK does
    // not fall back like the interactive CLI does, it throws on the next send
    // and every message bounces. Switch here so config always wins.
    if (opts.model) {
      try {
        const current = await this.session.rpc.model.getCurrent();
        const effortChanged = opts.reasoningEffort ? current?.reasoningEffort !== opts.reasoningEffort : false;
        const tierChanged = opts.contextTier ? current?.contextTier !== opts.contextTier : false;
        if (current?.modelId !== opts.model || effortChanged || tierChanged) {
          await this.session.setModel(opts.model, {
            ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
            ...(opts.contextTier ? { contextTier: opts.contextTier } : {}),
          });
        }
      } catch (e) {
        await this.kill();
        throw new ModelUnavailableError(opts.model, e);
      }
    }

    this._alive = true;
    this.session.on((e: SessionEvent) => this.handleEvent(e));
  }

  async listSessions(): Promise<unknown[]> {
    if (!this.client) return [];
    return this.client.listSessions();
  }

  async getLastSessionId(): Promise<string | undefined> {
    return this.client?.getLastSessionId();
  }

  async deleteSession(id: string): Promise<void> {
    await this.client?.deleteSession(id);
  }

  async kill() {
    this._alive = false;
    this._turnActive = false;
    this.activeTurnId = null;
    this.clearPendingTurnReservations('Session killed');
    this.toolNameByCallId.clear();
    try {
      await this.session?.disconnect();
    } catch {
      /* ignore */
    }
    Session.releaseClient();
    this.session = null;
    this.client = null;
  }
}
