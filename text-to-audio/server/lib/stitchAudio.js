'use strict';

const { spawn } = require('child_process');
const fsp = require('fs/promises');
const path = require('path');

// A common Piper output rate, used here purely as a consistent target format:
// the final ffmpeg encode step resamples everything to this value, so the
// pipeline is correct even if a given voice's actual native rate differs.
const SAMPLE_RATE = 22050;
const CHANNELS = 1;

/**
 * Concatenates ordered chunk wav files into one final mp3, splicing in a
 * silence clip after each chunk per its pauseAfterMs (0 = no gap, e.g. the
 * last chunk). Silence duration/spacing is the only "prosody" control this
 * pipeline applies between chunks — see chunkText.js for how pauseAfterMs
 * is decided.
 *
 * @param {Array<{wavPath: string, pauseAfterMs: number}>} orderedChunks
 * @param {string} outputDir - scratch + final-output directory for this job
 * @returns {Promise<string>} absolute path to the final .mp3
 */
async function stitchAudio(orderedChunks, outputDir) {
  const listFilePath = path.join(outputDir, 'concat-list.txt');
  const listLines = [];

  for (let i = 0; i < orderedChunks.length; i++) {
    const { wavPath, pauseAfterMs } = orderedChunks[i];
    listLines.push(`file '${wavPath}'`);

    if (pauseAfterMs > 0) {
      const silencePath = path.join(outputDir, `silence-${i}.wav`);
      await generateSilence(silencePath, pauseAfterMs / 1000);
      listLines.push(`file '${silencePath}'`);
    }
  }

  await fsp.writeFile(listFilePath, listLines.join('\n'));

  const stitchedWavPath = path.join(outputDir, 'stitched.wav');
  await runFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listFilePath,
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    '-c:a', 'pcm_s16le',
    stitchedWavPath,
  ]);

  const finalMp3Path = path.join(outputDir, 'output.mp3');
  await runFfmpeg(['-y', '-i', stitchedWavPath, '-codec:a', 'libmp3lame', '-qscale:a', '2', finalMp3Path]);

  return finalMp3Path;
}

function generateSilence(outputPath, durationSeconds) {
  return runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=mono:sample_rate=${SAMPLE_RATE}`,
    '-t', String(durationSeconds),
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    let stderr = '';

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-2000)}`));
      }
    });
  });
}

module.exports = { stitchAudio };
