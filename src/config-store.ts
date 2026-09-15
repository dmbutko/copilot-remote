import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { MCPServerConfig } from './mcp-config.js';
import { log } from './log.js';
import { resolveProviderConfig, type RemoteProviderConfig } from './provider-config.js';
import { atomicWriteSync } from './util/atomic-write.js';

const CONFIG_DIR = join(process.env.HOME ?? '.', '.copilot-remote');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
/**
 * Per-chat overrides live in their own file, deliberately NOT a RestartManager
 * watch target (it watches CONFIG_FILE by path, never the directory — see
 * restart-manager.ts). Writing config.json restarts the bot, which is wanted for
 * global changes and unwanted for a one-chat model switch.
 */
export const OVERRIDES_FILE = join(CONFIG_DIR, 'chat-overrides.json');

/** Fields a chat may override. Everything else stays global-only by design. */
export const PER_CHAT_KEYS = ['model', 'reasoningEffort', 'contextTier'] as const;
export type PerChatKey = (typeof PER_CHAT_KEYS)[number];

/**
 * Narrow an update to the overridable fields. Overrides are deliberately
 * restricted: display toggles, autopilot and autoApprove stay global so a chat
 * can never quietly diverge on a permission-shaped setting.
 */
function pickPerChat(updates: Partial<ChatConfig>): Partial<ChatConfig> {
  const out: Partial<ChatConfig> = {};
  for (const k of PER_CHAT_KEYS) {
    if (updates[k] !== undefined) (out as Record<string, unknown>)[k] = updates[k];
  }
  return out;
}

export type PermKind = 'shell' | 'write' | 'mcp' | 'read' | 'url' | 'custom-tool';
export type MessageMode = 'enqueue' | 'immediate';
export type ContextTier = 'default' | 'long_context';

export function normalizeMessageMode(value: unknown): MessageMode {
  return value === 'immediate' ? 'immediate' : 'enqueue';
}

export function normalizeContextTier(value: unknown): ContextTier {
  return value === 'long_context' ? 'long_context' : 'default';
}

export interface ChatConfig {
  showUsage: boolean;
  showThinking: boolean;
  showTools: boolean;
  showReactions: boolean;
  autopilot: boolean;
  mode: string;
  model: string;
  agent: string | null;
  reasoningEffort: string;
  contextTier: ContextTier;
  messageMode: MessageMode;
  infiniteSessions: boolean | undefined;
  excludedTools: string[];
  autoApprove: Record<PermKind, boolean>;
}

/** Global config fields from config.json (not per-chat) */
export interface GlobalConfig {
  cliUrl?: string;
  provider?: RemoteProviderConfig;
  logLevel?: string;
  logging?: {
    level?: string;
  };
  debug?: boolean;
  mcpServers?: Record<string, MCPServerConfig>;
  customAgents?: unknown[];
  skillDirectories?: string[];
  disabledSkills?: string[];
  systemInstructions?: string;
  availableTools?: string[];
  excludedTools?: string[];
  /**
   * Optional external command invoked on each user prompt to supply additional
   * model context. `command` must be an EXECUTABLE PATH (run via execFile, no
   * shell — a string like "bash foo.sh" will not work; point at an executable
   * with a shebang). It is run with the session id as its single argv argument;
   * its stdout (if any) is PREPENDED to the user's prompt for that turn via the
   * hook's modifiedPrompt. (The host CLI parses but does not inject a
   * userPromptSubmitted hook's additionalContext — verified through CLI 1.0.64 —
   * so modifiedPrompt is used instead.)
   * Absent ⇒ feature OFF. The bridge treats stdout as opaque and has NO knowledge
   * of the command's meaning; non-zero exit / timeout / error / stdout exceeding
   * `maxBytes` ⇒ no context injected (fail-open, never blocks the message; the
   * failure is logged at debug level). Defaults: timeoutMs 2000, maxBytes 65536.
   */
  promptContextProvider?: { command: string; timeoutMs?: number; maxBytes?: number };
  /**
   * When true (default), passes `enableConfigDiscovery: true` to the underlying CLI
   * session. This activates the CLI's built-in github-mcp-server injection (and
   * `web_search`), plus discovery of MCP servers / plugins / disabledMcpServers /
   * disabledSkills from `~/.copilot/mcp-config.json`, `.vscode/mcp.json`, `.mcp.json`,
   * and `~/.copilot/plugins/`. Set to false to revert to the pre-fix behavior
   * (e.g. for BYOK provider sessions where built-in github-mcp is undesirable, or
   * if discovered config conflicts with copilot-remote's explicit `mcpServers`).
   */
  enableCliConfigDiscovery?: boolean;
  /** Idle timeout in minutes — kills turn if no SDK events. 0 = disabled. Default: 15 */
  selfDevelopment?: {
    enabled?: boolean;
    autoRestart?: boolean;
    debounceMs?: number;
    watchConfig?: boolean;
    watchMcp?: boolean;
    watchAgents?: boolean;
    watchSkills?: boolean;
    watchPrompts?: boolean;
    notifyDmsOnly?: boolean;
  };
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: ChatConfig = {
  showUsage: false,
  showThinking: false,
  showTools: false,
  showReactions: true,
  autopilot: false,
  mode: 'interactive',
  model: '',
  agent: null,
  reasoningEffort: '',
  contextTier: 'default',
  messageMode: 'enqueue',
  infiniteSessions: undefined,
  excludedTools: [],
  autoApprove: {
    read: true,
    shell: false,
    write: false,
    mcp: false,
    url: false,
    'custom-tool': false,
  },
};

export class ConfigStore {
  private global: ChatConfig;
  private rawFile: GlobalConfig = {};
  private overrides = new Map<string, Partial<ChatConfig>>();
  private readonly configDir: string;
  private readonly configFile: string;
  private readonly overridesFile: string;

  /**
   * @param opts.configDir Override the default `~/.copilot-remote/` directory.
   *   Tests MUST pass a tmpdir here to avoid mutating the real production
   *   config when calling `set(..., true)`.
   */
  constructor(opts: { configDir?: string } = {}) {
    this.configDir = opts.configDir ?? CONFIG_DIR;
    this.configFile = opts.configDir ? join(opts.configDir, 'config.json') : CONFIG_FILE;
    this.overridesFile = opts.configDir ? join(opts.configDir, 'chat-overrides.json') : OVERRIDES_FILE;
    this.global = this.load();
    this.loadOverrides();
  }

  private loadOverrides(): void {
    try {
      if (!existsSync(this.overridesFile)) return;
      const data = JSON.parse(readFileSync(this.overridesFile, 'utf-8')) as Record<string, Partial<ChatConfig>>;
      for (const [key, value] of Object.entries(data)) {
        const picked = pickPerChat(value);
        if (Object.keys(picked).length) this.overrides.set(key, picked);
      }
      log.info('[config] Loaded', this.overrides.size, 'chat override(s) from', this.overridesFile);
    } catch (e) {
      // Fail open: a corrupt overrides file must never stop the bridge starting.
      log.error('[config] Failed to load chat overrides:', e);
    }
  }

  private saveOverrides(): boolean {
    try {
      if (!existsSync(this.configDir)) mkdirSync(this.configDir, { recursive: true });
      const obj = Object.fromEntries(this.overrides);
      atomicWriteSync(this.overridesFile, JSON.stringify(obj, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      log.error('[config] Failed to save chat overrides:', e);
      return false;
    }
  }

  /** True when the last override write reached disk. Callers report durability honestly. */
  lastOverrideWriteOk = true;

  /** Get the raw global config file (non-ChatConfig fields like provider, mcpServers, etc.) */
  raw(): GlobalConfig {
    const provider = resolveProviderConfig(this.rawFile.provider);
    return {
      ...this.rawFile,
      ...(provider ? { provider } : {}),
    };
  }

  /** Get effective config for a session key (global + overrides merged) */
  get(key: string): ChatConfig {
    const overrides = this.overrides.get(key);
    if (!overrides) return { ...this.global, autoApprove: { ...this.global.autoApprove } };
    return {
      ...this.global,
      ...overrides,
      autoApprove: { ...this.global.autoApprove, ...(overrides.autoApprove ?? {}) },
    };
  }

  /** Update config for a key. If isGlobal, persists to disk. Otherwise, stores as thread override. */
  set(key: string, updates: Partial<ChatConfig>, isGlobal = false): ChatConfig {
    const normalizedUpdates = { ...updates };
    if (updates.messageMode !== undefined) {
      normalizedUpdates.messageMode = normalizeMessageMode(updates.messageMode);
    }
    if (updates.contextTier !== undefined) {
      normalizedUpdates.contextTier = normalizeContextTier(updates.contextTier);
    }

    if (isGlobal) {
      Object.assign(this.global, normalizedUpdates);
      if (updates.autoApprove) {
        Object.assign(this.global.autoApprove, updates.autoApprove);
      }
      this.save();
    } else {
      const existing = this.overrides.get(key) ?? {};
      Object.assign(existing, pickPerChat(normalizedUpdates));
      if (Object.keys(existing).length) this.overrides.set(key, existing);
      else this.overrides.delete(key);
      this.lastOverrideWriteOk = this.saveOverrides();
    }
    return this.get(key);
  }

  /** Check if a key is a thread (has overrides) or global context (DM) */
  hasOverrides(key: string): boolean {
    return this.overrides.has(key);
  }

  /** Get just the global config */
  getGlobal(): ChatConfig {
    return { ...this.global, autoApprove: { ...this.global.autoApprove } };
  }

  /**
   * Reset thread overrides so the chat inherits global again. Returns true if any
   * existed in memory. Always rewrites the file: after a failed removal write the
   * entry is gone from memory but still on disk, so a retry must be able to reach
   * the write again rather than short-circuit on the empty map.
   */
  resetOverrides(key: string): boolean {
    const had = this.overrides.delete(key);
    this.lastOverrideWriteOk = this.saveOverrides();
    return had;
  }

  private load(): ChatConfig {
    try {
      if (existsSync(this.configFile)) {
        const data = JSON.parse(readFileSync(this.configFile, 'utf-8'));
        const provider = resolveProviderConfig(data.provider);
        log.info('[config] Loaded from', this.configFile);
        this.rawFile = {
          ...data,
          ...(provider ? { provider } : {}),
        };
        return {
          ...DEFAULT_CONFIG,
          ...data,
          model: process.env.COPILOT_REMOTE_MODEL ?? data.model ?? DEFAULT_CONFIG.model,
          messageMode: normalizeMessageMode(data.messageMode),
          contextTier: normalizeContextTier(data.contextTier),
          autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...(data.autoApprove ?? {}) },
        };
      }
    } catch (e) {
      log.error('[config] Failed to load:', e);
    }
    return { ...DEFAULT_CONFIG, autoApprove: { ...DEFAULT_CONFIG.autoApprove } };
  }

  private save(): void {
    try {
      if (!existsSync(this.configDir)) mkdirSync(this.configDir, { recursive: true });
      atomicWriteSync(this.configFile, JSON.stringify({ ...this.rawFile, ...this.global }, null, 2), { mode: 0o600 });
      log.info('[config] Saved to', this.configFile);
    } catch (e) {
      log.error('[config] Failed to save:', e);
    }
  }
}
