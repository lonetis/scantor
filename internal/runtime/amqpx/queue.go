package amqpx

import "context"

// Queue reads the depth of a queue the runtime consumes or publishes to.
type Queue struct {
	Conn *Conn
	Name string
}

// ReadyCount returns the number of ready messages (docs/runtime.md §11.4): a passive queue.declare, which needs
// no configure permission and creates nothing, on a channel of its own, because the broker closes the channel
// when the queue is missing (reported as IsNotFound). Quorum queues count neither delayed nor unacknowledged
// messages here (docs/queue.md §3.3). It waits for a connection while ctx allows.
func (q Queue) ReadyCount(ctx context.Context) (int, error) {
	conn, _, err := q.Conn.Wait(ctx)
	if err != nil {
		return 0, err
	}
	ch, err := conn.Channel()
	if err != nil {
		return 0, err
	}
	// After a NOT_FOUND the broker has closed the channel already; closing it again only reports that.
	defer func() { _ = ch.Close() }()
	declared, err := ch.QueueDeclarePassive(q.Name, true, false, false, false, nil)
	if err != nil {
		return 0, err
	}
	return declared.Messages, nil
}
