package runner

import (
	"bufio"
	"bytes"
	"os"
	"strconv"
)

// memoryEvents is the cgroup v2 memory event counter file of the container.
const memoryEvents = "/sys/fs/cgroup/memory.events"

// oomKills returns the container's oom_kill counter, or -1 when it cannot be read (best effort,
// docs/runtime.md §8.6).
func oomKills() int64 {
	data, err := os.ReadFile(memoryEvents)
	if err != nil {
		return -1
	}
	s := bufio.NewScanner(bytes.NewReader(data))
	for s.Scan() {
		if v, ok := bytes.CutPrefix(s.Bytes(), []byte("oom_kill ")); ok {
			n, err := strconv.ParseInt(string(v), 10, 64)
			if err != nil {
				return -1
			}
			return n
		}
	}
	return -1
}
