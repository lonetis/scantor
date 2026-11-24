package resolver

import (
	"encoding/binary"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync"

	"github.com/zmap/dns"
)

// The resolver never builds an answer from zdns results: zdns' own cache and CNAME handling lose or
// invent records (docs/nodes.md §6.11). Instead the dialer wraps every connection zdns opens and a
// recorder keeps the raw reply of one lookup attempt, from which the engines assemble the answer. In
// the iterative route the same wrappers trim every reply before zdns parses it, so what zdns keeps in
// its delegation cache stays small whatever a hostile zone sends.

// dialCause is the outcome of one dial of a lookup.
type dialCause int

const (
	dialOK dialCause = iota + 1
	// dialRefused: the server guard refused the address.
	dialRefused
	// dialRateLimited: the server's rate limit had no token within the wait.
	dialRateLimited
	// dialFailed: the network refused the connection.
	dialFailed
	// dialBudget: the lookup had used its query budget.
	dialBudget
	// dialNoResources: the resolver had no file descriptor or kernel memory for the connection.
	dialNoResources
)

type dialOutcome struct {
	server netip.AddrPort
	cause  dialCause
}

// recorder collects what one attempt of a lookup received: the reply the engine answers from and the
// facts that classify a failed attempt. It keeps no other reply, so an attempt holds at most one
// message (at most 64 KiB) whatever its servers send. A nil recorder records nothing.
type recorder struct {
	// iterative: the iterative route keeps the last acceptable reply of the hop question and trims
	// every reply before zdns reads it; the recursive and local routes keep the first acceptable reply.
	iterative bool

	mu  sync.Mutex
	hop question
	// reply is the acceptable reply to the hop question (nil: none yet).
	reply *dns.Msg
	// replies counts the replies to any query of the attempt; truncated: a reply to the hop question
	// had TC=1.
	replies   int
	truncated bool
	dials     []dialOutcome
}

// newRecorder returns the recorder of a lookup whose (first) hop asks hop.
func newRecorder(hop question, iterative bool) *recorder {
	return &recorder{hop: hop, iterative: iterative}
}

// start begins an attempt for hop: everything recorded so far is forgotten.
func (r *recorder) start(hop question) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hop = hop
	r.reply, r.replies, r.truncated, r.dials = nil, 0, false, nil
}

// observe records a reply that answers a query of the attempt and returns the bytes zdns reads in
// place of raw: raw itself, or in the iterative route a trimmed reply or SERVFAIL (sanitizeIterative)
// of at most limit bytes.
func (r *recorder) observe(m *dns.Msg, raw []byte, limit int) []byte {
	r.mu.Lock()
	hop, iterative := r.hop, r.iterative
	r.replies++
	if sameQuestion(m, hop) {
		if m.Truncated {
			r.truncated = true
		}
		acceptable := forwardAcceptable(m, hop)
		if iterative {
			acceptable = iterativeAcceptable(m, hop)
		}
		if acceptable && (iterative || r.reply == nil) {
			r.reply = m
		}
	}
	r.mu.Unlock()
	if !iterative {
		return raw
	}
	view := sanitizeIterative(m, len(raw), hop)
	if view == m {
		return raw
	}
	view.Compress = true
	b, err := view.Pack()
	if err != nil || len(b) > limit {
		return packServfail(m, raw)
	}
	return b
}

func (r *recorder) dialed(server netip.AddrPort, cause dialCause) {
	if r == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dials = append(r.dials, dialOutcome{server: server, cause: cause})
}

// accepted returns the acceptable reply of the attempt, or nil.
func (r *recorder) accepted() *dns.Msg {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reply
}

// received returns how many replies the attempt received and whether one to the hop question was
// truncated.
func (r *recorder) received() (replies int, truncated bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.replies, r.truncated
}

func (r *recorder) outcomes() []dialOutcome {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]dialOutcome(nil), r.dials...)
}

// forwardAcceptable reports whether m answers q in the recursive and local routes: TC=0, NXDOMAIN, or
// NOERROR that is not a referral (NOERROR without recursion available, answers or SOA, from a server
// that does not recurse).
func forwardAcceptable(m *dns.Msg, q question) bool {
	if !sameQuestion(m, q) || m.Truncated {
		return false
	}
	switch m.Rcode {
	case dns.RcodeNameError:
		return true
	case dns.RcodeSuccess:
		return m.RecursionAvailable || len(m.Answer) > 0 || soaFor(m.Ns, "") != nil
	}
	return false
}

// iterativeAcceptable reports whether m ends the hop: TC=0, NOERROR or NXDOMAIN, and authoritative,
// NXDOMAIN, or holding a record of the hop's name of the asked type or a CNAME. Referrals and replies
// for other questions (name server addresses) never qualify.
func iterativeAcceptable(m *dns.Msg, hop question) bool {
	if !sameQuestion(m, hop) || m.Truncated {
		return false
	}
	if m.Rcode != dns.RcodeSuccess && m.Rcode != dns.RcodeNameError {
		return false
	}
	if m.Authoritative || m.Rcode == dns.RcodeNameError {
		return true
	}
	for _, rr := range m.Answer {
		t := rr.Header().Rrtype
		if dns.CanonicalName(rr.Header().Name) == hop.name && (t == hop.qtype || t == dns.TypeCNAME) {
			return true
		}
	}
	return false
}

// Bounds of what zdns may keep from one reply in the iterative route (docs/nodes.md §6.11). zdns caches
// delegations and name server addresses under names the zones choose, so a hostile zone could fill its
// cache with huge entries; the capture trims each reply before zdns parses it.
const (
	// maxReferralBytes: a reply zdns only iterates on or caches (anything but the answer to the hop
	// question) that is larger reaches zdns as SERVFAIL.
	maxReferralBytes = 16 << 10
	// maxDelegationNS NS records of one owner (one delegation) are kept, as unbound and BIND cap the
	// servers of a delegation.
	maxDelegationNS = 13
	// maxDelegationGlue address records of the kept name servers are kept (an IPv4 and an IPv6 address
	// for each).
	maxDelegationGlue = 2 * maxDelegationNS
	// maxInfraAnswers answer records are kept from a reply to a question zdns asks for itself (the
	// addresses of a name server).
	maxInfraAnswers = 2 * maxDelegationNS
	// maxInfraRecordBytes bounds the uncompressed size of all records kept from one trimmed reply.
	maxInfraRecordBytes = 4096
)

// sanitizeIterative returns what zdns reads instead of m (n bytes on the wire), a reply to a query of
// the iterative route whose hop asks hop: m itself, a trimmed copy, or a SERVFAIL reply. zdns caches
// only NOERROR replies, and the engine purges the key of the hop question after every attempt, so an
// authoritative answer to the hop question passes unchanged. Every other NOERROR reply is trimmed to
// what an iteration needs: the NS records of one delegation and one SOA in the authority section, the
// addresses of the kept name servers in the additional section, and for a question zdns asks itself a
// few answer records, all together at most maxInfraRecordBytes. A non-authoritative answer to the hop
// question keeps its answer section; any other reply above maxReferralBytes becomes SERVFAIL.
func sanitizeIterative(m *dns.Msg, n int, hop question) *dns.Msg {
	if m.Rcode != dns.RcodeSuccess {
		return m
	}
	hopReply := sameQuestion(m, hop)
	if hopReply && m.Authoritative {
		return m
	}
	hopAnswer := hopReply && len(m.Answer) > 0
	if !hopAnswer && n > maxReferralBytes {
		return servfailOf(m)
	}
	budget := maxInfraRecordBytes
	take := func(rr dns.RR) bool {
		l := dns.Len(rr)
		if l > budget {
			return false
		}
		budget -= l
		return true
	}
	out := &dns.Msg{MsgHdr: m.MsgHdr, Question: m.Question}
	if hopAnswer {
		out.Answer = m.Answer
	} else {
		for _, rr := range m.Answer {
			if len(out.Answer) == maxInfraAnswers || !take(rr) {
				break
			}
			out.Answer = append(out.Answer, rr)
		}
	}
	var owner string
	haveSOA, servers := false, 0
	targets := make(map[string]bool, maxDelegationNS)
	for _, rr := range m.Ns {
		switch v := rr.(type) {
		case *dns.NS:
			name := dns.CanonicalName(v.Hdr.Name)
			if owner == "" {
				owner = name
			}
			if name == owner && servers < maxDelegationNS && take(rr) {
				out.Ns = append(out.Ns, rr)
				targets[dns.CanonicalName(v.Ns)] = true
				servers++
			}
		case *dns.SOA:
			if !haveSOA && take(rr) {
				out.Ns = append(out.Ns, rr)
				haveSOA = true
			}
		}
	}
	glue := 0
	for _, rr := range m.Extra {
		switch rr.Header().Rrtype {
		case dns.TypeOPT:
			out.Extra = append(out.Extra, dns.Copy(rr))
		case dns.TypeA, dns.TypeAAAA:
			if glue < maxDelegationGlue && targets[dns.CanonicalName(rr.Header().Name)] && take(rr) {
				out.Extra = append(out.Extra, rr)
				glue++
			}
		}
	}
	if len(out.Answer) == len(m.Answer) && len(out.Ns) == len(m.Ns) && len(out.Extra) == len(m.Extra) {
		return m
	}
	return out
}

// servfailOf is an empty SERVFAIL reply with the header and question of m.
func servfailOf(m *dns.Msg) *dns.Msg {
	out := &dns.Msg{MsgHdr: m.MsgHdr, Question: m.Question}
	out.Rcode = dns.RcodeServerFailure
	out.Authoritative, out.Truncated = false, false
	if m.IsEdns0() != nil {
		out.SetEdns0(ednsSize, false)
	}
	return out
}

// packServfail packs servfailOf(m); raw is returned in the impossible case that it does not pack.
func packServfail(m *dns.Msg, raw []byte) []byte {
	b, err := servfailOf(m).Pack()
	if err != nil {
		return raw
	}
	return b
}

// sentQuery is the ID and question of the last query written on a connection.
type sentQuery struct {
	ok bool
	id uint16
	q  dns.Question
}

// parseSent reads the ID and question of a written query.
func parseSent(b []byte) sentQuery {
	m := new(dns.Msg)
	if err := m.Unpack(b); err != nil || m.Response || len(m.Question) != 1 {
		return sentQuery{}
	}
	return sentQuery{ok: true, id: m.Id, q: m.Question[0]}
}

// answers reports whether m is a reply to the query: QR set, the same ID and the same question
// (names compared without case).
func (s sentQuery) answers(m *dns.Msg) bool {
	if !s.ok || !m.Response || m.Id != s.id || len(m.Question) != 1 {
		return false
	}
	q := m.Question[0]
	return q.Qtype == s.q.Qtype && q.Qclass == s.q.Qclass && strings.EqualFold(q.Name, s.q.Name)
}

// filter records a received message when it answers the sent query and returns the bytes zdns reads
// in its place (at most limit bytes); anything else passes unchanged.
func (s sentQuery) filter(rec *recorder, b []byte, limit int) []byte {
	if !s.ok || rec == nil {
		return b
	}
	m := new(dns.Msg)
	if err := m.Unpack(b); err != nil || !s.answers(m) {
		return b
	}
	return rec.observe(m, b, limit)
}

// udpCapture wraps a connected UDP socket. It embeds *net.UDPConn, so it stays a net.PacketConn and
// zmap/dns keeps datagram framing; Read and Write are the calls zmap/dns makes on connected sockets.
type udpCapture struct {
	*net.UDPConn
	rec  *recorder
	sent sentQuery
}

func (c *udpCapture) Write(b []byte) (int, error) {
	c.sent = parseSent(b)
	return c.UDPConn.Write(b)
}

func (c *udpCapture) Read(b []byte) (int, error) {
	n, err := c.UDPConn.Read(b)
	if n > 0 {
		n = copy(b, c.sent.filter(c.rec, b[:n], len(b)))
	}
	return n, err
}

// tcpCapture wraps a TCP connection and reassembles the 2-byte length frames in both directions. A
// received frame reaches the reader only once it is complete, as filter may replace it.
type tcpCapture struct {
	net.Conn
	rec  *recorder
	sent sentQuery
	wbuf []byte
	// rbuf holds received bytes of an incomplete frame, out the frames the reader has not read yet,
	// and rerr the read error to return once out is empty.
	rbuf, out []byte
	rerr      error
}

func (c *tcpCapture) Write(b []byte) (int, error) {
	n, err := c.Conn.Write(b)
	c.wbuf = append(c.wbuf, b[:n]...)
	for {
		frame, rest, ok := nextFrame(c.wbuf)
		if !ok {
			break
		}
		c.sent = parseSent(frame)
		c.wbuf = rest
	}
	return n, err
}

// tcpReadChunk is the read size of tcpCapture.
const tcpReadChunk = 4096

func (c *tcpCapture) Read(b []byte) (int, error) {
	for len(c.out) == 0 {
		if c.rerr != nil {
			return 0, c.rerr
		}
		c.rbuf = slices.Grow(c.rbuf, tcpReadChunk)
		n, err := c.Conn.Read(c.rbuf[len(c.rbuf) : len(c.rbuf)+tcpReadChunk])
		c.rbuf = c.rbuf[:len(c.rbuf)+n]
		for {
			frame, rest, ok := nextFrame(c.rbuf)
			if !ok {
				break
			}
			view := c.sent.filter(c.rec, frame, dns.MaxMsgSize)
			c.out = binary.BigEndian.AppendUint16(c.out, uint16(len(view))) //nolint:gosec // at most dns.MaxMsgSize
			c.out = append(c.out, view...)
			c.rbuf = rest
		}
		if err != nil {
			c.rerr = err
		}
	}
	n := copy(b, c.out)
	c.out = c.out[n:]
	return n, nil
}

// nextFrame splits one length-prefixed DNS message off buf.
func nextFrame(buf []byte) (frame, rest []byte, ok bool) {
	if len(buf) < 2 {
		return nil, buf, false
	}
	n := int(binary.BigEndian.Uint16(buf))
	if len(buf) < 2+n {
		return nil, buf, false
	}
	return buf[2 : 2+n], buf[2+n:], true
}
