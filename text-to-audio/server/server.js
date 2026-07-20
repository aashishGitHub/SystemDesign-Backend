const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const { chunkText } = require('./lib/chunkText');
const { withRetry } = require('./lib/withRetry');
const { synthesizeChunk } = require('./lib/piperSynthesize');
const { stitchAudio } = require('./lib/stitchAudio');
const jobManager = require('./lib/jobManager');

const app = express();
const PORT = process.env.PORT || 3001;

const MAX_FILE_BYTES = 100 * 1024; // 100KB, per plan
const LONG_POLL_TIMEOUT_MS = 10000;
const CONCURRENCY = 4;

// Piper voices baked into the Docker image (see Dockerfile). Names follow
// Piper's own convention (rhasspy/piper-voices on Hugging Face) — verified
// against the current VOICES.md at build time, not guessed.
const VOICES = {
  female: 'en_US-amy-medium',
  male: 'en_US-ryan-medium',
};
const DEFAULT_VOICE = 'female';

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES + 1024 }, // small cushion so we can return a clean error instead of a raw multer crash
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Upload a .txt/.md file and kick off async TTS conversion.
 * Responds immediately with a jobId; progress is tracked via long-polling.
 */
app.post('/api/convert', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded (expected multipart field "file")' });
  }

  const filename = req.file.originalname || '';
  const isTextFile = /\.(txt|md)$/i.test(filename);
  if (!isTextFile) {
    return res.status(400).json({ error: 'Only .txt or .md files are supported' });
  }

  if (req.file.size > MAX_FILE_BYTES) {
    return res.status(400).json({ error: `File exceeds the ${MAX_FILE_BYTES / 1024}KB limit` });
  }

  let text;
  try {
    text = req.file.buffer.toString('utf8');
    if (Buffer.from(text, 'utf8').length !== req.file.buffer.length) {
      throw new Error('not valid utf-8');
    }
  } catch (err) {
    return res.status(400).json({ error: 'File is not valid UTF-8 text' });
  }

  if (!text.trim()) {
    return res.status(400).json({ error: 'File is empty' });
  }

  const voiceKey = VOICES[req.body.voice] ? req.body.voice : DEFAULT_VOICE;
  const voice = VOICES[voiceKey];

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return res.status(400).json({ error: 'File has no readable text content' });
  }

  const job = jobManager.createJob(chunks.length);
  console.log(`[${new Date().toISOString()}] Job ${job.id} created: ${chunks.length} chunks, voice=${voiceKey}`);

  processJob(job, chunks, voice).catch((err) => {
    console.error(`[${new Date().toISOString()}] Job ${job.id} crashed: ${err.message}`);
    jobManager.markError(job.id, err.message);
  });

  res.status(202).json({ jobId: job.id, totalChunks: chunks.length });
});

/**
 * Long-polling status endpoint, mirroring the pattern in
 * long-polling-nodejs/server/server.js: hold the connection open until the
 * job's progress differs from what the client already knows, or time out.
 */
app.get('/api/jobs/:id/status', (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found (it may have expired)' });
  }

  const known = Number(req.query.known ?? -1);

  const sendState = () => {
    res.json({
      status: job.status,
      total: job.total,
      completed: job.completed,
      error: job.error,
    });
  };

  const hasNewState = () => job.status !== 'processing' || job.completed !== known;

  if (hasNewState()) {
    return sendState();
  }

  const timeoutId = setTimeout(() => {
    cleanup();
    sendState();
  }, LONG_POLL_TIMEOUT_MS);

  function onUpdate(updatedId) {
    if (updatedId !== job.id || !hasNewState()) return;
    cleanup();
    sendState();
  }

  function cleanup() {
    clearTimeout(timeoutId);
    jobManager.emitter.off('update', onUpdate);
  }

  jobManager.emitter.on('update', onUpdate);
  req.on('close', cleanup);
});

/**
 * Download the finished audio file.
 */
app.get('/api/jobs/:id/audio', (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found (it may have expired)' });
  }
  if (job.status !== 'done') {
    return res.status(409).json({ error: `Job is not ready (status: ${job.status})` });
  }
  res.download(job.outputPath, 'audio.mp3');
});

/**
 * Runs Piper over every chunk with bounded concurrency, then stitches the
 * results into the final audio file.
 */
async function processJob(job, chunks, voice) {
  let nextIndex = 0;
  const results = new Array(chunks.length);

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= chunks.length) return;

      const chunk = chunks[i];
      const wavPath = path.join(job.dir, `chunk-${String(i).padStart(5, '0')}.wav`);

      try {
        await withRetry(() => synthesizeChunk({ text: chunk.text, outputPath: wavPath, voice }));
      } catch (err) {
        const snippet = chunk.text.slice(0, 60);
        throw new Error(`chunk ${i} ("${snippet}${chunk.text.length > 60 ? '…' : ''}") failed: ${err.message}`);
      }

      results[i] = { wavPath, pauseAfterMs: chunk.pauseAfterMs };
      jobManager.incrementCompleted(job.id);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

  const finalPath = await stitchAudio(results, job.dir);
  jobManager.markDone(job.id, finalPath);
  console.log(`[${new Date().toISOString()}] Job ${job.id} done: ${finalPath}`);
}

// Serve the built React SPA in production (see Dockerfile) so the whole app
// runs as a single container/process.
const clientDist = path.join(__dirname, 'public');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health') return next();
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║  Text-to-Audio Server Started                                ║
╠════════════════════════════════════════════════════════════╣
║  Port: ${PORT}                                                    ║
║  Health: http://localhost:${PORT}/health                          ║
║  Convert: POST http://localhost:${PORT}/api/convert                ║
╚════════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  console.log('\nShutting down gracefully...');
  server.close(() => process.exit(0));
});
