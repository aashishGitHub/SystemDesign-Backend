'use strict';

// Defaults tuned so a chunk is small enough for Piper to synthesize quickly
// (enabling parallelism) but large enough to avoid excessive process-spawn
// overhead for a 100KB document.
const DEFAULT_MAX_CHUNK_CHARS = 500;
const DEFAULT_SENTENCE_GROUP_PAUSE_MS = 150;
const DEFAULT_PARAGRAPH_PAUSE_MS = 500;

const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+/;

/**
 * Splits raw text into paragraphs (blank-line separated), then splits any
 * paragraph longer than maxChunkChars into sentence-grouped sub-chunks so no
 * single Piper invocation receives an unreasonably large input.
 *
 * Returns an ordered array of { text, pauseAfterMs } where pauseAfterMs is
 * the silence to splice in after this chunk's synthesized audio (0 for the
 * very last chunk, since nothing follows it). Sentence-internal pacing is
 * left to Piper's own --sentence-silence flag; this function only decides
 * pauses *between* independently-synthesized chunks.
 *
 * @param {string} text
 * @param {{maxChunkChars?: number, sentenceGroupPauseMs?: number, paragraphPauseMs?: number}} [options]
 * @returns {Array<{text: string, pauseAfterMs: number}>}
 */
function chunkText(text, options = {}) {
  const maxChunkChars = options.maxChunkChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const sentenceGroupPauseMs = options.sentenceGroupPauseMs ?? DEFAULT_SENTENCE_GROUP_PAUSE_MS;
  const paragraphPauseMs = options.paragraphPauseMs ?? DEFAULT_PARAGRAPH_PAUSE_MS;

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChunkChars) {
      chunks.push({ text: paragraph, pauseAfterMs: paragraphPauseMs });
      continue;
    }

    const subChunks = groupIntoSubChunks(paragraph, maxChunkChars);
    subChunks.forEach((subChunk, index) => {
      const isLastInParagraph = index === subChunks.length - 1;
      chunks.push({
        text: subChunk,
        pauseAfterMs: isLastInParagraph ? paragraphPauseMs : sentenceGroupPauseMs,
      });
    });
  }

  const speakableChunks = dropUnspeakableChunks(chunks);

  if (speakableChunks.length > 0) {
    speakableChunks[speakableChunks.length - 1].pauseAfterMs = 0;
  }

  return speakableChunks;
}

// Piper crashes (wave.Error: "# channels not specified") on a chunk with no
// speakable content — it never writes a single audio frame, so the wav
// writer's header never gets set before close. This catches things our
// paragraph/sentence splitter otherwise passes through as "non-empty": a
// lone "...", a markdown "---" rule, stray punctuation. Only the bundled
// English voices are in scope, so "has an ASCII letter or digit" is a
// reasonable proxy for "is speakable" here. Dropped chunks fold their pause
// into the preceding surviving chunk so paragraph/sentence pacing holds.
const HAS_SPEAKABLE_CONTENT = /[a-zA-Z0-9]/;

function dropUnspeakableChunks(chunks) {
  const result = [];
  for (const chunk of chunks) {
    if (!HAS_SPEAKABLE_CONTENT.test(chunk.text)) {
      if (result.length > 0) {
        result[result.length - 1].pauseAfterMs = Math.max(result[result.length - 1].pauseAfterMs, chunk.pauseAfterMs);
      }
      continue;
    }
    result.push({ ...chunk });
  }
  return result;
}

/**
 * Groups a paragraph's sentences into sub-chunks up to maxChunkChars.
 * A "sentence" with no terminal punctuation (e.g. a long code-like line)
 * falls back to a hard length split so no chunk is ever left unbounded.
 */
function groupIntoSubChunks(paragraph, maxChunkChars) {
  const sentences = paragraph
    .split(SENTENCE_BOUNDARY)
    .flatMap((sentence) => hardSplitIfTooLong(sentence, maxChunkChars))
    .filter((s) => s.length > 0);

  const subChunks = [];
  let current = '';

  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > maxChunkChars && current) {
      subChunks.push(current);
      current = sentence;
    } else {
      current = candidate;
    }
  }
  if (current) {
    subChunks.push(current);
  }

  return subChunks;
}

function hardSplitIfTooLong(sentence, maxChunkChars) {
  if (sentence.length <= maxChunkChars) {
    return [sentence];
  }
  const parts = [];
  for (let i = 0; i < sentence.length; i += maxChunkChars) {
    parts.push(sentence.slice(i, i + maxChunkChars));
  }
  return parts;
}

module.exports = { chunkText };
