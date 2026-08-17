import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, markdownToText, markdownToTelegramChunks } from '../format.js';

describe('markdownToHtml', () => {
  it('converts headers to plain text (no bold wrapping)', () => {
    // The new markdown-it parser renders headings without bold by default
    const result = markdownToHtml('# Hello');
    assert.ok(result.includes('Hello'));
  });

  it('converts bold text', () => {
    assert.ok(markdownToHtml('**bold**').includes('<b>bold</b>'));
  });

  it('converts italic text', () => {
    assert.ok(markdownToHtml('*italic*').includes('<i>italic</i>'));
  });

  it('converts bold+italic', () => {
    const result = markdownToHtml('***both***');
    assert.ok(result.includes('<b>'));
    assert.ok(result.includes('<i>'));
    assert.ok(result.includes('both'));
  });

  it('converts inline code', () => {
    assert.ok(markdownToHtml('use `npm install`').includes('<code>npm install</code>'));
  });

  it('converts code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    const result = markdownToHtml(input);
    assert.ok(result.includes('<pre><code>'));
    assert.ok(result.includes('const x = 1;'));
    assert.ok(result.includes('</code></pre>'));
  });

  it('handles unclosed code blocks', () => {
    const input = '```\nsome code';
    assert.ok(markdownToHtml(input).includes('<pre>'));
  });

  it('converts links', () => {
    const result = markdownToHtml('[foo](https://bar.com)');
    assert.ok(result.includes('<a href="https://bar.com">foo</a>'));
  });

  it('converts strikethrough', () => {
    assert.ok(markdownToHtml('~~gone~~').includes('<s>gone</s>'));
  });

  it('converts blockquotes', () => {
    assert.ok(markdownToHtml('> quoted').includes('<blockquote>'));
    assert.ok(markdownToHtml('> quoted').includes('quoted'));
  });

  it('converts unordered lists', () => {
    assert.ok(markdownToHtml('- item').includes('• item'));
    assert.ok(markdownToHtml('* item').includes('• item'));
  });

  it('converts ordered lists', () => {
    const result = markdownToHtml('1. first');
    assert.ok(result.includes('1. first'));
  });

  it('converts horizontal rules', () => {
    assert.ok(markdownToHtml('---').includes('───'));
  });

  it('escapes HTML entities', () => {
    const result = markdownToHtml('<script>alert(1)</script>');
    assert.ok(result.includes('&lt;script&gt;'));
    assert.ok(!result.includes('<script>'));
  });

  it('handles mixed content', () => {
    const input = '# Title\n\nSome **bold** and `code`\n\n- item 1\n- item 2';
    const result = markdownToHtml(input);
    assert.ok(result.includes('Title'));
    assert.ok(result.includes('<b>bold</b>'));
    assert.ok(result.includes('<code>code</code>'));
    assert.ok(result.includes('• item 1'));
  });

  it('converts spoilers', () => {
    const result = markdownToHtml('this is ||hidden|| text');
    assert.ok(result.includes('<tg-spoiler>hidden</tg-spoiler>'));
  });

  it('wraps file references in code tags', () => {
    const result = markdownToHtml('check README.md for details');
    assert.ok(result.includes('<code>'));
    assert.ok(result.includes('README.md'));
  });
});

describe('markdownToText', () => {
  it('strips bold markers', () => {
    assert.equal(markdownToText('**bold**'), 'bold');
  });

  it('strips headers', () => {
    assert.equal(markdownToText('## Header'), 'Header');
  });

  it('strips links but keeps text', () => {
    assert.equal(markdownToText('[click](http://x.com)'), 'click');
  });

  it('strips inline code backticks', () => {
    assert.equal(markdownToText('use `npm`'), 'use npm');
  });

  it('converts list markers to bullets', () => {
    assert.ok(markdownToText('- item').includes('• item'));
  });
});

describe('markdownToTelegramChunks', () => {
  it('returns single chunk for short text', () => {
    const chunks = markdownToTelegramChunks('hello **world**', 4096);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].html.includes('<b>world</b>'));
  });

  it('splits long text into multiple chunks', () => {
    const long = 'word '.repeat(2000);
    const chunks = markdownToTelegramChunks(long, 4096);
    assert.ok(chunks.length > 1);
  });

  it('does not split a word in the middle of plain text', () => {
    const long = 'because '.repeat(1000);
    const chunks = markdownToTelegramChunks(long, 4096);
    assert.ok(chunks.length > 1);
    for (const c of chunks) {
      assert.ok(!c.text.startsWith('ecause'), `chunk starts mid-word: ${c.text.slice(0, 20)}`);
      assert.ok(!c.text.endsWith('b'), `chunk ends mid-word: ${c.text.slice(-20)}`);
    }
  });

  it('never splits a surrogate pair, including through HTML expansion re-split', () => {
    // Third instance of this bug class this month (editMessageRaw and clip() were
    // the first two). A boundary landing between the high and low surrogate of an
    // emoji leaves a half-character, which encodes to invalid UTF-8 and makes
    // Telegram reject the ENTIRE message with HTTP 400.
    // Bold + link force HTML expansion, so the secondary splitter in
    // format/telegram.ts computes its own boundary on top of chunkText's.
    const emoji = '\u{1F600}';
    const md = `**${emoji.repeat(30)}** [${emoji.repeat(30)}](https://example.com)`;
    const plainNoWs = emoji.repeat(60);
    for (const limit of [11, 25, 41, 63]) {
      const chunks = markdownToTelegramChunks(md, limit);
      for (const c of chunks) {
        assert.doesNotMatch(c.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, `limit ${limit}: unpaired high surrogate`);
        assert.doesNotMatch(c.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, `limit ${limit}: unpaired low surrogate`);
        assert.doesNotMatch(c.html, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, `limit ${limit}: unpaired surrogate in html`);
        assert.equal(Buffer.from(c.text, 'utf-8').toString('utf-8'), c.text, `limit ${limit}: not UTF-8 round-trippable`);
      }
      assert.equal(
        chunks.map((c) => c.text).join('').replace(/\s/g, ''),
        plainNoWs,
        `limit ${limit}: content lost or duplicated`,
      );
      assert.ok(chunks.some((c) => c.html.includes('<b>')), `limit ${limit}: bold formatting lost`);
      assert.ok(chunks.some((c) => c.html.includes('<a href')), `limit ${limit}: link formatting lost`);
    }
  });

  it('emits individually valid chunks when a surrogate pair cannot fit the limit', () => {
    // Guard against an infinite loop: limit 1 can never hold a 2-unit pair, so
    // the boundary must move forward rather than back.
    const chunks = markdownToTelegramChunks('\u{1F600}\u{1F600}\u{1F600}', 1);
    assert.ok(chunks.length > 0);
    for (const c of chunks) {
      assert.doesNotMatch(c.text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'unpaired high surrogate');
      assert.doesNotMatch(c.text, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'unpaired low surrogate');
    }
    assert.equal(chunks.map((c) => c.text).join(''), '\u{1F600}\u{1F600}\u{1F600}');
  });

  it('does not produce tiny orphan chunks when HTML barely exceeds limit', () => {
    // Regression for the Salzburg bug: a 4254-char paragraph with inline **bold** rendered to
    // ~4143-char HTML (47 over the 4096 limit). The old dispatcher used proportional math that
    // shaved only the overflow, producing a chunk still 1-byte over the limit, which then
    // recursively split again — leaving a 3-char orphan ("on ") and a 46-char fragment.
    const para = Array.from({ length: 70 }, (_, i) =>
      `Some **bold ${i}** text here with a few more **words** that follow naturally and read like a sentence.`,
    ).join(' ');
    const chunks = markdownToTelegramChunks(para, 4096);
    assert.ok(chunks.length >= 2, `expected to split, got ${chunks.length}`);
    for (const c of chunks) {
      assert.ok(c.html.length <= 4096, `chunk html exceeds limit: ${c.html.length}`);
    }
    // No orphan: every chunk should carry meaningful content (>= 50 chars).
    for (const c of chunks) {
      assert.ok(c.text.length >= 50, `tiny orphan chunk: text=${c.text.length} "${c.text}"`);
    }
  });

  it('every chunk fits within the requested HTML limit', () => {
    const para = Array.from({ length: 600 }, (_, i) => `**w${i}**`).join(' ');
    const chunks = markdownToTelegramChunks(para, 4096);
    for (const c of chunks) {
      assert.ok(c.html.length <= 4096, `chunk exceeds 4096: ${c.html.length}`);
    }
  });

  it('handles a single very long word without infinite-looping', () => {
    const giant = 'a'.repeat(10000);
    const chunks = markdownToTelegramChunks(giant, 4096);
    assert.ok(chunks.length >= 2, 'expected at least 2 chunks');
    const joined = chunks.map((c) => c.text).join('');
    assert.equal(joined.length, giant.length, `length differs: ${joined.length} vs ${giant.length}`);
    assert.equal(joined, giant, 'roundtrip broken on long word');
  });
});
