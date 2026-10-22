// Package envconf implements the environment value syntax shared by every scantor component
// (docs/architecture.md §10) and a small Reader that each component's single LoadConfig uses.
//
// Value syntax:
//   - booleans: exactly "true" or "false";
//   - lists: comma-separated, whitespace trimmed, empty entries dropped;
//   - durations: Go duration syntax ("500ms", "30s", "15m", "24h"), never negative;
//   - byte sizes: a non-negative integer with an optional binary suffix KiB, MiB, GiB or TiB;
//   - *_DAYS: whole, non-negative days;
//   - PEM certificate bundles (SCANTOR_CA_CERT): one or more certificates; a value written on one line
//     with literal \n escapes (as .env.example shows) is accepted too.
//
// No package other than a component's LoadConfig reads the environment; LoadConfig receives a getenv
// function so it stays testable.
package envconf

import (
	"crypto/x509"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Binary size units.
const (
	KiB int64 = 1 << 10
	MiB int64 = 1 << 20
	GiB int64 = 1 << 30
	TiB int64 = 1 << 40
)

// ParseBool parses "true" or "false" (surrounding whitespace ignored). Anything else is an error, so a
// typo such as "yes" never silently changes a security setting.
func ParseBool(s string) (bool, error) {
	switch strings.TrimSpace(s) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, errors.New("invalid boolean: use true or false")
	}
}

// ParseList splits a comma-separated list, trims every entry and drops empty entries. It never fails.
func ParseList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// ParseDuration parses Go duration syntax and rejects negative values.
func ParseDuration(s string) (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimSpace(s))
	if err != nil {
		return 0, errors.New("invalid duration: use Go syntax such as 500ms, 30s, 15m or 24h")
	}
	if d < 0 {
		return 0, errors.New("invalid duration: must not be negative")
	}
	return d, nil
}

var byteSizePattern = regexp.MustCompile(`^([0-9]+)(KiB|MiB|GiB|TiB)?$`)

// ParseByteSize parses a non-negative integer with an optional binary suffix (KiB, MiB, GiB, TiB).
func ParseByteSize(s string) (int64, error) {
	m := byteSizePattern.FindStringSubmatch(strings.TrimSpace(s))
	if m == nil {
		return 0, errors.New("invalid byte size: use an integer with an optional KiB, MiB, GiB or TiB suffix")
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, errors.New("invalid byte size: too large")
	}
	unit := int64(1)
	switch m[2] {
	case "KiB":
		unit = KiB
	case "MiB":
		unit = MiB
	case "GiB":
		unit = GiB
	case "TiB":
		unit = TiB
	}
	if n > math.MaxInt64/unit {
		return 0, errors.New("invalid byte size: too large")
	}
	return n * unit, nil
}

// FormatByteSize renders a byte count with the largest binary suffix that divides it exactly.
func FormatByteSize(n int64) string {
	for _, u := range []struct {
		size   int64
		suffix string
	}{{TiB, "TiB"}, {GiB, "GiB"}, {MiB, "MiB"}, {KiB, "KiB"}} {
		if n != 0 && n%u.size == 0 {
			return strconv.FormatInt(n/u.size, 10) + u.suffix
		}
	}
	return strconv.FormatInt(n, 10)
}

// ParseInt parses a decimal integer.
func ParseInt(s string) (int64, error) {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil {
		var numErr *strconv.NumError
		if errors.As(err, &numErr) && errors.Is(numErr.Err, strconv.ErrRange) {
			return 0, errors.New("invalid integer: out of range")
		}
		return 0, errors.New("invalid integer")
	}
	return n, nil
}

// ParseFloat parses a decimal number.
func ParseFloat(s string) (float64, error) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, errors.New("invalid number")
	}
	return f, nil
}

// ParseDays parses a whole, non-negative number of days.
func ParseDays(s string) (int, error) {
	n, err := ParseInt(s)
	if err != nil {
		return 0, errors.New("invalid number of days")
	}
	if n < 0 || n > math.MaxInt32 {
		return 0, errors.New("invalid number of days: must be a whole, non-negative number")
	}
	return int(n), nil
}

// ParsePEMCertificates validates a PEM bundle of one or more certificates and returns it normalised: a
// value without real newlines has its literal "\n" escapes turned into newlines, so the one-line form of
// .env files also works where no tool expanded the escapes (a shell export, docker run -e).
func ParsePEMCertificates(s string) (string, error) {
	s = strings.TrimSpace(s)
	if !strings.ContainsRune(s, '\n') {
		s = strings.ReplaceAll(s, `\n`, "\n")
	}
	if !x509.NewCertPool().AppendCertsFromPEM([]byte(s)) {
		return "", errors.New("contains no valid PEM certificate")
	}
	return s + "\n", nil
}
