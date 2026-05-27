import * as fs from 'node:fs';
import * as path from 'node:path';
import { Session, type SessionOptions } from './session.js';
import { SessionStore } from './store.js';
import { log } from './log.js';
import type { RestartManager } from './restart-manager.js';

export interface SessionRegistryDeps {
  sessions: Map<string, Session>;
  workDirs: Map<string, string>;
  sessionStore: SessionStore;
  restartManager: RestartManager;
  config: { workDir: string };
  /** Build the SDK SessionOptions for a chat, given an optional cwd / sessionId override. */
  buildSessionOptions: (chatId: string, cwdOverride?: string, sessionIdOverride?: string) => SessionOptions;
  /** Hook persistent listeners (usage, context, tool status, etc.) onto a freshly started/resumed Session. */
  registerSessionListeners: (session: Session, chatId: string) => void;
  /** Override Session construction (tests only). Defaults to `new Session()`. */
  sessionFactory?: () => Session;
}

const RESUME_FAILURE_LIMIT = 3;
const ARCHIVE_KEEP = 5;

function archivePaths() {
  const home = process.env.HOME ?? '~';
  const copilotDir = path.join(home, '.copilot', 'session-state');
  return { copilotDir, archiveDir: path.join(copilotDir, '.archive') };
}

/**
 * Owns the per-chat Session lifecycle:
 *   - the live `sessions` map (chatId → Session)
 *   - the per-chat `workDirs` map
 *   - getSession() with an in-flight Promise dedup lock to prevent two
 *     concurrent calls from racing to create duplicate Sessions for the
 *     same chat (Fix 2)
 *   - suspendSession / archiveSession
 *   - invalidateChat / invalidateAll for use by future Fix 3 (wedged-turn kill)
 */
export class SessionRegistry {
  readonly sessions: Map<string, Session>;
  readonly workDirs: Map<string, string>;

  private readonly sessionStarts = new Map<string, Promise<Session>>();
  private readonly resumeFailures = new Map<string, number>();

  constructor(private readonly deps: SessionRegistryDeps) {
    this.sessions = deps.sessions;
    this.workDirs = deps.workDirs;
  }

  workDir(chatId: string): string {
    return this.workDirs.get(chatId) ?? this.deps.config.workDir;
  }

  /**
   * Return the live Session for a chat, resuming a stored one or starting fresh
   * if needed. Concurrent calls for the same chatId share a single in-flight
   * Promise so we never create two Sessions for one chat.
   */
  async getSession(chatId: string): Promise<Session> {
    const existing = this.sessions.get(chatId);
    if (existing?.alive) return existing;

    const inflight = this.sessionStarts.get(chatId);
    if (inflight) return inflight;

    const promise = this.startOrResume(chatId).finally(() => {
      if (this.sessionStarts.get(chatId) === promise) {
        this.sessionStarts.delete(chatId);
      }
    });
    this.sessionStarts.set(chatId, promise);
    return promise;
  }

  /** Kill in-memory Session but preserve disk state. Next message auto-resumes. */
  suspendSession(chatId: string): void {
    const s = this.sessions.get(chatId);
    if (s?.alive) {
      try {
        s.kill();
      } catch {
        /* ignore */
      }
    }
    this.sessions.delete(chatId);
    log.info('[session:suspend]', chatId);
  }

  /**
   * Suspend + move entire session directory to archive. Session won't auto-resume;
   * next message creates fresh. Old data preserved for forensic/query access.
   */
  async archiveSession(chatId: string, explicitSessionId?: string): Promise<void> {
    this.suspendSession(chatId);
    const ids = [
      ...new Set([
        ...(explicitSessionId ? [explicitSessionId] : []),
        ...this.deps.sessionStore.getSessionIds(chatId),
      ]),
    ];
    const { copilotDir, archiveDir } = archivePaths();
    for (const sessionId of ids) {
      const sessionDir = path.join(copilotDir, sessionId);
      if (!fs.existsSync(sessionDir)) continue;
      fs.mkdirSync(archiveDir, { recursive: true });
      const archiveDest = path.join(archiveDir, `${sessionId}-${Date.now()}`);
      try {
        fs.renameSync(sessionDir, archiveDest);
        log.info('[session:archive]', sessionId, '→', archiveDest);
      } catch (e) {
        log.warn('[session:archive] Failed to move', sessionId, e);
      }
    }
    this.deps.sessionStore.delete(chatId);
    this.resetResumeFailures(chatId);
    this.pruneArchives(ids, ARCHIVE_KEEP);
  }

  /**
   * Drop a single chat's in-memory state. Used by the wedged-turn killer (Fix 3)
   * and any future capability that needs to force a fresh Session on next message.
   * Does NOT archive — disk state stays intact, next getSession resumes.
   */
  invalidateChat(chatId: string, reason: string): void {
    this.suspendSession(chatId);
    this.sessionStarts.delete(chatId);
    log.info('[registry:invalidate]', chatId, reason);
  }

  /**
   * Invalidate every live OR in-flight chat. Iterates the union of `sessions`
   * and `sessionStarts` keys so we don't miss a chat that's mid-start.
   */
  invalidateAll(reason: string): void {
    const keys = new Set<string>([...this.sessions.keys(), ...this.sessionStarts.keys()]);
    for (const chatId of keys) this.invalidateChat(chatId, reason);
  }

  private async startOrResume(chatId: string): Promise<Session> {
    const s = this.deps.sessionFactory ? this.deps.sessionFactory() : new Session();
    const deterministicSessionId = SessionStore.deterministicSessionId(chatId);
    const opts = this.deps.buildSessionOptions(chatId);

    for (const saved of this.deps.sessionStore.getResumeCandidates(chatId)) {
      const resumeCwd = saved.cwd && saved.cwd !== this.deps.config.workDir ? saved.cwd : opts.cwd;
      if (saved.cwd && saved.cwd !== this.deps.config.workDir) {
        this.workDirs.set(chatId, saved.cwd);
        this.deps.restartManager.addWorkDir(saved.cwd);
      }
      try {
        await s.resume(saved.sessionId, this.deps.buildSessionOptions(chatId, resumeCwd, saved.sessionId));
        this.deps.sessionStore.touch(chatId);
        this.resetResumeFailures(chatId);
        this.sessions.set(chatId, s);
        this.deps.registerSessionListeners(s, chatId);
        log.info('Resumed session', saved.sessionId, 'for', chatId);
        return s;
      } catch (e) {
        log.warn('Resume failed for', saved.sessionId, '— trying next candidate/new session:', e);
        const failures = this.recordResumeFailure(chatId);
        if (failures >= RESUME_FAILURE_LIMIT) {
          log.warn('[session:resume-guard] 3 consecutive failures, archiving', saved.sessionId);
          await this.archiveSession(chatId, saved.sessionId);
          break;
        }
        if (saved.sessionId !== deterministicSessionId) {
          this.deps.sessionStore.delete(chatId);
        }
      }
    }

    await s.start(opts);
    this.resetResumeFailures(chatId);
    this.deps.restartManager.addWorkDir(this.workDir(chatId));
    if (s.sessionId) {
      this.deps.sessionStore.set(chatId, {
        sessionId: s.sessionId,
        cwd: this.workDir(chatId),
        model: opts.model ?? '',
        createdAt: Date.now(),
        lastUsed: Date.now(),
      });
    }
    this.deps.registerSessionListeners(s, chatId);
    this.sessions.set(chatId, s);
    return s;
  }

  private recordResumeFailure(chatId: string): number {
    const count = (this.resumeFailures.get(chatId) ?? 0) + 1;
    this.resumeFailures.set(chatId, count);
    return count;
  }

  private resetResumeFailures(chatId: string): void {
    this.resumeFailures.delete(chatId);
  }

  /** Keep only the latest `keepN` archives per session ID prefix. */
  private pruneArchives(sessionIds: string[], keepN: number): void {
    const { archiveDir } = archivePaths();
    if (!fs.existsSync(archiveDir)) return;
    for (const prefix of sessionIds) {
      try {
        const entries = fs
          .readdirSync(archiveDir)
          .filter((name) => name.startsWith(prefix + '-'))
          .sort()
          .reverse();
        for (const old of entries.slice(keepN)) {
          const fullPath = path.join(archiveDir, old);
          fs.rmSync(fullPath, { recursive: true, force: true });
          log.info('[session:prune]', old);
        }
      } catch (e) {
        log.debug('[session:prune] error', prefix, e);
      }
    }
  }
}
