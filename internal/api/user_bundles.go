package api

import (
	"context"
	"net/url"
)

// Bundle methods of the user API (docs/api.md, tag `revisions`). A revision is addressed by its task (id
// or name) and its number, "latest" or id (docs/api.md §1.4).

func bundlePath(task, revision string) string {
	return "/api/tasks/" + PathSegment(task) + "/revisions/" + PathSegment(revision) + "/bundle"
}

// CreateRevisionBundle calls createRevisionBundle: it returns the revision's queued, running or ready
// bundle, or creates one; rebuild replaces a ready bundle.
func (c *Client) CreateRevisionBundle(ctx context.Context, task, revision string, rebuild bool, wait int) (*Bundle, error) {
	var q url.Values
	if rebuild {
		q = url.Values{"rebuild": {"true"}}
	}
	var out Bundle
	return &out, c.postJSON(ctx, bundlePath(task, revision), q, nil, &out, wait)
}

// GetRevisionBundle calls getRevisionBundle; a revision without a bundle (or with an expired one) is a
// notFound error.
func (c *Client) GetRevisionBundle(ctx context.Context, task, revision string, wait int) (*Bundle, error) {
	var out Bundle
	return &out, c.getWait(ctx, bundlePath(task, revision), nil, wait, &out)
}
