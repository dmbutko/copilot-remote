import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  RestartManager,
  collectWatchTargets,
  consumeRestartNotice,
  detectSupervisor,
  filterRestartRecipients,
  isDmSessionKey,
  persistRestartNotice,
  resolveSelfDevelopmentSettings,
} from '../restart-manager.js';

describe('detectSupervisor', () => {
  it('detects launchd and systemd environments', () => {
    assert.equal(detectSupervisor({ LAUNCH_JOB_NAME: 'com.copilot-remote' }), 'launchd');
    assert.equal(detectSupervisor({ INVOCATION_ID: 'abc123' }), 'systemd');
    assert.equal(detectSupervisor({}), null);
  });
});

describe('isDmSessionKey', () => {
  it('accepts positive integer chat ids only', () => {
    assert.equal(isDmSessionKey('880903035'), true);
    assert.equal(isDmSessionKey('1'), true);
  });

  it('rejects group, supergroup, channel, and forum-topic keys', () => {
    assert.equal(isDmSessionKey('-1234567890'), false); // basic group
    assert.equal(isDmSessionKey('-1001234567890'), false); // supergroup/channel
    assert.equal(isDmSessionKey('-1001234567890:5'), false); // forum topic
    assert.equal(isDmSessionKey('123:45'), false); // (defensive) any colon key
  });

  it('rejects malformed or surprising inputs', () => {
    assert.equal(isDmSessionKey(''), false);
    assert.equal(isDmSessionKey('0'), false);
    assert.equal(isDmSessionKey('0123'), false); // leading zero
    assert.equal(isDmSessionKey('1e3'), false); // scientific notation
    assert.equal(isDmSessionKey(' 123'), false); // leading whitespace
    assert.equal(isDmSessionKey('0x10'), false); // hex
    assert.equal(isDmSessionKey('123.4'), false);
    assert.equal(isDmSessionKey('abc'), false);
    assert.equal(isDmSessionKey(undefined as unknown as string), false);
  });
});

describe('filterRestartRecipients', () => {
  it('returns DM-only recipients when notifyDmsOnly is true', () => {
    const result = filterRestartRecipients(['123', '-1001', '-123', '123:45', '456'], true);
    assert.deepEqual(result.sort(), ['123', '456']);
  });

  it('returns all unique recipients when notifyDmsOnly is false', () => {
    const result = filterRestartRecipients(['123', '-1001', '-123', '123:45', '123'], false);
    assert.deepEqual(result.sort(), ['-1001', '-123', '123', '123:45']);
  });

  it('deduplicates and drops blank entries', () => {
    const result = filterRestartRecipients(['123', '123', '', '   ', '456'], true);
    assert.deepEqual(result.sort(), ['123', '456']);
  });

  it('returns an empty array when only group recipients are provided in DM-only mode', () => {
    assert.deepEqual(filterRestartRecipients(['-1001', '-1002', '-1001234567890:5'], true), []);
  });
});

describe('resolveSelfDevelopmentSettings', () => {
  it('defaults notifyDmsOnly to true', () => {
    const settings = resolveSelfDevelopmentSettings();
    assert.equal(settings.notifyDmsOnly, true);
  });

  it('honors notifyDmsOnly override from config', () => {
    const settings = resolveSelfDevelopmentSettings({ selfDevelopment: { notifyDmsOnly: false } });
    assert.equal(settings.notifyDmsOnly, false);
  });
});

describe('collectWatchTargets', () => {
  it('collects deduplicated config, agent, prompt, skill, and mcp targets', () => {
    const targets = collectWatchTargets({
      homeDir: '/Users/tester',
      workDirs: ['/workspace/app', '/workspace/app'],
      config: {
        skillDirectories: ['/custom/skills', '/custom/skills'],
      },
    });

    assert.ok(targets.includes(path.resolve('/Users/tester/.copilot/mcp-config.json')));
    assert.ok(targets.includes(path.resolve('/workspace/app/.github/agents')));
    assert.ok(targets.includes(path.resolve('/workspace/app/.github/prompts')));
    assert.ok(targets.includes(path.resolve('/Users/tester/.copilot/skills')));
    assert.ok(targets.includes(path.resolve('/custom/skills')));
    assert.equal(targets.length, new Set(targets).size);
  });

  it('honors self-development watch toggles', () => {
    const settings = resolveSelfDevelopmentSettings(
      { selfDevelopment: { watchPrompts: false, watchAgents: false } },
      undefined,
    );

    const targets = collectWatchTargets({
      homeDir: '/Users/tester',
      workDirs: ['/workspace/app'],
      config: { selfDevelopment: settings },
    });

    assert.equal(
      targets.some((target) => target.includes('/agents')),
      false,
    );
    assert.equal(
      targets.some((target) => target.includes('/prompts')),
      false,
    );
  });
});

describe('RestartManager', () => {
  it('debounces change notifications and auto-restarts when supervised', async () => {
    const watched: string[] = [];
    const unwatched: string[] = [];
    const required: string[] = [];
    const restarts: string[] = [];

    const manager = new RestartManager({
      env: { LAUNCH_JOB_NAME: 'com.copilot-remote' },
      homeDir: '/Users/tester',
      workDirs: ['/workspace/app'],
      settings: { debounceMs: 5 },
      watchFile: ((target: string) => {
        watched.push(target);
        return {
          ref() {
            return this;
          },
          unref() {
            return this;
          },
        };
      }) as unknown as typeof import('node:fs').watchFile,
      unwatchFile: ((target: string) => {
        unwatched.push(target);
      }) as typeof import('node:fs').unwatchFile,
      onRestartRequired: ({ reason }) => {
        required.push(reason);
      },
      onRequestRestart: ({ reason }) => {
        restarts.push(reason);
      },
    });

    manager.handleObservedChange('/workspace/app/.github/agents/notes.agent.md');
    manager.handleObservedChange('/workspace/app/.github/agents/notes.agent.md');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(watched.length > 0);
    assert.equal(required.length, 1);
    assert.equal(restarts.length, 1);
    assert.match(required[0] ?? '', /Capability change detected/);

    manager.stop();
    assert.deepEqual(unwatched.sort(), watched.sort());
  });

  it('tracks pending restart without auto-restart when unsupervised', async () => {
    let restartCalls = 0;
    const manager = new RestartManager({
      env: {},
      homeDir: '/Users/tester',
      settings: { debounceMs: 5 },
      watchFile: (() => ({
        ref() {
          return this;
        },
        unref() {
          return this;
        },
      })) as unknown as typeof import('node:fs').watchFile,
      unwatchFile: (() => undefined) as typeof import('node:fs').unwatchFile,
      onRequestRestart: () => {
        restartCalls++;
      },
    });

    manager.handleObservedChange('/tmp/config.json');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const status = manager.getStatus();
    assert.equal(status.pending?.changedPath, '/tmp/config.json');
    assert.equal(restartCalls, 0);
  });
});

describe('restart notices', () => {
  it('persists and consumes a one-shot restart announcement', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'copilot-remote-'));

    try {
      const notice = persistRestartNotice(
        {
          homeDir,
          reason: 'Manual restart requested',
          recipients: ['chat-1', 'chat-1', 'chat-2:42'],
        },
        { now: () => 1_000 },
      );

      assert.deepEqual(notice, {
        reason: 'Manual restart requested',
        recipients: ['chat-1', 'chat-2:42'],
        requestedAt: 1_000,
      });

      const consumed = consumeRestartNotice({ homeDir }, { now: () => 2_000 });
      assert.deepEqual(consumed, notice);
      assert.equal(consumeRestartNotice({ homeDir }, { now: () => 2_000 }), null);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('drops stale restart notices', () => {
    const homeDir = mkdtempSync(path.join(tmpdir(), 'copilot-remote-'));

    try {
      persistRestartNotice(
        {
          homeDir,
          reason: 'Old restart',
          recipients: ['chat-1'],
        },
        { now: () => 1_000 },
      );

      assert.equal(consumeRestartNotice({ homeDir, maxAgeMs: 100 }, { now: () => 2_000 }), null);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
