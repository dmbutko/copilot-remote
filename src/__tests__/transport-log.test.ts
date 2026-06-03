import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Update } from 'grammy/types';
import {
  formatLogFields,
  summarizeSdkEvent,
  summarizeTelegramApiCall,
  summarizeTelegramApiResult,
  summarizeTelegramUpdate,
  summarizeTextForLog,
} from '../transport-log.js';

describe('transport-log', () => {
  it('summarizes Telegram message updates', () => {
    const update: Update = {
      update_id: 1,
      message: {
        message_id: 99,
        date: 1,
        chat: { id: 123, type: 'private', first_name: 'Test' },
        from: { id: 456, is_bot: false, first_name: 'Tester' },
        text: 'hello there',
      },
    } as unknown as Update;

    assert.deepEqual(summarizeTelegramUpdate(update), {
      updateId: 1,
      kind: 'message',
      chat: 123,
      from: 456,
      msg: 99,
      thread: undefined,
      text: 'hello there',
      hasPhoto: false,
      hasDocument: false,
      hasVoice: false,
      hasAudio: false,
      hasVideo: false,
      hasLocation: false,
      hasSticker: false,
    });
  });

  it('summarizes Telegram API call payloads', () => {
    assert.deepEqual(
      summarizeTelegramApiCall('sendMessage', {
        chat_id: '123',
        message_thread_id: 77,
        reply_parameters: { message_id: 55 },
        parse_mode: 'HTML',
        text: 'hello world',
      }),
      {
        method: 'sendMessage',
        chat: '123',
        msg: undefined,
        thread: 77,
        replyTo: 55,
        draftId: undefined,
        action: undefined,
        callbackId: undefined,
        parseMode: 'HTML',
        text: 'hello world',
        caption: undefined,
      },
    );
  });

  it('summarizes SDK events', () => {
    assert.deepEqual(
      summarizeSdkEvent('assistant.message_delta', {
        turnId: 'turn-1',
        interactionId: 'ix-1',
        deltaContent: 'partial response',
      }),
      {
        type: 'assistant.message_delta',
        turnId: 'turn-1',
        interactionId: 'ix-1',
        toolCallId: undefined,
        toolName: undefined,
        exitCode: undefined,
        success: undefined,
        chars: 16,
        text: 'partial response',
        currentTokens: undefined,
        tokenLimit: undefined,
        messagesLength: undefined,
        title: undefined,
        message: undefined,
      },
    );
  });

  it('formats log fields predictably', () => {
    assert.deepEqual(formatLogFields({ chat: 123, text: 'hello', ok: true }), ['chat=123', 'text="hello"', 'ok=true']);
  });

  it('clips long text summaries', () => {
    assert.equal(summarizeTextForLog('abcdefghij', 5), 'abcde…');
  });

  it('summarizes Telegram API result for a successful sendMessage envelope', () => {
    const envelope = {
      ok: true,
      result: { message_id: 42, chat: { id: -100, type: 'supergroup' }, message_thread_id: 7, date: 1, text: 'hi' },
    };
    assert.deepEqual(summarizeTelegramApiResult('sendMessage', envelope), {
      method: 'sendMessage',
      ok: true,
      msg: 42,
      chat: -100,
      thread: 7,
    });
  });

  it('summarizes Telegram API result for an already-unwrapped Message', () => {
    // Some transformer layers pass the unwrapped result directly.
    const message = { message_id: 99, chat: { id: 5 }, message_thread_id: undefined };
    assert.deepEqual(summarizeTelegramApiResult('sendMessage', message), {
      method: 'sendMessage',
      ok: true,
      msg: 99,
      chat: 5,
      thread: undefined,
    });
  });

  it('summarizes Telegram API result for a failed envelope (BUTTON_DATA_INVALID)', () => {
    const envelope = {
      ok: false,
      error_code: 400,
      description: 'Bad Request: BUTTON_DATA_INVALID',
    };
    assert.deepEqual(summarizeTelegramApiResult('sendMessage', envelope), {
      method: 'sendMessage',
      ok: false,
      errorCode: 400,
      description: 'Bad Request: BUTTON_DATA_INVALID',
    });
  });

  it('clips very long error descriptions in failed envelopes', () => {
    const longDesc = 'a'.repeat(500);
    const envelope = { ok: false, error_code: 400, description: longDesc };
    const summary = summarizeTelegramApiResult('sendMessage', envelope);
    assert.equal(summary.ok, false);
    assert.ok(typeof summary.description === 'string' && summary.description.length <= 201);
  });
});
