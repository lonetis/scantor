package runner

import (
	"context"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/lonetis/scantor/internal/runtime/amqpx"
	"github.com/lonetis/scantor/internal/runtime/pool"
	"github.com/lonetis/scantor/internal/runtime/upload"
)

// The runner's dependencies are interfaces, so its unit tests run against a fake broker, a fake
// orchestrator and a scripted connector; the worker wiring passes the amqpx, upload and pool types.

// SlotChannel is the AMQP channel of one slot (amqpx.Consumer): prefetch 1, one consumer.
type SlotChannel interface {
	Deliveries() <-chan amqp.Delivery
	// Lost is closed when the broker cancelled the consumer or the channel closed; its deliveries are then
	// detached and are never acked or nacked (docs/runtime.md §6.4, §6.6).
	Lost() <-chan struct{}
	LostReason() string
	// Cancel stops receiving while keeping the current delivery ackable.
	Cancel() error
	Ack(tag uint64) error
	// Nack gives a delivery back with requeue (never basic.reject, docs/runtime.md §12).
	Nack(tag uint64) error
	Close() error
}

// Broker is the AMQP side of a runner: slot consumers on the scan queue and the shared confirm
// publisher.
type Broker interface {
	// Consume opens a slot channel and starts consuming with tag; it waits for a connection while ctx
	// allows. A missing queue is reported as amqpx.IsNotFound.
	Consume(ctx context.Context, tag string) (SlotChannel, error)
	// Publish publishes with mandatory and confirms and waits for the outcome; it waits for a connection
	// and for the end of a connection block while ctx allows.
	Publish(ctx context.Context, pub amqpx.Publication) amqpx.Outcome
	Connected() bool
	Blocked() bool
	// Changed is closed at the next change of Connected or Blocked.
	Changed() <-chan struct{}
}

// Spawner starts connector processes (pool.Launcher).
type Spawner interface {
	Spawn(ctx context.Context, slot, gen int, output pool.Sink) (*pool.Process, error)
}

// Uploader stores the files of a successful execution (upload.Uploader).
type Uploader interface {
	Upload(ctx context.Context, t upload.Target, files []upload.File) error
}

// AMQPBroker is the Broker of a real worker: the worker's connection, its shared publisher and the scan
// queue.
type AMQPBroker struct {
	Conn      *amqpx.Conn
	Publisher *amqpx.Publisher
	Queue     string
}

// Consume implements Broker.
func (b AMQPBroker) Consume(ctx context.Context, tag string) (SlotChannel, error) {
	conn, gen, err := b.Conn.Wait(ctx)
	if err != nil {
		return nil, err
	}
	c, err := amqpx.Consume(conn, gen, b.Queue, tag)
	if err != nil {
		return nil, err
	}
	return c, nil
}

// Publish implements Broker.
func (b AMQPBroker) Publish(ctx context.Context, pub amqpx.Publication) amqpx.Outcome {
	return b.Publisher.Publish(ctx, pub)
}

// Connected implements Broker.
func (b AMQPBroker) Connected() bool { return b.Conn.Connected() }

// Blocked implements Broker.
func (b AMQPBroker) Blocked() bool { return b.Conn.Blocked() }

// Changed implements Broker.
func (b AMQPBroker) Changed() <-chan struct{} { return b.Conn.Changed() }

// sleepCtx waits d, or less when ctx ends or wake is closed. It reports whether the full delay passed.
func sleepCtx(ctx context.Context, d time.Duration, wake <-chan struct{}) bool {
	if d <= 0 {
		return true
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	case <-wake:
		return false
	}
}
