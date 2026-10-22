package api

import "encoding/json"

// TaskSource says how a task's workspace was created.
type TaskSource struct {
	Kind     string     `json:"kind"`
	Template string     `json:"template,omitempty"`
	Git      *GitSource `json:"git,omitempty"`
}

// Task source kinds.
const (
	SourceScaffold  = "scaffold"
	SourceUpload    = "upload"
	SourceGit       = "git"
	SourceWorkspace = "workspace"
)

// GitSource records the git origin of a task.
type GitSource struct {
	URL          string `json:"url"`
	Ref          string `json:"ref"`
	Path         string `json:"path"`
	CredentialID string `json:"credentialId,omitempty"`
	Commit       string `json:"commit"`
	PackSHA256   string `json:"packSha256"`
	PulledAt     *Time  `json:"pulledAt"`
}

// TaskWorkspace is the cached workspace status of a task.
type TaskWorkspace struct {
	PackSHA256     *string `json:"packSha256"`
	FileCount      int     `json:"fileCount"`
	Bytes          int64   `json:"bytes"`
	Dirty          bool    `json:"dirty"`
	LastSyncSHA256 *string `json:"lastSyncSha256"`
	CheckedAt      *Time   `json:"checkedAt"`
}

// RevisionPointer is the embedded summary of a task's latest revisions.
type RevisionPointer struct {
	ID         string `json:"id"`
	Number     int    `json:"number"`
	State      string `json:"state"`
	PackSHA256 string `json:"packSha256"`
	CreatedAt  Time   `json:"createdAt"`
}

// Task is the API representation of a task (docs/api.md §2).
type Task struct {
	ID                  string           `json:"id"`
	UserID              string           `json:"userId"`
	Name                string           `json:"name"`
	Language            string           `json:"language"`
	Description         string           `json:"description,omitempty"`
	Source              TaskSource       `json:"source"`
	Workspace           TaskWorkspace    `json:"workspace"`
	RevisionCount       int              `json:"revisionCount"`
	LatestRevision      *RevisionPointer `json:"latestRevision"`
	LatestReadyRevision *RevisionPointer `json:"latestReadyRevision"`
	Privileged          bool             `json:"privileged"`
	CreatedAt           Time             `json:"createdAt"`
	UpdatedAt           Time             `json:"updatedAt"`
}

// CreateTask is the body of createTask.
type CreateTask struct {
	Name        string `json:"name"`
	Language    string `json:"language"`
	Template    string `json:"template,omitempty"`
	Description string `json:"description,omitempty"`
}

// UploadTaskOptions are the query parameters of uploadTask.
type UploadTaskOptions struct {
	// Publish defaults to true on the server; set NoPublish to send publish=false.
	NoPublish bool
	Force     bool
	Message   string
	Wait      int
}

// UploadTaskResult is the response of uploadTask.
type UploadTaskResult struct {
	Task     Task      `json:"task"`
	Revision *Revision `json:"revision"`
	Created  bool      `json:"created"`
}

// WorkspaceStatus is the response of getTaskWorkspace.
type WorkspaceStatus struct {
	PackSHA256               string  `json:"packSha256"`
	FileCount                int     `json:"fileCount"`
	Bytes                    int64   `json:"bytes"`
	Dirty                    bool    `json:"dirty"`
	LatestRevisionPackSHA256 *string `json:"latestRevisionPackSha256"`
	LastSyncSHA256           *string `json:"lastSyncSha256"`
	CheckedAt                Time    `json:"checkedAt"`
}

// TaskFileEntry is one entry of listTaskFiles.
type TaskFileEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
	Mode int    `json:"mode"`
}

// TaskFileList is the response of listTaskFiles.
type TaskFileList struct {
	Entries   []TaskFileEntry `json:"entries"`
	Truncated bool            `json:"truncated"`
}

// TaskFileContent is the response of readTaskFile.
type TaskFileContent struct {
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	SHA256    string `json:"sha256"`
	Encoding  string `json:"encoding"`
	Content   string `json:"content"`
	Truncated bool   `json:"truncated"`
}

// RevisionSourceInfo is the provenance of a revision (docs/tasks.md §10).
type RevisionSourceInfo struct {
	Kind       string             `json:"kind"`
	PackSHA256 string             `json:"packSha256"`
	PackBytes  int64              `json:"packBytes"`
	FileCount  int                `json:"fileCount"`
	Git        *RevisionGitSource `json:"git,omitempty"`
}

// RevisionGitSource is the git provenance of a revision.
type RevisionGitSource struct {
	URL    string `json:"url"`
	Ref    string `json:"ref"`
	Path   string `json:"path"`
	Commit string `json:"commit"`
	Dirty  bool   `json:"dirty"`
}

// ImageRef is a reference pinned by digest.
type ImageRef struct {
	Ref    string `json:"ref"`
	Digest string `json:"digest"`
}

// RevisionImage is the pushed image of a revision.
type RevisionImage struct {
	Repository string   `json:"repository"`
	Tag        string   `json:"tag"`
	Digest     string   `json:"digest"`
	Bytes      int64    `json:"bytes"`
	Platform   Platform `json:"platform"`
}

// Revision states.
const (
	RevisionQueued   = "queued"
	RevisionBuilding = "building"
	RevisionReady    = "ready"
	RevisionFailed   = "failed"
)

// Revision is the API representation of a revision (docs/api.md §2). Manifest is the normalised
// manifest as stored (internal/manifest.Manifest).
type Revision struct {
	ID               string             `json:"id"`
	UserID           string             `json:"userId"`
	TaskID           string             `json:"taskId"`
	TaskName         string             `json:"taskName"`
	Number           int                `json:"number"`
	Ref              string             `json:"ref"`
	State            string             `json:"state"`
	Message          string             `json:"message,omitempty"`
	Source           RevisionSourceInfo `json:"source"`
	Manifest         json.RawMessage    `json:"manifest,omitempty"`
	Language         string             `json:"language,omitempty"`
	BaseImage        *ImageRef          `json:"baseImage,omitempty"`
	Image            *RevisionImage     `json:"image"`
	Description      *Description       `json:"description"`
	SettingsDefaults *ScanSettings      `json:"settingsDefaults,omitempty"`
	Privileged       bool               `json:"privileged"`
	Errors           []BuildError       `json:"errors"`
	CreatedAt        Time               `json:"createdAt"`
	StartedAt        *Time              `json:"startedAt,omitempty"`
	FinishedAt       *Time              `json:"finishedAt,omitempty"`
	UpdatedAt        Time               `json:"updatedAt"`
}

// RevisionSummary is the list representation of a revision.
type RevisionSummary struct {
	ID          string             `json:"id"`
	Number      int                `json:"number"`
	Ref         string             `json:"ref"`
	State       string             `json:"state"`
	Source      RevisionSourceInfo `json:"source"`
	Privileged  bool               `json:"privileged"`
	ErrorsCount int                `json:"errorsCount"`
	CreatedAt   Time               `json:"createdAt"`
	FinishedAt  *Time              `json:"finishedAt"`
}

// PublishRevision is the body of publishRevision.
type PublishRevision struct {
	Message string `json:"message,omitempty"`
}

// BuildLogLine is one entry of getRevisionBuildLog.
type BuildLogLine struct {
	Line   int             `json:"line"`
	At     Time            `json:"at"`
	Phase  string          `json:"phase"`
	Type   string          `json:"type"`
	Stream string          `json:"stream,omitempty"`
	Level  string          `json:"level,omitempty"`
	Text   string          `json:"text,omitempty"`
	Error  *BuildError     `json:"error,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
}

// BuildLog is the response of getRevisionBuildLog.
type BuildLog struct {
	Lines    []BuildLogLine `json:"lines"`
	NextLine int            `json:"nextLine"`
	Complete bool           `json:"complete"`
}

// DownloadURL is a presigned download URL with its expiry.
type DownloadURL struct {
	URL       string `json:"url"`
	ExpiresAt Time   `json:"expiresAt"`
}

// TestTask is the body of testTask.
type TestTask struct {
	TaskConfig     json.RawMessage `json:"taskConfig,omitempty"`
	ScanConfig     json.RawMessage `json:"scanConfig,omitempty"`
	AnalysisConfig json.RawMessage `json:"analysisConfig,omitempty"`
	Limit          int             `json:"limit,omitempty"`
	MaxAttempts    int             `json:"maxAttempts,omitempty"`
	TimeoutMs      int64           `json:"timeoutMs,omitempty"`
}

// TestRunInput is the recorded input of a test run (secrets masked).
type TestRunInput struct {
	TaskConfig     json.RawMessage `json:"taskConfig,omitempty"`
	ScanConfig     json.RawMessage `json:"scanConfig,omitempty"`
	AnalysisConfig json.RawMessage `json:"analysisConfig,omitempty"`
	Limit          int             `json:"limit"`
	MaxAttempts    int             `json:"maxAttempts"`
	TimeoutMs      int64           `json:"timeoutMs"`
}

// DraftImage is the draft image of a test run.
type DraftImage struct {
	Ref    string `json:"ref"`
	Digest string `json:"digest"`
	Cached bool   `json:"cached"`
}

// TestRunSummary counts the analyses of a test run.
type TestRunSummary struct {
	Analyses  int `json:"analyses"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

// Test-run states.
const (
	TestRunQueued    = "queued"
	TestRunBuilding  = "building"
	TestRunRunning   = "running"
	TestRunCompleted = "completed"
	TestRunFailed    = "failed"
	TestRunCancelled = "cancelled"
)

// TestRun is the API representation of a test run (docs/api.md §2).
type TestRun struct {
	ID          string            `json:"id"`
	UserID      string            `json:"userId"`
	TaskID      string            `json:"taskId"`
	TaskName    string            `json:"taskName"`
	State       string            `json:"state"`
	Input       TestRunInput      `json:"input"`
	PackSHA256  string            `json:"packSha256,omitempty"`
	DraftImage  *DraftImage       `json:"draftImage,omitempty"`
	Description *Description      `json:"description,omitempty"`
	Errors      []BuildError      `json:"errors"`
	Summary     TestRunSummary    `json:"summary"`
	Analyses    []TestRunAnalysis `json:"analyses,omitempty"`
	CreatedAt   Time              `json:"createdAt"`
	StartedAt   *Time             `json:"startedAt,omitempty"`
	FinishedAt  *Time             `json:"finishedAt,omitempty"`
	ExpiresAt   Time              `json:"expiresAt"`
}

// Settled reports whether the test run reached a final state.
func (t TestRun) Settled() bool {
	return t.State == TestRunCompleted || t.State == TestRunFailed || t.State == TestRunCancelled
}

// TestRunAnalysis is one analysis of a test run (an Analysis without round and worker fields).
type TestRunAnalysis struct {
	ID        string          `json:"id"`
	TestRunID string          `json:"testRunId,omitempty"`
	Seq       int64           `json:"seq"`
	Status    string          `json:"status"`
	Attempt   int             `json:"attempt"`
	Config    json.RawMessage `json:"config,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *ScantorError   `json:"error"`
	Attempts  []Attempt       `json:"attempts"`
	Files     []FileRef       `json:"files"`
	LogTail   string          `json:"logTail"`
	Timings   *Timings        `json:"timings,omitempty"`
	CreatedAt *Time           `json:"createdAt,omitempty"`
	UpdatedAt *Time           `json:"updatedAt,omitempty"`
}

// TestRunLogEvent is the data of a `log` event of streamTestRun.
type TestRunLogEvent struct {
	Seq    *int64 `json:"seq"`
	Stream string `json:"stream"`
	Text   string `json:"text"`
	At     Time   `json:"at"`
}

// TestRunStateEvent is the data of a `state` event of streamTestRun.
type TestRunStateEvent struct {
	State string `json:"state"`
}

// Server-sent event names of streamTestRun.
const (
	TestRunEventState    = "state"
	TestRunEventLog      = "log"
	TestRunEventAnalysis = "analysis"
	TestRunEventError    = "error"
	TestRunEventEnd      = "end"
)

// FileDownload is a presigned download of an analysis or test-run file.
type FileDownload struct {
	URL         string `json:"url"`
	ExpiresAt   Time   `json:"expiresAt"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
	Inline      bool   `json:"inline"`
}

// LanguageInfo is one item of listLanguages.
type LanguageInfo struct {
	Language   string   `json:"language"`
	Title      string   `json:"title"`
	Base       string   `json:"base"`
	BaseImage  string   `json:"baseImage"`
	Entry      string   `json:"entry"`
	Extensions []string `json:"extensions"`
}

// TemplateExample is the example configs of a template.
type TemplateExample struct {
	ScanConfig     json.RawMessage `json:"scanConfig"`
	AnalysisConfig json.RawMessage `json:"analysisConfig"`
}

// TemplateInfo is one item of listTemplates.
type TemplateInfo struct {
	Name                 string          `json:"name"`
	Title                string          `json:"title"`
	Description          string          `json:"description"`
	ScanConfigSchema     json.RawMessage `json:"scanConfigSchema"`
	AnalysisConfigSchema json.RawMessage `json:"analysisConfigSchema"`
	Example              TemplateExample `json:"example"`
	Resolves             bool            `json:"resolves"`
}

// EstimateTemplate is the body of estimateTemplate.
type EstimateTemplate struct {
	ScanConfig json.RawMessage `json:"scanConfig"`
}

// TemplateEstimate is the response of estimateTemplate.
type TemplateEstimate struct {
	ExpectedTotal        *int64 `json:"expectedTotal"`
	Exact                bool   `json:"exact"`
	ConfirmationRequired bool   `json:"confirmationRequired"`
	TooLarge             bool   `json:"tooLarge"`
}

// ScaffoldInfo is one item of listScaffolds.
type ScaffoldInfo struct {
	Language  string   `json:"language"`
	Templates []string `json:"templates"`
}

// Upload is an uploaded list file (docs/api.md §4.9).
type Upload struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
	Lines       int64  `json:"lines"`
	LastUsedAt  *Time  `json:"lastUsedAt"`
	CreatedAt   Time   `json:"createdAt"`
}

// GitCredential is a stored git credential (never with its secret).
type GitCredential struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Name       string `json:"name"`
	Host       string `json:"host"`
	Username   string `json:"username"`
	Last4      string `json:"last4"`
	LastUsedAt *Time  `json:"lastUsedAt"`
	CreatedAt  Time   `json:"createdAt"`
	UpdatedAt  Time   `json:"updatedAt"`
}
