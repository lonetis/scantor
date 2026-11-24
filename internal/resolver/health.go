package resolver

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// stateMaxAge is the age at which the state file (rewritten every second) counts as stale.
const stateMaxAge = 5 * time.Second

// Healthcheck reads the resolver's state file at path (`scantor node resolver healthcheck`, the
// container healthcheck). It returns the stats as one line of JSON, the health output the daemon
// parses, whenever the file is readable, and an error unless the resolver is healthy: the file is
// fresh, the resolver listens and its upstream check passes.
func Healthcheck(path string, now time.Time) ([]byte, error) {
	data, err := os.ReadFile(path) //nolint:gosec // the fixed state file path
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("the resolver has not written its state yet")
		}
		return nil, fmt.Errorf("read state file: %w", err)
	}
	var st Stats
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, errors.New("the state file is malformed")
	}
	line, err := json.Marshal(st)
	if err != nil {
		return nil, err
	}
	at, err := time.Parse(time.RFC3339Nano, st.At)
	switch {
	case err != nil:
		return line, errors.New("the state file has no valid time")
	case now.Sub(at) >= stateMaxAge:
		return line, fmt.Errorf("the state file is %s old", now.Sub(at).Round(time.Second))
	case !st.Ready:
		if st.Error != "" {
			return line, fmt.Errorf("the resolver does not listen on %s (%s)", st.Listen, st.Error)
		}
		return line, fmt.Errorf("the resolver does not listen on %s yet", st.Listen)
	case !st.UpstreamOK:
		return line, fmt.Errorf("no %s server answers (%s)", serversOf(st.Mode), st.UpstreamError)
	}
	return line, nil
}

func serversOf(mode string) string {
	if mode == ModeIterative {
		return "root"
	}
	return "upstream"
}
