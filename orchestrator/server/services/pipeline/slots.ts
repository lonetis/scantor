import { useConfig } from '../../utils/config'
import { Semaphore } from '../helpers/concurrency'

// Build slots (docs/tasks.md §9.10): revision builds and test-run builds share SCANTOR_BUILD_CONCURRENCY concurrent
// `scantor task build` subprocesses, served FIFO.

let slots: Semaphore | null = null

export function useBuildSlots(): Semaphore {
  slots ??= new Semaphore(useConfig().buildConcurrency)
  return slots
}

/** Test seam. */
export function setBuildSlotsForTesting(value: Semaphore | null): void {
  slots = value
}
