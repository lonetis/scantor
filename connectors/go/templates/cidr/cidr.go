// Package cidr is the typed proxy of the template cidr: one analysis per IP address (or per subnet
// of length Prefix) of IPv4/IPv6 CIDR ranges, minus exclusions, IPv4 before IPv6 in ascending order.
package cidr

import (
	"iter"

	scantor "github.com/lonetis/scantor/connectors/go"
	"github.com/lonetis/scantor/connectors/go/internal/proxy"
)

// ScanConfig selects the ranges. Zero values of Cidrs and MaxAnalyses mean the defaults.
type ScanConfig struct {
	// Cidrs are CIDR ranges or single addresses (IPv4 or IPv6). Host bits are cleared.
	Cidrs []string `json:"cidrs,omitempty" jsonschema:"minItems=1,maxItems=1000,minLength=2,maxLength=49,default=192.0.2.0/29,description=CIDR ranges or single addresses (IPv4 or IPv6). Host bits are cleared."`
	// Exclude lists ranges or addresses never to emit (in subnet mode: subnets that intersect an
	// exclusion are skipped).
	Exclude []string `json:"exclude,omitempty" jsonschema:"maxItems=1000,minLength=2,maxLength=49,default=[],description=CIDR ranges or addresses never to emit (in subnet mode: subnets that intersect an exclusion are skipped)."`
	// Prefix is nil for one analysis per address; otherwise one analysis per subnet of this length.
	Prefix *int `json:"prefix,omitempty" jsonschema:"minimum=0,maximum=128,default=null,description=null = one analysis per address; otherwise one analysis per subnet of this length (each cidr must be at least that large; ≤ 32 when any IPv4 range is present)."`
	// MaxAnalyses is the required safety cap: the scan is rejected when the expansion is larger.
	MaxAnalyses int `json:"maxAnalyses,omitempty" jsonschema:"minimum=1,maximum=100000000,default=65536,description=Required safety cap: the scan is rejected when the expansion is larger."`
}

// AnalysisConfig is one address or subnet.
type AnalysisConfig struct {
	// IP is the address, or the network address of the subnet (RFC 5952 text form for IPv6).
	IP string `json:"ip" jsonschema:"required,minLength=2,maxLength=39,description=Address\\, or network address of the subnet (RFC 5952 text form for IPv6)."`
	// Prefix is 32/128 for single addresses, otherwise the subnet length.
	Prefix int `json:"prefix" jsonschema:"required,minimum=0,maximum=128,description=32/128 for single addresses\\, otherwise the subnet length."`
	// Version is the IP version, 4 or 6.
	Version int `json:"version" jsonschema:"required,enum=4,enum=6,description=IP version."`
}

// Schedule yields the addresses or subnets. Pass it unwrapped (scantor.Serve(cidr.Schedule, run)) or
// iterate it inside a custom schedule; the task config argument is ignored.
func Schedule[TC any](ctx scantor.Context, scanConfig ScanConfig, _ TC) iter.Seq2[AnalysisConfig, error] {
	return proxy.Schedule[AnalysisConfig](ctx, "cidr", scanConfig)
}
