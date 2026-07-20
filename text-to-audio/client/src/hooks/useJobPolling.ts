import { useEffect, useRef, useState } from 'react'

export type JobStatus = 'processing' | 'done' | 'error'

export interface JobState {
  status: JobStatus
  total: number
  completed: number
  error: string | null
}

const INITIAL_STATE: JobState = { status: 'processing', total: 0, completed: 0, error: null }

/**
 * Long-polling hook for job progress, adapted from
 * long-polling-nodejs/client/src/hooks/useLongPolling.ts: it re-invokes
 * itself immediately after each response, using an AbortController for
 * cleanup, and stops once the job reaches a terminal status.
 */
export function useJobPolling(jobId: string | null): JobState {
  const [state, setState] = useState<JobState>(INITIAL_STATE)
  const knownRef = useRef(-1)

  useEffect(() => {
    if (!jobId) {
      setState(INITIAL_STATE)
      return
    }

    let cancelled = false
    let retryTimeout: ReturnType<typeof setTimeout> | undefined
    let abortController: AbortController | undefined
    knownRef.current = -1
    setState(INITIAL_STATE)

    const poll = async () => {
      if (cancelled) return
      abortController = new AbortController()

      try {
        const res = await fetch(`/api/jobs/${jobId}/status?known=${knownRef.current}`, {
          signal: abortController.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        const data: JobState = await res.json()
        if (cancelled) return

        setState(data)
        knownRef.current = data.completed

        if (data.status === 'processing') {
          poll()
        }
      } catch (err) {
        if (cancelled || (err as Error).name === 'AbortError') return
        retryTimeout = setTimeout(poll, 2000)
      }
    }

    poll()

    return () => {
      cancelled = true
      abortController?.abort()
      if (retryTimeout) clearTimeout(retryTimeout)
    }
  }, [jobId])

  return state
}
