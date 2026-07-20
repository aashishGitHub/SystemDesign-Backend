import { useEffect, useRef, useState } from 'react'
import { UploadDropzone } from './components/UploadDropzone'
import { ProgressBar } from './components/ProgressBar'
import { VoiceSpeedControls, VoiceOption } from './components/VoiceSpeedControls'
import { DownloadButton } from './components/DownloadButton'
import { useJobPolling } from './hooks/useJobPolling'
import styles from './App.module.css'

function App() {
  const [file, setFile] = useState<File | null>(null)
  const [voice, setVoice] = useState<VoiceOption>('female')
  const [speed, setSpeed] = useState(1.0)
  const [jobId, setJobId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  const job = useJobPolling(jobId)
  const isProcessing = jobId !== null && job.status === 'processing'
  const isDone = job.status === 'done'

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = speed
    }
  }, [speed, isDone])

  const handleConvert = async () => {
    if (!file) return
    setUploadError(null)
    setJobId(null)
    setIsSubmitting(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('voice', voice)

      const res = await fetch('/api/convert', { method: 'POST', body: formData })
      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || `Upload failed (HTTP ${res.status})`)
      }

      setJobId(data.jobId)
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  const errorMessage = uploadError || (job.status === 'error' ? job.error : null)
  const canConvert = file !== null && file.size <= 100 * 1024 && !isSubmitting && !isProcessing

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1>🔊 Text to Audio</h1>
        <p className={styles.subtitle}>Upload a .txt or .md file, get back natural-sounding audio — fully offline via Piper TTS.</p>
      </header>

      <div className={styles.card}>
        <UploadDropzone onFileSelected={setFile} disabled={isSubmitting || isProcessing} />

        <VoiceSpeedControls
          voice={voice}
          onVoiceChange={setVoice}
          speed={speed}
          onSpeedChange={setSpeed}
          disabled={isSubmitting || isProcessing}
        />

        <button className={styles.convertButton} onClick={handleConvert} disabled={!canConvert}>
          {isSubmitting ? 'Uploading…' : 'Convert to audio'}
        </button>

        {errorMessage && <p className={styles.error}>⚠️ {errorMessage}</p>}

        {jobId && job.total > 0 && (job.status === 'processing' || job.status === 'done') && (
          <ProgressBar completed={job.completed} total={job.total} />
        )}

        {isDone && (
          <div className={styles.result}>
            <audio ref={audioRef} controls src={`/api/jobs/${jobId}/audio`} className={styles.audio} />
            <DownloadButton jobId={jobId} ready={isDone} />
          </div>
        )}
      </div>
    </div>
  )
}

export default App
