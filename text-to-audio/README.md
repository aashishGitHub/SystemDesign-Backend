# Text to Audio

Convert a `.txt`/`.md` file (up to 100KB) into a natural-sounding `.mp3`, entirely offline using [Piper TTS](https://github.com/OHF-Voice/piper1-gpl) — no API keys, no cloud calls.

## Quick Start (Docker)

```bash
docker compose build
docker compose up
```

Open **http://localhost:3001**, drop in a text file, and download the generated audio once it's done.

## How it works

- The text is split into paragraphs/sentence-groups (`server/lib/chunkText.js`), each synthesized independently by the Piper CLI so up to 4 chunks process concurrently.
- Piper's own `--sentence-silence` flag paces sentences within a chunk; an explicit, longer silence is spliced in at paragraph boundaries (`server/lib/stitchAudio.js`, via `ffmpeg`).
- Progress is reported to the browser via long-polling (`GET /api/jobs/:id/status`) — the same pattern used in this repo's `long-polling-nodejs` demo.
- Playback speed (0.8x–1.5x) is applied client-side via the `<audio>` element's `playbackRate`, so it doesn't require re-synthesizing audio.

## Local development (without Docker)

Requires Node.js and `ffmpeg` on your PATH (`brew install ffmpeg`). Piper needs its own Python venv — on macOS, prefer Python 3.11 over the newest Homebrew Python (3.14 at time of writing): Piper's ML dependencies (e.g. `onnxruntime`) are much more likely to ship prebuilt wheels for 3.11, and Homebrew's Python enforces PEP 668, so a plain `pip install` into the system interpreter will fail anyway.

One-time setup, from `text-to-audio/`:

```bash
python3.11 -m venv .venv                 # use your Python 3.11, not the system default
.venv/bin/pip install piper-tts
mkdir -p piper-voices
.venv/bin/python3 -m piper.download_voices en_US-amy-medium --data-dir piper-voices
.venv/bin/python3 -m piper.download_voices en_US-ryan-medium --data-dir piper-voices
```

Then run the server, pointing it at that venv and voice directory:

```bash
cd server && npm install
PIPER_PYTHON="$(pwd)/../.venv/bin/python3" PIPER_DATA_DIR="$(pwd)/../piper-voices" npm run dev   # http://localhost:3001
```

```bash
cd client && npm install && npm run dev    # http://localhost:3000 (proxies /api to :3001)
```

## Tests

```bash
cd server && npm test
```

Runs unit tests (Node's built-in `node --test`) for the chunking and retry logic. There's no automated end-to-end test — verify the full pipeline manually:

1. `curl http://localhost:3001/health` → `{"status":"ok",...}`
2. Upload a short `.txt` through the UI, confirm the progress bar advances and the resulting audio has audible pauses at sentence/paragraph breaks.
3. Try an empty file, a non-`.txt`/`.md` file, and a ~100KB file to exercise the validation and performance paths.

## Scope notes

- **Voices**: two bundled Piper voices (`en_US-amy-medium` female, `en_US-ryan-medium` male). Both are baked into the Docker image at build time.
- **No pitch/emphasis synthesis on `!`**: Piper's CLI doesn't expose reliable per-word pitch control, so this app only varies *pause length* by punctuation/paragraph breaks rather than promising emphasis it can't deliver.
- **Local-only**: designed for `docker compose up` on your machine — no cloud deployment concerns (managed storage, TLS, autoscaling) are addressed here.
