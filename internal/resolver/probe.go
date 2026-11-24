package resolver

import (
	"context"
	"errors"
	"net"
	"strings"
	"time"
)

// Errors of a failed probe (ProbeResult.Error).
const (
	// ProbeErrTimeout: no answer in time.
	ProbeErrTimeout = "timeout"
	// ProbeErrNotFound: the name does not exist or has no TXT record (another server answered).
	ProbeErrNotFound = "notFound"
	// ProbeErrFailed: the lookup failed (SERVFAIL, REFUSED, no server).
	ProbeErrFailed = "failed"
	// ProbeErrBadAnswer: a TXT answer without the resolver's marker.
	ProbeErrBadAnswer = "badAnswer"
)

// Probe looks up ProbeName (TXT) through r, in the probe container the system resolver: Docker's
// embedded DNS, which forwards to the worker network's gateway, exactly the path of the workers'
// lookups. The node and spec of the answering resolver are part of the result.
func Probe(ctx context.Context, r *net.Resolver) ProbeResult {
	start := time.Now()
	txts, err := r.LookupTXT(ctx, ProbeName)
	ms := time.Since(start).Milliseconds()
	if err != nil {
		var de *net.DNSError
		switch {
		case errors.Is(err, context.DeadlineExceeded), errors.As(err, &de) && de.IsTimeout:
			return ProbeResult{Error: ProbeErrTimeout, MS: ms}
		case errors.As(err, &de) && de.IsNotFound:
			return ProbeResult{Error: ProbeErrNotFound, MS: ms}
		}
		return ProbeResult{Error: ProbeErrFailed, MS: ms}
	}
	for _, txt := range txts {
		node, spec, ok := parseProbeAnswer(txt)
		if ok {
			return ProbeResult{OK: true, Node: node, Spec: spec, MS: ms}
		}
	}
	return ProbeResult{Error: ProbeErrBadAnswer, MS: ms}
}

// parseProbeAnswer reads "scantor-resolver node=<id> spec=<hash>".
func parseProbeAnswer(txt string) (node, spec string, ok bool) {
	fields := strings.Fields(txt)
	if len(fields) != 3 || fields[0] != ProbeAnswerPrefix {
		return "", "", false
	}
	node, okNode := strings.CutPrefix(fields[1], "node=")
	spec, okSpec := strings.CutPrefix(fields[2], "spec=")
	if !okNode || !okSpec || node == "" || spec == "" {
		return "", "", false
	}
	return node, spec, true
}
