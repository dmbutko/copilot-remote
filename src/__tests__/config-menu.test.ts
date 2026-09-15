import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendConfigMenu, handleConfigCallback } from '../config-menu.js';
import { DEFAULT_CONFIG, type ChatConfig } from '../config-store.js';

function createDeps(initialConfig?: Partial<ChatConfig>) {
  const state = {
    config: {
      ...DEFAULT_CONFIG,
      ...initialConfig,
      autoApprove: { ...DEFAULT_CONFIG.autoApprove, ...(initialConfig?.autoApprove ?? {}) },
    } satisfies ChatConfig,
    raw: {} as Record<string, unknown>,
    deletedSessionStoreKeys: [] as string[],
    getSessionCalls: 0,
    suspendCalls: 0,
  };

  const client = {
    sendButtonsCalls: [] as Array<Record<string, unknown>>,
    editButtonsCalls: [] as Array<Record<string, unknown>>,
    answerCallbackCalls: [] as Array<Record<string, unknown>>,
    async sendButtons(chatId: string, text: string, buttons: unknown[][]) {
      this.sendButtonsCalls.push({ chatId, text, buttons });
      return 1;
    },
    async editButtons(chatId: string, msgId: number, text: string, buttons: unknown[][]) {
      this.editButtonsCalls.push({ chatId, msgId, text, buttons });
    },
    async answerCallback(callbackId: string, text?: string) {
      this.answerCallbackCalls.push({ callbackId, text });
    },
  };

  const configStore = {
    // Deliberately DIFFERENT from getGlobal: this stands in for a chat that has
    // a per-chat override. /config is a global editor, so any menu that reads
    // this instead of getGlobal() would display the override as the default —
    // and its writes would then promote it globally. A revert of that fix makes
    // the menu assertions below fail.
    get: () => ({
      ...state.config,
      model: 'chat-override-model',
      autoApprove: { ...state.config.autoApprove },
    }),
    getGlobal: () => ({ ...state.config, autoApprove: { ...state.config.autoApprove } }),
    set: (_key: string, updates: Partial<ChatConfig>) => {
      state.config = {
        ...state.config,
        ...updates,
        autoApprove: { ...state.config.autoApprove, ...(updates.autoApprove ?? {}) },
      };
      return { ...state.config, autoApprove: { ...state.config.autoApprove } };
    },
    raw: () => state.raw,
  };

  const deps = {
    client,
    configStore,
    sessions: new Map<string, Record<string, unknown>>(),
    sessionStore: {
      delete: (key: string) => state.deletedSessionStoreKeys.push(key),
      get: () => undefined,
    },
    listModels: async () => [],
    workDir: () => '/tmp/project',
    bin: 'copilot',
    getSession: async () => {
      state.getSessionCalls++;
      return { alive: true };
    },
    suspendSession: () => {
      state.suspendCalls++;
    },
  };

  return { state, deps };
}

describe('config-menu', () => {
  it('shows queue-first message mode label in the config menu', async () => {
    const { deps } = createDeps({ messageMode: 'enqueue' });

    await sendConfigMenu('chat-1', deps as never);

    const firstCall = deps.client.sendButtonsCalls[0];
    assert.ok(firstCall);
    const buttons = firstCall.buttons as Array<Array<{ text: string }>>;
    const messagesBtn = buttons.find((row) => row[0]?.text?.startsWith('📨 Messages'))?.[0];
    assert.equal(messagesBtn?.text, '📨 Messages: Queue next message');
  });

  it('shows the GLOBAL model, not a chat override', async () => {
    // /config edits globals, so it must display globals. If a renderer reverts
    // to configStore.get(chatId) this shows 'chat-override-model' instead.
    const { deps } = createDeps({ model: 'global-model' });
    await sendConfigMenu('chat-1', deps as never);

    const call = deps.client.sendButtonsCalls[0];
    const buttons = call?.buttons as Array<Array<{ text: string }>>;
    const rendered = String(call?.text ?? '') + ' | ' + buttons.flat().map((b) => b.text).join(' | ');
    assert.ok(rendered.includes('global-model'), 'must render the global default');
    assert.ok(!rendered.includes('chat-override-model'), 'must not render a per-chat override as the global default');
  });

  it('toggles message mode and updates the live session setting', async () => {
    const { state, deps } = createDeps({ messageMode: 'enqueue' });
    const liveSession = { alive: true, messageMode: 'enqueue' };
    deps.sessions.set('chat-1', liveSession);

    const handled = await handleConfigCallback('cfg:messageMode', 'chat-1', 99, 'cb-1', deps as never);

    assert.equal(handled, true);
    assert.equal(state.config.messageMode, 'immediate');
    assert.equal(liveSession.messageMode, 'immediate');

    const lastEdit = deps.client.editButtonsCalls.at(-1);
    assert.ok(lastEdit);
    const buttons = lastEdit?.buttons as Array<Array<{ text: string }>>;
    const messagesBtn = buttons.find((row) => row[0]?.text?.startsWith('📨 Messages'))?.[0];
    assert.equal(messagesBtn?.text, '📨 Messages: Interrupt current turn');
  });

  it('toggles display settings and answers the callback with the new state', async () => {
    const { state, deps } = createDeps({ showThinking: false });

    const handled = await handleConfigCallback('dsp:showThinking', 'chat-1', 55, 'cb-2', deps as never);

    assert.equal(handled, true);
    assert.equal(state.config.showThinking, true);
    assert.deepEqual(deps.client.answerCallbackCalls[0], {
      callbackId: 'cb-2',
      text: 'Thinking: ✅ ON',
    });
  });

  it('ignores an invalid ctx: callback without rebuilding or changing config', async () => {
    const { state, deps } = createDeps({ contextTier: 'default' });

    const handled = await handleConfigCallback('ctx:bogus', 'chat-1', 77, 'cb-ctx', deps as never);

    assert.equal(handled, true);
    assert.equal(state.config.contextTier, 'default');
    assert.equal(state.getSessionCalls, 0);
    assert.equal(state.suspendCalls, 0);
  });

  it('applies a valid ctx: callback', async () => {
    const { state, deps } = createDeps({ contextTier: 'default' });

    const handled = await handleConfigCallback('ctx:long_context', 'chat-1', 78, 'cb-ctx2', deps as never);

    assert.equal(handled, true);
    assert.equal(state.config.contextTier, 'long_context');
    assert.equal(state.getSessionCalls, 1);
  });
});
