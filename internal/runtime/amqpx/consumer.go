package amqpx

import (
	"errors"
	"fmt"
	"sync"

	amqp "github.com/rabbitmq/amqp091-go"
)

// Consumer is the channel of one process slot (docs/runtime.md §6.2): prefetch 1 and one consumer. It is
// used only for consume, ack (multiple=false) and nack (multiple=false, requeue=true); it never publishes
// and never rejects.
type Consumer struct {
	ch         *amqp.Channel
	gen        uint64
	tag        string
	deliveries <-chan amqp.Delivery

	lost       chan struct{}
	lostOnce   sync.Once
	mu         sync.Mutex
	lostReason string
}

// Consume opens a channel on conn (generation gen), sets qos(1, 0, false) and starts consuming queue with
// tag. A missing queue is a NOT_FOUND error (IsNotFound).
func Consume(conn *amqp.Connection, gen uint64, queue, tag string) (*Consumer, error) {
	ch, err := conn.Channel()
	if err != nil {
		return nil, fmt.Errorf("open slot channel: %w", err)
	}
	if err := ch.Qos(1, 0, false); err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("set prefetch: %w", err)
	}
	cancelled := ch.NotifyCancel(make(chan string, 1))
	closed := ch.NotifyClose(make(chan *amqp.Error, 1))
	deliveries, err := ch.Consume(queue, tag, false, false, false, false, nil)
	if err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("consume %s: %w", queue, err)
	}
	c := &Consumer{ch: ch, gen: gen, tag: tag, deliveries: deliveries, lost: make(chan struct{})}
	go c.watch(cancelled, closed)
	return c, nil
}

// watch turns a broker-initiated basic.cancel (queue deleted, consumer timeout, docs/runtime.md §6.4) or
// the end of the channel into Lost. A cancel the client sent itself never reaches NotifyCancel.
func (c *Consumer) watch(cancelled <-chan string, closed <-chan *amqp.Error) {
	select {
	case tag, ok := <-cancelled:
		if ok {
			c.markLost("the broker cancelled consumer " + tag)
			return
		}
		c.markLost("channel closed")
	case e, ok := <-closed:
		if ok && e != nil {
			c.markLost("channel closed: " + e.Error())
			return
		}
		c.markLost("channel closed")
	}
}

func (c *Consumer) markLost(reason string) {
	c.lostOnce.Do(func() {
		c.mu.Lock()
		c.lostReason = reason
		c.mu.Unlock()
		close(c.lost)
	})
}

// Deliveries returns the consumer's deliveries; the channel is closed after a cancel (by either side) or
// when the channel closes.
func (c *Consumer) Deliveries() <-chan amqp.Delivery { return c.deliveries }

// Lost is closed when the broker cancelled the consumer or the channel closed. Deliveries of the channel
// are then detached: the broker has already returned them (or dropped them with the queue), so they are
// never acked or nacked (docs/runtime.md §6.4, §6.6).
func (c *Consumer) Lost() <-chan struct{} { return c.lost }

// LostReason explains Lost.
func (c *Consumer) LostReason() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lostReason
}

// Generation is the connection generation of the channel.
func (c *Consumer) Generation() uint64 { return c.gen }

// Tag is the consumer tag.
func (c *Consumer) Tag() string { return c.tag }

// Cancel stops receiving (basic.cancel) while keeping unacked deliveries ackable. It waits for cancel-ok;
// deliveries sent before it are still in Deliveries, which is closed afterwards.
func (c *Consumer) Cancel() error {
	if err := c.ch.Cancel(c.tag, false); err != nil {
		return fmt.Errorf("cancel consumer %s: %w", c.tag, err)
	}
	return nil
}

// Ack acknowledges one delivery.
func (c *Consumer) Ack(tag uint64) error { return c.ch.Ack(tag, false) }

// Nack gives one delivery back with requeue (not counted toward the delivery limit).
func (c *Consumer) Nack(tag uint64) error { return c.ch.Nack(tag, false, true) }

// Close closes the channel; unacked deliveries return to the queue.
func (c *Consumer) Close() error {
	if c.ch.IsClosed() {
		return nil
	}
	err := c.ch.Close()
	if errors.Is(err, amqp.ErrClosed) {
		return nil
	}
	return err
}
