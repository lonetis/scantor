package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Typed methods of the user API (docs/api.md §4). Path parameters accept the forms of docs/api.md §1.4
// (task id or name, revision number, "latest" or id, and so on). Methods with a wait parameter
// long-poll up to that many seconds (0 = return immediately).

var errNotUser = errors.New("user API calls need a user API key")

func (c *Client) requireUser() error {
	if c.cred.Kind != PrincipalUser {
		return errNotUser
	}
	if !c.HasToken() {
		return ErrNoToken
	}
	return nil
}

func (c *Client) userCall(ctx context.Context, method, path string, q url.Values, body, out any, timeout time.Duration) error {
	if err := c.requireUser(); err != nil {
		return err
	}
	_, err := c.Do(ctx, Request{Method: method, Path: path, Query: q, Body: body, Timeout: timeout}, out)
	return err
}

func (c *Client) getJSON(ctx context.Context, path string, q url.Values, out any) error {
	return c.userCall(ctx, http.MethodGet, path, q, nil, out, 0)
}

func (c *Client) getWait(ctx context.Context, path string, q url.Values, wait int, out any) error {
	if q == nil {
		q = url.Values{}
	}
	if wait > 0 {
		q.Set("wait", strconv.Itoa(wait))
	}
	return c.userCall(ctx, http.MethodGet, path, q, nil, out, waitTimeout(wait))
}

func (c *Client) postJSON(ctx context.Context, path string, q url.Values, body, out any, wait int) error {
	if wait > 0 {
		if q == nil {
			q = url.Values{}
		}
		q.Set("wait", strconv.Itoa(wait))
	}
	return c.userCall(ctx, http.MethodPost, path, q, body, out, waitTimeout(wait))
}

func pageValues(p PageQuery) url.Values {
	q := url.Values{}
	if p.Limit > 0 {
		q.Set("limit", strconv.Itoa(p.Limit))
	}
	if p.Cursor != "" {
		q.Set("cursor", p.Cursor)
	}
	return q
}

func setList(q url.Values, key string, values []string) {
	if len(values) > 0 {
		q.Set(key, strings.Join(values, ","))
	}
}

func setIf(q url.Values, key, value string) {
	if value != "" {
		q.Set(key, value)
	}
}

// ── health and instance ──────────────────────────────────────────────────────

// GetHealth calls getHealth (public). A 503 with a health body is returned as *Error.
func (c *Client) GetHealth(ctx context.Context) (*Health, error) {
	var out Health
	_, err := c.Do(ctx, Request{Method: http.MethodGet, Path: "/api/health"}, &out)
	return &out, err
}

// GetInstanceInfo calls getInstanceInfo.
func (c *Client) GetInstanceInfo(ctx context.Context) (*InstanceInfo, error) {
	var out InstanceInfo
	return &out, c.getJSON(ctx, "/api/info", nil, &out)
}

// GetAccount calls getAccount.
func (c *Client) GetAccount(ctx context.Context) (*Account, error) {
	var out Account
	return &out, c.getJSON(ctx, "/api/account", nil, &out)
}

// ── tasks ────────────────────────────────────────────────────────────────────

// ListTasksQuery holds the parameters of listTasks.
type ListTasksQuery struct {
	PageQuery
	Q        string
	Language string
	UserID   string
}

// ListTasks calls listTasks.
func (c *Client) ListTasks(ctx context.Context, query ListTasksQuery) (*Page[Task], error) {
	q := pageValues(query.PageQuery)
	setIf(q, "q", query.Q)
	setIf(q, "language", query.Language)
	setIf(q, "userId", query.UserID)
	var out Page[Task]
	return &out, c.getJSON(ctx, "/api/tasks", q, &out)
}

// CreateTask calls createTask.
func (c *Client) CreateTask(ctx context.Context, body CreateTask) (*Task, error) {
	var out Task
	return &out, c.postJSON(ctx, "/api/tasks", nil, body, &out, 0)
}

// GetTask calls getTask.
func (c *Client) GetTask(ctx context.Context, task string) (*Task, error) {
	var out Task
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task), nil, &out)
}

// DeleteTask calls deleteTask.
func (c *Client) DeleteTask(ctx context.Context, task string) (*JobRef, error) {
	var out struct {
		Job JobRef `json:"job"`
	}
	err := c.userCall(ctx, http.MethodDelete, "/api/tasks/"+PathSegment(task), nil, nil, &out, 0)
	return &out.Job, err
}

// UploadTask calls uploadTask with a gzip-compressed pack streamed from pack. The upload is never
// retried.
func (c *Client) UploadTask(ctx context.Context, pack io.Reader, opts UploadTaskOptions) (*UploadTaskResult, error) {
	if err := c.requireUser(); err != nil {
		return nil, err
	}
	q := url.Values{}
	if opts.NoPublish {
		q.Set("publish", "false")
	}
	if opts.Force {
		q.Set("force", "true")
	}
	setIf(q, "message", opts.Message)
	if opts.Wait > 0 {
		q.Set("wait", strconv.Itoa(opts.Wait))
	}
	var out UploadTaskResult
	_, err := c.Do(ctx, Request{
		Method: http.MethodPost, Path: "/api/tasks/upload", Query: q,
		RawBody: pack, ContentType: "application/gzip",
		Timeout: waitTimeout(opts.Wait) + 5*time.Minute,
	}, &out)
	return &out, err
}

// GetTaskWorkspace calls getTaskWorkspace.
func (c *Client) GetTaskWorkspace(ctx context.Context, task string) (*WorkspaceStatus, error) {
	var out WorkspaceStatus
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task)+"/workspace", nil, &out)
}

// DownloadTaskWorkspace calls downloadTaskWorkspace; the caller closes the gzip stream.
func (c *Client) DownloadTaskWorkspace(ctx context.Context, task string) (io.ReadCloser, error) {
	return c.openStream(ctx, "/api/tasks/"+PathSegment(task)+"/workspace/archive", nil, "application/gzip")
}

// ListTaskFiles calls listTaskFiles; revision is optional.
func (c *Client) ListTaskFiles(ctx context.Context, task, path string, recursive bool, revision string) (*TaskFileList, error) {
	q := url.Values{"path": {path}, "recursive": {strconv.FormatBool(recursive)}}
	setIf(q, "revision", revision)
	var out TaskFileList
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task)+"/files", q, &out)
}

// ReadTaskFile calls readTaskFile; revision is optional.
func (c *Client) ReadTaskFile(ctx context.Context, task, path, revision string) (*TaskFileContent, error) {
	q := url.Values{"path": {path}}
	setIf(q, "revision", revision)
	var out TaskFileContent
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task)+"/files/content", q, &out)
}

// ── revisions ────────────────────────────────────────────────────────────────

// ListRevisions calls listRevisions; state is optional.
func (c *Client) ListRevisions(ctx context.Context, task, state string, page PageQuery) (*Page[RevisionSummary], error) {
	q := pageValues(page)
	setIf(q, "state", state)
	var out Page[RevisionSummary]
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task)+"/revisions", q, &out)
}

// PublishRevision calls publishRevision.
func (c *Client) PublishRevision(ctx context.Context, task string, body PublishRevision, wait int) (*Revision, error) {
	var out Revision
	return &out, c.postJSON(ctx, "/api/tasks/"+PathSegment(task)+"/revisions", nil, body, &out, wait)
}

// GetRevision calls getRevision; revision is a number, "latest" or an id.
func (c *Client) GetRevision(ctx context.Context, task, revision string, wait int) (*Revision, error) {
	var out Revision
	return &out, c.getWait(ctx, "/api/tasks/"+PathSegment(task)+"/revisions/"+PathSegment(revision), nil, wait, &out)
}

// GetRevisionBuildLog calls getRevisionBuildLog.
func (c *Client) GetRevisionBuildLog(ctx context.Context, task, revision string, afterLine, limit int) (*BuildLog, error) {
	q := url.Values{}
	if afterLine > 0 {
		q.Set("afterLine", strconv.Itoa(afterLine))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out BuildLog
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task)+"/revisions/"+PathSegment(revision)+"/logs", q, &out)
}

// GetRevisionSourceURL calls downloadRevisionSource with redirect=false.
func (c *Client) GetRevisionSourceURL(ctx context.Context, task, revision string) (*DownloadURL, error) {
	var out DownloadURL
	q := url.Values{"redirect": {"false"}}
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task)+"/revisions/"+PathSegment(revision)+"/source", q, &out)
}

// ── test runs ────────────────────────────────────────────────────────────────

// TestTask calls testTask.
func (c *Client) TestTask(ctx context.Context, task string, body TestTask, wait int) (*TestRun, error) {
	var out TestRun
	return &out, c.postJSON(ctx, "/api/tasks/"+PathSegment(task)+"/test-runs", nil, body, &out, wait)
}

// ListTestRuns calls listTestRuns.
func (c *Client) ListTestRuns(ctx context.Context, task string, page PageQuery) (*Page[TestRun], error) {
	var out Page[TestRun]
	return &out, c.getJSON(ctx, "/api/tasks/"+PathSegment(task)+"/test-runs", pageValues(page), &out)
}

// GetTestRun calls getTestRun.
func (c *Client) GetTestRun(ctx context.Context, testRunID string, withAnalyses bool, wait int) (*TestRun, error) {
	q := url.Values{"analyses": {strconv.FormatBool(withAnalyses)}}
	var out TestRun
	return &out, c.getWait(ctx, "/api/test-runs/"+PathSegment(testRunID), q, wait, &out)
}

// CancelTestRun calls cancelTestRun.
func (c *Client) CancelTestRun(ctx context.Context, testRunID string) (*TestRun, error) {
	var out TestRun
	return &out, c.postJSON(ctx, "/api/test-runs/"+PathSegment(testRunID)+"/cancel", nil, nil, &out, 0)
}

// StreamTestRun calls streamTestRun and returns a reader of its server-sent events. The caller closes
// it; ctx cancellation ends the stream.
func (c *Client) StreamTestRun(ctx context.Context, testRunID string) (*EventStream, error) {
	body, err := c.openStream(ctx, "/api/test-runs/"+PathSegment(testRunID)+"/stream", nil, "text/event-stream")
	if err != nil {
		return nil, err
	}
	return NewEventStream(body), nil
}

// GetTestRunFileDownload calls getTestRunFileDownload with redirect=false.
func (c *Client) GetTestRunFileDownload(ctx context.Context, testRunID, fileID string) (*FileDownload, error) {
	var out FileDownload
	return &out, c.getJSON(ctx, "/api/test-runs/"+PathSegment(testRunID)+"/files/"+PathSegment(fileID), url.Values{"redirect": {"false"}}, &out)
}

// ── catalog ──────────────────────────────────────────────────────────────────

// ListLanguages calls listLanguages.
func (c *Client) ListLanguages(ctx context.Context) ([]LanguageInfo, error) {
	var out List[LanguageInfo]
	return out.Items, c.getJSON(ctx, "/api/languages", nil, &out)
}

// ListTemplates calls listTemplates.
func (c *Client) ListTemplates(ctx context.Context) ([]TemplateInfo, error) {
	var out List[TemplateInfo]
	return out.Items, c.getJSON(ctx, "/api/templates", nil, &out)
}

// GetTemplate calls getTemplate.
func (c *Client) GetTemplate(ctx context.Context, name string) (*TemplateInfo, error) {
	var out TemplateInfo
	return &out, c.getJSON(ctx, "/api/templates/"+PathSegment(name), nil, &out)
}

// EstimateTemplate calls estimateTemplate.
func (c *Client) EstimateTemplate(ctx context.Context, name string, scanConfig json.RawMessage) (*TemplateEstimate, error) {
	var out TemplateEstimate
	return &out, c.postJSON(ctx, "/api/templates/"+PathSegment(name)+"/estimate", nil, EstimateTemplate{ScanConfig: scanConfig}, &out, 0)
}

// ListScaffolds calls listScaffolds.
func (c *Client) ListScaffolds(ctx context.Context) ([]ScaffoldInfo, error) {
	var out List[ScaffoldInfo]
	return out.Items, c.getJSON(ctx, "/api/scaffolds", nil, &out)
}

// GetGuide calls getGuide (or getAuthoringGuide when language is set) and returns the Markdown.
func (c *Client) GetGuide(ctx context.Context, guide, language string) (string, error) {
	path := "/api/guides/" + PathSegment(guide)
	if language != "" {
		path = "/api/guides/authoring/" + PathSegment(language)
	}
	body, err := c.openStream(ctx, path, nil, "text/markdown")
	if err != nil {
		return "", err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, 4<<20))
	if err != nil {
		return "", fmt.Errorf("read guide: %w", err)
	}
	return string(data), nil
}

// ── uploads ──────────────────────────────────────────────────────────────────

// CreateUpload calls createUpload with the raw list file.
func (c *Client) CreateUpload(ctx context.Context, name, contentType string, data io.Reader) (*Upload, error) {
	if err := c.requireUser(); err != nil {
		return nil, err
	}
	if contentType == "" {
		contentType = "text/plain"
	}
	q := url.Values{"kind": {"list"}}
	setIf(q, "name", name)
	var out Upload
	_, err := c.Do(ctx, Request{Method: http.MethodPost, Path: "/api/uploads", Query: q, RawBody: data, ContentType: contentType, Timeout: 10 * time.Minute}, &out)
	return &out, err
}

// ListUploads calls listUploads.
func (c *Client) ListUploads(ctx context.Context, page PageQuery) (*Page[Upload], error) {
	var out Page[Upload]
	return &out, c.getJSON(ctx, "/api/uploads", pageValues(page), &out)
}

// GetUpload calls getUpload.
func (c *Client) GetUpload(ctx context.Context, uploadID string) (*Upload, error) {
	var out Upload
	return &out, c.getJSON(ctx, "/api/uploads/"+PathSegment(uploadID), nil, &out)
}

// DeleteUpload calls deleteUpload.
func (c *Client) DeleteUpload(ctx context.Context, uploadID string) error {
	return c.userCall(ctx, http.MethodDelete, "/api/uploads/"+PathSegment(uploadID), nil, nil, nil, 0)
}

// ── scans ────────────────────────────────────────────────────────────────────

// ListScans calls listScans.
func (c *Client) ListScans(ctx context.Context, query ListScansQuery) (*Page[ScanSummary], error) {
	q := pageValues(query.PageQuery)
	setList(q, "state", query.States)
	setIf(q, "task", query.Task)
	setIf(q, "userId", query.UserID)
	var out Page[ScanSummary]
	return &out, c.getJSON(ctx, "/api/scans", q, &out)
}

// StartScan calls startScan.
func (c *Client) StartScan(ctx context.Context, body StartScan) (*Scan, error) {
	var out Scan
	return &out, c.postJSON(ctx, "/api/scans", nil, body, &out, 0)
}

// GetScan calls getScan.
func (c *Client) GetScan(ctx context.Context, scanID string, wait int) (*Scan, error) {
	var out Scan
	return &out, c.getWait(ctx, "/api/scans/"+PathSegment(scanID), nil, wait, &out)
}

func (c *Client) scanAction(ctx context.Context, scanID, action string, body any) (*Scan, error) {
	var out Scan
	return &out, c.postJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/"+action, nil, body, &out, 0)
}

// PauseScan calls pauseScan.
func (c *Client) PauseScan(ctx context.Context, scanID string) (*Scan, error) {
	return c.scanAction(ctx, scanID, "pause", nil)
}

// ResumeScan calls resumeScan.
func (c *Client) ResumeScan(ctx context.Context, scanID string) (*Scan, error) {
	return c.scanAction(ctx, scanID, "resume", nil)
}

// ScaleScan calls scaleScan.
func (c *Client) ScaleScan(ctx context.Context, scanID string, body ScaleScan) (*Scan, error) {
	return c.scanAction(ctx, scanID, "scale", body)
}

// CancelScan calls cancelScan.
func (c *Client) CancelScan(ctx context.Context, scanID string) (*Scan, error) {
	return c.scanAction(ctx, scanID, "cancel", nil)
}

// RestartScan calls restartScan and returns the new scan.
func (c *Client) RestartScan(ctx context.Context, scanID string, body RestartScan) (*Scan, error) {
	return c.scanAction(ctx, scanID, "restart", body)
}

// RetryFailedAnalyses calls retryFailedAnalyses.
func (c *Client) RetryFailedAnalyses(ctx context.Context, scanID string) (*ScanJob, error) {
	var out ScanJob
	return &out, c.postJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/retry-failed", nil, nil, &out, 0)
}

// DeleteScan calls deleteScan.
func (c *Client) DeleteScan(ctx context.Context, scanID string) (*ScanJob, error) {
	var out ScanJob
	return &out, c.userCall(ctx, http.MethodDelete, "/api/scans/"+PathSegment(scanID), nil, nil, &out, 0)
}

// ListInflightAnalyses calls listInflightAnalyses.
func (c *Client) ListInflightAnalyses(ctx context.Context, scanID string) (*InflightList, error) {
	var out InflightList
	return &out, c.getJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/inflight", nil, &out)
}

// ListScanConditions calls listScanConditions.
func (c *Client) ListScanConditions(ctx context.Context, scanID string) ([]Condition, error) {
	var out List[Condition]
	return out.Items, c.getJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/conditions", nil, &out)
}

// ListScanEvents calls listScanEvents; eventType is optional.
func (c *Client) ListScanEvents(ctx context.Context, scanID, eventType string, page PageQuery) (*Page[Event], error) {
	q := pageValues(page)
	setIf(q, "type", eventType)
	var out Page[Event]
	return &out, c.getJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/events", q, &out)
}

// ListScanWorkers calls listScanWorkers.
func (c *Client) ListScanWorkers(ctx context.Context, scanID string, states []string, page PageQuery) (*Page[Worker], error) {
	q := pageValues(page)
	setList(q, "state", states)
	var out Page[Worker]
	return &out, c.getJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/workers", q, &out)
}

// GetWorkerLogs calls getWorkerLogs (wait ≤ 30 s).
func (c *Client) GetWorkerLogs(ctx context.Context, scanID, workerID string, tailBytes, wait int) (*WorkerLogs, error) {
	q := url.Values{}
	if tailBytes > 0 {
		q.Set("tailBytes", strconv.Itoa(tailBytes))
	}
	var out WorkerLogs
	return &out, c.getWait(ctx, "/api/scans/"+PathSegment(scanID)+"/workers/"+PathSegment(workerID)+"/logs", q, wait, &out)
}

// ── analyses ─────────────────────────────────────────────────────────────────

// ListAnalyses calls listAnalyses (sorted by seq; nextCursor is the last seq).
func (c *Client) ListAnalyses(ctx context.Context, scanID string, query ListAnalysesQuery) (*Page[Analysis], error) {
	q := url.Values{}
	setList(q, "status", query.Statuses)
	setList(q, "fields", query.Fields)
	if query.AfterSeq != nil {
		q.Set("afterSeq", strconv.FormatInt(*query.AfterSeq, 10))
	}
	if query.Limit > 0 {
		q.Set("limit", strconv.Itoa(query.Limit))
	}
	var out Page[Analysis]
	return &out, c.getJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/analyses", q, &out)
}

// GetAnalysis calls getAnalysis.
func (c *Client) GetAnalysis(ctx context.Context, analysisID string) (*Analysis, error) {
	var out Analysis
	return &out, c.getJSON(ctx, "/api/analyses/"+PathSegment(analysisID), nil, &out)
}

// QueryAnalyses calls queryAnalyses.
func (c *Client) QueryAnalyses(ctx context.Context, scanID string, body QueryAnalyses) (*QueryResult, error) {
	var out QueryResult
	return &out, c.postJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/analyses/query", nil, body, &out, 0)
}

// AggregateAnalyses calls aggregateAnalyses.
func (c *Client) AggregateAnalyses(ctx context.Context, scanID string, body AggregateAnalyses) (*AggregateResult, error) {
	var out AggregateResult
	return &out, c.postJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/analyses/aggregate", nil, body, &out, 0)
}

// GetFileDownload calls getFileDownload with redirect=false.
func (c *Client) GetFileDownload(ctx context.Context, analysisID, fileID string) (*FileDownload, error) {
	var out FileDownload
	return &out, c.getJSON(ctx, "/api/analyses/"+PathSegment(analysisID)+"/files/"+PathSegment(fileID), url.Values{"redirect": {"false"}}, &out)
}

// ── exports and jobs ─────────────────────────────────────────────────────────

// ExportScanInline calls exportScanInline and returns the streamed JSONL or CSV body.
func (c *Client) ExportScanInline(ctx context.Context, scanID string, query ExportInlineQuery) (io.ReadCloser, error) {
	q := url.Values{}
	setIf(q, "format", query.Format)
	setList(q, "status", query.Statuses)
	setList(q, "fields", query.Fields)
	if len(query.Filter) > 0 {
		q.Set("filter", string(query.Filter))
	}
	if query.AfterSeq != nil {
		q.Set("afterSeq", strconv.FormatInt(*query.AfterSeq, 10))
	}
	accept := "application/x-ndjson"
	if query.Format == ExportCSV {
		accept = "text/csv"
	}
	return c.openStream(ctx, "/api/scans/"+PathSegment(scanID)+"/export", q, accept)
}

// ExportScan calls exportScan.
func (c *Client) ExportScan(ctx context.Context, scanID string, body ExportScan, wait int) (*Export, error) {
	var out Export
	return &out, c.postJSON(ctx, "/api/scans/"+PathSegment(scanID)+"/exports", nil, body, &out, wait)
}

// ListExports calls listExports; scanID is optional.
func (c *Client) ListExports(ctx context.Context, scanID string, page PageQuery) (*Page[Export], error) {
	q := pageValues(page)
	setIf(q, "scanId", scanID)
	var out Page[Export]
	return &out, c.getJSON(ctx, "/api/exports", q, &out)
}

// GetExport calls getExport.
func (c *Client) GetExport(ctx context.Context, exportID string, wait int) (*Export, error) {
	var out Export
	return &out, c.getWait(ctx, "/api/exports/"+PathSegment(exportID), nil, wait, &out)
}

// DeleteExport calls deleteExport.
func (c *Client) DeleteExport(ctx context.Context, exportID string) error {
	return c.userCall(ctx, http.MethodDelete, "/api/exports/"+PathSegment(exportID), nil, nil, nil, 0)
}

// ListJobsQuery holds the parameters of listJobs.
type ListJobsQuery struct {
	PageQuery
	Kind   string
	State  string
	UserID string
}

// ListJobs calls listJobs.
func (c *Client) ListJobs(ctx context.Context, query ListJobsQuery) (*Page[Job], error) {
	q := pageValues(query.PageQuery)
	setIf(q, "kind", query.Kind)
	setIf(q, "state", query.State)
	setIf(q, "userId", query.UserID)
	var out Page[Job]
	return &out, c.getJSON(ctx, "/api/jobs", q, &out)
}

// GetJob calls getJob.
func (c *Client) GetJob(ctx context.Context, jobID string, wait int) (*Job, error) {
	var out Job
	return &out, c.getWait(ctx, "/api/jobs/"+PathSegment(jobID), nil, wait, &out)
}

// ── nodes (admin) ────────────────────────────────────────────────────────────

// ListNodes calls listNodes; state and pool are optional.
func (c *Client) ListNodes(ctx context.Context, state, pool string) ([]Node, error) {
	q := url.Values{}
	setIf(q, "state", state)
	setIf(q, "pool", pool)
	var out List[Node]
	return out.Items, c.getJSON(ctx, "/api/nodes", q, &out)
}

// CreateNode calls createNode.
func (c *Client) CreateNode(ctx context.Context, body CreateNode) (*NodeWithToken, error) {
	var out NodeWithToken
	return &out, c.postJSON(ctx, "/api/nodes", nil, body, &out, 0)
}

// GetNode calls getNode.
func (c *Client) GetNode(ctx context.Context, nodeID string) (*Node, error) {
	var out Node
	return &out, c.getJSON(ctx, "/api/nodes/"+PathSegment(nodeID), nil, &out)
}

// UpdateNode calls updateNode.
func (c *Client) UpdateNode(ctx context.Context, nodeID string, body UpdateNode) (*Node, error) {
	var out Node
	return &out, c.userCall(ctx, http.MethodPatch, "/api/nodes/"+PathSegment(nodeID), nil, body, &out, 0)
}

// DeleteNode calls deleteNode.
func (c *Client) DeleteNode(ctx context.Context, nodeID string) error {
	return c.userCall(ctx, http.MethodDelete, "/api/nodes/"+PathSegment(nodeID), nil, nil, nil, 0)
}

// RotateNodeToken calls rotateNodeToken.
func (c *Client) RotateNodeToken(ctx context.Context, nodeID string) (*NodeWithToken, error) {
	var out NodeWithToken
	return &out, c.postJSON(ctx, "/api/nodes/"+PathSegment(nodeID)+"/token", nil, nil, &out, 0)
}

// RevokeNodeToken calls revokeNodeToken.
func (c *Client) RevokeNodeToken(ctx context.Context, nodeID string) (*Node, error) {
	var out Node
	return &out, c.userCall(ctx, http.MethodDelete, "/api/nodes/"+PathSegment(nodeID)+"/token", nil, nil, &out, 0)
}

// GetNodeJoin calls getNodeJoin.
func (c *Client) GetNodeJoin(ctx context.Context, nodeID string) (*NodeJoin, error) {
	var out NodeJoin
	return &out, c.getJSON(ctx, "/api/nodes/"+PathSegment(nodeID)+"/join", nil, &out)
}

// ListNodeWorkers calls listNodeWorkers.
func (c *Client) ListNodeWorkers(ctx context.Context, nodeID string, states []string, page PageQuery) (*Page[Worker], error) {
	q := pageValues(page)
	setList(q, "state", states)
	var out Page[Worker]
	return &out, c.getJSON(ctx, "/api/nodes/"+PathSegment(nodeID)+"/workers", q, &out)
}

// ListNodeEvents calls listNodeEvents.
func (c *Client) ListNodeEvents(ctx context.Context, nodeID, eventType string, page PageQuery) (*Page[Event], error) {
	q := pageValues(page)
	setIf(q, "type", eventType)
	var out Page[Event]
	return &out, c.getJSON(ctx, "/api/nodes/"+PathSegment(nodeID)+"/events", q, &out)
}

// openStream performs an authenticated GET and returns the body for streaming.
func (c *Client) openStream(ctx context.Context, path string, q url.Values, accept string) (io.ReadCloser, error) {
	if err := c.requireUser(); err != nil {
		return nil, err
	}
	resp, _, err := c.Open(ctx, Request{Method: http.MethodGet, Path: path, Query: q, Accept: accept})
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}
