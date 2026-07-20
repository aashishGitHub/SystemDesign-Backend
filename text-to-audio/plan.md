You are an expert full-stack developer specializing in audio systems and cloud architecture. Build a complete, production-ready text-to-speech (TTS) web application with the following requirements:

## Core Requirements
- **Input**: User uploads .txt or .md files (up to 100KB)
- **Output**: High-quality audio file (.wav or .mp3) with natural human voice
- **Voice Modulation**: Pause at sentence/paragraph boundaries, natural prosody, emphasis on punctuation
- **Interface**: Modern, intuitive web UI with progress tracking
- **Architecture**: Express.js backend + React frontend, Docker ready

## Technical Constraints
- Use Piper TTS (free, no API keys) OR ElevenLabs (if API key available) for voice quality
- Prefer Piper for cost-free solution with good voice modulation
- Handle files up to 100KB characters efficiently (chunk into sentences)
- Concurrent processing for speed (3-4 parallel TTS requests)
- Automatic error recovery and retry logic

## Deliverables
1. **package.json** - Dependencies for Express + React setup
2. **server.js** - Backend API (chunking, TTS processing, CORS support)
3. **App.jsx** - React frontend with upload, progress bar, download
4. **index.html** - Entry point
5. **index.css** - Modern, clean styling (dark mode support)
6. **docker-compose.yml** - Ready-to-run with Piper TTS + Express
7. **Quick Start Guide** - 3 commands to run locally

## Code Quality Standards
- Follow SOLID principles (Single Responsibility, Open/Closed, Liskov Substitution)
- DRY (Don't Repeat Yourself) - reusable chunking logic
- Proper error handling with user-friendly messages
- Input validation (file size, text length)
- Structured logging for debugging
- Comments explaining architecture decisions

## UI/UX Specifics
- Drag-and-drop file upload zone
- Real-time progress indicator (percentage + chunk count)
- Voice/speed selection dropdown (if Piper supports multiple)
- Download button (disabled until audio ready)
- Display file size and estimated processing time
- Handle edge cases: empty files, corrupted text, network errors
- Mobile responsive (works on tablet + phone)

## Voice Modulation Features
- **Pauses**: Add 200-500ms silence at sentence boundaries (. ! ?)
- **Prosody**: Exclamation marks = higher emphasis, ellipsis = longer pauses
- **Speed**: Adjustable playback speed slider (0.8x - 1.5x)
- **Voice Gender**: Dropdown to switch between male/female voices if available

## Performance Targets
- Upload processing: < 100ms
- TTS conversion for 70K chars: < 15 minutes
- Concurrent chunk processing: 3-4 workers max
- Memory footprint: < 500MB

## Deployment Ready
- Supports both localhost testing and cloud deployment (AWS, DigitalOcean, Railway)
- Environment variables for API endpoints
- Proper CORS headers
- Health check endpoint
- Graceful shutdown handling

Build the complete, working solution. Every file should be production-grade with proper error boundaries, logging, and user feedback. Make the UI beautiful and intuitive - someone non-technical should be able to upload a text file and download audio without help.