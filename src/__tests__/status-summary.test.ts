import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAssistantPlan,
  formatSubagentStatus,
  formatToolStatus,
  reasoningTail,
} from '../status-summary.js';

describe('status-summary', () => {
  it('formats task tool status using the human description first', () => {
    assert.deepEqual(
      formatToolStatus('task', {
        agent_type: 'code-review',
        description: 'Code review github-remote',
        prompt: 'Please do a thorough code review',
      }),
      {
        label: '🤖 Agent',
        detail: 'Code review github-remote',
        statusLine: '🤖 Agent Code review github-remote',
      },
    );
  });

  it('formats bash tool status using description before raw command text', () => {
    assert.deepEqual(
      formatToolStatus('bash', {
        description: 'Check git status for staged/unstaged changes',
        command: 'cd ~/source/github-remote && git --no-pager status',
      }),
      {
        label: '▶️ Run',
        detail: 'Check git status for staged/unstaged changes',
        statusLine: '▶️ Run Check git status for staged/unstaged changes',
      },
    );
  });

  it('extracts intent and the first actionable tool from assistant planning metadata', () => {
    assert.deepEqual(
      extractAssistantPlan({
        content: '',
        reasoningText: 'The user wants a thorough code review.\n\nLet me start by checking git status.',
        toolRequests: [
          { name: 'report_intent', arguments: { intent: 'Reviewing code changes' } },
          {
            name: 'bash',
            arguments: {
              description: 'Check git status for staged/unstaged changes',
              command: 'cd ~/source/github-remote && git --no-pager status',
            },
          },
        ],
      }),
      {
        intentText: 'Reviewing code changes',
        activeToolStatus: '▶️ Run Check git status for staged/unstaged changes',
      },
    );
  });

  it('formats subagent milestones for human-readable progress updates', () => {
    assert.deepEqual(formatSubagentStatus({ agentName: 'code-review', agentDisplayName: 'Code Review Agent' }), {
      statusLine: '🤖 Starting Code Review Agent',
    });
  });
});

describe('reasoningTail', () => {
  it('returns short text unchanged and collapses whitespace', () => {
    assert.equal(reasoningTail('Comparing   the\n  grain pattern'), 'Comparing the grain pattern');
    assert.equal(reasoningTail('   '), '');
  });

  it('never starts on a lone low surrogate when the cut lands inside an emoji', () => {
    const text = 'x'.repeat(50) + '\u{1F527}' + 'y'.repeat(199);
    const tail = reasoningTail(text, 200);
    const first = tail.charCodeAt(1); // index 0 is the ellipsis prefix
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), 'must not start on a lone low surrogate');
    assert.equal(Buffer.from(tail, 'utf8').toString('utf8'), tail, 'must round-trip as valid UTF-8');
  });

  it('marks clipped text with an ellipsis', () => {
    const tail = reasoningTail('alpha bravo ' + 'z'.repeat(400), 200);
    assert.ok(tail.startsWith('…'));
    assert.equal(tail.length, 201);
  });

  it('clip() never leaves a dangling high surrogate', () => {
    // formatToolStatus clips through clip(); a cut inside an emoji would emit
    // invalid UTF-8 and Telegram would reject the edit.
    const status = formatToolStatus('bash', { command: 'x'.repeat(95) + '\u{1F527}tail' }).statusLine;
    assert.equal(Buffer.from(status, 'utf8').toString('utf8'), status, 'must round-trip as valid UTF-8');
  });
});
