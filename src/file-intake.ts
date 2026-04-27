import path from 'node:path';
import type { FileAttachment } from './session.js';

export interface IncomingFileContext {
  fileId: string;
  fileName: string;
  caption: string;
  chatId: string;
  msgId: number;
}

export interface FileIntakeDeps {
  resolveFileUrl(fileId: string): Promise<string | null>;
  download(url: string): Promise<Uint8Array>;
  ensureTempDir(dirPath: string): void;
  writeFile(filePath: string, data: Uint8Array): void;
  transcribeAudio?(filePath: string): Promise<string | null | undefined>;
  handlePrompt(chatId: string, msgId: number, prompt: string, attachments?: FileAttachment[]): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  logDebug?(message: string, error: unknown): void;
  uploadDir?: string;
}

export const DEFAULT_UPLOAD_DIR = '/tmp/copilot-remote-files';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const TRANSCRIBABLE_AUDIO_EXTENSIONS = ['.oga', '.ogg'];

export function isImageFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isTranscribableAudio(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return TRANSCRIBABLE_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Sanitize filename: strip path traversal, keep only basename, add uniqueness. */
function safeFileName(ctx: IncomingFileContext): string {
  const base = path.basename(ctx.fileName).replace(/[^\w.\-]/g, '_') || 'file';
  const ext = path.extname(base);
  const name = path.basename(base, ext);
  const suffix = ctx.fileId.slice(-8);
  return `${name}-${ctx.msgId}-${suffix}${ext || '.bin'}`;
}

export async function handleIncomingFileUpload(ctx: IncomingFileContext, deps: FileIntakeDeps): Promise<void> {
  const url = await deps.resolveFileUrl(ctx.fileId);
  if (!url) {
    await deps.sendMessage(ctx.chatId, '❌ Could not download file.');
    return;
  }

  try {
    const buffer = await deps.download(url);
    const baseDir = deps.uploadDir || DEFAULT_UPLOAD_DIR;
    const safeChatId = String(ctx.chatId).replace(/[^\w\-]/g, '_');
    const chatDir = path.join(baseDir, safeChatId);
    deps.ensureTempDir(chatDir);
    const diskName = safeFileName(ctx);
    const tmpPath = path.join(chatDir, diskName);
    deps.writeFile(tmpPath, buffer);

    const displayName = path.basename(ctx.fileName) || diskName;

    if (isTranscribableAudio(ctx.fileName) && deps.transcribeAudio) {
      try {
        const transcript = await deps.transcribeAudio(tmpPath);
        if (transcript?.trim()) {
          const prompt = ctx.caption
            ? `${ctx.caption}\n\n(Voice transcription: ${transcript.trim()})`
            : transcript.trim();
          await deps.handlePrompt(ctx.chatId, ctx.msgId, prompt);
          return;
        }
      } catch (error) {
        deps.logDebug?.('Voice transcription failed:', error);
      }
    }

    const attachments: FileAttachment[] = [{ type: 'file', path: tmpPath, displayName }];

    if (isImageFile(ctx.fileName)) {
      const prompt = ctx.caption || 'Describe this image.';
      await deps.handlePrompt(ctx.chatId, ctx.msgId, prompt, attachments);
      return;
    }

    const prompt = ctx.caption
      ? `${ctx.caption}\n\n[Attached file: ${tmpPath}]`
      : `I sent you a file: ${tmpPath}\nPlease read and analyze it.`;
    await deps.handlePrompt(ctx.chatId, ctx.msgId, prompt, attachments);
  } catch (error) {
    await deps.sendMessage(ctx.chatId, '❌ ' + String(error));
  }
}
