import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelInfo } from '@github/copilot-sdk';
import { sendConfigMenu, sendModelPicker, sendReasoningMenu, handleConfigCallback } from '../config-menu.js';
import { DEFAULT_CONFIG, type ChatConfig } from '../config-store.js';

function model(id: string, supportedReasoningEfforts: ModelInfo['supportedReasoningEfforts'] = ['low', 'high']): ModelInfo {
  return {
    id,
    name: id,
    supportedReasoningEfforts,
    capabilities: {
      supports: { vision: false, reasoningEffort: true },
      limits: { max_context_window_tokens: 128_000 },
    },
  };
}

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
    models: [] as ModelInfo[],
    listModelsError: null as Error | null,
    listModelsCalls: 0,
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
    listModels: async () => {
      state.listModelsCalls++;
      if (state.listModelsError) throw state.listModelsError;
      return structuredClone(state.models);
    },
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

  it('shows newly available models when the picker is reopened', async () => {
    const { state, deps } = createDeps({ model: 'existing-model' });
    state.models = [model('existing-model')];
    await sendModelPicker('chat-1', 10, deps as never);
    const before = JSON.stringify(deps.client.editButtonsCalls.at(-1)?.buttons);
    assert.ok(!before.includes('new-model'));

    state.models.push(model('new-model'));
    await sendModelPicker('chat-1', 10, deps as never);

    const after = JSON.stringify(deps.client.editButtonsCalls.at(-1)?.buttons);
    assert.ok(after.includes('new-model'));
    assert.equal(state.listModelsCalls, 2);
    assert.equal(state.getSessionCalls, 0, 'listing must not create or resume a chat');
  });

  it('refreshes reasoning capabilities rather than reusing the previous menu', async () => {
    const { state, deps } = createDeps({ model: 'existing-model' });
    state.models = [model('existing-model', ['low', 'high'])];
    await sendReasoningMenu('chat-1', 10, deps as never);
    assert.ok(!JSON.stringify(deps.client.editButtonsCalls.at(-1)?.buttons).includes('reason:max'));

    state.models = [model('existing-model', ['low', 'high', 'max'])];
    await sendReasoningMenu('chat-1', 10, deps as never);

    assert.ok(JSON.stringify(deps.client.editButtonsCalls.at(-1)?.buttons).includes('reason:max'));
    assert.equal(state.listModelsCalls, 2);
  });

  it('rejects a stale model button without changing settings or rebuilding', async () => {
    const { state, deps } = createDeps({ model: 'existing-model', reasoningEffort: 'high', contextTier: 'long_context' });
    state.models = [model('existing-model'), model('removed-model')];
    await sendModelPicker('chat-1', 10, deps as never);
    state.models = [model('existing-model')];
    const before = structuredClone(state.config);

    await handleConfigCallback('model:removed-model', 'chat-1', 10, 'stale-button', deps as never);

    assert.deepEqual(state.config, before);
    assert.equal(state.getSessionCalls, 0);
    assert.equal(state.suspendCalls, 0);
    assert.match(String(deps.client.answerCallbackCalls.at(-1)?.text), /Model unavailable/);
    assert.ok(!JSON.stringify(deps.client.editButtonsCalls.at(-1)?.buttons).includes('removed-model'));
  });

  it('uses fresh capabilities when selecting a new global model and preserves context tier', async () => {
    const { state, deps } = createDeps({ model: 'existing-model', reasoningEffort: 'high', contextTier: 'long_context' });
    state.models = [model('existing-model'), model('new-model', ['low', 'medium'])];

    await handleConfigCallback('model:new-model', 'chat-1', 10, 'new-model-button', deps as never);

    assert.equal(state.config.model, 'new-model');
    assert.equal(state.config.reasoningEffort, '', 'incompatible inherited effort must be cleared');
    assert.equal(state.config.contextTier, 'long_context');
    assert.equal(state.getSessionCalls, 1);
    assert.equal(state.suspendCalls, 1);
  });

  it('shows explicit errors after a successful lookup instead of stale or invented models', async () => {
    const { state, deps } = createDeps({ model: 'existing-model' });
    state.models = [model('existing-model')];
    await sendModelPicker('chat-1', 10, deps as never);
    state.listModelsError = new Error('catalogue unavailable');
    const before = structuredClone(state.config);

    await sendModelPicker('chat-1', 10, deps as never);
    assert.match(String(deps.client.editButtonsCalls.at(-1)?.text), /Couldn't load models/);
    assert.ok(!JSON.stringify(deps.client.editButtonsCalls.at(-1)?.buttons).includes('model:existing-model'));
    await sendReasoningMenu('chat-1', 10, deps as never);
    assert.match(String(deps.client.editButtonsCalls.at(-1)?.text), /Couldn't load model capabilities/);
    await handleConfigCallback('model:existing-model', 'chat-1', 10, 'failed-lookup', deps as never);
    assert.deepEqual(state.config, before);
    assert.equal(state.getSessionCalls, 0);
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
