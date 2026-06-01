import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FileAttachment } from '../session.js';
import { DEFAULT_UPLOAD_DIR, handleIncomingFileUpload, isImageFile, isTranscribableAudio } from '../file-intake.js';

function createDeps(overrides: Partial<Parameters<typeof handleIncomingFileUpload>[1]> = {}) {
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const prompts: Array<{ chatId: string; msgId: number; prompt: string; attachments?: FileAttachment[] }> = [];
  const writes: Array<{ path: string; data: Uint8Array }> = [];
  const directories: string[] = [];
  const debugLogs: Array<{ message: string; error: unknown }> = [];

  const deps: Parameters<typeof handleIncomingFileUpload>[1] = {
    async resolveFileUrl() {
      return 'https://example.com/file';
    },
    async download() {
      return new Uint8Array([1, 2, 3]);
    },
    ensureTempDir(dirPath) {
      directories.push(dirPath);
    },
    writeFile(filePath, data) {
      writes.push({ path: filePath, data });
    },
    async transcribeAudio() {
      return null;
    },
    async handlePrompt(chatId, msgId, prompt, attachments) {
      prompts.push({ chatId, msgId, prompt, attachments });
    },
    async sendMessage(chatId, text) {
      sentMessages.push({ chatId, text });
    },
    logDebug(message, error) {
      debugLogs.push({ message, error });
    },
    ...overrides,
  };

  return { deps, sentMessages, prompts, writes, directories, debugLogs };
}

describe('file intake helpers', () => {
  it('detects supported image and voice file types case-insensitively', () => {
    assert.equal(isImageFile('Screenshot.PNG'), true);
    assert.equal(isImageFile('notes.txt'), false);
    assert.equal(isTranscribableAudio('voice.OGA'), true);
    assert.equal(isTranscribableAudio('voice.mp3'), false);
  });
});

describe('handleIncomingFileUpload', () => {
  it('notifies the user when Telegram cannot resolve a download URL', async () => {
    const { deps, sentMessages, prompts } = createDeps({
      async resolveFileUrl() {
        return null;
      },
    });

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'notes.txt', caption: '', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.deepEqual(sentMessages, [{ chatId: 'chat-1', text: '❌ Could not download file.' }]);
    assert.equal(prompts.length, 0);
  });

  it('surfaces download failures back to the user', async () => {
    const boom = new Error('network exploded');
    const { deps, sentMessages } = createDeps({
      async download() {
        throw boom;
      },
    });

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'notes.txt', caption: '', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.deepEqual(sentMessages, [{ chatId: 'chat-1', text: '❌ Error: network exploded' }]);
  });

  it('falls back to file analysis when voice transcription blows up', async () => {
    const { deps, prompts, debugLogs, writes, directories } = createDeps({
      async transcribeAudio() {
        throw new Error('ffmpeg sad');
      },
    });

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'voice.ogg', caption: 'What did I say?', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.ok(directories[0]?.includes('chat-1'));
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.path.includes('chat-1'));
    assert.ok(writes[0]?.path.includes('voice'));
    assert.deepEqual(prompts, [
      {
        chatId: 'chat-1',
        msgId: 1,
        prompt: `What did I say?\n\n[Attached file: ${writes[0]?.path}]`,
        attachments: [{ type: 'file', path: writes[0]?.path, displayName: 'voice.ogg' }],
      },
    ]);
    assert.equal(debugLogs.length, 1);
    assert.equal(debugLogs[0]?.message, 'Voice transcription failed:');
  });

  it('routes image uploads through SDK attachments for vision flows', async () => {
    const { deps, prompts, writes } = createDeps();

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'diagram.png', caption: '', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.prompt, 'Describe this image.');
    assert.equal(prompts[0]?.attachments?.length, 1);
    assert.equal(prompts[0]?.attachments?.[0]?.displayName, 'diagram.png');
    assert.ok(writes[0]?.path.includes('diagram'));
    assert.ok(writes[0]?.path.includes('chat-1'));
  });

  it('uses transcription text directly when voice transcription succeeds', async () => {
    const { deps, prompts } = createDeps({
      async transcribeAudio() {
        return 'ship it';
      },
    });

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'voice.oga', caption: 'Summarize this', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.deepEqual(prompts, [
      {
        chatId: 'chat-1',
        msgId: 1,
        prompt: 'Summarize this\n\n(Voice transcription: ship it)',
        attachments: undefined,
      },
    ]);
  });

  it('generates unique filenames to avoid collisions', async () => {
    const { deps, writes } = createDeps();

    await handleIncomingFileUpload(
      { fileId: 'AAbb1234CCdd', fileName: 'photo.jpg', caption: '', chatId: 'chat-1', msgId: 10 },
      deps,
    );
    await handleIncomingFileUpload(
      { fileId: 'EEff5678GGhh', fileName: 'photo.jpg', caption: '', chatId: 'chat-1', msgId: 11 },
      deps,
    );

    assert.equal(writes.length, 2);
    assert.notEqual(writes[0]?.path, writes[1]?.path);
    assert.ok(writes[0]?.path.includes('10'));
    assert.ok(writes[1]?.path.includes('11'));
  });

  it('attaches non-image files as FileAttachment with displayName', async () => {
    const { deps, prompts } = createDeps();

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'report.pdf', caption: 'Check this', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0]?.attachments?.length, 1);
    assert.equal(prompts[0]?.attachments?.[0]?.displayName, 'report.pdf');
    assert.ok(prompts[0]?.prompt.includes('Check this'));
  });

  it('sanitizes path traversal in filenames', async () => {
    const { deps, writes } = createDeps();

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: '../../../etc/passwd', caption: '', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.equal(writes.length, 1);
    assert.ok(!writes[0]?.path.includes('..'));
    assert.ok(writes[0]?.path.includes('passwd'));
  });

  it('uses custom uploadDir from config', async () => {
    const { deps, writes, directories } = createDeps({ uploadDir: '/custom/uploads' });

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'photo.jpg', caption: '', chatId: 'chat-1', msgId: 1 },
      deps,
    );

    assert.ok(directories[0]?.startsWith('/custom/uploads'));
    assert.ok(writes[0]?.path.startsWith('/custom/uploads'));
  });

  it('creates per-chat subdirectories', async () => {
    const { deps, directories } = createDeps();

    await handleIncomingFileUpload(
      { fileId: 'file-1', fileName: 'photo.jpg', caption: '', chatId: '-100123456', msgId: 1 },
      deps,
    );

    assert.ok(directories[0]?.includes('-100123456'));
  });

  // Regression tests for the May-27 envelope rollout. file-intake produces
  // prompts that reach Copilot, so each prompt MUST begin with the
  // `<sender>{id}</sender>\n` envelope when senderId is supplied (the
  // production path always sets it). See src/inbound-envelope.ts.
  describe('sender envelope prepending', () => {
    it('prepends <sender> envelope to image-caption prompt when senderId is set', async () => {
      const { deps, prompts } = createDeps();

      await handleIncomingFileUpload(
        {
          fileId: 'file-1',
          fileName: 'diagram.png',
          caption: 'what is this?',
          chatId: 'chat-1',
          msgId: 1,
          senderId: '880903035',
        },
        deps,
      );

      assert.equal(prompts.length, 1);
      assert.ok(
        prompts[0]?.prompt.startsWith('<sender>880903035</sender>\n'),
        `expected envelope as line 1, got: ${JSON.stringify(prompts[0]?.prompt.slice(0, 60))}`,
      );
      assert.ok(prompts[0]?.prompt.endsWith('what is this?'));
    });

    it('prepends <sender> envelope to plain-file prompt when senderId is set', async () => {
      const { deps, prompts } = createDeps();

      await handleIncomingFileUpload(
        {
          fileId: 'file-1',
          fileName: 'report.pdf',
          caption: 'Check this',
          chatId: 'chat-1',
          msgId: 1,
          senderId: '769243474',
        },
        deps,
      );

      assert.equal(prompts.length, 1);
      assert.ok(
        prompts[0]?.prompt.startsWith('<sender>769243474</sender>\n'),
        `expected envelope as line 1`,
      );
    });

    it('prepends <sender> envelope to voice transcription prompt when senderId is set', async () => {
      const { deps, prompts } = createDeps({
        async transcribeAudio() {
          return 'remind me to call mum';
        },
      });

      await handleIncomingFileUpload(
        {
          fileId: 'file-1',
          fileName: 'voice.oga',
          caption: '',
          chatId: 'chat-1',
          msgId: 1,
          senderId: '880903035',
        },
        deps,
      );

      assert.equal(prompts.length, 1);
      assert.ok(
        prompts[0]?.prompt.startsWith('<sender>880903035</sender>\n'),
        `expected envelope as line 1`,
      );
      assert.ok(prompts[0]?.prompt.includes('remind me to call mum'));
    });

    it('omits envelope when senderId is undefined (test-fixture path)', async () => {
      const { deps, prompts } = createDeps();

      await handleIncomingFileUpload(
        { fileId: 'file-1', fileName: 'diagram.png', caption: '', chatId: 'chat-1', msgId: 1 },
        deps,
      );

      assert.equal(prompts.length, 1);
      assert.ok(!prompts[0]?.prompt.startsWith('<sender>'));
    });
  });
});
