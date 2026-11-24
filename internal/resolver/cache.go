package resolver

import (
	"container/list"
	"encoding/binary"
	"hash/maphash"
	"reflect"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zmap/dns"
)

// TTL rules of the answer cache (docs/nodes.md §6.11).
const (
	// maxPositiveTTL caps the TTL of positive answers.
	maxPositiveTTL = uint32(time.Hour / time.Second)
	// maxNegativeTTL caps the TTL of NXDOMAIN and NODATA answers.
	maxNegativeTTL = uint32(15 * time.Minute / time.Second)
	// noSOATTL is the TTL of a negative answer without SOA.
	noSOATTL = uint32(5)
	// failureTTL is the TTL of a remote failure (the servers answered SERVFAIL or REFUSED, or timed
	// out). Local causes are never cached.
	failureTTL = uint32(5)
	// maxEntryBytes: answers larger in wire format (uncompressed) are served but not cached.
	maxEntryBytes = 16 << 10
	// keyOverheadBytes is the memory one key of the cache holds besides its entry and the key name: its
	// map slot (with the map's growth headroom), list element and item.
	keyOverheadBytes = 256
	cacheShards      = 64
)

// cacheKey is a question, or (nameLevel) the name alone: a name-level entry holds an NXDOMAIN that
// applies to every type of the name (RFC 2308 §5).
type cacheKey struct {
	name      string
	qtype     uint16
	nameLevel bool
}

// entry is a final answer: its rcode and records with TTLs already capped at the entry's TTL.
type entry struct {
	rcode  int
	answer []dns.RR
	ns     []dns.RR
	stored time.Time
	ttl    uint32
	// size estimates the memory the entry holds (entryBytes); the cache counts it once per key.
	size int
	// cacheable is false for answers that are served once but never cached.
	cacheable bool
}

// entryStructBytes is the memory of the entry struct itself.
var entryStructBytes = allocBytes(int(reflect.TypeFor[entry]().Size()))

// newEntry builds the entry of a lookup result at now and decides its TTL.
func newEntry(res result, now time.Time) *entry {
	e := &entry{rcode: res.rcode, stored: now}
	switch {
	case res.fail != failNone:
		e.rcode = dns.RcodeServerFailure
		e.ttl = failureTTL
		e.cacheable = res.fail == failRemote
		e.size = entryStructBytes
		return e
	case res.rcode == dns.RcodeSuccess && hasAnswerFor(res):
		ttl := maxPositiveTTL
		for _, rr := range res.answer {
			ttl = min(ttl, rr.Header().Ttl)
		}
		e.ttl = ttl
	case res.rcode == dns.RcodeSuccess || res.rcode == dns.RcodeNameError:
		ttl, haveSOA := maxNegativeTTL, false
		for _, rr := range res.answer {
			ttl = min(ttl, rr.Header().Ttl)
		}
		for _, rr := range res.ns {
			if soa, ok := rr.(*dns.SOA); ok {
				ttl = min(ttl, soa.Hdr.Ttl, soa.Minttl)
				haveSOA = true
			}
		}
		if !haveSOA {
			ttl = min(ttl, noSOATTL)
		}
		e.ttl = ttl
	default:
		e.ttl = 0
	}
	e.answer = capTTLs(res.answer, e.ttl)
	e.ns = capTTLs(res.ns, e.ttl)
	m := dns.Msg{Answer: e.answer, Ns: e.ns}
	e.size = entryBytes(e)
	e.cacheable = e.ttl > 0 && m.Len() <= maxEntryBytes
	return e
}

// entryBytes estimates the memory e holds: the entry, its record slices and every record with what
// the record references. Go keeps a record in several allocations (struct, names, rdata slices), so
// its memory is a multiple of its wire size, up to 16 times for NSEC type bitmaps or TXT records of
// one-byte strings; counting the allocations keeps the cache within cacheBytes of heap whatever the
// records are (TestAnswerCacheAccountsItsHeap).
func entryBytes(e *entry) int {
	n := entryStructBytes + allocBytes(cap(e.answer)*int(reflect.TypeFor[dns.RR]().Size())) +
		allocBytes(cap(e.ns)*int(reflect.TypeFor[dns.RR]().Size()))
	for _, rr := range e.answer {
		n += heapBytes(reflect.ValueOf(rr))
	}
	for _, rr := range e.ns {
		n += heapBytes(reflect.ValueOf(rr))
	}
	return n
}

// heapBytes estimates the heap memory v references (pointer targets, string bytes, slice arrays and
// what they reference in turn), without v's own inline size. Strings shared between records count
// once per reference.
func heapBytes(v reflect.Value) int {
	switch v.Kind() {
	case reflect.Pointer:
		if v.IsNil() {
			return 0
		}
		return allocBytes(int(v.Type().Elem().Size())) + heapBytes(v.Elem())
	case reflect.Interface:
		if v.IsNil() {
			return 0
		}
		e := v.Elem()
		if e.Kind() == reflect.Pointer {
			return heapBytes(e)
		}
		return allocBytes(int(e.Type().Size())) + heapBytes(e)
	case reflect.String:
		return allocBytes(v.Len())
	case reflect.Slice:
		if v.IsNil() {
			return 0
		}
		n := allocBytes(v.Cap() * int(v.Type().Elem().Size()))
		if pointerFree(v.Type().Elem()) {
			return n
		}
		for i := range v.Len() {
			n += heapBytes(v.Index(i))
		}
		return n
	case reflect.Array:
		if pointerFree(v.Type().Elem()) {
			return 0
		}
		n := 0
		for i := range v.Len() {
			n += heapBytes(v.Index(i))
		}
		return n
	case reflect.Struct:
		n := 0
		for i := range v.NumField() {
			n += heapBytes(v.Field(i))
		}
		return n
	case reflect.Map:
		if v.IsNil() {
			return 0
		}
		n := allocBytes(v.Len() * 2 * int(v.Type().Key().Size()+v.Type().Elem().Size()))
		it := v.MapRange()
		for it.Next() {
			n += heapBytes(it.Key()) + heapBytes(it.Value())
		}
		return n
	}
	return 0
}

// pointerFree reports whether values of t reference no memory (numbers, booleans and arrays and
// structs of them), so heapBytes need not look into them.
func pointerFree(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64, reflect.Complex64, reflect.Complex128:
		return true
	case reflect.Array:
		return pointerFree(t.Elem())
	case reflect.Struct:
		for i := range t.NumField() {
			if !pointerFree(t.Field(i).Type) {
				return false
			}
		}
		return true
	}
	return false
}

// allocBytes is the memory the Go allocator uses for an object of n bytes: n rounded up to its size
// class, here 16 bytes, plus 12.5 % above 256 bytes for the coarser classes.
func allocBytes(n int) int {
	if n <= 0 {
		return 0
	}
	if n > 256 {
		n += n / 8
	}
	return (n + 15) &^ 15
}

// hasAnswerFor reports whether a NOERROR result answers its question (anything but NODATA): the
// answer section holds a record of the question's type at the end of the chain, or a CNAME was asked.
func hasAnswerFor(res result) bool {
	for _, rr := range res.answer {
		t := rr.Header().Rrtype
		if t == res.qtype || res.qtype == dns.TypeANY {
			return true
		}
	}
	return false
}

// capTTLs copies rrs with every TTL at most ttl; SOA records get exactly ttl (the negative TTL,
// RFC 2308 §3).
func capTTLs(rrs []dns.RR, ttl uint32) []dns.RR {
	out := make([]dns.RR, 0, len(rrs))
	for _, rr := range rrs {
		c := dns.Copy(rr)
		h := c.Header()
		if _, ok := c.(*dns.SOA); ok || h.Ttl > ttl {
			h.Ttl = ttl
		}
		out = append(out, c)
	}
	return out
}

// expired reports whether the entry's TTL ran out at now.
func (e *entry) expired(now time.Time) bool {
	return now.Sub(e.stored) >= time.Duration(e.ttl)*time.Second
}

// records returns copies of the records with TTLs decremented by the entry's age.
func (e *entry) records(now time.Time) (answer, ns []dns.RR) {
	age := max(now.Sub(e.stored), 0) / time.Second
	dec := func(rrs []dns.RR) []dns.RR {
		out := make([]dns.RR, 0, len(rrs))
		for _, rr := range rrs {
			c := dns.Copy(rr)
			h := c.Header()
			if time.Duration(h.Ttl) > age {
				h.Ttl -= uint32(age) //nolint:gosec // age < TTL, a uint32
			} else {
				h.Ttl = 0
			}
			out = append(out, c)
		}
		return out
	}
	return dec(e.answer), dec(e.ns)
}

// answerCache is a byte-bounded LRU of final answers in 64 shards.
type answerCache struct {
	seed     maphash.Seed
	shards   [cacheShards]cacheShard
	maxBytes int64 // per shard
	bytes    atomic.Int64
	entries  atomic.Int64
}

type cacheShard struct {
	mu    sync.Mutex
	m     map[cacheKey]*list.Element
	lru   list.List
	bytes int64
}

type cacheItem struct {
	key cacheKey
	e   *entry
	// size is what the item counts: its entry, the key's bookkeeping and the key name.
	size int
}

func newAnswerCache(maxBytes int64) *answerCache {
	c := &answerCache{seed: maphash.MakeSeed(), maxBytes: max(maxBytes/cacheShards, maxEntryBytes)}
	for i := range c.shards {
		c.shards[i].m = make(map[cacheKey]*list.Element)
	}
	return c
}

func (c *answerCache) shard(k cacheKey) *cacheShard {
	var h maphash.Hash
	h.SetSeed(c.seed)
	_, _ = h.WriteString(k.name)
	_, _ = h.Write(binary.BigEndian.AppendUint16(nil, k.qtype))
	return &c.shards[h.Sum64()%cacheShards]
}

// get returns the fresh entry of k, or nil; expired entries are removed.
func (c *answerCache) get(k cacheKey, now time.Time) *entry {
	s := c.shard(k)
	s.mu.Lock()
	defer s.mu.Unlock()
	el := s.m[k]
	if el == nil {
		return nil
	}
	it := el.Value.(*cacheItem)
	if it.e.expired(now) {
		c.removeLocked(s, el)
		return nil
	}
	s.lru.MoveToFront(el)
	return it.e
}

// lookup returns the cached answer of a question: its own entry or a name-level NXDOMAIN.
func (c *answerCache) lookup(name string, qtype uint16, now time.Time) *entry {
	if e := c.get(cacheKey{name: name, qtype: qtype}, now); e != nil {
		return e
	}
	return c.get(cacheKey{name: name, nameLevel: true}, now)
}

// store caches a cacheable entry of a question; an NXDOMAIN without a CNAME chain also becomes the
// name-level entry of the name.
func (c *answerCache) store(name string, qtype uint16, e *entry) {
	if !e.cacheable {
		return
	}
	c.put(cacheKey{name: name, qtype: qtype}, e)
	if e.rcode == dns.RcodeNameError && len(e.answer) == 0 {
		c.put(cacheKey{name: name, nameLevel: true}, e)
	}
}

func (c *answerCache) put(k cacheKey, e *entry) {
	s := c.shard(k)
	s.mu.Lock()
	defer s.mu.Unlock()
	if el := s.m[k]; el != nil {
		c.removeLocked(s, el)
	}
	size := e.size + keyOverheadBytes + allocBytes(len(k.name))
	s.m[k] = s.lru.PushFront(&cacheItem{key: k, e: e, size: size})
	s.bytes += int64(size)
	c.bytes.Add(int64(size))
	c.entries.Add(1)
	for s.bytes > c.maxBytes {
		back := s.lru.Back()
		if back == nil {
			break
		}
		c.removeLocked(s, back)
	}
}

func (c *answerCache) removeLocked(s *cacheShard, el *list.Element) {
	it := el.Value.(*cacheItem)
	s.lru.Remove(el)
	delete(s.m, it.key)
	s.bytes -= int64(it.size)
	c.bytes.Add(-int64(it.size))
	c.entries.Add(-1)
}
