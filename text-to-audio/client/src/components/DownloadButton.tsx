import styles from './DownloadButton.module.css'

interface Props {
  jobId: string | null
  ready: boolean
}

export function DownloadButton({ jobId, ready }: Props) {
  if (!ready || !jobId) {
    return (
      <button className={styles.button} disabled>
        Download audio
      </button>
    )
  }

  return (
    <a className={styles.button} href={`/api/jobs/${jobId}/audio`} download="audio.mp3">
      Download audio
    </a>
  )
}
