import styles from './ProgressBar.module.css'

interface Props {
  completed: number
  total: number
}

export function ProgressBar({ completed, total }: Props) {
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0

  return (
    <div className={styles.wrapper}>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
      <div className={styles.label}>
        {percent}% — chunk {completed} of {total}
      </div>
    </div>
  )
}
