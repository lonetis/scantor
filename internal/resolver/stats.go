package resolver

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/zmap/dns"
)

// counters are the cumulative counters of Stats.
type counters struct {
	queries         atomic.Int64
	cacheHits       atomic.Int64
	lookups         atomic.Int64
	inflight        atomic.Int64
	overloaded      atomic.Int64
	rateLimited     atomic.Int64
	timeouts        atomic.Int64
	tcpFallbackFail atomic.Int64
	panics          atomic.Int64
	budgetExceeded  atomic.Int64
	tcpRejected     atomic.Int64
	noError         atomic.Int64
	nxDomain        atomic.Int64
	servFail        atomic.Int64
	refused         atomic.Int64
	otherRcode      atomic.Int64
}

// countRcode counts one response sent to a client.
func (c *counters) countRcode(rcode int) {
	switch rcode {
	case dns.RcodeSuccess:
		c.noError.Add(1)
	case dns.RcodeNameError:
		c.nxDomain.Add(1)
	case dns.RcodeServerFailure:
		c.servFail.Add(1)
	case dns.RcodeRefused:
		c.refused.Add(1)
	default:
		c.otherRcode.Add(1)
	}
}

// fill copies the counters into st.
func (c *counters) fill(st *Stats) {
	st.Queries = c.queries.Load()
	st.CacheHits = c.cacheHits.Load()
	st.Lookups = c.lookups.Load()
	st.Inflight = c.inflight.Load()
	st.Overloaded = c.overloaded.Load()
	st.RateLimited = c.rateLimited.Load()
	st.Timeouts = c.timeouts.Load()
	st.TCPFallbackFail = c.tcpFallbackFail.Load()
	st.Panics = c.panics.Load()
	st.QueryBudgetExceeded = c.budgetExceeded.Load()
	st.TCPRejected = c.tcpRejected.Load()
	st.Rcodes = Rcodes{
		NoError:  c.noError.Load(),
		NXDomain: c.nxDomain.Load(),
		ServFail: c.servFail.Load(),
		Refused:  c.refused.Load(),
		Other:    c.otherRcode.Load(),
	}
}

// qpsWindow is the number of one-second samples the query rate averages over.
const qpsWindow = 10

// rateMeter turns the cumulative query count, sampled once per state write, into queries per second
// over the last qpsWindow samples.
type rateMeter struct {
	samples [qpsWindow + 1]struct {
		at      float64 // seconds
		queries int64
	}
	n, next int
}

func (r *rateMeter) observe(atSeconds float64, queries int64) float64 {
	r.samples[r.next].at, r.samples[r.next].queries = atSeconds, queries
	r.next = (r.next + 1) % len(r.samples)
	if r.n < len(r.samples) {
		r.n++
	}
	if r.n < 2 {
		return 0
	}
	oldest := r.samples[(r.next-r.n+len(r.samples))%len(r.samples)]
	dt := atSeconds - oldest.at
	if dt <= 0 {
		return 0
	}
	return float64(queries-oldest.queries) / dt
}

// conntrackFiles are the host's connection tracking counters; the resolver shares the host's network
// namespace, so they describe the host.
var conntrackFiles = [2]string{"/proc/sys/net/netfilter/nf_conntrack_count", "/proc/sys/net/netfilter/nf_conntrack_max"}

// readConntrack reads the host's connection tracking usage (zero when unreadable, for example
// without the nf_conntrack module).
func readConntrack(files [2]string) Conntrack {
	read := func(path string) int64 {
		data, err := os.ReadFile(path) //nolint:gosec // fixed procfs paths
		if err != nil {
			return 0
		}
		v, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
		if err != nil {
			return 0
		}
		return v
	}
	return Conntrack{Count: read(files[0]), Max: read(files[1])}
}

// writeState replaces the state file atomically (a temporary file renamed over it).
func writeState(path string, st Stats) error {
	data, err := json.Marshal(st)
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil { //nolint:gosec // the healthcheck exec reads it
		return fmt.Errorf("write state file: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".state-*")
	if err != nil {
		return fmt.Errorf("write state file: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op after the rename
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write state file: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil { //nolint:gosec // read by the healthcheck exec
		_ = tmp.Close()
		return fmt.Errorf("write state file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write state file: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("write state file: %w", err)
	}
	return nil
}
