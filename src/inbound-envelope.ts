/**
 * Telegram inbound envelope helpers.
 *
 * Every inbound user prompt that reaches Copilot has a one-line envelope
 * prepended by the bridge transport layer:
 *
 *   <sender>{telegramId-or-unknown}</sender>\n
 *
 * In-session agents strip this line via the regex documented in
 * `~/stuff/AGENTS.md`. The bridge itself ALSO has to strip it before
 * doing bridge-local routing (slash commands, yes/no permission replies,
 * ask_user freeform answers) — see `src/index.ts:onMessage`.
 *
 * Spec invariants enforced here:
 * - Anchored to start-of-string.
 * - `{senderId}` is either one or more digits, or the literal `unknown`.
 *   (Looser regex would let an attacker spoof identity by pasting
 *   `<sender>FAKE</sender>\n` as the first line of their message.)
 * - Trailing newline consumed.
 *
 * Why centralize: prior to this module the envelope was built in two
 * places (`src/telegram.ts`, `src/file-intake.ts`) and parsed inline in
 * `src/index.ts` with a slightly looser regex. Centralizing kills the
 * drift risk that caused the May-27 `/config` regression.
 */

/** Strict envelope regex. Matches only the documented spec. */
export const SENDER_ENVELOPE_REGEX = /^<sender>([0-9]+|unknown)<\/sender>\n/;

/** Build the envelope line for the given sender id. */
export function buildSenderEnvelope(senderId: string): string {
  return `<sender>${senderId}</sender>\n`;
}

/**
 * Split a wrapped inbound text into envelope + body.
 *
 * If the text has no envelope (e.g., legacy fixture or malformed input),
 * returns `{ envelope: '', body: text }` — bridge-local routing will still
 * work, and Copilot's first-line parser will treat it as `actor=unknown`.
 *
 * This is the primary defense against the May-27 `/config` regression:
 * bridge-local routing MUST switch on `body`, never on the wrapped text.
 */
export function splitEnvelope(text: string): { envelope: string; body: string } {
  const match = text.match(SENDER_ENVELOPE_REGEX);
  if (!match) return { envelope: '', body: text };
  return { envelope: match[0], body: text.slice(match[0].length) };
}
