package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"time"
)

// TimeLayout is the timestamp format of the REST API: ISO 8601 UTC with milliseconds.
const TimeLayout = "2006-01-02T15:04:05.000Z07:00"

// Time is a timestamp that encodes as an ISO 8601 UTC string with milliseconds
// ("2026-10-21T09:01:00.000Z", docs/api.md §1.6) and decodes any RFC 3339 timestamp. Nullable fields use
// *Time; a JSON null decodes into the zero Time.
type Time struct{ time.Time }

// NewTime wraps t.
func NewTime(t time.Time) Time { return Time{t} }

// TimePtr returns a pointer to NewTime(t), for nullable fields.
func TimePtr(t time.Time) *Time { v := NewTime(t); return &v }

// Now returns the current time.
func Now() Time { return Time{time.Now()} }

// MarshalJSON encodes the time in UTC with exactly three fractional digits.
func (t Time) MarshalJSON() ([]byte, error) {
	return []byte(`"` + t.UTC().Format(TimeLayout) + `"`), nil
}

// UnmarshalJSON decodes an RFC 3339 string or null.
func (t *Time) UnmarshalJSON(b []byte) error {
	if bytes.Equal(b, []byte("null")) {
		*t = Time{}
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("timestamp must be a string: %w", err)
	}
	parsed, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return fmt.Errorf("invalid timestamp %q: %w", s, err)
	}
	t.Time = parsed
	return nil
}

// String renders the API format.
func (t Time) String() string { return t.UTC().Format(TimeLayout) }

// EpochMs converts epoch milliseconds (serverTime) to a time.
func EpochMs(ms int64) time.Time { return time.UnixMilli(ms) }

// ClockOffset returns serverTime + rtt/2 − localNow, the offset to add to the local clock to obtain the
// orchestrator's clock (docs/api.md §7). sent and received are the local times around the request.
func ClockOffset(serverTimeMs int64, sent, received time.Time) time.Duration {
	rtt := received.Sub(sent)
	server := time.UnixMilli(serverTimeMs).Add(rtt / 2)
	return server.Sub(received)
}
