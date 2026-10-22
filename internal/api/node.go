package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Typed methods of the node API (/api/node/*, docs/api.md §7). They require a node client
// (PrincipalNode). Retries are the caller's decision: the daemon's loops already repeat every call.

// MaxAssignmentsWait is the upper bound of the assignments long-poll in seconds.
const MaxAssignmentsWait = 60

var errNotNode = errors.New("node API calls need a node credential")

func (c *Client) nodeCall(ctx context.Context, req Request, out any) (*Response, error) {
	if c.cred.Kind != PrincipalNode {
		return nil, errNotNode
	}
	return c.Do(ctx, req, out)
}

// NodeHello calls nodeHello and, on success, sets the instance id header for later calls.
func (c *Client) NodeHello(ctx context.Context, body NodeHelloRequest) (*NodeHelloResponse, *Response, error) {
	var out NodeHelloResponse
	resp, err := c.nodeCall(ctx, Request{Method: http.MethodPost, Path: "/api/node/hello", Body: body, Timeout: 30 * time.Second}, &out)
	if err != nil {
		return nil, resp, err
	}
	c.SetInstanceID(body.InstanceID)
	return &out, resp, nil
}

// GetNodeAssignments long-polls getNodeAssignments: it returns at once when the node's assignments
// revision is greater than rev, otherwise after wait seconds (≤ 60) with the current set.
func (c *Client) GetNodeAssignments(ctx context.Context, rev int64, wait int) (*NodeAssignments, *Response, error) {
	if wait > MaxAssignmentsWait {
		wait = MaxAssignmentsWait
	}
	q := url.Values{"rev": {strconv.FormatInt(rev, 10)}, "wait": {strconv.Itoa(max(wait, 0))}}
	var out NodeAssignments
	resp, err := c.nodeCall(ctx, Request{Method: http.MethodGet, Path: "/api/node/assignments", Query: q, Timeout: waitTimeout(wait)}, &out)
	if err != nil {
		return nil, resp, err
	}
	return &out, resp, nil
}

// PostNodeStatus calls postNodeStatus with a complete snapshot of the node's workers.
func (c *Client) PostNodeStatus(ctx context.Context, body NodeStatusRequest) (*NodeStatusResponse, *Response, error) {
	var out NodeStatusResponse
	resp, err := c.nodeCall(ctx, Request{Method: http.MethodPost, Path: "/api/node/status", Body: body, Timeout: 30 * time.Second}, &out)
	if err != nil {
		return nil, resp, err
	}
	return &out, resp, nil
}

// PostWorkerLogs calls postWorkerLogs (HTTP 204).
func (c *Client) PostWorkerLogs(ctx context.Context, workerID string, body WorkerLogsUpload) error {
	_, err := c.nodeCall(ctx, Request{Method: http.MethodPost, Path: "/api/node/workers/" + PathSegment(workerID) + "/logs", Body: body, Timeout: 30 * time.Second}, nil)
	return err
}
