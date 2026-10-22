package cidr

import (
	"encoding/binary"
	"math/big"
	"math/bits"
	"net/netip"
)

// u128 is an unsigned 128-bit integer: an IPv6 address, or an IPv4 address in the low 32 bits.
type u128 struct{ hi, lo uint64 }

var maxU128 = u128{hi: ^uint64(0), lo: ^uint64(0)}

// lowMask returns 2^k − 1 for k in 0…128.
func lowMask(k int) u128 {
	switch {
	case k <= 0:
		return u128{}
	case k < 64:
		return u128{lo: 1<<uint(k) - 1}
	case k < 128:
		return u128{hi: 1<<uint(k-64) - 1, lo: ^uint64(0)}
	default:
		return maxU128
	}
}

func (a u128) add(b u128) u128 {
	lo, carry := bits.Add64(a.lo, b.lo, 0)
	hi, _ := bits.Add64(a.hi, b.hi, carry)
	return u128{hi: hi, lo: lo}
}

func (a u128) sub(b u128) u128 {
	lo, borrow := bits.Sub64(a.lo, b.lo, 0)
	hi, _ := bits.Sub64(a.hi, b.hi, borrow)
	return u128{hi: hi, lo: lo}
}

func (a u128) or(b u128) u128     { return u128{hi: a.hi | b.hi, lo: a.lo | b.lo} }
func (a u128) andNot(b u128) u128 { return u128{hi: a.hi &^ b.hi, lo: a.lo &^ b.lo} }

func (a u128) cmp(b u128) int {
	switch {
	case a.hi < b.hi:
		return -1
	case a.hi > b.hi:
		return 1
	case a.lo < b.lo:
		return -1
	case a.lo > b.lo:
		return 1
	default:
		return 0
	}
}

func (a u128) big() *big.Int {
	v := new(big.Int).SetUint64(a.hi)
	v.Lsh(v, 64)
	return v.Or(v, new(big.Int).SetUint64(a.lo))
}

func fromAddr(a netip.Addr) u128 {
	if a.Is4() {
		b := a.As4()
		return u128{lo: uint64(binary.BigEndian.Uint32(b[:]))}
	}
	b := a.As16()
	return u128{hi: binary.BigEndian.Uint64(b[:8]), lo: binary.BigEndian.Uint64(b[8:])}
}

// toAddr converts back; an IPv4 address (v4, value below 2^32) goes through its IPv4-mapped form.
func toAddr(v u128, v4 bool) netip.Addr {
	var b [16]byte
	binary.BigEndian.PutUint64(b[:8], v.hi)
	binary.BigEndian.PutUint64(b[8:], v.lo)
	if v4 {
		b[10], b[11] = 0xff, 0xff
		return netip.AddrFrom16(b).Unmap()
	}
	return netip.AddrFrom16(b)
}
