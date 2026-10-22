package amqpx

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/lonetis/scantor/internal/runtime"
)

// ConfirmTimeout bounds the wait for a publisher confirm (docs/runtime.md §6.3).
const ConfirmTimeout = 30 * time.Second

// Return bookkeeping.
const (
	returnBuffer   = 256
	returnDrainTTL = 2 * time.Minute
	drainInterval  = 100 * time.Millisecond
)

// Outcome is the result of one confirmed publish.
type Outcome int

// Publish outcomes (docs/runtime.md §6.3).
const (
	// Confirmed: the broker acked and did not return the message.
	Confirmed Outcome = iota
	// Nacked: the broker refused the message (for scan queues: full under reject-publish).
	Nacked
	// Returned: the message was unroutable (mandatory) — no queue bound.
	Returned
	// Unconfirmed: no confirm within 30 s or the channel/connection closed; the outcome is unknown.
	Unconfirmed
)

func (o Outcome) String() string {
	switch o {
	case Confirmed:
		return "confirmed"
	case Nacked:
		return "nacked"
	case Returned:
		return "returned"
	default:
		return "unconfirmed"
	}
}

// Publication is one message to publish.
type Publication struct {
	Exchange   string
	RoutingKey string
	// Type is the AMQP `type` property (analysis, result, attempt).
	Type    string
	Body    []byte
	Headers amqp.Table
}

// Publisher is the shared confirm-mode publisher of a worker (docs/runtime.md §6.3). It is safe for
// concurrent use.
type Publisher struct {
	conn   *Conn
	userID string
	appID  string
	logger *slog.Logger

	mu       sync.Mutex
	ch       *amqp.Channel
	gen      uint64
	returns  chan amqp.Return
	returned map[string]time.Time
	stop     chan struct{}
	stopOnce sync.Once
}

// NewPublisher returns a publisher on conn: every message carries user_id (the scan's RabbitMQ user,
// validated by the broker) and app_id.
func NewPublisher(conn *Conn, userID, appID string, logger *slog.Logger) *Publisher {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	p := &Publisher{conn: conn, userID: userID, appID: appID, logger: logger, returned: map[string]time.Time{}, stop: make(chan struct{})}
	go p.drainLoop()
	return p
}

// Close stops the publisher and closes its channel.
func (p *Publisher) Close() {
	p.stopOnce.Do(func() { close(p.stop) })
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ch != nil && !p.ch.IsClosed() {
		_ = p.ch.Close()
	}
	p.ch = nil
}

// Confirmation is a sent publish awaiting its confirm.
type Confirmation interface {
	// Wait waits for the confirm and classifies it.
	Wait(ctx context.Context) Outcome
}

// Pending is a sent publish awaiting its confirm.
type Pending struct {
	p         *Publisher
	ch        *amqp.Channel
	dc        *amqp.DeferredConfirmation
	messageID string
	err       error
}

// Err returns the error of a failed send (the outcome is then Unconfirmed).
func (pd *Pending) Err() error { return pd.err }

// Send publishes pub (mandatory, persistent, confirm mode) once the connection is up and not blocked,
// and returns the pending confirm. Sends are written in call order.
func (p *Publisher) Send(ctx context.Context, pub Publication) Confirmation {
	return p.send(ctx, pub)
}

func (p *Publisher) send(ctx context.Context, pub Publication) *Pending {
	if err := p.conn.WaitUnblocked(ctx); err != nil {
		return &Pending{err: err}
	}
	ch, err := p.channel(ctx)
	if err != nil {
		return &Pending{err: err}
	}
	msg := amqp.Publishing{
		ContentType:  runtime.ContentTypeJSON,
		DeliveryMode: amqp.Persistent,
		Type:         pub.Type,
		MessageId:    uuid.NewString(),
		UserId:       p.userID,
		AppId:        p.appID,
		Timestamp:    time.Now(),
		Headers:      pub.Headers,
		Body:         pub.Body,
	}
	dc, err := ch.PublishWithDeferredConfirmWithContext(ctx, pub.Exchange, pub.RoutingKey, true, false, msg)
	if err != nil {
		p.dropChannel(ch)
		return &Pending{err: err}
	}
	return &Pending{p: p, ch: ch, dc: dc, messageID: msg.MessageId}
}

// Wait waits for the confirm and classifies it. A return of the same message id received before the ack
// makes it Returned (amqp091-go dispatches basic.return before the ack of the same message).
func (pd *Pending) Wait(ctx context.Context) Outcome {
	if pd.err != nil || pd.dc == nil {
		return Unconfirmed
	}
	timer := time.NewTimer(ConfirmTimeout)
	defer timer.Stop()
	select {
	case <-pd.dc.Done():
	case <-timer.C:
		return Unconfirmed
	case <-ctx.Done():
		return Unconfirmed
	}
	if !pd.dc.Acked() {
		if pd.ch.IsClosed() {
			return Unconfirmed // the library nacks pending confirms when the channel closes
		}
		return Nacked
	}
	if pd.p.takeReturned(pd.messageID) {
		return Returned
	}
	return Confirmed
}

// Publish sends pub and waits for its confirm.
func (p *Publisher) Publish(ctx context.Context, pub Publication) Outcome {
	return p.send(ctx, pub).Wait(ctx)
}

func (p *Publisher) channel(ctx context.Context) (*amqp.Channel, error) {
	for {
		conn, gen, err := p.conn.Wait(ctx)
		if err != nil {
			return nil, err
		}
		p.mu.Lock()
		if p.ch != nil && !p.ch.IsClosed() && p.gen == gen {
			ch := p.ch
			p.mu.Unlock()
			return ch, nil
		}
		ch, err := conn.Channel()
		if err == nil {
			err = ch.Confirm(false)
		}
		if err != nil {
			p.mu.Unlock()
			if ch != nil {
				_ = ch.Close()
			}
			p.logger.Warn("cannot open the publisher channel", "err", err)
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Second):
			}
			continue
		}
		returns := ch.NotifyReturn(make(chan amqp.Return, returnBuffer))
		closes := ch.NotifyClose(make(chan *amqp.Error, 1))
		// Returns of the previous channel may still be undrained; keep them for their pending confirms.
		p.drainLocked()
		p.ch, p.gen, p.returns = ch, gen, returns
		p.mu.Unlock()
		go func() {
			if e, ok := <-closes; ok && e != nil {
				p.logger.Warn("publisher channel closed by the broker", "code", e.Code, "reason", e.Reason)
			}
		}()
		return ch, nil
	}
}

func (p *Publisher) dropChannel(ch *amqp.Channel) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.ch == ch {
		p.ch = nil
	}
	_ = ch.Close()
}

// takeReturned drains the returns received so far and reports (and forgets) whether messageID was
// returned. The drain happens under the lock with non-blocking receives, so a return that the library
// dispatched before the ack is always seen.
func (p *Publisher) takeReturned(messageID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.drainLocked()
	if _, ok := p.returned[messageID]; ok {
		delete(p.returned, messageID)
		return true
	}
	return false
}

func (p *Publisher) drainLocked() {
	if p.returns == nil {
		return
	}
	for {
		select {
		case r, ok := <-p.returns:
			if !ok {
				p.returns = nil
				return
			}
			p.returned[r.MessageId] = time.Now()
			p.logger.Debug("publish returned as unroutable", "exchange", r.Exchange, "routingKey", r.RoutingKey, "reply", r.ReplyText)
		default:
			return
		}
	}
}

// drainLoop keeps the return buffer from filling up and forgets returns nobody asked for.
func (p *Publisher) drainLoop() {
	t := time.NewTicker(drainInterval)
	defer t.Stop()
	for {
		select {
		case <-p.stop:
			return
		case <-t.C:
			p.mu.Lock()
			p.drainLocked()
			for id, at := range p.returned {
				if time.Since(at) > returnDrainTTL {
					delete(p.returned, id)
				}
			}
			p.mu.Unlock()
		}
	}
}
