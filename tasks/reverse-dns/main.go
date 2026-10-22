// Package main is the reverse-dns example task: a PTR lookup for every address of CIDR ranges. The
// cidr template is used unwrapped, so the scheduler expands the ranges natively.
package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"slices"
	"strings"
	"time"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/templates/cidr"
)

// TaskConfig is constant for all analyses of a scan.
type TaskConfig struct {
	Nameserver string `json:"nameserver" jsonschema:"default=,description=DNS server as host:port; empty uses the resolver of the worker container"`
	TimeoutMs  int    `json:"timeoutMs" jsonschema:"default=3000,minimum=100,maximum=30000,description=Timeout of one lookup in milliseconds"`
}

// Result lists the PTR names of one address.
type Result struct {
	Names []string `json:"names" jsonschema:"description=PTR names without the trailing dot; sorted"`
	Found bool     `json:"found" jsonschema:"description=Whether the address has at least one PTR record"`
}

func run(ctx scantor.Context, ac cidr.AnalysisConfig, tc TaskConfig) (Result, error) {
	if ac.Prefix != 32 && ac.Prefix != 128 {
		return Result{}, scantor.Fatal("reverse DNS needs single addresses; leave the scan config prefix unset")
	}
	resolver, err := newResolver(tc.Nameserver)
	if err != nil {
		return Result{}, scantor.Fatalf("invalid task config: %w", err)
	}
	lookupCtx, cancel := context.WithTimeout(ctx, time.Duration(tc.TimeoutMs)*time.Millisecond)
	defer cancel()
	names, err := resolver.LookupAddr(lookupCtx, ac.IP)
	var dnsErr *net.DNSError
	switch {
	case err == nil:
	case errors.As(err, &dnsErr) && dnsErr.IsNotFound:
		return Result{Names: []string{}, Found: false}, nil
	case errors.As(err, &dnsErr) && (dnsErr.IsTimeout || dnsErr.IsTemporary):
		// Transient resolver trouble: try again after the scan's backoff.
		return Result{}, scantor.Retry(err.Error(), 0)
	default:
		return Result{}, fmt.Errorf("PTR lookup of %s: %w", ac.IP, err)
	}
	for i, name := range names {
		names[i] = strings.TrimSuffix(name, ".")
	}
	slices.Sort(names)
	ctx.Log(scantor.LevelInfo, "resolved", "ip", ac.IP, "names", len(names))
	return Result{Names: names, Found: len(names) > 0}, nil
}

// newResolver returns Go's own resolver (identical behaviour in every image), optionally pinned to
// one nameserver.
func newResolver(nameserver string) (*net.Resolver, error) {
	if nameserver == "" {
		return &net.Resolver{PreferGo: true}, nil
	}
	if _, _, err := net.SplitHostPort(nameserver); err != nil {
		return nil, fmt.Errorf("nameserver %q: %w", nameserver, err)
	}
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, nameserver)
		},
	}, nil
}

func main() { scantor.Serve(cidr.Schedule, run) }
