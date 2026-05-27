import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

/**
 * Tests the composite-key + chat-scoped helpers used in src/index.ts for
 * `pendingPerms` and `pendingInputs`. Helpers are inlined in index.ts;
 * this file reconstructs the same pattern in isolation so we can validate
 * the cross-chat-coexist and chat-scoped-clear behaviours without spinning
 * up the full bot.
 *
 * Key invariant: chat-scoped match must NOT confuse the DM chatId `X` with
 * a threaded chatId `X:Y` whose composite keys both start with `X:`.
 * Threaded chat keys look like `X:Y:msgId`; DM keys look like `X:msgId`.
 * The match helper enforces this by checking the LAST colon is at exactly
 * `chatId.length`.
 */
function makePendingSet() {
  const set = new Set<string>();
  const key = (chatId: string, msgId: number) => `${chatId}:${msgId}`;
  const matchesChat = (k: string, chatId: string) =>
    k.startsWith(`${chatId}:`) && k.lastIndexOf(':') === chatId.length;
  return {
    set,
    add: (chatId: string, msgId: number) => set.add(key(chatId, msgId)),
    has: (chatId: string, msgId: number) => set.has(key(chatId, msgId)),
    clear: (chatId: string, msgId: number) => set.delete(key(chatId, msgId)),
    clearForChat: (chatId: string) => {
      for (const k of set) if (matchesChat(k, chatId)) set.delete(k);
    },
  };
}

describe('pending-state composite key', () => {
  it('same msgId in two chats coexists (no collision)', () => {
    const p = makePendingSet();
    p.add('chat-A', 1234);
    p.add('chat-B', 1234);
    assert.ok(p.has('chat-A', 1234));
    assert.ok(p.has('chat-B', 1234));
    assert.equal(p.set.size, 2);
  });

  it('clearing one chat does not affect the same msgId in another chat', () => {
    const p = makePendingSet();
    p.add('chat-A', 1234);
    p.add('chat-B', 1234);
    p.clear('chat-A', 1234);
    assert.ok(!p.has('chat-A', 1234));
    assert.ok(p.has('chat-B', 1234));
  });

  it('clearForChat removes only that chat entries', () => {
    const p = makePendingSet();
    p.add('chat-A', 1);
    p.add('chat-A', 2);
    p.add('chat-A', 3);
    p.add('chat-B', 1);
    p.add('chat-B', 2);
    p.clearForChat('chat-A');
    assert.ok(!p.has('chat-A', 1));
    assert.ok(!p.has('chat-A', 2));
    assert.ok(!p.has('chat-A', 3));
    assert.ok(p.has('chat-B', 1));
    assert.ok(p.has('chat-B', 2));
    assert.equal(p.set.size, 2);
  });

  it('clearForChat on DM chatId does NOT wipe threaded entries (real bug)', () => {
    // Threaded chats use sessionKey form `${rawChatId}:${threadId}`. Naive
    // prefix-match would wipe both. matchesChat requires the LAST colon
    // separator to be at chatId.length — so `880903035` matches `880903035:5000`
    // but NOT `880903035:33:5000`.
    const p = makePendingSet();
    p.add('880903035', 5000); // DM
    p.add('880903035:33', 5000); // thread 33 in same chat
    p.add('880903035:99', 7000); // thread 99 in same chat

    p.clearForChat('880903035');

    assert.ok(!p.has('880903035', 5000), 'DM entry removed');
    assert.ok(p.has('880903035:33', 5000), 'thread 33 entry preserved');
    assert.ok(p.has('880903035:99', 7000), 'thread 99 entry preserved');

    p.clearForChat('880903035:33');
    assert.ok(!p.has('880903035:33', 5000), 'thread 33 entry now removed');
    assert.ok(p.has('880903035:99', 7000), 'thread 99 still preserved');
  });

  it('clearForChat on empty chat is a no-op (no throw)', () => {
    const p = makePendingSet();
    p.add('chat-A', 1);
    p.clearForChat('chat-Z');
    assert.equal(p.set.size, 1);
  });
});

