package resolver

import (
	"encoding/binary"
	"fmt"
	"maps"
	"net"
	"net/netip"
	"testing"
)

func TestParseProcNet(t *testing.T) {
	addr := netip.MustParseAddrPort("127.0.0.1:53")
	if binary.NativeEndian.Uint16([]byte{1, 0}) == 1 && procNetAddr(addr) != "0100007F:0035" {
		t.Errorf("procNetAddr = %s", procNetAddr(addr))
	}
	other := procNetAddr(netip.MustParseAddrPort("127.0.0.1:5353"))
	a := procNetAddr(addr)
	udp := fmt.Sprintf(`  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops
  156: %[1]s 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 4001 2 0000000000000000 0
  157: %[1]s 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 4002 2 0000000000000000 0
  158: %[2]s 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 4003 2 0000000000000000 0
  159: %[1]s 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 0 2 0000000000000000 0
garbage
`, a, other)
	if got := parseProcNet([]byte(udp), addr, false); !maps.Equal(got, map[uint64]bool{4001: true, 4002: true}) {
		t.Errorf("udp = %v", got)
	}
	// TCP: only listening sockets (accepted connections share the local address).
	tcp := fmt.Sprintf(`  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: %[1]s 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5001 1 0000000000000000 100 0 0 10 0
   1: %[1]s 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 20 4 30 10 -1
`, a)
	if got := parseProcNet([]byte(tcp), addr, true); !maps.Equal(got, map[uint64]bool{5001: true}) {
		t.Errorf("tcp = %v", got)
	}
}

func TestDepartIndex(t *testing.T) {
	older := map[uint64]bool{1: true}
	cases := []struct {
		name   string
		others map[uint64]bool
		target uint32
		ok     bool
	}{
		{"alone", map[uint64]bool{}, 0, false},
		{"the resolver it bound next to still serves", map[uint64]bool{1: true}, steerFirst, true},
		{"a resolver bound after it", map[uint64]bool{2: true}, steerSecond, true},
	}
	for _, tc := range cases {
		if target, ok := departIndex(tc.others, older); target != tc.target || ok != tc.ok {
			t.Errorf("%s: %d %v", tc.name, target, ok)
		}
	}
	if target, ok := departIndex(map[uint64]bool{2: true}, map[uint64]bool{}); target != steerSecond || !ok {
		t.Errorf("first resolver: %d %v", target, ok)
	}
}

func TestAddressServed(t *testing.T) {
	addr := netip.MustParseAddrPort(freeAddr(t))
	if addressServed(addr) {
		t.Error("a free address is served")
	}
	pc, err := net.ListenPacket("udp4", addr.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	if !addressServed(addr) {
		t.Error("a bound address is not served")
	}
}
