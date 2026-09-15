// Per-chat model overrides: pure resolution + presentation helpers.
//
// Kept out of index.ts so the interesting logic (fuzzy id matching, effort
// validation against a model's real capabilities, footer rendering) is unit
// testable without a live session.
import type { ChatConfig, ContextTier } from './config-store.js';

export interface ModelLike {
  id?: string;
  name?: string;
  supportedReasoningEfforts?: string[];
  capabilities?: { limits?: { max_context_window_tokens?: number } };
}

export const modelId = (m: ModelLike): string => m.id ?? m.name ?? '';

/**
 * Resolve a user-supplied model fragment to exactly one live id.
 *
 * Exact id wins outright, so a short id can never be shadowed by a longer one
 * that contains it. Otherwise a unique case-insensitive substring match is
 * accepted ("astra" -> "gpt-6-astra"); anything ambiguous or unknown returns
 * the candidate list instead of guessing. Guessing is how a chat gets pinned to
 * a non-existent model, which is the documented original lockout cause.
 */
export function resolveModel(input: string, models: ModelLike[]): { id: string } | { error: string } {
  const want = input.trim().toLowerCase();
  if (!want) return { error: 'No model given.' };
  const ids = models.map(modelId).filter(Boolean);
  if (!ids.length) return { error: 'Model list unavailable — try again.' };

  const exact = ids.find((id) => id.toLowerCase() === want);
  if (exact) return { id: exact };

  const hits = ids.filter((id) => id.toLowerCase().includes(want));
  if (hits.length === 1) return { id: hits[0] };
  if (hits.length > 1) return { error: `"${input}" matches ${hits.join(', ')} — be more specific.` };
  return { error: `No model matching "${input}". Available: ${ids.join(', ')}` };
}

/**
 * Resolve a reasoning effort against the chosen model's real capabilities.
 *
 * "highest"/"lowest" are resolved here rather than by the caller because only
 * this model's `supportedReasoningEfforts` ordering is authoritative — and note
 * "max" is itself a real level on some models, so it cannot double as the
 * sentinel. '' means "unset / model default".
 */
export function resolveReasoning(input: string, model: ModelLike): { effort: string } | { error: string } {
  const supported = model.supportedReasoningEfforts ?? [];
  const want = input.trim().toLowerCase();
  if (!want || want === 'default') return { effort: '' };
  if (!supported.length) return { error: `${modelId(model)} does not support reasoning effort.` };
  if (want === 'highest') return { effort: supported[supported.length - 1] };
  if (want === 'lowest') return { effort: supported[0] };
  const hit = supported.find((s) => s.toLowerCase() === want);
  if (hit) return { effort: hit };
  return { error: `${modelId(model)} supports ${supported.join(', ')} — not "${input}".` };
}

/** 1050000 -> "1050k". Below 1k is shown as-is. */
export function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * Footer shown while a chat diverges from the global defaults, e.g.
 * `_gpt-6-astra · max · 872k_`. A different model includes all three
 * settings; otherwise only differing fields appear.
 *
 * The number is the session's usable prompt budget, as shown by /context,
 * not the catalogue's maximum. Until a new model reports its budget, show the
 * requested tier rather than attributing the previous model's size to it.
 */
export function overrideFooter(effective: ChatConfig, global: ChatConfig, tokenLimit?: number): string {
  const parts: string[] = [];
  const modelChanged = !!effective.model && effective.model !== global.model;
  if (modelChanged) parts.push(effective.model);
  if (modelChanged || effective.reasoningEffort !== global.reasoningEffort) {
    // An explicit "back to model default" is still a divergence — showing
    // nothing here would hide a chat that deliberately dropped off a global
    // high-reasoning setting.
    parts.push(effective.reasoningEffort || 'default effort');
  }
  if (modelChanged || effective.contextTier !== global.contextTier) {
    parts.push(
      tokenLimit !== undefined && Number.isFinite(tokenLimit) && tokenLimit > 0
        ? formatTokens(tokenLimit)
        : effective.contextTier,
    );
  }
  return parts.length ? `\n\n_${parts.join(' · ')}_` : '';
}

/** Human summary of what a chat is pinned to, for the tool's reply. */
export function describeOverride(o: Partial<ChatConfig>): string {
  const bits = [o.model, o.reasoningEffort, o.contextTier === 'long_context' ? 'long context' : undefined].filter(
    Boolean,
  );
  return bits.length ? bits.join(' · ') : 'global defaults';
}

export type { ContextTier };
