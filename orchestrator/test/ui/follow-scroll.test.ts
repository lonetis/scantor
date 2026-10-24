import { effectScope, nextTick, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import { useFollowScroll, type ScrollContainer } from '../../app/composables/useFollowScroll'

// "Follow log" (docs/ui.md §5.9, FEATURES UI-TASK-026): the build log and LogView stay at the bottom while
// following, also when they mount with their lines already loaded.

function box(scrollHeight: number, clientHeight = 100): ScrollContainer & { scrollHeight: number } {
  return { scrollTop: 0, scrollHeight, clientHeight }
}

async function flush(): Promise<void> {
  await nextTick()
  await nextTick()
}

describe('useFollowScroll', () => {
  it('opens at the end when the log mounts with its lines', async () => {
    const container = ref<ScrollContainer | null>(null)
    const scope = effectScope()
    scope.run(() => useFollowScroll(container, () => 500))
    // The template ref is set during the mount, after setup ran.
    container.value = box(2000)
    await flush()
    expect(container.value.scrollTop).toBe(2000)
    scope.stop()
  })

  it('follows new lines, pauses when scrolled up and resumes with the toggle', async () => {
    const element = box(1000)
    const container = ref<ScrollContainer | null>(element)
    const lines = ref(10)
    const scope = effectScope()
    const follow = scope.run(() => useFollowScroll(container, () => lines.value))!
    await flush()
    expect(element.scrollTop).toBe(1000)

    element.scrollHeight = 1500
    lines.value = 20
    await flush()
    expect(element.scrollTop).toBe(1500)

    element.scrollTop = 200
    follow.onScroll()
    expect(follow.follow.value).toBe(false)
    element.scrollHeight = 2000
    lines.value = 30
    await flush()
    expect(element.scrollTop).toBe(200)

    follow.toggleFollow()
    expect(follow.follow.value).toBe(true)
    expect(element.scrollTop).toBe(2000)

    element.scrollTop = 2000 - 100 - 10
    follow.onScroll()
    expect(follow.follow.value).toBe(true)
    scope.stop()
  })
})
