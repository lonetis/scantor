package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"time"
	"unicode/utf8"
)

// Task-file and git methods of the user API (docs/api.md §4.7, §4.8) that user.go does not cover.

// helperCallTimeout bounds calls that run a workspace helper: up to 30 s waiting for a helper slot plus
// the helper itself (SCANTOR_HELPER_TIMEOUT, 5 minutes by default).
const helperCallTimeout = 6 * time.Minute

// TaskFileData is the content of one file of writeTaskFiles: UTF-8 text, sent as a JSON string, or any
// other bytes, sent as {"base64": "…"}.
type TaskFileData struct {
	data   []byte
	binary bool
}

// NewTaskFileData returns the content for data: text when it is valid UTF-8 without NUL bytes, otherwise
// base64.
func NewTaskFileData(data []byte) TaskFileData {
	return TaskFileData{data: data, binary: !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0}
}

// Binary reports whether the content is sent as base64.
func (d TaskFileData) Binary() bool { return d.binary }

// MarshalJSON encodes the text as a string or the bytes as {"base64": "…"}.
func (d TaskFileData) MarshalJSON() ([]byte, error) {
	if d.binary {
		return marshalNoEscape(struct {
			Base64 string `json:"base64"`
		}{base64.StdEncoding.EncodeToString(d.data)})
	}
	return marshalNoEscape(string(d.data))
}

// WriteTaskFiles is the body of writeTaskFiles: task-relative paths and their contents (≤ 200 files).
type WriteTaskFiles struct {
	Files map[string]TaskFileData `json:"files"`
}

// WorkspaceRef is the workspace state returned by the file routes.
type WorkspaceRef struct {
	PackSHA256 string `json:"packSha256"`
	Dirty      bool   `json:"dirty"`
}

// WriteTaskFilesResult is the response of writeTaskFiles.
type WriteTaskFilesResult struct {
	Written   []string     `json:"written"`
	Workspace WorkspaceRef `json:"workspace"`
}

// DeleteTaskFilesResult is the response of deleteTaskFile.
type DeleteTaskFilesResult struct {
	Deleted   []string     `json:"deleted"`
	Workspace WorkspaceRef `json:"workspace"`
}

// ImportGitTask is the body of importGitTask.
type ImportGitTask struct {
	URL          string   `json:"url"`
	Ref          string   `json:"ref,omitempty"`
	Path         string   `json:"path,omitempty"`
	CredentialID string   `json:"credentialId,omitempty"`
	Select       []string `json:"select,omitempty"`
}

// GitCandidate is a task folder found by importGitTask.
type GitCandidate struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Language string `json:"language"`
	Exists   bool   `json:"exists"`
}

// ImportGitResult is the response of importGitTask: the imported tasks, or (with nothing imported) the
// candidates to choose from with select.
type ImportGitResult struct {
	Imported   []Task         `json:"imported"`
	Candidates []GitCandidate `json:"candidates"`
}

// PullGitTask is the body of pullGitTask.
type PullGitTask struct {
	Force bool `json:"force,omitempty"`
}

// PullGitResult is the response of pullGitTask.
type PullGitResult struct {
	Task           Task   `json:"task"`
	PreviousCommit string `json:"previousCommit"`
	Commit         string `json:"commit"`
	Changed        bool   `json:"changed"`
}

// WriteTaskFiles calls writeTaskFiles.
func (c *Client) WriteTaskFiles(ctx context.Context, task string, files map[string]TaskFileData) (*WriteTaskFilesResult, error) {
	var out WriteTaskFilesResult
	return &out, c.userCall(ctx, http.MethodPut, "/api/tasks/"+PathSegment(task)+"/files", nil,
		WriteTaskFiles{Files: files}, &out, helperCallTimeout)
}

// DeleteTaskFile calls deleteTaskFile.
func (c *Client) DeleteTaskFile(ctx context.Context, task, path string, recursive bool) (*DeleteTaskFilesResult, error) {
	q := url.Values{"path": {path}, "recursive": {strconv.FormatBool(recursive)}}
	var out DeleteTaskFilesResult
	return &out, c.userCall(ctx, http.MethodDelete, "/api/tasks/"+PathSegment(task)+"/files", q, nil, &out, helperCallTimeout)
}

// ImportGitTask calls importGitTask.
func (c *Client) ImportGitTask(ctx context.Context, body ImportGitTask) (*ImportGitResult, error) {
	var out ImportGitResult
	return &out, c.userCall(ctx, http.MethodPost, "/api/tasks/import-git", nil, body, &out, helperCallTimeout)
}

// PullGitTask calls pullGitTask.
func (c *Client) PullGitTask(ctx context.Context, task string, body PullGitTask) (*PullGitResult, error) {
	var out PullGitResult
	return &out, c.userCall(ctx, http.MethodPost, "/api/tasks/"+PathSegment(task)+"/git/pull", nil, body, &out, helperCallTimeout)
}

// Compile-time check that TaskFileData stays a json.Marshaler.
var _ json.Marshaler = TaskFileData{}
