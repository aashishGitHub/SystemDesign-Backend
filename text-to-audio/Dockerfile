# --- Stage 1: build the React (Vite) client -------------------------------
FROM node:20-slim AS client-builder
WORKDIR /app/client
COPY client/package.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# --- Stage 2: Express server + Piper TTS + ffmpeg, serving the built SPA ---
FROM node:20-slim
WORKDIR /app/server

# python3-venv: Piper (piper-tts) is a pip package; a venv avoids Debian's
# PEP 668 "externally managed environment" restriction on system Python.
# ffmpeg: used to stitch per-chunk wav files into the final audio file.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/piper-venv \
    && /opt/piper-venv/bin/pip install --no-cache-dir piper-tts

ENV PIPER_PYTHON=/opt/piper-venv/bin/python3
ENV PIPER_DATA_DIR=/opt/piper-voices

# Bake voices in at build time (verified against OHF-Voice/piper1-gpl's
# download_voices.py: --data-dir is a real flag, default is cwd) so the
# container never needs network access at runtime. Female (Amy) + male
# (Ryan) cover the voice-gender dropdown.
RUN mkdir -p /opt/piper-voices && \
    /opt/piper-venv/bin/python3 -m piper.download_voices en_US-amy-medium --data-dir /opt/piper-voices && \
    /opt/piper-venv/bin/python3 -m piper.download_voices en_US-ryan-medium --data-dir /opt/piper-voices

COPY server/package.json ./
RUN npm install --omit=dev
COPY server/ ./
COPY --from=client-builder /app/client/dist ./public

ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
