import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore, DEFAULT_CONFIG, normalizeMessageMode } from '../config-store.js';

describe('ConfigStore', () => {
  // Tests use a per-suite tmpdir for config so they don't mutate the real
  // production `~/.copilot-remote/config.json` (which the running daemon
  // would otherwise pick up as a "capability change" and auto-restart on).
  let tmpDir: string;
  const make = () => new ConfigStore({ configDir: tmpDir });

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfgstore-test-'));
  });
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a config object with all expected keys', () => {
    const store = make();
    const cfg = store.get('test-chat-' + Date.now());
    assert.equal(typeof cfg.model, 'string');
    assert.equal(typeof cfg.autopilot, 'boolean');
    assert.equal(typeof cfg.showReactions, 'boolean');
    assert.equal(typeof cfg.autoApprove, 'object');
    assert.ok('read' in cfg.autoApprove);
    assert.ok('shell' in cfg.autoApprove);
  });

  it('global set changes all keys', () => {
    const store = make();
    const before = store.getGlobal().model;
    const testModel = 'test-model-' + Date.now();
    store.set('chat1', { model: testModel }, true);
    assert.equal(store.get('chat1').model, testModel);
    assert.equal(store.get('other-chat').model, testModel);
    // Restore
    store.set('chat1', { model: before }, true);
  });

  it('thread overrides only affect that thread', () => {
    const store = make();
    const globalModel = store.getGlobal().model;
    const threadKey = 'thread-' + Date.now();
    store.set(threadKey, { model: 'thread-only-model' }, false);
    assert.equal(store.get(threadKey).model, 'thread-only-model');
    assert.equal(store.getGlobal().model, globalModel);
  });

  it('thread overrides merge with global', () => {
    const store = make();
    const threadKey = 'thread-merge-' + Date.now();
    store.set(threadKey, { showThinking: true }, false);
    const cfg = store.get(threadKey);
    assert.equal(cfg.showThinking, true);
    // Other fields come from global
    assert.equal(cfg.model, store.getGlobal().model);
  });

  it('autoApprove merges correctly', () => {
    const store = make();
    const threadKey = 'thread-approve-' + Date.now();
    const globalShell = store.getGlobal().autoApprove.shell;
    store.set(threadKey, { autoApprove: { shell: !globalShell } as any }, false);
    const cfg = store.get(threadKey);
    assert.equal(cfg.autoApprove.shell, !globalShell);
    // Other approve settings come from global
    assert.equal(cfg.autoApprove.read, store.getGlobal().autoApprove.read);
  });

  it('hasOverrides tracks thread state', () => {
    const store = make();
    const key = 'has-overrides-' + Date.now();
    assert.equal(store.hasOverrides(key), false);
    store.set(key, { model: 'x' }, false);
    assert.equal(store.hasOverrides(key), true);
  });

  it('resetOverrides reverts to global', () => {
    const store = make();
    const key = 'reset-' + Date.now();
    store.set(key, { model: 'custom' }, false);
    assert.equal(store.get(key).model, 'custom');
    store.resetOverrides(key);
    assert.equal(store.get(key).model, store.getGlobal().model);
    assert.equal(store.hasOverrides(key), false);
  });

  it('DEFAULT_CONFIG has sensible defaults', () => {
    assert.equal(DEFAULT_CONFIG.autopilot, false);
    assert.equal(DEFAULT_CONFIG.showReactions, true);
    assert.equal(DEFAULT_CONFIG.messageMode, 'enqueue');
    assert.equal(DEFAULT_CONFIG.autoApprove.read, true);
    assert.equal(DEFAULT_CONFIG.autoApprove.shell, false);
    assert.equal(DEFAULT_CONFIG.autoApprove.write, false);
  });

  it('normalizes legacy blank message mode to enqueue', () => {
    assert.equal(normalizeMessageMode(''), 'enqueue');
    assert.equal(normalizeMessageMode(undefined), 'enqueue');
    assert.equal(normalizeMessageMode('immediate'), 'immediate');
  });
});
