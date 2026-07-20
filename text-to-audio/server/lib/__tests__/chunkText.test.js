'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chunkText } = require('../chunkText');

test('single short paragraph produces one chunk with no trailing pause', () => {
  const chunks = chunkText('Hello there. How are you?');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, 'Hello there. How are you?');
  assert.equal(chunks[0].pauseAfterMs, 0);
});

test('blank-line separated paragraphs each become a chunk with a paragraph pause', () => {
  const chunks = chunkText('First paragraph.\n\nSecond paragraph.');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'First paragraph.');
  assert.equal(chunks[0].pauseAfterMs, 500);
  assert.equal(chunks[1].text, 'Second paragraph.');
  assert.equal(chunks[1].pauseAfterMs, 0, 'last chunk overall gets no trailing pause');
});

test('a paragraph longer than maxChunkChars is split into sentence-grouped sub-chunks', () => {
  const sentence = 'This is a test sentence with several words in it.';
  const paragraph = `${sentence} ${sentence} ${sentence}`;
  const chunks = chunkText(paragraph, { maxChunkChars: 60 });

  assert.ok(chunks.length > 1, 'expected more than one sub-chunk');
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 60 + sentence.length, 'no chunk should balloon far past the max');
  }
  const nonFinalPauses = chunks.slice(0, -1).map((c) => c.pauseAfterMs);
  assert.ok(nonFinalPauses.every((ms) => ms === 150), 'intra-paragraph sub-chunks use the shorter sentence-group pause');
  assert.equal(chunks[chunks.length - 1].pauseAfterMs, 0);
});

test('a sentence with no terminal punctuation falls back to a hard length split', () => {
  const noPunctuation = 'a'.repeat(1000);
  const chunks = chunkText(noPunctuation, { maxChunkChars: 100 });

  assert.ok(chunks.length >= 10, 'should be split into multiple bounded chunks');
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 100);
  }
});

test('multiple paragraphs separated by extra blank lines are still detected', () => {
  const chunks = chunkText('Para one.\n\n\n\nPara two.');
  assert.equal(chunks.length, 2);
});

test('empty or whitespace-only input produces no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n   '), []);
});

test('custom pause options are honored', () => {
  const chunks = chunkText('Para one.\n\nPara two.\n\nPara three.', { paragraphPauseMs: 999 });
  assert.equal(chunks[0].pauseAfterMs, 999);
  assert.equal(chunks[1].pauseAfterMs, 999);
  assert.equal(chunks[2].pauseAfterMs, 0);
});

test('a punctuation-only paragraph (e.g. a markdown "---" rule) is dropped, not handed to Piper', () => {
  const chunks = chunkText('Real sentence one.\n\n---\n\nReal sentence two.');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'Real sentence one.');
  assert.equal(chunks[1].text, 'Real sentence two.');
});

test('dropping an unspeakable chunk folds its pause into the preceding chunk', () => {
  const chunks = chunkText('Real sentence one.\n\n...\n\nReal sentence two.', { paragraphPauseMs: 700 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].pauseAfterMs, 700, 'the paragraph pause before the dropped "..." should carry over');
  assert.equal(chunks[1].pauseAfterMs, 0);
});

test('a file with only punctuation/whitespace content produces no chunks', () => {
  assert.deepEqual(chunkText('---\n\n...\n\n***'), []);
});
