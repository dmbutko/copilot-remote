import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeOverride, formatTokens, overrideFooter, resolveModel, resolveReasoning } from '../chat-model.js';
import type { ChatConfig } from '../config-store.js';

const MODELS = [
  {
    id: 'gpt-6-astra',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    capabilities: { limits: { max_context_window_tokens: 1_050_000 } },
  },
  { id: 'claude-opus-5', supportedReasoningEfforts: ['low', 'high'] },
  { id: 'claude-opus-4.8' },
  { id: 'gpt-5.5' },
  { id: 'gpt-5.5-mini' },
];

const base = (over: Partial<ChatConfig> = {}): ChatConfig =>
  ({ model: 'gpt-5.5', reasoningEffort: '', contextTier: 'default', ...over }) as ChatConfig;

describe('resolveModel', () => {
  it('resolves a unique fragment — "astra" is the motivating case', () => {
    assert.deepEqual(resolveModel('astra', MODELS), { id: 'gpt-6-astra' });
  });

  it('prefers an exact id over a longer id that contains it', () => {
    // "gpt-5.5" is a substring of "gpt-5.5-mini", so without exact-first this
    // resolves as ambiguous and a valid explicit id becomes unselectable.
    assert.deepEqual(resolveModel('gpt-5.5', MODELS), { id: 'gpt-5.5' });
  });

  it('refuses an ambiguous fragment rather than guessing', () => {
    const r = resolveModel('opus', MODELS) as { error: string };
    assert.match(r.error, /claude-opus-5/);
    assert.match(r.error, /claude-opus-4\.8/);
    assert.match(r.error, /be more specific/);
  });

  it('lists what exists when nothing matches (never invents an id)', () => {
    const r = resolveModel('gpt-9-nope', MODELS) as { error: string };
    assert.match(r.error, /No model matching/);
    assert.match(r.error, /gpt-6-astra/);
  });

  it('errors when the model list is unavailable', () => {
    assert.ok('error' in resolveModel('astra', []));
  });
});

describe('resolveReasoning', () => {
  it('maps "highest"/"lowest" onto the model-specific scale', () => {
    assert.deepEqual(resolveReasoning('highest', MODELS[0]), { effort: 'max' });
    assert.deepEqual(resolveReasoning('lowest', MODELS[0]), { effort: 'low' });
    // Different model, different scale — "highest" must not mean "max" globally.
    assert.deepEqual(resolveReasoning('highest', MODELS[1]), { effort: 'high' });
  });

  it('rejects a level the chosen model does not support', () => {
    const r = resolveReasoning('xhigh', MODELS[1]) as { error: string };
    assert.match(r.error, /supports low, high/);
  });

  it('treats "max" as a literal level, not a synonym for highest', () => {
    // "max" is a real level on some models, which is why the sentinel had to be
    // the word "highest". On a low/high-only model it must be rejected, not
    // silently resolved to "high".
    const r = resolveReasoning('max', MODELS[1]) as { error: string };
    assert.ok('error' in r, '"max" must not be treated as a sentinel');
    assert.match(r.error, /supports low, high/);
    // ...and on a model that really has it, it resolves literally.
    assert.deepEqual(resolveReasoning('max', MODELS[0]), { effort: 'max' });
  });

  it('treats empty/default as unset', () => {
    assert.deepEqual(resolveReasoning('', MODELS[0]), { effort: '' });
    assert.deepEqual(resolveReasoning('default', MODELS[0]), { effort: '' });
  });

  it('reports models with no reasoning support', () => {
    const r = resolveReasoning('high', MODELS[3]) as { error: string };
    assert.match(r.error, /does not support reasoning/);
  });
});

describe('overrideFooter', () => {
  it('renders nothing when the chat matches global', () => {
    assert.equal(overrideFooter(base(), base(), 872_000), '');
  });

  it('shows all settings for a different model even when effort and tier match global', () => {
    const global = base({ model: 'claude-opus-5', reasoningEffort: 'max', contextTier: 'long_context' });
    const eff = { ...global, model: 'gpt-6-astra' };
    assert.equal(overrideFooter(eff, global, 872_000), '\n\n_gpt-6-astra · max · 872k_');
  });

  it('uses the observed budget for default context too, without guessing catalogue capacity', () => {
    const eff = base({ model: 'gpt-6-astra', reasoningEffort: 'xhigh' });
    assert.equal(overrideFooter(eff, base(), 128_000), '\n\n_gpt-6-astra · xhigh · 128k_');
  });

  it('still shows only the differing setting when the model matches global', () => {
    const globalLong = base({ model: 'gpt-6-astra', contextTier: 'long_context' });
    const eff = base({ model: 'gpt-6-astra', contextTier: 'default' });
    assert.equal(overrideFooter(eff, globalLong, 128_000), '\n\n_128k_');
    assert.equal(overrideFooter(base({ reasoningEffort: 'high' }), base(), 128_000), '\n\n_high_');
  });

  it('shows an explicitly-cleared reasoning effort as a difference', () => {
    // Global high, chat deliberately back to model default — hiding this would
    // make a diverged chat look identical to a default one.
    const globalHigh = base({ reasoningEffort: 'high' });
    const eff = base({ reasoningEffort: '' });
    assert.equal(overrideFooter(eff, globalHigh, 872_000), '\n\n_default effort_');
  });

  it('shows the requested tier until the session reports a valid budget', () => {
    const eff = base({ model: 'claude-opus-5', contextTier: 'long_context' });
    for (const unavailable of [undefined, 0, -1, NaN, Infinity]) {
      assert.equal(overrideFooter(eff, base(), unavailable), '\n\n_claude-opus-5 · default effort · long_context_');
    }
  });
});

describe('formatTokens', () => {
  it('formats as k', () => {
    assert.equal(formatTokens(1_050_000), '1050k');
    assert.equal(formatTokens(936_000), '936k');
    assert.equal(formatTokens(512), '512');
  });
});

describe('describeOverride', () => {
  it('summarises a pinned chat and an inheriting one', () => {
    assert.equal(describeOverride({ model: 'gpt-6-astra', reasoningEffort: 'max' }), 'gpt-6-astra · max');
    assert.equal(describeOverride({}), 'global defaults');
  });
});
