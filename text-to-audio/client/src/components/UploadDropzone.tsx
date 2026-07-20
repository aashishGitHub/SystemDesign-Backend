import { useRef, useState } from 'react'
import styles from './UploadDropzone.module.css'

interface Props {
  onFileSelected: (file: File) => void
  disabled: boolean
}

const MAX_BYTES = 100 * 1024
// Rough throughput estimate for the "estimated processing time" hint only —
// actual time depends on CPU and text content, this is not a precise figure.
const ESTIMATED_BYTES_PER_SECOND = 200

export function UploadDropzone({ onFileSelected, disabled }: Props) {
  const [isDragOver, setIsDragOver] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleFile = (file: File | undefined) => {
    if (!file) return
    setSelectedFile(file)
    onFileSelected(file)
  }

  return (
    <div>
      <div
        className={`${styles.dropzone} ${isDragOver ? styles.dragOver : ''} ${disabled ? styles.disabled : ''}`}
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          if (!disabled) setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setIsDragOver(false)
          if (!disabled) handleFile(e.dataTransfer.files[0])
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".txt,.md"
          hidden
          disabled={disabled}
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
        <p className={styles.icon}>📄</p>
        <p className={styles.title}>Drag &amp; drop a .txt or .md file here</p>
        <p className={styles.subtitle}>or click to browse (max 100KB)</p>
      </div>

      {selectedFile && (
        <div className={styles.fileInfo}>
          <strong>{selectedFile.name}</strong> — {(selectedFile.size / 1024).toFixed(1)} KB
          {selectedFile.size > MAX_BYTES && <span className={styles.warning}> (exceeds 100KB limit)</span>}
          <div className={styles.estimate}>
            ~estimated processing time: {formatEstimate(selectedFile.size)}
          </div>
        </div>
      )}
    </div>
  )
}

function formatEstimate(bytes: number): string {
  const seconds = Math.ceil(bytes / ESTIMATED_BYTES_PER_SECOND)
  if (seconds < 60) return `${seconds}s`
  return `${Math.ceil(seconds / 60)} min`
}
