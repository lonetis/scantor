import { nextTick, ref, watch, type Ref } from 'vue'

// "Follow log" of LogView and BuildLog (docs/ui.md §5.9): while following, the view stays at the bottom as lines
// arrive, including the lines a log mounts with (a build log read before its revision); scrolling up pauses
// following and scrolling back to the bottom resumes it.

export interface ScrollContainer {
  scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** Distance from the bottom that still counts as "at the bottom". */
export const FOLLOW_BOTTOM_TOLERANCE_PX = 24

export function useFollowScroll(container: Readonly<Ref<ScrollContainer | null | undefined>>, lineCount: () => number) {
  const follow = ref(true)

  function scrollToEnd(): void {
    const element = container.value
    if (element) element.scrollTop = element.scrollHeight
  }

  // `immediate`: the first run waits for the mount, so a log that already has its lines opens at the end too.
  watch(lineCount, async () => {
    if (!follow.value) return
    await nextTick()
    scrollToEnd()
  }, { immediate: true, flush: 'post' })

  function onScroll(): void {
    const element = container.value
    if (!element) return
    follow.value = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_BOTTOM_TOLERANCE_PX
  }

  function toggleFollow(): void {
    follow.value = !follow.value
    if (follow.value) scrollToEnd()
  }

  return { follow, onScroll, toggleFollow }
}
