package api

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// Script, script-file and script-run methods of the user API (docs/api.md, tags `scripts`,
// `script-files`, `script-runs`). A script is addressed by its id or its name (docs/api.md §1.4).

func scriptPath(script string) string { return "/api/scripts/" + PathSegment(script) }

func scriptRunPath(scriptRunID string) string { return "/api/script-runs/" + PathSegment(scriptRunID) }

// ── scripts ──────────────────────────────────────────────────────────────────

// ListScripts calls listScripts.
func (c *Client) ListScripts(ctx context.Context, query ListScriptsQuery) (*Page[Script], error) {
	q := pageValues(query.PageQuery)
	setIf(q, "q", query.Q)
	setIf(q, "userId", query.UserID)
	var out Page[Script]
	return &out, c.getJSON(ctx, "/api/scripts", q, &out)
}

// CreateScript calls createScript, which scaffolds the script folder with workspace helpers.
func (c *Client) CreateScript(ctx context.Context, body CreateScript) (*Script, error) {
	var out Script
	return &out, c.userCall(ctx, http.MethodPost, "/api/scripts", nil, body, &out, helperCallTimeout)
}

// UploadScript calls uploadScript with a gzip-compressed pack streamed from pack. The upload is never
// retried.
func (c *Client) UploadScript(ctx context.Context, pack io.Reader, opts UploadScriptOptions) (*UploadScriptResult, error) {
	if err := c.requireUser(); err != nil {
		return nil, err
	}
	q := url.Values{}
	if opts.Force {
		q.Set("force", "true")
	}
	var out UploadScriptResult
	_, err := c.Do(ctx, Request{
		Method: http.MethodPost, Path: "/api/scripts/upload", Query: q,
		RawBody: pack, ContentType: "application/gzip",
		Timeout: helperCallTimeout + 5*time.Minute,
	}, &out)
	return &out, err
}

// GetScript calls getScript.
func (c *Client) GetScript(ctx context.Context, script string) (*Script, error) {
	var out Script
	return &out, c.getJSON(ctx, scriptPath(script), nil, &out)
}

// DeleteScript calls deleteScript and returns its scriptDelete job.
func (c *Client) DeleteScript(ctx context.Context, script string) (*JobRef, error) {
	var out struct {
		Job JobRef `json:"job"`
	}
	err := c.userCall(ctx, http.MethodDelete, scriptPath(script), nil, nil, &out, 0)
	return &out.Job, err
}

// DownloadScriptWorkspace calls downloadScriptWorkspace; the caller closes the gzip stream.
func (c *Client) DownloadScriptWorkspace(ctx context.Context, script string) (io.ReadCloser, error) {
	return c.openStream(ctx, scriptPath(script)+"/workspace/archive", nil, "application/gzip")
}

// ── script files ─────────────────────────────────────────────────────────────

// ListScriptFiles calls listScriptFiles.
func (c *Client) ListScriptFiles(ctx context.Context, script, path string, recursive bool) (*TaskFileList, error) {
	q := url.Values{"path": {path}, "recursive": {strconv.FormatBool(recursive)}}
	var out TaskFileList
	return &out, c.userCall(ctx, http.MethodGet, scriptPath(script)+"/files", q, nil, &out, helperCallTimeout)
}

// ReadScriptFile calls readScriptFile.
func (c *Client) ReadScriptFile(ctx context.Context, script, path string) (*TaskFileContent, error) {
	q := url.Values{"path": {path}}
	var out TaskFileContent
	return &out, c.userCall(ctx, http.MethodGet, scriptPath(script)+"/files/content", q, nil, &out, helperCallTimeout)
}

// WriteScriptFiles calls writeScriptFiles (≤ 200 files per call).
func (c *Client) WriteScriptFiles(ctx context.Context, script string, files map[string]TaskFileData) (*WriteScriptFilesResult, error) {
	var out WriteScriptFilesResult
	return &out, c.userCall(ctx, http.MethodPut, scriptPath(script)+"/files", nil,
		WriteTaskFiles{Files: files}, &out, helperCallTimeout)
}

// DeleteScriptFile calls deleteScriptFile.
func (c *Client) DeleteScriptFile(ctx context.Context, script, path string, recursive bool) (*DeleteScriptFileResult, error) {
	q := url.Values{"path": {path}, "recursive": {strconv.FormatBool(recursive)}}
	var out DeleteScriptFileResult
	return &out, c.userCall(ctx, http.MethodDelete, scriptPath(script)+"/files", q, nil, &out, helperCallTimeout)
}

// ── script runs ──────────────────────────────────────────────────────────────

// StartScriptRun calls startScriptRun. The request snapshots the script folder synchronously, so it may
// wait for a workspace helper; wait > 0 long-polls until the run is terminal.
func (c *Client) StartScriptRun(ctx context.Context, script string, body StartScriptRun, wait int) (*ScriptRun, error) {
	var out ScriptRun
	return &out, c.userCall(ctx, http.MethodPost, scriptPath(script)+"/runs", waitValues(wait), body, &out, helperCallTimeout+waitTimeout(wait))
}

// ListScriptRuns calls listScriptRuns (newest first, without logTail).
func (c *Client) ListScriptRuns(ctx context.Context, script string, page PageQuery) (*Page[ScriptRun], error) {
	var out Page[ScriptRun]
	return &out, c.getJSON(ctx, scriptPath(script)+"/runs", pageValues(page), &out)
}

// GetScriptRun calls getScriptRun; wait > 0 long-polls until the run is terminal.
func (c *Client) GetScriptRun(ctx context.Context, scriptRunID string, wait int) (*ScriptRun, error) {
	var out ScriptRun
	return &out, c.getWait(ctx, scriptRunPath(scriptRunID), nil, wait, &out)
}

// CancelScriptRun calls cancelScriptRun.
func (c *Client) CancelScriptRun(ctx context.Context, scriptRunID string) (*ScriptRun, error) {
	var out ScriptRun
	return &out, c.postJSON(ctx, scriptRunPath(scriptRunID)+"/cancel", nil, nil, &out, 0)
}

// RestartScriptRun calls restartScriptRun and returns the new run. Like startScriptRun it snapshots the
// script folder synchronously.
func (c *Client) RestartScriptRun(ctx context.Context, scriptRunID string, body RestartScriptRun) (*ScriptRun, error) {
	var out ScriptRun
	return &out, c.userCall(ctx, http.MethodPost, scriptRunPath(scriptRunID)+"/restart", nil, body, &out, helperCallTimeout)
}

// GetScriptRunLogs calls getScriptRunLogs: the lines after afterLine (0 = from the first retained line),
// at most limit (0 = server default) per page.
func (c *Client) GetScriptRunLogs(ctx context.Context, scriptRunID string, afterLine int64, limit int) (*ScriptRunLogsPage, error) {
	q := url.Values{}
	if afterLine > 0 {
		q.Set("afterLine", strconv.FormatInt(afterLine, 10))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out ScriptRunLogsPage
	return &out, c.getJSON(ctx, scriptRunPath(scriptRunID)+"/logs", q, &out)
}

// GetScriptRunOutputDownload calls getScriptRunOutputDownload with redirect=false.
func (c *Client) GetScriptRunOutputDownload(ctx context.Context, scriptRunID, outputID string) (*FileDownload, error) {
	var out FileDownload
	return &out, c.getJSON(ctx, scriptRunPath(scriptRunID)+"/outputs/"+PathSegment(outputID), url.Values{"redirect": {"false"}}, &out)
}

// ReadScriptRunOutput calls readScriptRunOutput: one byte range from offset, at most length bytes
// (0 = server default).
func (c *Client) ReadScriptRunOutput(ctx context.Context, scriptRunID, outputID string, offset, length int64) (*FileContent, error) {
	q := url.Values{}
	if offset > 0 {
		q.Set("offset", strconv.FormatInt(offset, 10))
	}
	if length > 0 {
		q.Set("length", strconv.FormatInt(length, 10))
	}
	var out FileContent
	return &out, c.getJSON(ctx, scriptRunPath(scriptRunID)+"/outputs/"+PathSegment(outputID)+"/content", q, &out)
}

// GetScriptRunSourceDownload calls getScriptRunSourceDownload with redirect=false: a presigned download
// of the snapshot the run was built from.
func (c *Client) GetScriptRunSourceDownload(ctx context.Context, scriptRunID string) (*DownloadURL, error) {
	var out DownloadURL
	return &out, c.getJSON(ctx, scriptRunPath(scriptRunID)+"/source", url.Values{"redirect": {"false"}}, &out)
}

func waitValues(wait int) url.Values {
	if wait <= 0 {
		return nil
	}
	return url.Values{"wait": {strconv.Itoa(wait)}}
}
