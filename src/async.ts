/**
 * Small async helpers shared by the foreground tools and the background watcher.
 * @module dsh-plugin-jules/async
 */

/**
 * Sleep, rejecting as soon as the caller cancels.
 * @param ms - milliseconds to wait.
 * @param signal - cancellation signal.
 * @returns settlement after the delay, or on cancellation.
 */
export async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
