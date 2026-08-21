import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../session.js';
import type { AssistantPlanEvent } from '../session.js';

type FakeEventHandler = (event: unknown) => void;
type FakeTypedHandler = (event: any) => void;

interface FakeSdkSession {
  sessionId: string;
  sendCalls: Array<Record<string, unknown>>;
  sendAndWaitCalls: Array<Record<string, unknown>>;
  truncateCalls: Array<{ eventId: string }>;
  on: (typeOrHandler: string | FakeEventHandler, maybeHandler?: FakeTypedHandler) => () => void;
  emit: (event: { type: string; id?: string; [k: string]: unknown }) => void;
  send: (opts: Record<string, unknown>) => Promise<void>;
  sendAndWait: (opts: Record<string, unknown>, timeout: number) => Promise<unknown>;
  rpc: { history: { truncate: (params: { eventId: string }) => Promise<{ eventsRemoved: number }> }; mcp: { reload: () => Promise<void> } };
}

function createTestSession() {
  const session = new Session() as any;
  session._alive = true;
  return session;
}

function createFakeSdkSession(
  impl?: (opts: Record<string, unknown>, timeout: number) => Promise<unknown>,
): FakeSdkSession {
  const handlers = new Set<FakeEventHandler>();
  const typedHandlers = new Map<string, Set<FakeTypedHandler>>();
  const truncateCalls: Array<{ eventId: string }> = [];

  return {
    sessionId: 'fake-session-id',
    sendCalls: [],
    sendAndWaitCalls: [],
    truncateCalls,
    on(typeOrHandler, maybeHandler) {
      if (typeof typeOrHandler === 'string' && maybeHandler) {
        const set = typedHandlers.get(typeOrHandler) ?? new Set<FakeTypedHandler>();
        set.add(maybeHandler);
        typedHandlers.set(typeOrHandler, set);
        return () => set.delete(maybeHandler);
      }
      const handler = typeOrHandler as FakeEventHandler;
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    emit(event) {
      for (const h of handlers) h(event);
      const set = typedHandlers.get(event.type);
      if (set) for (const h of set) h(event);
    },
    async send(opts: Record<string, unknown>) {
      this.sendCalls.push(opts);
    },
    async sendAndWait(opts: Record<string, unknown>, timeout: number) {
      this.sendAndWaitCalls.push(opts);
      return impl ? impl(opts, timeout) : { data: { content: `final:${String(opts.prompt ?? '')}` } };
    },
    rpc: {
      history: {
        async truncate(params: { eventId: string }) {
          truncateCalls.push(params);
          return { eventsRemoved: 1 };
        },
      },
      mcp: {
        async reload() {},
      },
    },
  };
}

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
});

describe('Session', () => {
  it('rejects send before the session is started', async () => {
    const session = new Session();
    await assert.rejects(() => session.send('hello'), /Session not started/);
  });

  it('reloadMcpServers waits for an in-flight send, then reloads exactly once', async () => {
    const session = createTestSession();
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let reloadCalls = 0;
    const sdk = createFakeSdkSession(async () => {
      await sendGate; // hold the send turn open so the queue is occupied
      return { data: { content: 'ok' } };
    });
    sdk.rpc.mcp.reload = async () => {
      reloadCalls++;
    };
    session.session = sdk;

    const sendPromise = session.send('hello'); // occupies the send queue
    const reloadPromise = session.reloadMcpServers(); // must queue behind the send

    await new Promise((r) => realSetTimeout(r, 10));
    assert.equal(reloadCalls, 0, 'reload must not run while a send holds the queue');

    releaseSend();
    await sendPromise;
    await reloadPromise;
    assert.equal(reloadCalls, 1, 'reload runs exactly once after the send completes');
  });

  it('reloadMcpServers rejects when the session is not started', async () => {
    const session = new Session();
    await assert.rejects(() => session.reloadMcpServers(), /Session not started/);
  });

  it('sendImmediate forwards mode=immediate and attachments to the SDK session', async () => {
    const session = createTestSession();
    const sdk = createFakeSdkSession();
    session.session = sdk;

    const attachments = [{ type: 'file', path: '/tmp/demo.txt' }];
    await session.sendImmediate('steer this turn', attachments as never);

    assert.equal(sdk.sendCalls.length, 1);
    assert.deepEqual(sdk.sendCalls[0], {
      prompt: 'steer this turn',
      mode: 'immediate',
      attachments,
    });
  });

  it('ask captures the user.message id during the turn and truncates history after sendAndWait', async () => {
    const session = createTestSession();
    let captured: FakeSdkSession | null = null;
    const sdk = createFakeSdkSession(async (opts) => {
      // Emit the user.message event mid-send — exactly when the SDK would surface it.
      captured!.emit({ type: 'user.message', id: 'evt-user-42' });
      return { data: { content: `final:${String(opts.prompt ?? '')}` } };
    });
    captured = sdk;
    session.session = sdk;

    const result = await session.ask('what time is it?');

    assert.equal(result.content, 'final:what time is it?');
    assert.equal(sdk.sendAndWaitCalls.length, 1);
    assert.deepEqual(sdk.truncateCalls, [{ eventId: 'evt-user-42' }]);
  });

  it('ask captures only the first user.message id if multiple fire', async () => {
    const session = createTestSession();
    let captured: FakeSdkSession | null = null;
    const sdk = createFakeSdkSession(async () => {
      captured!.emit({ type: 'user.message', id: 'first-id' });
      captured!.emit({ type: 'user.message', id: 'second-id' });
      return { data: { content: 'ok' } };
    });
    captured = sdk;
    session.session = sdk;

    await session.ask('q');

    assert.deepEqual(sdk.truncateCalls, [{ eventId: 'first-id' }]);
  });

  it('ask still truncates if sendAndWait throws after user.message was captured', async () => {
    const session = createTestSession();
    let captured: FakeSdkSession | null = null;
    const sdk = createFakeSdkSession(async () => {
      captured!.emit({ type: 'user.message', id: 'evt-user-99' });
      throw new Error('boom');
    });
    captured = sdk;
    session.session = sdk;

    await assert.rejects(() => session.ask('q'), /boom/);
    assert.deepEqual(sdk.truncateCalls, [{ eventId: 'evt-user-99' }]);
  });

  it('ask does not truncate when no user.message event fires (e.g. early failure)', async () => {
    const session = createTestSession();
    const sdk = createFakeSdkSession(async () => {
      throw new Error('early failure');
    });
    session.session = sdk;

    await assert.rejects(() => session.ask('q'), /early failure/);
    assert.deepEqual(sdk.truncateCalls, []);
  });

  it('ask swallows truncate errors so the user still gets the answer', async () => {
    const session = createTestSession();
    let captured: FakeSdkSession | null = null;
    const sdk = createFakeSdkSession(async () => {
      captured!.emit({ type: 'user.message', id: 'evt-user-7' });
      return { data: { content: 'answer' } };
    });
    captured = sdk;
    sdk.rpc.history.truncate = async () => {
      throw new Error('truncate exploded');
    };
    session.session = sdk;

    const result = await session.ask('q');
    assert.equal(result.content, 'answer');
  });

  it('send without askMode never touches truncate', async () => {
    const session = createTestSession();
    let captured: FakeSdkSession | null = null;
    const sdk = createFakeSdkSession(async () => {
      captured!.emit({ type: 'user.message', id: 'should-not-be-used' });
      return { data: { content: 'ok' } };
    });
    captured = sdk;
    session.session = sdk;

    await session.send('hello');
    assert.deepEqual(sdk.truncateCalls, []);
  });

  it('serializes queued sends and isolates streamed events by reserved turn', async () => {
    const session = createTestSession();
    let releaseFirst: (() => void) | undefined;

    const sdk = createFakeSdkSession(async (opts) => {
      const prompt = String(opts.prompt ?? '');
      const turnId = prompt === 'first' ? 'turn-1' : 'turn-2';
      session.handleEvent({ type: 'assistant.turn_start', data: { turnId } } as any);
      session.handleEvent({ type: 'assistant.reasoning_delta', data: { deltaContent: `${prompt}-thinking` } } as any);
      session.handleEvent({ type: 'assistant.message_delta', data: { deltaContent: `${prompt}-delta` } } as any);

      if (prompt === 'first') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }

      session.handleEvent({ type: 'assistant.turn_end', data: { turnId } } as any);

      return { data: { content: `${prompt}-final` } };
    });

    session.session = sdk;
    session.messageMode = 'enqueue';

    const firstReservation = session.reserveTurn();
    const secondReservation = session.reserveTurn();
    const firstThinking: string[] = [];
    const secondThinking: string[] = [];

    session.on('thinking_event', (event: { turnId: string | null; text: string }) => {
      if (event.turnId === firstReservation.currentTurnId) firstThinking.push(event.text);
      if (event.turnId === secondReservation.currentTurnId) secondThinking.push(event.text);
    });

    const first = session.send('first', undefined, firstReservation);
    const second = session.send('second', undefined, secondReservation);

    await new Promise<void>((resolve) => setImmediate(resolve));

    // Only the active turn should be running; queued sends wait their turn in the wrapper.
    assert.equal(sdk.sendAndWaitCalls.length, 1);
    assert.equal(sdk.sendAndWaitCalls[0]?.prompt, 'first');

    releaseFirst?.();

    await new Promise<void>((resolve) => setImmediate(resolve));

    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.deepEqual(
      sdk.sendAndWaitCalls.map((call) => call.prompt),
      ['first', 'second'],
    );
    assert.equal(firstResult.content, 'first-delta');
    assert.equal(secondResult.content, 'second-delta');
    assert.deepEqual(firstThinking, ['first-thinking']);
    assert.deepEqual(secondThinking, ['second-thinking']);
  });

  it('falls back to final SDK content when no delta events were streamed', async () => {
    const session = createTestSession();
    const sdk = createFakeSdkSession(async (opts) => ({
      data: { content: `final:${String(opts.prompt ?? '')}` },
    }));
    session.session = sdk;
    session.messageMode = 'enqueue';

    const result = await session.send('no delta path');

    assert.equal(result.content, 'final:no delta path');
    assert.equal(sdk.sendAndWaitCalls[0]?.mode, 'enqueue');
  });

  it('emits permission_request and resolves approval when approve() is called', async () => {
    const session = new Session() as any;
    const seen: unknown[] = [];
    session.on('permission_request', (req: unknown) => {
      seen.push(req);
      queueMicrotask(() => session.approve());
    });

    const result = await session.handlePermission({ kind: 'shell' });

    assert.equal(seen.length, 1);
    assert.equal((result as { kind: string }).kind, 'approve-once');
  });

  it('emits permission_request and resolves denial when deny() is called', async () => {
    const session = new Session() as any;
    session.on('permission_request', () => {
      queueMicrotask(() => session.deny());
    });

    const result = await session.handlePermission({ kind: 'write' });

    assert.equal((result as { kind: string }).kind, 'reject');
  });

  it('emits permission_timeout and denies when approval expires', async () => {
    const session = new Session() as any;
    const events: string[] = [];
    let timerCallback: (() => void) | undefined;

    globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
      timerCallback = () => callback();
      return { mocked: true } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => undefined) as typeof clearTimeout;

    session.on('permission_request', () => {
      events.push('request');
    });
    session.on('permission_timeout', () => {
      events.push('timeout');
    });

    const pending = session.handlePermission({ kind: 'shell' });
    assert.deepEqual(events, ['request']);

    timerCallback?.();

    const result = await pending;
    assert.deepEqual(events, ['request', 'timeout']);
    assert.equal((result as { kind: string }).kind, 'user-not-available');
  });

  it('buildConfig pre-tool hook emits telemetry without overriding permissions', async () => {
    const session = new Session() as any;
    session.cwd = '/tmp/project';

    const seen: Array<Record<string, unknown>> = [];
    session.on('hook:pre_tool', (payload: unknown) => {
      seen.push(payload as Record<string, unknown>);
    });

    const config = session.buildConfig({ cwd: '/tmp/project', autopilot: false, messageMode: 'enqueue' }) as {
      hooks?: {
        onPreToolUse?: (input: { toolName?: string; arguments?: unknown }) => Promise<unknown>;
      };
    };

    const result = await config.hooks?.onPreToolUse?.({ toolName: 'bash', arguments: { command: 'ls' } });

    assert.equal(result, undefined);
    assert.deepEqual(seen, [{ toolName: 'bash', arguments: { command: 'ls' } }]);
  });

  it('maps tool.execution_complete events and extracts image payloads', () => {
    const session = new Session() as any;
    let toolEvent: Record<string, unknown> | undefined;

    session.on('tool_complete', (event: unknown) => {
      toolEvent = event as Record<string, unknown>;
    });

    // Register the tool name via execution_start so execution_complete can look it up
    session.handleEvent({
      type: 'tool.execution_start',
      data: { toolCallId: 'call-1', toolName: 'generate_image', arguments: {} },
    } as any);

    session.handleEvent({
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'call-1',
        success: true,
        result: {
          content: 'done',
          detailedContent: 'done',
          contents: [
            { type: 'image', data: 'base64-image-1', mimeType: 'image/png' },
            { type: 'text', text: 'ignored' },
            { type: 'image', data: 'base64-image-2', mimeType: 'image/png' },
          ],
        },
      },
    } as any);

    assert.deepEqual(toolEvent, {
      turnId: null,
      toolCallId: 'call-1',
      toolName: 'generate_image',
      success: true,
      detailedContent: 'done',
      images: ['base64-image-1', 'base64-image-2'],
    });
  });

  it('maps tool.execution_partial_result events to tool_output with toolName from start event', () => {
    const session = new Session() as any;
    let outputEvent: Record<string, unknown> | undefined;

    session.on('tool_output', (event: unknown) => {
      outputEvent = event as Record<string, unknown>;
    });

    session.handleEvent({
      type: 'tool.execution_start',
      data: { toolCallId: 'call-9', toolName: 'shell', arguments: {} },
    } as any);

    session.handleEvent({
      type: 'tool.execution_partial_result',
      data: { toolCallId: 'call-9', partialOutput: 'hello world' },
    } as any);

    assert.deepEqual(outputEvent, {
      turnId: null,
      toolCallId: 'call-9',
      toolName: 'shell',
      content: 'hello world',
    });
  });

  it('emits richer planning metadata from assistant.message events', () => {
    const session = new Session() as any;
    let planEvent: AssistantPlanEvent | undefined;
    let thinkingSummary: { turnId: string | null; text: string } | undefined;

    session.activeTurnId = 'turn-7';
    session.on('assistant_plan', (event: AssistantPlanEvent) => {
      planEvent = event;
    });
    session.on('thinking_summary', (event: { turnId: string | null; text: string }) => {
      thinkingSummary = event;
    });

    session.handleEvent({
      type: 'assistant.message',
      data: {
        content: '',
        reasoningText: 'Use the code-review agent for this repo audit.',
        toolRequests: [
          {
            toolCallId: 'call-1',
            name: 'report_intent',
            arguments: { intent: 'Reviewing code changes' },
            type: 'function',
          },
          { toolCallId: 'call-2', name: 'task', arguments: { agent_type: 'code-review' }, type: 'function' },
        ],
      },
    } as any);

    assert.deepEqual(thinkingSummary, {
      turnId: 'turn-7',
      text: 'Use the code-review agent for this repo audit.',
    });
    assert.deepEqual(planEvent, {
      turnId: 'turn-7',
      content: undefined,
      reasoningText: 'Use the code-review agent for this repo audit.',
      toolRequests: [
        {
          toolCallId: 'call-1',
          name: 'report_intent',
          arguments: { intent: 'Reviewing code changes' },
          type: 'function',
        },
        { toolCallId: 'call-2', name: 'task', arguments: { agent_type: 'code-review' }, type: 'function' },
      ],
    });
  });

  it('emits thinking summaries from assistant.reasoning events', () => {
    const session = new Session() as any;
    let thinkingSummary: { turnId: string | null; text: string } | undefined;

    session.activeTurnId = 'turn-9';
    session.on('thinking_summary', (event: { turnId: string | null; text: string }) => {
      thinkingSummary = event;
    });

    session.handleEvent({
      type: 'assistant.reasoning',
      data: { content: 'First, inspect the repository state.' },
    } as any);

    assert.deepEqual(thinkingSummary, {
      turnId: 'turn-9',
      text: 'First, inspect the repository state.',
    });
  });

  it('tracks all turns started during a single send on the active reservation', async () => {
    const session = createTestSession();
    const sdk = createFakeSdkSession(async () => {
      session.handleEvent({ type: 'assistant.turn_start', data: { turnId: 'turn-1' } } as any);
      session.handleEvent({ type: 'assistant.message_delta', data: { deltaContent: 'hello ' } } as any);
      session.handleEvent({ type: 'assistant.turn_end', data: { turnId: 'turn-1' } } as any);
      session.handleEvent({ type: 'assistant.turn_start', data: { turnId: 'turn-2' } } as any);
      session.handleEvent({ type: 'assistant.message_delta', data: { deltaContent: 'world' } } as any);
      session.handleEvent({ type: 'assistant.turn_end', data: { turnId: 'turn-2' } } as any);
      return { data: { content: 'hello world' } };
    });
    session.session = sdk;
    session.messageMode = 'enqueue';

    const reservation = session.reserveTurn();
    const result = await session.send('multi-turn', undefined, reservation);

    assert.equal(result.content, 'hello world');
    assert.deepEqual([...reservation.ownedTurnIds], ['turn-1', 'turn-2']);
    assert.equal(reservation.currentTurnId, 'turn-2');
  });

  it('emits subagent start events with metadata', () => {
    const session = new Session() as any;
    let subagentEvent: Record<string, unknown> | undefined;

    session.activeTurnId = 'turn-12';
    session.on('subagent_start', (event: unknown) => {
      subagentEvent = event as Record<string, unknown>;
    });

    session.handleEvent({
      type: 'subagent.started',
      data: {
        toolCallId: 'tool-call-9',
        agentName: 'code-review',
        agentDisplayName: 'Code Review Agent',
        agentDescription: 'Reviews code changes.',
      },
    } as any);

    assert.deepEqual(subagentEvent, {
      turnId: 'turn-12',
      toolCallId: 'tool-call-9',
      agentName: 'code-review',
      agentDisplayName: 'Code Review Agent',
      agentDescription: 'Reviews code changes.',
    });
  });

  it('prewarmSharedClient delegates to the shared client bootstrap path', async () => {
    const originalGetSharedClient = (Session as any).getSharedClient;
    const seen: Array<Record<string, unknown> | undefined> = [];

    (Session as any).getSharedClient = async (opts?: Record<string, unknown>, retain?: boolean) => {
      seen.push({ ...(opts ?? {}), retain });
      return {};
    };

    try {
      await Session.prewarmSharedClient({ binary: 'copilot', githubToken: 'token-123' });
    } finally {
      (Session as any).getSharedClient = originalGetSharedClient;
    }

    assert.deepEqual(seen, [{ binary: 'copilot', githubToken: 'token-123', retain: false }]);
  });

  it('builds external-server client options when cliUrl is provided', () => {
    const clientOpts = (Session as any).buildSharedClientOptions({
      binary: 'copilot',
      cliUrl: 'http://127.0.0.1:4141',
      githubToken: 'token-123',
    });

    assert.deepEqual(clientOpts, {
      connection: { kind: 'uri', url: 'http://127.0.0.1:4141', connectionToken: undefined },
    });
  });

  it('disables logged-in user auth when a BYOK provider is configured', () => {
    const clientOpts = (Session as any).buildSharedClientOptions({
      binary: 'copilot',
      githubToken: 'token-123',
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      },
    });

    assert.deepEqual(clientOpts, {
      connection: { kind: 'stdio', path: 'copilot', args: undefined, env: undefined },
      useLoggedInUser: false,
    });
  });

  it('promptContextProvider inserts context AFTER the <sender> envelope', async () => {
    // Regression: the hook prepended provider stdout blindly
    // (`${ctx}\n\n${prompt}`), pushing <sender> off line 1 so the actor parsed
    // as `unknown`. Live 2026-06-24 (07815e0) → 2026-08-17.
    // `/bin/echo` is invoked with the session id as argv, so stdout == sessionId.
    const session = new Session() as any;
    session.cwd = '/tmp/project';

    const config = session.buildConfig({
      cwd: '/tmp/project',
      promptContextProvider: { command: '/bin/echo', timeoutMs: 5000 },
    });

    const result = await config.hooks.onUserPromptSubmitted(
      { prompt: '<sender>880903035</sender>\nSelling watch on fb' },
      { sessionId: 'INJECTED-CONTEXT' },
    );

    assert.equal(
      result.modifiedPrompt,
      '<sender>880903035</sender>\nINJECTED-CONTEXT\n\nSelling watch on fb',
    );
    assert.ok(
      result.modifiedPrompt.startsWith('<sender>880903035</sender>\n'),
      'envelope must remain on line 1 or the actor parses as unknown',
    );
  });

  it('root abort clears busy; sub-agent abort does not', () => {
    // An aborted turn terminates with `abort`, NOT `assistant.turn_end`. Before this was
    // handled, `busy` stayed true forever and (in immediate mode) every later message was
    // swallowed as steering for a turn that never ended — the 2026-08-21 2h wedge.
    const session = new Session() as any;

    session.handleEvent({ type: 'assistant.turn_start', data: { turnId: 'a1' } } as any);
    assert.equal(session.busy, true, 'turn_start should mark the session busy');

    // Sub-agent aborts carry an agentId and must NOT end the root turn.
    session.handleEvent({ type: 'abort', agentId: 'sub-7', data: { reason: 'user_initiated' } } as any);
    assert.equal(session.busy, true, 'sub-agent abort must not clear the root turn');

    // Root abort has no agentId.
    session.handleEvent({ type: 'abort', data: { reason: 'user_initiated' } } as any);
    assert.equal(session.busy, false, 'root abort must clear busy');
    assert.equal(session.activeTurnId, null, 'root abort must clear the active turn id');
  });

  it('aborted root idle also clears busy (no preceding abort event)', () => {
    // The CLI can report a cancelled loop via session.idle{aborted:true} without a root
    // `abort` first. That is equally terminal — if busy stays true, immediate-mode
    // messages keep being swallowed as steering for a turn that already ended.
    const session = new Session() as any;
    session.handleEvent({ type: 'assistant.turn_start', data: { turnId: 'a1' } } as any);

    session.handleEvent({ type: 'session.idle', agentId: 'sub-3', data: { aborted: true } } as any);
    assert.equal(session.busy, true, 'sub-agent idle must not clear the root turn');

    session.handleEvent({ type: 'session.idle', data: { aborted: true } } as any);
    assert.equal(session.busy, false, 'aborted root idle must clear busy');
  });

  it('abort() surfaces a soft RPC refusal instead of reporting success', async () => {
    // The SDK helper `session.abort()` discards the RPC result, so {success:false}
    // looked like success and left the turn running. We call the typed RPC directly.
    const session = new Session() as any;

    session.session = { rpc: { abort: async () => ({ success: true }) } };
    assert.equal(await session.abort(), true, 'clean abort reports true');

    session.session = { rpc: { abort: async () => ({ success: false }) } };
    assert.equal(await session.abort(), false, 'declined abort must not report success');

    session.session = { rpc: { abort: async () => ({ success: false, error: 'runtime refused' }) } };
    await assert.rejects(() => session.abort(), /runtime refused/, 'error must propagate');
  });

  it('abort during background-followup capture releases the wait immediately', async () => {
    // Regression: waits of 8s/180s (capped by turnTimeoutMs) held the send queue after an
    // abort, so /abort confirmed "stopped" while the next message still queued behind it.
    const session = new Session() as any;
    const bg = {
      aborted: false,
      completions: 1,
      idles: 0,
      turnStarts: 0,
      capturing: false,
      followupId: null,
      followupContent: '',
      wake: null as (() => void) | null,
    };

    const started = Date.now();
    const pending = session.captureBackgroundFollowups(bg, Date.now());
    // Abort mid-wait, exactly as the raw SDK listener does on a root abort.
    setTimeout(() => {
      bg.aborted = true;
      bg.wake?.();
    }, 20);

    const result = await pending;
    const elapsed = Date.now() - started;
    assert.equal(result, null, 'no synthesis is produced for an aborted turn');
    assert.ok(elapsed < 2000, `capture must exit promptly on abort, took ${elapsed}ms`);
  });

  it('includes a custom sessionId in the SDK session config', () => {
    const session = new Session() as any;
    session.cwd = '/tmp/project';

    const config = session.buildConfig({
      cwd: '/tmp/project',
      sessionId: 'telegram--100123-thread-42',
      autopilot: false,
    });

    assert.equal(config.sessionId, 'telegram--100123-thread-42');
  });

  it('passes provider config through to the SDK session config', () => {
    const session = new Session() as any;
    session.cwd = '/tmp/project';

    const config = session.buildConfig({
      cwd: '/tmp/project',
      model: 'gpt-4.1-mini',
      provider: {
        type: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        wireApi: 'responses',
      },
    });

    assert.deepEqual(config.provider, {
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      wireApi: 'responses',
    });
  });

  it('passes contextTier through to the SDK session config, including "default"', () => {
    const session = new Session() as any;
    session.cwd = '/tmp/project';
    // Explicit "default" must be sent (not omitted) so resume reverts a journaled long_context tier.
    assert.equal(session.buildConfig({ cwd: '/tmp/project', contextTier: 'default' }).contextTier, 'default');
    assert.equal(
      session.buildConfig({ cwd: '/tmp/project', contextTier: 'long_context' }).contextTier,
      'long_context',
    );
  });

  it('deletePersistedSession uses the shared client without retaining it', async () => {
    const originalGetSharedClient = (Session as any).getSharedClient;
    const deleted: string[] = [];

    (Session as any).getSharedClient = async (_opts?: Record<string, unknown>, retain?: boolean) => {
      assert.equal(retain, false);
      return {
        async deleteSession(sessionId: string) {
          deleted.push(sessionId);
        },
      };
    };

    try {
      await Session.deletePersistedSession('telegram--100123-thread-42', { binary: 'copilot' });
    } finally {
      (Session as any).getSharedClient = originalGetSharedClient;
    }

    assert.deepEqual(deleted, ['telegram--100123-thread-42']);
  });

  it('resetSharedClient stops and clears the shared client state', async () => {
    const originalSharedClient = (Session as any).sharedClient;
    const originalSharedClientStarting = (Session as any).sharedClientStarting;
    const originalSharedClientSignature = (Session as any).sharedClientSignature;
    const originalClientRefCount = (Session as any).clientRefCount;
    let stopCalls = 0;
    let forceStopCalls = 0;

    (Session as any).sharedClient = {
      async stop() {
        stopCalls++;
        return [];
      },
      async forceStop() {
        forceStopCalls++;
      },
    };
    (Session as any).sharedClientStarting = Promise.resolve();
    (Session as any).sharedClientSignature = 'sig';
    (Session as any).clientRefCount = 3;

    try {
      await Session.resetSharedClient('test-reset');
    } finally {
      (Session as any).sharedClient = originalSharedClient;
      (Session as any).sharedClientStarting = originalSharedClientStarting;
      (Session as any).sharedClientSignature = originalSharedClientSignature;
      (Session as any).clientRefCount = originalClientRefCount;
    }

    assert.equal(stopCalls, 1);
    assert.equal(forceStopCalls, 0);
    assert.equal((Session as any).sharedClient, originalSharedClient);
    assert.equal((Session as any).sharedClientSignature, originalSharedClientSignature);
    assert.equal((Session as any).clientRefCount, originalClientRefCount);
  });

  it('resetSharedClient force stops when graceful stop fails', async () => {
    const originalSharedClient = (Session as any).sharedClient;
    const originalSharedClientStarting = (Session as any).sharedClientStarting;
    const originalSharedClientSignature = (Session as any).sharedClientSignature;
    const originalClientRefCount = (Session as any).clientRefCount;
    let forceStopCalls = 0;

    (Session as any).sharedClient = {
      async stop() {
        throw new Error('boom');
      },
      async forceStop() {
        forceStopCalls++;
      },
    };
    (Session as any).sharedClientStarting = null;
    (Session as any).sharedClientSignature = 'sig';
    (Session as any).clientRefCount = 2;

    try {
      await Session.resetSharedClient('test-force-reset');
    } finally {
      (Session as any).sharedClient = originalSharedClient;
      (Session as any).sharedClientStarting = originalSharedClientStarting;
      (Session as any).sharedClientSignature = originalSharedClientSignature;
      (Session as any).clientRefCount = originalClientRefCount;
    }

    assert.equal(forceStopCalls, 1);
    assert.equal((Session as any).sharedClient, originalSharedClient);
    assert.equal((Session as any).sharedClientSignature, originalSharedClientSignature);
    assert.equal((Session as any).clientRefCount, originalClientRefCount);
  });
});
