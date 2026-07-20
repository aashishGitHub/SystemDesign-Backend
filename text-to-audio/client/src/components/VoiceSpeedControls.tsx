import styles from './VoiceSpeedControls.module.css'

export type VoiceOption = 'female' | 'male'

interface Props {
  voice: VoiceOption
  onVoiceChange: (voice: VoiceOption) => void
  speed: number
  onSpeedChange: (speed: number) => void
  disabled: boolean
}

export function VoiceSpeedControls({ voice, onVoiceChange, speed, onSpeedChange, disabled }: Props) {
  return (
    <div className={styles.row}>
      <label className={styles.field}>
        <span>Voice</span>
        <select
          value={voice}
          disabled={disabled}
          onChange={(e) => onVoiceChange(e.target.value as VoiceOption)}
        >
          <option value="female">Female (Amy)</option>
          <option value="male">Male (Ryan)</option>
        </select>
      </label>

      <label className={styles.field}>
        <span>Playback speed: {speed.toFixed(2)}x</span>
        <input
          type="range"
          min={0.8}
          max={1.5}
          step={0.05}
          value={speed}
          onChange={(e) => onSpeedChange(Number(e.target.value))}
        />
      </label>
    </div>
  )
}
