// Package fakebroker is an in-memory AMQP broker for the runtime's unit tests: one scan queue with
// prefetch-1 slot channels, delayed delivery (x-opt-delivery-time), redelivery flags, consumer
// cancellation by the broker, connection loss and blocking, an optional x-max-length with reject-publish,
// and a scripted outcome for every publish. It implements runner.Broker and the scheduler's publisher and
// queue depth.
package fakebroker

import (
	"context"
	"errors"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/amqpx"
)

// Published is one publish the broker saw, with its outcome.
type Published struct {
	amqpx.Publication
	Outcome amqpx.Outcome
	At      time.Time
}

// message is one queued analysis message.
type message struct {
	body        []byte
	redelivered bool
	visibleAt   time.Time
	deliveries  int
}

// Broker is the fake. The zero value is not usable; call New.
type Broker struct {
	mu         sync.Mutex
	queue      []*message
	channels   map[*Channel]bool
	published  []Published
	connected  bool
	blocked    bool
	changed    chan struct{}
	nextTag    uint64
	missing    bool // the queue does not exist (consume fails with NOT_FOUND)
	wake       chan struct{}
	maxLength  int   // x-max-length with x-overflow reject-publish; 0 means unlimited
	rejecting  bool  // the queue went over maxLength and refuses publishes
	depthErr   error // the error of every ReadyCount while set
	depthReads int

	// Outcome decides the outcome of a publish; nil confirms everything. It runs without the lock.
	Outcome func(pub amqpx.Publication) amqpx.Outcome
	// AnalysesExchange is the exchange whose publishes are queued (default scantor.analyses).
	AnalysesExchange string
}

// New returns a connected broker with an empty queue.
func New() *Broker {
	b := &Broker{channels: map[*Channel]bool{}, connected: true, changed: make(chan struct{}), wake: make(chan struct{}, 1), AnalysesExchange: "scantor.analyses"}
	go b.dispatchLoop()
	return b
}

// Enqueue adds an analysis message to the queue.
func (b *Broker) Enqueue(body []byte) {
	b.mu.Lock()
	b.queue = append(b.queue, &message{body: body})
	b.limitLocked()
	b.mu.Unlock()
	b.poke()
}

// EnqueueRedelivered adds a message that the broker already delivered once.
func (b *Broker) EnqueueRedelivered(body []byte) {
	b.mu.Lock()
	b.queue = append(b.queue, &message{body: body, redelivered: true, deliveries: 1})
	b.limitLocked()
	b.mu.Unlock()
	b.poke()
}

// SetMaxLength limits the queue like x-max-length with x-overflow reject-publish on a RabbitMQ 4.4 quorum
// queue (docs/queue.md §3.3): ready and delayed messages count, unacknowledged ones do not; a publish is
// accepted while the queue is not rejecting, and the queue starts rejecting once it holds more than n
// messages (so it can exceed n by the publishes accepted before); it rejects every publish, delayed ones
// included, until it holds at most 80 % of n again (RabbitMQ keeps refusing only the publishers it refused;
// refusing every publisher is the stricter case). 0 removes the limit.
func (b *Broker) SetMaxLength(n int) {
	b.mu.Lock()
	b.maxLength = n
	b.rejecting = false
	b.limitLocked()
	b.mu.Unlock()
}

// limitLocked updates the reject state from the number of queued (ready and delayed) messages.
func (b *Broker) limitLocked() {
	switch {
	case b.maxLength <= 0:
		b.rejecting = false
	case len(b.queue) > b.maxLength:
		b.rejecting = true
	case len(b.queue) <= b.maxLength*8/10:
		b.rejecting = false
	}
}

// Ready returns the number of ready (visible, undelivered) messages and of delayed ones.
func (b *Broker) Ready() (ready, delayed int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	for _, m := range b.queue {
		if m.visibleAt.After(now) {
			delayed++
		} else {
			ready++
		}
	}
	return ready, delayed
}

// ReadyCount implements the scheduler's QueueDepth like a passive queue.declare: the ready messages, without
// delayed and unacknowledged ones. A missing queue fails with ErrNotFound; it waits for a connection.
func (b *Broker) ReadyCount(ctx context.Context) (int, error) {
	for {
		b.mu.Lock()
		connected, missing, changed, err := b.connected, b.missing, b.changed, b.depthErr
		b.mu.Unlock()
		switch {
		case missing:
			return 0, ErrNotFound
		case err != nil:
			return 0, err
		case connected:
			b.mu.Lock()
			b.depthReads++
			b.mu.Unlock()
			ready, _ := b.Ready()
			return ready, nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
}

// DepthReads returns how often ReadyCount answered.
func (b *Broker) DepthReads() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.depthReads
}

// SetDepthErr makes ReadyCount fail with err (nil restores it).
func (b *Broker) SetDepthErr(err error) {
	b.mu.Lock()
	b.depthErr = err
	b.mu.Unlock()
}

// Published returns every publish so far.
func (b *Broker) Published() []Published {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]Published(nil), b.published...)
}

// SetMissing makes the queue disappear (consume fails with NOT_FOUND) or reappear.
func (b *Broker) SetMissing(missing bool) {
	b.mu.Lock()
	b.missing = missing
	b.mu.Unlock()
}

// SetBlocked sets the connection-blocked state.
func (b *Broker) SetBlocked(blocked bool) {
	b.mu.Lock()
	b.blocked = blocked
	b.signalLocked()
	b.mu.Unlock()
}

// Disconnect simulates a connection loss: every channel closes and its unacked deliveries return to
// the queue as redelivered. Reconnect restores the connection.
func (b *Broker) Disconnect() {
	b.mu.Lock()
	b.connected = false
	chans := b.channelList()
	b.signalLocked()
	b.mu.Unlock()
	for _, c := range chans {
		c.lose("connection lost")
	}
}

// Reconnect restores the connection.
func (b *Broker) Reconnect() {
	b.mu.Lock()
	b.connected = true
	b.signalLocked()
	b.mu.Unlock()
	b.poke()
}

// CancelConsumers simulates a broker-initiated basic.cancel (queue deleted, consumer timeout): unacked
// deliveries return to the queue and the consumers' deliveries are detached.
func (b *Broker) CancelConsumers() {
	b.mu.Lock()
	chans := b.channelList()
	b.mu.Unlock()
	for _, c := range chans {
		c.lose("the broker cancelled the consumer")
	}
}

// Consumers returns the number of channels with an active consumer.
func (b *Broker) Consumers() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := 0
	for c := range b.channels {
		if c.active() {
			n++
		}
	}
	return n
}

func (b *Broker) channelList() []*Channel {
	out := make([]*Channel, 0, len(b.channels))
	for c := range b.channels {
		out = append(out, c)
	}
	return out
}

func (b *Broker) signalLocked() {
	close(b.changed)
	b.changed = make(chan struct{})
}

func (b *Broker) poke() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

// Connected implements runner.Broker.
func (b *Broker) Connected() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.connected
}

// Blocked implements runner.Broker.
func (b *Broker) Blocked() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.blocked
}

// Changed implements runner.Broker.
func (b *Broker) Changed() <-chan struct{} {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.changed
}

// ErrNotFound mimics the broker's 404 for a missing queue.
var ErrNotFound = &amqp.Error{Code: amqp.NotFound, Reason: "NOT_FOUND - no queue"}

// Consume implements runner.Broker (the return type is the concrete *Channel; runner tests wrap it).
func (b *Broker) Consume(ctx context.Context, tag string) (*Channel, error) {
	for {
		b.mu.Lock()
		connected, missing, changed := b.connected, b.missing, b.changed
		if connected && !missing {
			c := &Channel{b: b, tag: tag, deliveries: make(chan amqp.Delivery, 1), lost: make(chan struct{}), consuming: true}
			b.channels[c] = true
			b.mu.Unlock()
			b.poke()
			return c, nil
		}
		b.mu.Unlock()
		if missing {
			return nil, ErrNotFound
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}

// Publish publishes and returns the outcome (waiting for a connection and the end of a block).
func (b *Broker) Publish(ctx context.Context, pub amqpx.Publication) amqpx.Outcome {
	for {
		b.mu.Lock()
		ok := b.connected && !b.blocked
		changed := b.changed
		b.mu.Unlock()
		if ok {
			break
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return amqpx.Unconfirmed
		}
	}
	outcome := amqpx.Confirmed
	if b.Outcome != nil {
		outcome = b.Outcome(pub)
	}
	b.mu.Lock()
	if outcome == amqpx.Confirmed && pub.Exchange == b.AnalysesExchange && b.rejecting {
		outcome = amqpx.Nacked
	}
	b.published = append(b.published, Published{Publication: pub, Outcome: outcome, At: time.Now()})
	if outcome == amqpx.Confirmed && pub.Exchange == b.AnalysesExchange {
		m := &message{body: pub.Body}
		if v, ok := pub.Headers[runtime.HeaderDeliveryTime].(int64); ok {
			m.visibleAt = time.UnixMilli(v)
		}
		b.queue = append(b.queue, m)
		b.limitLocked()
	}
	b.mu.Unlock()
	b.poke()
	return outcome
}

// Send publishes asynchronously (the scheduler's publisher interface).
func (b *Broker) Send(ctx context.Context, pub amqpx.Publication) amqpx.Confirmation {
	return &confirmation{outcome: b.Publish(ctx, pub)}
}

type confirmation struct{ outcome amqpx.Outcome }

func (c *confirmation) Wait(context.Context) amqpx.Outcome { return c.outcome }

// dispatchLoop hands visible messages to idle consumers.
func (b *Broker) dispatchLoop() {
	t := time.NewTicker(10 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-b.wake:
		case <-t.C:
		}
		b.dispatch()
	}
}

func (b *Broker) dispatch() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.connected {
		return
	}
	now := time.Now()
	for c := range b.channels {
		if !c.active() || c.held != nil {
			continue
		}
		idx := -1
		for i, m := range b.queue {
			if !m.visibleAt.After(now) {
				idx = i
				break
			}
		}
		if idx < 0 {
			return
		}
		m := b.queue[idx]
		b.queue = append(b.queue[:idx], b.queue[idx+1:]...)
		b.limitLocked()
		b.nextTag++
		m.deliveries++
		c.held = m
		c.heldTag = b.nextTag
		c.deliveries <- amqp.Delivery{DeliveryTag: b.nextTag, Redelivered: m.redelivered, Body: m.body, ConsumerTag: c.tag}
	}
}

// Channel is one fake slot channel.
type Channel struct {
	b          *Broker
	tag        string
	deliveries chan amqp.Delivery
	lost       chan struct{}
	lostOnce   sync.Once
	reason     string

	// Guarded by b.mu.
	consuming bool
	closed    bool
	held      *message
	heldTag   uint64
	acks      int
	nacks     int
}

func (c *Channel) active() bool { return c.consuming && !c.closed }

// Deliveries implements runner.SlotChannel.
func (c *Channel) Deliveries() <-chan amqp.Delivery { return c.deliveries }

// Lost implements runner.SlotChannel.
func (c *Channel) Lost() <-chan struct{} { return c.lost }

// LostReason implements runner.SlotChannel.
func (c *Channel) LostReason() string {
	c.b.mu.Lock()
	defer c.b.mu.Unlock()
	return c.reason
}

// lose detaches the channel: the held delivery returns to the queue as redelivered.
func (c *Channel) lose(reason string) {
	c.b.mu.Lock()
	if c.closed {
		c.b.mu.Unlock()
		return
	}
	c.reason = reason
	c.requeueLocked()
	wasConsuming := c.consuming
	c.consuming, c.closed = false, true
	delete(c.b.channels, c)
	c.b.mu.Unlock()
	c.lostOnce.Do(func() { close(c.lost) })
	if wasConsuming {
		close(c.deliveries)
	}
	c.b.poke()
}

// requeueLocked returns the held delivery to the head of the queue (RabbitMQ 4.4 quorum queues redeliver
// a requeued message first).
func (c *Channel) requeueLocked() {
	if c.held != nil {
		c.held.redelivered = true
		c.b.queue = append([]*message{c.held}, c.b.queue...)
		c.held = nil
		c.b.limitLocked()
	}
}

// Cancel implements runner.SlotChannel.
func (c *Channel) Cancel() error {
	c.b.mu.Lock()
	defer c.b.mu.Unlock()
	if c.closed {
		return errors.New("channel closed")
	}
	if c.consuming {
		c.consuming = false
		close(c.deliveries)
	}
	return nil
}

// Ack implements runner.SlotChannel.
func (c *Channel) Ack(tag uint64) error {
	c.b.mu.Lock()
	defer c.b.mu.Unlock()
	if c.closed || c.held == nil || c.heldTag != tag {
		return errors.New("unknown delivery tag")
	}
	c.held = nil
	c.acks++
	c.b.poke()
	return nil
}

// Nack implements runner.SlotChannel (requeue, not counted).
func (c *Channel) Nack(tag uint64) error {
	c.b.mu.Lock()
	defer c.b.mu.Unlock()
	if c.closed || c.held == nil || c.heldTag != tag {
		return errors.New("unknown delivery tag")
	}
	c.held.deliveries--
	c.requeueLocked()
	c.nacks++
	c.b.poke()
	return nil
}

// Close implements runner.SlotChannel: an unacked delivery returns to the queue.
func (c *Channel) Close() error {
	c.b.mu.Lock()
	if c.closed {
		c.b.mu.Unlock()
		return nil
	}
	c.requeueLocked()
	wasConsuming := c.consuming
	c.consuming, c.closed = false, true
	delete(c.b.channels, c)
	c.b.mu.Unlock()
	if wasConsuming {
		close(c.deliveries)
	}
	c.lostOnce.Do(func() { close(c.lost) })
	c.b.poke()
	return nil
}

// Settled returns the number of acks and nacks of the channel.
func (c *Channel) Settled() (acks, nacks int) {
	c.b.mu.Lock()
	defer c.b.mu.Unlock()
	return c.acks, c.nacks
}
