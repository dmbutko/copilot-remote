import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';

import { SessionRegistry } from '../session-registry.js';
import { SessionStore } from '../store.js';
import type { Session } from '../session.js';
import type { RestartManager } from '../restart-manager.js';

/** Build a fake Session with a controllable `start()` deferred promise. */
function makeFakeSession(opts: { startDeferred: Promise<void>; sessionId?: string }) {
  const fake = new EventEmitter() as unknown as Session & {
    startCalls: number;
    aliveFlag: boolean;
  };
  Object.assign(fake, {
    startCalls: 0,
    aliveFlag: false,
    get alive() {
      return (this as { aliveFlag: boolean }).aliveFlag;
    },
    sessionId: opts.sessionId,
    async start(_o: unknown) {
      (this as { startCalls: number }).startCalls += 1;
      await opts.startDeferred;
      (this as { aliveFlag: boolean }).aliveFlag = true;
    },
    async resume(_id: string, _o: unknown) {
      throw new Error('resume should not be called in this test');
    },
    kill() {
      (this as { aliveFlag: boolean }).aliveFlag = false;
    },
  });
  return fake as Session & { startCalls: number; aliveFlag: boolean };
}

function makeRegistry(overrides: {
  sessionFactory: () => Session;
  workDir?: string;
}) {
  const sessions = new Map<string, Session>();
  const workDirs = new Map<string, string>();
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reg-test-'));
  const cfgDir = path.join(tmpHome, '.copilot');
  fs.mkdirSync(cfgDir, { recursive: true });
  process.env.HOME = tmpHome;
  const sessionStore = new SessionStore();
  const restartManager = { addWorkDir: () => {} } as unknown as RestartManager;
  const config = { workDir: overrides.workDir ?? '/tmp/work' };
  const reg = new SessionRegistry({
    sessions,
    workDirs,
    sessionStore,
    restartManager,
    config,
    buildSessionOptions: (_chatId, cwdOverride) => ({ cwd: cwdOverride ?? config.workDir }),
    registerSessionListeners: () => {},
    sessionFactory: overrides.sessionFactory,
  });
  return { reg, sessions, workDirs, sessionStore, tmpHome };
}

describe('SessionRegistry race lock', () => {
  let prevHome: string | undefined;
  let tmpToCleanup: string | null = null;

  beforeEach(() => {
    prevHome = process.env.HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (tmpToCleanup) {
      fs.rmSync(tmpToCleanup, { recursive: true, force: true });
      tmpToCleanup = null;
    }
  });

  it('concurrent getSession() calls for same chat share one Session', async () => {
    let resolveStart!: () => void;
    const startDeferred = new Promise<void>((r) => {
      resolveStart = r;
    });

    let factoryCalls = 0;
    let createdFake: ReturnType<typeof makeFakeSession> | null = null;
    const { reg, sessions, tmpHome } = makeRegistry({
      sessionFactory: () => {
        factoryCalls += 1;
        createdFake = makeFakeSession({ startDeferred });
        return createdFake;
      },
    });
    tmpToCleanup = tmpHome;

    const a = reg.getSession('chat-1');
    const b = reg.getSession('chat-1');
    const c = reg.getSession('chat-1');

    resolveStart();
    const [sa, sb, sc] = await Promise.all([a, b, c]);

    assert.equal(factoryCalls, 1, 'Session factory should be called exactly once');
    assert.strictEqual(sa, sb);
    assert.strictEqual(sb, sc);
    assert.strictEqual(sa, createdFake);
    assert.strictEqual(sessions.get('chat-1'), sa);
  });

  it('after in-flight start completes, sessionStarts entry is cleared', async () => {
    let resolveStart!: () => void;
    const startDeferred = new Promise<void>((r) => {
      resolveStart = r;
    });

    const { reg, tmpHome } = makeRegistry({
      sessionFactory: () => makeFakeSession({ startDeferred }),
    });
    tmpToCleanup = tmpHome;

    const p = reg.getSession('chat-1');
    resolveStart();
    await p;

    const internal = reg as unknown as { sessionStarts: Map<string, unknown> };
    assert.equal(internal.sessionStarts.size, 0);
  });

  it('if start() rejects, sessionStarts is cleared and next call retries', async () => {
    let attempts = 0;
    let resolveSecond!: () => void;
    const secondDeferred = new Promise<void>((r) => {
      resolveSecond = r;
    });

    const { reg, tmpHome } = makeRegistry({
      sessionFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          return makeFakeSession({ startDeferred: Promise.reject(new Error('boom')) });
        }
        return makeFakeSession({ startDeferred: secondDeferred });
      },
    });
    tmpToCleanup = tmpHome;

    await assert.rejects(reg.getSession('chat-1'), /boom/);

    const internal = reg as unknown as { sessionStarts: Map<string, unknown> };
    assert.equal(internal.sessionStarts.size, 0, 'sessionStarts cleared after rejection');

    const p = reg.getSession('chat-1');
    resolveSecond();
    const s = await p;
    assert.equal(attempts, 2);
    assert.ok(s);
  });
});
