import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { TelegramClient, withAbortTimeout } from '../telegram.js';

const TEST_BOT_INFO: UserFromGetMe = {
  id: 999999,
  is_bot: true,
  first_name: 'Test Bot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: true,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: true,
  allows_users_to_create_topics: true,
};

type ApiCall = {
  method: string;
  payload: Record<string, unknown>;
};

type ApiResponder = (
  method: string,
  payload: Record<string, unknown>,
) => unknown | undefined | Promise<unknown | undefined>;

function getBot(client: TelegramClient): Bot {
  return (client as unknown as { bot: Bot }).bot;
}

async function createTelegramHarness(
  client: TelegramClient,
  responder?: ApiResponder,
): Promise<{ bot: Bot; calls: ApiCall[] }> {
  const bot = getBot(client);
  const calls: ApiCall[] = [];
  bot.botInfo = TEST_BOT_INFO;

  bot.api.config.use(async (_prev, method, payload) => {
    const normalizedPayload = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: normalizedPayload });

    const override = await responder?.(method, normalizedPayload);
    if (override !== undefined) {
      return override as ReturnType<typeof _prev>;
    }

    switch (method) {
      case 'sendMessage':
      case 'editMessageText':
        return Promise.resolve({
          ok: true,
          result: {
            message_id: Number(normalizedPayload.message_id ?? 1),
            date: 1,
            chat: {
              id: Number(normalizedPayload.chat_id ?? 1),
              type: 'private',
              first_name: 'Test',
            },
            text: String(normalizedPayload.text ?? ''),
          },
        }) as ReturnType<typeof _prev>;
      case 'answerCallbackQuery':
      case 'sendChatAction':
      case 'setMessageReaction':
        return Promise.resolve({ ok: true, result: true }) as ReturnType<typeof _prev>;
      default:
        return Promise.resolve({ ok: true, result: true }) as ReturnType<typeof _prev>;
    }
  });
  return { bot, calls };
}

function makeTextUpdate(args: {
  messageId: number;
  chatId: number;
  fromId: number;
  text: string;
  threadId?: number;
  replyToMessageId?: number;
  replyText?: string;
}): Update {
  return {
    update_id: 1,
    message: {
      message_id: args.messageId,
      date: 1,
      chat: {
        id: args.chatId,
        type: args.threadId ? 'supergroup' : 'private',
        ...(args.threadId ? { title: 'Debug Topic' } : { first_name: 'Tester' }),
      },
      from: {
        id: args.fromId,
        is_bot: false,
        first_name: 'Tester',
      },
      text: args.text,
      ...(args.threadId ? { message_thread_id: args.threadId, is_topic_message: true } : {}),
      ...(args.replyToMessageId
        ? {
            reply_to_message: {
              message_id: args.replyToMessageId,
              date: 1,
              chat: {
                id: args.chatId,
                type: args.threadId ? 'supergroup' : 'private',
                ...(args.threadId ? { title: 'Debug Topic' } : { first_name: 'Tester' }),
              },
              from: {
                id: args.fromId,
                is_bot: false,
                first_name: 'Tester',
              },
              text: args.replyText ?? 'quoted message',
            },
          }
        : {}),
    },
  } as unknown as Update;
}

function makeCallbackUpdate(args: {
  chatId: number;
  fromId: number;
  messageId: number;
  data: string;
  threadId?: number;
}): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'callback-1',
      chat_instance: 'chat-instance-1',
      from: {
        id: args.fromId,
        is_bot: false,
        first_name: 'Tester',
      },
      data: args.data,
      message: {
        message_id: args.messageId,
        date: 1,
        chat: {
          id: args.chatId,
          type: args.threadId ? 'supergroup' : 'private',
          ...(args.threadId ? { title: 'Debug Topic' } : { first_name: 'Tester' }),
        },
        from: {
          id: TEST_BOT_INFO.id,
          is_bot: true,
          first_name: TEST_BOT_INFO.first_name,
          username: TEST_BOT_INFO.username,
        },
        text: 'button message',
        ...(args.threadId ? { message_thread_id: args.threadId, is_topic_message: true } : {}),
      },
    },
  } as unknown as Update;
}

describe('TelegramClient.sendDraft', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('attempts draft streaming for topic/supergroup chats', async () => {
    const calls: Array<{ url: string; body: string | undefined }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : undefined,
      });

      return {
        json: async () => ({ ok: true }),
      } as Response;
    }) as typeof fetch;

    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });

    const ok = await client.sendDraft('-1001234567890', 42, 'hello topic drafts', {
      threadId: 99,
      replyTo: 7,
    });

    assert.equal(ok, 'ok');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /sendMessageDraft$/);

    const payload = JSON.parse(calls[0].body ?? '{}') as {
      chat_id?: string;
      draft_id?: number;
      text?: string;
      message_thread_id?: number;
      reply_parameters?: { message_id?: number; allow_sending_without_reply?: boolean };
    };

    assert.equal(payload.chat_id, '-1001234567890');
    assert.equal(payload.draft_id, 42);
    assert.equal(payload.message_thread_id, 99);
    assert.deepEqual(payload.reply_parameters, { message_id: 7, allow_sending_without_reply: true });
    assert.equal(typeof payload.text, 'string');
    assert.ok((payload.text ?? '').includes('hello topic drafts'));
  });
});

describe('TelegramClient grammY-style adapter tests', () => {
  it('falls back to plain text when sendMessage HTML rendering fails', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    const { calls } = await createTelegramHarness(client, (method, payload) => {
      if (method === 'sendMessage' && payload.parse_mode === 'HTML') {
        throw new Error('HTML exploded');
      }
      return undefined;
    });

    const messageId = await client.sendMessage('123', '**bold**');

    assert.equal(messageId, 1);
    const sendCalls = calls.filter((call) => call.method === 'sendMessage');
    assert.equal(sendCalls.length, 2);
    assert.equal(sendCalls[0]?.payload.parse_mode, 'HTML');
    assert.equal(sendCalls[1]?.payload.parse_mode, undefined);
    assert.equal(sendCalls[1]?.payload.text, 'bold');
  });

  it('falls back to plain text when editMessage HTML rendering fails', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    const { calls } = await createTelegramHarness(client, (method, payload) => {
      if (method === 'editMessageText' && payload.parse_mode === 'HTML') {
        throw new Error('HTML exploded');
      }
      return undefined;
    });

    await client.editMessage('123', 7, '**bold**');

    const editCalls = calls.filter((call) => call.method === 'editMessageText');
    assert.equal(editCalls.length, 2);
    assert.equal(editCalls[0]?.payload.parse_mode, 'HTML');
    assert.equal(editCalls[1]?.payload.parse_mode, undefined);
    assert.equal(editCalls[1]?.payload.text, 'bold');
  });

  it('maps a real text update into onMessage callback arguments', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['1'],
    });
    const { bot } = await createTelegramHarness(client);

    let seen:
      | {
          text: string;
          chatId: string;
          msgId: number;
          replyText: string | undefined;
          replyToMsgId: number | undefined;
          threadId: number | undefined;
        }
      | undefined;

    client.onMessage = async (text, chatId, msgId, replyText, replyToMsgId, threadId) => {
      seen = { text, chatId, msgId, replyText, replyToMsgId, threadId };
    };

    await bot.handleUpdate(
      makeTextUpdate({
        messageId: 10,
        chatId: 123,
        fromId: 1,
        text: 'hello from grammY',
        threadId: 77,
        replyToMessageId: 9,
        replyText: 'older message',
      }),
    );

    assert.deepEqual(seen, {
      text: '<sender>1</sender>\nhello from grammY',
      chatId: '123',
      msgId: 10,
      replyText: 'older message',
      replyToMsgId: 9,
      threadId: 77,
    });
  });

  it('maps a callback query update and auto-answers the callback', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['1'],
    });
    const { bot, calls } = await createTelegramHarness(client);

    let seen:
      | {
          callbackId: string;
          data: string;
          chatId: string;
          msgId: number;
          threadId: number | undefined;
        }
      | undefined;

    client.onCallback = async (callbackId, data, chatId, msgId, threadId) => {
      seen = { callbackId, data, chatId, msgId, threadId };
    };

    await bot.handleUpdate(
      makeCallbackUpdate({
        chatId: 123,
        fromId: 1,
        messageId: 42,
        data: 'agent:notes',
        threadId: 77,
      }),
    );

    assert.deepEqual(seen, {
      callbackId: 'callback-1',
      data: 'agent:notes',
      chatId: '123',
      msgId: 42,
      threadId: 77,
    });
    assert.ok(calls.some((call) => call.method === 'answerCallbackQuery'));
  });

  it('uses mapped thread fallback for callback queries with inaccessible messages', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['1'],
    });
    const { bot } = await createTelegramHarness(client);

    const messageId = await client.sendButtons(
      '123',
      'Choose an agent',
      [[{ text: 'Notes', data: 'agent:notes' }]],
      77,
    );

    let seenThreadId: number | undefined;
    client.onCallback = async (_callbackId, _data, _chatId, _msgId, threadId) => {
      seenThreadId = threadId;
    };

    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'callback-2',
        chat_instance: 'chat-instance-2',
        from: {
          id: 1,
          is_bot: false,
          first_name: 'Tester',
        },
        data: 'agent:notes',
        message: {
          message_id: messageId ?? 1,
          date: 0,
          chat: {
            id: 123,
            type: 'supergroup',
            title: 'Debug Topic',
          },
        },
      },
    } as unknown as Update);

    assert.equal(seenThreadId, 77);
  });

  it('captures outbound sendButtons payloads through grammY api interception', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    const { calls } = await createTelegramHarness(client);

    const messageId = await client.sendButtons(
      '123',
      'Choose an agent',
      [[{ text: 'Notes', data: 'agent:notes' }]],
      77,
    );

    assert.equal(messageId, 1);

    const sendMessageCall = calls.find((call) => call.method === 'sendMessage');
    assert.ok(sendMessageCall);
    assert.equal(sendMessageCall?.payload.chat_id, '123');
    assert.equal(sendMessageCall?.payload.message_thread_id, 77);
    assert.equal(sendMessageCall?.payload.text, 'Choose an agent');
    assert.deepEqual(sendMessageCall?.payload.reply_markup, {
      inline_keyboard: [[{ text: 'Notes', callback_data: 'agent:notes' }]],
    });
  });

  it('does not leak client-only button styles into Telegram inline keyboard payloads', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    const { calls } = await createTelegramHarness(client);

    await client.sendButtons('123', 'Approve this?', [[{ text: 'Approve', data: 'perm:yes', style: 'success' }]], 77);

    const sendMessageCall = calls.find((call) => call.method === 'sendMessage');
    assert.ok(sendMessageCall);
    assert.deepEqual(sendMessageCall?.payload.reply_markup, {
      inline_keyboard: [[{ text: 'Approve', callback_data: 'perm:yes' }]],
    });
  });
});

describe('TelegramClient draft failure handling', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('disables sendDraft only for the failing chat', async () => {
    const calls: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return {
        json: async () => ({ ok: false, description: 'unknown method' }),
      } as Response;
    }) as typeof fetch;

    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });

    const first = await client.sendDraft('chat-1', 1, 'hello');
    const secondSameChat = await client.sendDraft('chat-1', 2, 'hello again');
    const otherChat = await client.sendDraft('chat-2', 3, 'hello other chat');

    assert.equal(first, 'permanent');
    assert.equal(secondSameChat, 'permanent');
    assert.equal(otherChat, 'permanent');
    assert.equal(calls.length, 2);
  });
});

describe('TelegramClient access control', () => {
  function makeBotUpdate(args: { messageId: number; chatId: number; fromId: number; text: string }): Update {
    return {
      update_id: 99,
      message: {
        message_id: args.messageId,
        date: 1,
        chat: { id: args.chatId, type: 'private', first_name: 'BotChat' },
        from: { id: args.fromId, is_bot: true, first_name: 'EvilBot', username: 'evil_bot' },
        text: args.text,
      },
    } as unknown as Update;
  }

  it('accepts messages from any user in allowedUsers (multi-user)', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111', '222'],
    });
    const { bot } = await createTelegramHarness(client);

    const seen: string[] = [];
    client.onMessage = async (text) => {
      seen.push(text);
    };

    await bot.handleUpdate(makeTextUpdate({ messageId: 1, chatId: 111, fromId: 111, text: 'from user 111' }));
    await bot.handleUpdate(makeTextUpdate({ messageId: 2, chatId: 222, fromId: 222, text: 'from user 222' }));

    assert.deepEqual(seen, ['<sender>111</sender>\nfrom user 111', '<sender>222</sender>\nfrom user 222']);
  });

  it('accepts messages from an allowed user across any chat context (no chat scoping)', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111'],
    });
    const { bot } = await createTelegramHarness(client);

    const seen: string[] = [];
    client.onMessage = async (text) => {
      seen.push(text);
    };

    // Same allowed user (fromId=111) messaging from three distinct chat contexts:
    //   - their own private DM (chatId matches userId)
    //   - a private chat with a different chatId (shouldn't happen in practice, but proves no chat-scoping)
    //   - a supergroup forum topic
    await bot.handleUpdate(makeTextUpdate({ messageId: 1, chatId: 111, fromId: 111, text: 'dm' }));
    await bot.handleUpdate(makeTextUpdate({ messageId: 2, chatId: 999, fromId: 111, text: 'other-chat' }));
    await bot.handleUpdate(
      makeTextUpdate({ messageId: 3, chatId: -1001234567890, fromId: 111, threadId: 42, text: 'topic' }),
    );

    assert.deepEqual(seen, [
      '<sender>111</sender>\ndm',
      '<sender>111</sender>\nother-chat',
      '<sender>111</sender>\ntopic',
    ]);
  });

  it('rejects messages from users not in allowedUsers', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111'],
      denialReplyJitterMs: [0, 0],
    });
    const { bot, calls } = await createTelegramHarness(client);

    let invoked = 0;
    client.onMessage = async () => {
      invoked++;
    };

    await bot.handleUpdate(makeTextUpdate({ messageId: 1, chatId: 999, fromId: 999, text: 'intruder' }));

    assert.equal(invoked, 0);
    const denials = calls.filter(
      (c) => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Not authorized'),
    );
    assert.equal(denials.length, 1, 'should send one denial reply');
    assert.ok(!String(denials[0].payload.text).includes('paired'), 'denial reply must not leak pairing details');
  });

  it('rate-limits denial replies to one per user per minute', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111'],
      denialReplyJitterMs: [0, 0],
    });
    const { bot, calls } = await createTelegramHarness(client);

    await bot.handleUpdate(makeTextUpdate({ messageId: 1, chatId: 999, fromId: 999, text: 'first' }));
    await bot.handleUpdate(makeTextUpdate({ messageId: 2, chatId: 999, fromId: 999, text: 'second' }));
    await bot.handleUpdate(makeTextUpdate({ messageId: 3, chatId: 999, fromId: 999, text: 'third' }));

    const denials = calls.filter(
      (c) => c.method === 'sendMessage' && String(c.payload.text ?? '').includes('Not authorized'),
    );
    assert.equal(denials.length, 1, 'should send only one denial across rapid repeated denials');
  });

  it('denies all messages when allowedUsers is empty (no auto-pair by default)', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    const { bot } = await createTelegramHarness(client);

    let invoked = 0;
    client.onMessage = async () => {
      invoked++;
    };

    await bot.handleUpdate(makeTextUpdate({ messageId: 1, chatId: 100, fromId: 100, text: 'first' }));
    await bot.handleUpdate(makeTextUpdate({ messageId: 2, chatId: 200, fromId: 200, text: 'second' }));

    assert.equal(invoked, 0);
  });

  it('always rejects messages from bot accounts even if their id is in allowedUsers', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['555'],
    });
    const { bot } = await createTelegramHarness(client);

    let invoked = 0;
    client.onMessage = async () => {
      invoked++;
    };

    await bot.handleUpdate(makeBotUpdate({ messageId: 1, chatId: 555, fromId: 555, text: 'bot speaks' }));

    assert.equal(invoked, 0);
  });
});

describe('TelegramClient.checkInlineMode', () => {
  it('warns and DMs each allowed user when supports_inline_queries is true', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111', '222'],
    });
    const { calls } = await createTelegramHarness(client, async (method) => {
      if (method === 'getMe') {
        return { ok: true, result: { ...TEST_BOT_INFO, supports_inline_queries: true } };
      }
      return undefined;
    });

    await client.checkInlineMode();

    const dms = calls.filter(
      (c) => c.method === 'sendMessage' && typeof c.payload.text === 'string' && (c.payload.text as string).includes('Inline mode is ENABLED'),
    );
    assert.equal(dms.length, 2);
    assert.deepEqual(
      dms.map((c) => String(c.payload.chat_id)).sort(),
      ['111', '222'],
    );
  });

  it('sends no warning when supports_inline_queries is false', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111'],
    });
    const { calls } = await createTelegramHarness(client, async (method) => {
      if (method === 'getMe') {
        return { ok: true, result: { ...TEST_BOT_INFO, supports_inline_queries: false } };
      }
      return undefined;
    });

    await client.checkInlineMode();

    const dms = calls.filter(
      (c) => c.method === 'sendMessage' && typeof c.payload.text === 'string' && (c.payload.text as string).includes('Inline mode is ENABLED'),
    );
    assert.equal(dms.length, 0);
  });

  it('swallows getMe failures without throwing', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111'],
    });
    await createTelegramHarness(client, async (method) => {
      if (method === 'getMe') {
        throw new Error('network down');
      }
      return undefined;
    });

    await assert.doesNotReject(() => client.checkInlineMode());
  });
});

describe('TelegramClient.checkInlineMode partial failure', () => {
  it('continues to DM remaining users when one sendMessage fails', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: ['111', '222'],
    });
    const { calls } = await createTelegramHarness(client, async (method, payload) => {
      if (method === 'getMe') {
        return { ok: true, result: { ...TEST_BOT_INFO, supports_inline_queries: true } };
      }
      if (method === 'sendMessage' && String(payload.chat_id) === '111') {
        throw new Error('user has not started DM');
      }
      return undefined;
    });

    await client.checkInlineMode();

    const dmAttempts = calls.filter(
      (c) =>
        c.method === 'sendMessage' && typeof c.payload.text === 'string' && (c.payload.text as string).includes('Inline mode is ENABLED'),
    );
    assert.deepEqual(
      dmAttempts.map((c) => String(c.payload.chat_id)).sort(),
      ['111', '222'],
    );
  });
});

describe('withAbortTimeout', () => {
  it('resolves with inner value when fn completes before timeout', async () => {
    const result = await withAbortTimeout(async () => 'ok', 1000);
    assert.equal(result, 'ok');
  });

  it('rejects with AbortError when fn never resolves and timeout elapses', async () => {
    const started = Date.now();
    await assert.rejects(
      withAbortTimeout(() => new Promise(() => {}), 50),
      (e) => (e as Error)?.name === 'AbortError',
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 40 && elapsed < 500, `expected ~50ms, got ${elapsed}ms`);
  });

  it('aborts the signal when timeout fires', async () => {
    let observedSignal: AbortSignal | undefined;
    await assert.rejects(
      withAbortTimeout((signal) => {
        observedSignal = signal;
        return new Promise(() => {});
      }, 50),
      (e) => (e as Error)?.name === 'AbortError',
    );
    assert.equal(observedSignal?.aborted, true);
  });

  it('passes signal through to fn even on fast path', async () => {
    let observedSignal: AbortSignal | undefined;
    const result = await withAbortTimeout(async (signal) => {
      observedSignal = signal;
      return 42;
    }, 1000);
    assert.equal(result, 42);
    assert.ok(observedSignal instanceof AbortSignal);
    assert.equal(observedSignal.aborted, false);
  });
});

describe('sendButtons — callback_data 64-byte guard', () => {
  it('warns when any button callback_data exceeds 64 bytes', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    await createTelegramHarness(client);

    const { log } = await import('../log.js');
    const originalWarn = log.warn;
    const warnings: string[][] = [];
    log.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)));
    };

    try {
      // Group thread session key (`-1003730545815:33`) + long choice text → > 64 bytes
      const longButton = '@-1003730545815:33|input:Numbers for 12/3/6/9 + small markers between';
      await client.sendButtons('-1003730545815', 'Choose:', [[{ text: 'Long choice', data: longButton }]], 33);
    } finally {
      log.warn = originalWarn;
    }

    const guardWarnings = warnings.filter((w) => w.some((s) => s.includes('callback_data exceeds 64-byte limit')));
    assert.equal(guardWarnings.length, 1, `expected one guard warning, got ${guardWarnings.length}`);
    const fields = guardWarnings[0]?.join(' ') ?? '';
    assert.ok(/bytes=\d+/.test(fields), `expected bytes=N in warning, got: ${fields}`);
    assert.ok(fields.includes('kind="input"'), `expected kind="input" (stripping @chatId routing prefix), got: ${fields}`);
  });

  it('does not warn when all callback_data are at or under 64 bytes', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    await createTelegramHarness(client);

    const { log } = await import('../log.js');
    const originalWarn = log.warn;
    const warnings: string[][] = [];
    log.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)));
    };

    try {
      await client.sendButtons('123', 'Choose:', [[{ text: 'Short', data: 'input:0' }]]);
    } finally {
      log.warn = originalWarn;
    }

    const guardWarnings = warnings.filter((w) => w.some((s) => s.includes('callback_data exceeds 64-byte limit')));
    assert.equal(guardWarnings.length, 0);
  });

  it('editMessageRaw never truncates mid-surrogate-pair', async () => {
    const client = new TelegramClient({
      botToken: 'test-token',
      allowedUsers: [],
    });
    const { calls } = await createTelegramHarness(client);

    // Land an emoji exactly on the 4092-unit cut: slicing there would leave a
    // lone high surrogate, which Telegram rejects with
    // "Bad Request: strings must be encoded in UTF-8".
    const text = 'a'.repeat(4091) + '🔧' + 'tail';
    await client.editMessageRaw('123', 7, text);

    const edit = calls.find((call) => call.method === 'editMessageText');
    const sent = String(edit?.payload.text ?? '');
    assert.ok(sent.length > 0);
    const lastUnit = sent.charCodeAt(sent.length - 1);
    assert.ok(!(lastUnit >= 0xd800 && lastUnit <= 0xdbff), 'must not end on a lone high surrogate');
    assert.equal(Buffer.from(sent, 'utf8').toString('utf8'), sent, 'must round-trip as valid UTF-8');
  });
});
