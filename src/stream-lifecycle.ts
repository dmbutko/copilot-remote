import type { Client, MessageOptions } from './client.js';
import { markdownToTelegramChunks } from './format.js';

export interface FinalizeStreamResponseArgs {
  client: Client;
  chatId: string;
  streamMsgId: number | null;
  final: string;
  responseMessageOpts: MessageOptions;
  /**
   * Skip the edit-in-place path and always deliver the answer as a fresh
   * message. Telegram sends no notification for edits, so in immediate
   * (steering) mode an edited placeholder can land silently above the user's
   * steer. Resending notifies and keeps the answer chronologically last.
   */
  forceResend?: boolean;
}

export async function finalizeStreamResponse({
  client,
  chatId,
  streamMsgId,
  final,
  responseMessageOpts,
  forceResend,
}: FinalizeStreamResponseArgs): Promise<'edited' | 'resent' | 'sent'> {
  const chunks = final ? markdownToTelegramChunks(final, 4096) : [];

  if (streamMsgId && chunks.length <= 1 && !forceResend) {
    await client.editMessage(chatId, streamMsgId, final);
    return 'edited';
  }

  if (streamMsgId) {
    await client.deleteMessage?.(chatId, streamMsgId).catch(() => {});
    await client.sendMessage(chatId, final, responseMessageOpts);
    return 'resent';
  }

  await client.sendMessage(chatId, final, responseMessageOpts);
  return 'sent';
}
