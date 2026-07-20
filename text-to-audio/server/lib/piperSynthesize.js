'use strict';

const { spawn } = require('child_process');

// Piper (OHF-Voice/piper1-gpl) ships as the `piper-tts` pip package, invoked
// as `<python> -m piper`. It's installed into a dedicated venv in the Docker
// image (see Dockerfile) to avoid Debian's PEP 668 system-Python restriction;
// PIPER_PYTHON points at that venv's interpreter. Voices are baked into the
// image under PIPER_DATA_DIR so synthesis never needs network access.
const PIPER_PYTHON = process.env.PIPER_PYTHON || 'python3';
const PIPER_DATA_DIR = process.env.PIPER_DATA_DIR || '/opt/piper-voices';
const SENTENCE_SILENCE_SECONDS = 0.3;

/**
 * Synthesizes one text chunk to a wav file via the local Piper CLI.
 * Piper's own --sentence-silence paces sentences *within* this chunk;
 * pauses *between* chunks are spliced in later by stitchAudio.js.
 *
 * @param {{text: string, outputPath: string, voice: string}} params
 * @returns {Promise<void>}
 */
function synthesizeChunk({ text, outputPath, voice }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'piper', // python3's own -m: run the installed `piper` package as a script
      '-m', voice, // piper's own -m: which voice model to use
      '-f', outputPath,
      '--data-dir', PIPER_DATA_DIR,
      '--sentence-silence', String(SENTENCE_SILENCE_SECONDS),
      '--',
      text,
    ];

    const child = spawn(PIPER_PYTHON, args);
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start piper: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`piper exited with code ${code}: ${stderr.trim() || '(no stderr output)'}`));
      }
    });
  });
}

module.exports = { synthesizeChunk, PIPER_DATA_DIR };
