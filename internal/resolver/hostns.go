package resolver

import (
	"bufio"
	"bytes"
	"net"
	"net/netip"
	"os"
	"slices"
	"strings"
)

// HostResolvConf is the file of the host nameservers: the resolver runs on the host network, where
// Docker gives the container a copy of the host's /etc/resolv.conf (a daemon-level dns setting
// replaces its nameservers).
const HostResolvConf = "/etc/resolv.conf"

// maxHostNameservers bounds the host nameservers taken from resolv.conf.
const maxHostNameservers = 16

// families tells which address families the node has outside loopback and link-local addresses.
type families struct{ v4, v6 bool }

// familiesOf derives the families from the interface addresses.
func familiesOf(addrs []netip.Addr) families {
	var f families
	for _, a := range addrs {
		if a.IsLoopback() || a.IsLinkLocalUnicast() {
			continue
		}
		if a.Is4() {
			f.v4 = true
		} else {
			f.v6 = true
		}
	}
	return f
}

// parseResolvConf returns the nameservers of a resolv.conf (port 53). It drops zoned and IPv6
// link-local addresses, which cannot be dialled without an interface, and non-loopback addresses of a
// family the node has no address of. IPv4 link-local nameservers stay: a cloud's metadata DNS server
// (169.254.169.254 on GCE) is often the only one.
func parseResolvConf(data []byte, have families) []netip.AddrPort {
	var out []netip.AddrPort
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 || fields[0] != "nameserver" {
			continue
		}
		if strings.Contains(fields[1], "%") {
			continue
		}
		a, err := netip.ParseAddr(fields[1])
		if err != nil {
			continue
		}
		a = a.Unmap()
		switch {
		case a.Is6() && a.IsLinkLocalUnicast(), a.IsUnspecified(), a.IsMulticast():
			continue
		case !a.IsLoopback() && a.Is4() && !have.v4, !a.IsLoopback() && a.Is6() && !have.v6:
			continue
		}
		ap := netip.AddrPortFrom(a, 53)
		if !slices.Contains(out, ap) && len(out) < maxHostNameservers {
			out = append(out, ap)
		}
	}
	return out
}

// readHostNameservers reads the host nameservers from path.
func readHostNameservers(path string, have families) ([]netip.AddrPort, error) {
	data, err := os.ReadFile(path) //nolint:gosec // the configured resolv.conf path
	if err != nil {
		return nil, err
	}
	return parseResolvConf(data, have), nil
}

// interfaceAddrs returns the addresses of the node's interfaces.
func interfaceAddrs() ([]netip.Addr, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok {
			if ip, ok := netip.AddrFromSlice(n.IP); ok {
				out = append(out, ip.Unmap())
			}
		}
	}
	return out, nil
}
