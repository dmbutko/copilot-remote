import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { MCPServerConfig } from './mcp-config.js';
import { log } from './log.js';
import { resolveProviderConfig, type RemoteProviderConfig } from './provider-config.js';
import { atomicWriteSync } from './util/atomic-write.js';

const CONFIG_DIR = join(process.env.HOME ?? '.', '.copilot-remote');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

export type PermKind = 'shell' | 'write' | 'mcp' | 'read' | 'url' | 'custom-tool';
export type MessageMode = 'enqueue' | 'immediate';

export function normalizeMessageMode(value: unknown): MessageMode {
  return value === 'immediate' ? 'immediate' : 'enqueue';
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
  model: 'claude-sonnet-4',
  agent: null,
  reasoningEffort: '',
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

  constructor() {
    this.global = this.load();
  }

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

    if (isGlobal) {
      Object.assign(this.global, normalizedUpdates);
      if (updates.autoApprove) {
        Object.assign(this.global.autoApprove, updates.autoApprove);
      }
      this.save();
    } else {
      const existing = this.overrides.get(key) ?? {};
      Object.assign(existing, normalizedUpdates);
      if (updates.autoApprove) {
        existing.autoApprove = { ...(existing.autoApprove ?? {}), ...updates.autoApprove };
      }
      this.overrides.set(key, existing);
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

  /** Reset thread overrides */
  resetOverrides(key: string): void {
    this.overrides.delete(key);
  }

  private load(): ChatConfig {
    try {
      if (existsSync(CONFIG_FILE)) {
        const data = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
        const provider = resolveProviderConfig(data.provider);
        log.info('[config] Loaded from', CONFIG_FILE);
        this.rawFile = {
          ...data,
          ...(provider ? { provider } : {}),
        };
        return {
          ...DEFAULT_CONFIG,
          ...data,
          model: process.env.COPILOT_REMOTE_MODEL ?? data.model ?? DEFAULT_CONFIG.model,
          messageMode: normalizeMessageMode(data.messageMode),
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
      if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
      atomicWriteSync(CONFIG_FILE, JSON.stringify({ ...this.rawFile, ...this.global }, null, 2), { mode: 0o600 });
      log.info('[config] Saved to', CONFIG_FILE);
    } catch (e) {
      log.error('[config] Failed to save:', e);
    }
  }
}
