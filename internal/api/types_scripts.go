package api

import "encoding/json"

// Wire types of scripts and script runs (docs/api.md, tags `scripts`, `script-files`, `script-runs`;
// docs/scripts.md). They mirror orchestrator/shared/types/scripts.ts. Script sources reuse SourceScaffold
// and SourceUpload.

// ScriptSource says how a script's folder was created.
type ScriptSource struct {
	Kind string `json:"kind"`
}

// ScriptWorkspace is the cached workspace status of a script folder. Scripts have no revisions, so
// nothing is "dirty".
type ScriptWorkspace struct {
	PackSHA256 *string `json:"packSha256"`
	FileCount  int     `json:"fileCount"`
	Bytes      int64   `json:"bytes"`
	CheckedAt  *Time   `json:"checkedAt"`
}

// ScriptDescribe holds the JSON Schemas the script's code reported for the pack PackSHA256 (its config
// and result models; null when the script declares none).
type ScriptDescribe struct {
	PackSHA256   string          `json:"packSha256"`
	ConfigSchema json.RawMessage `json:"configSchema"`
	ResultSchema json.RawMessage `json:"resultSchema"`
	At           Time            `json:"at"`
}

// Script-run states.
const (
	ScriptRunQueued    = "queued"
	ScriptRunBuilding  = "building"
	ScriptRunRunning   = "running"
	ScriptRunCompleted = "completed"
	ScriptRunFailed    = "failed"
	ScriptRunCancelled = "cancelled"
)

// ScriptRunSettled reports whether a script-run state is terminal.
func ScriptRunSettled(state string) bool {
	return state == ScriptRunCompleted || state == ScriptRunFailed || state == ScriptRunCancelled
}

// Streams of a script run's log.
const (
	ScriptRunStreamBuild  = "build"
	ScriptRunStreamStdout = "stdout"
	ScriptRunStreamStderr = "stderr"
	ScriptRunStreamSystem = "system"
)

// Script-run error types: the script reports scriptError and validation itself; the platform decides
// the others.
const (
	ScriptErrorScript     = "scriptError"
	ScriptErrorValidation = "validation"
	ScriptErrorTimeout    = "timeout"
	ScriptErrorCrash      = "crash"
	ScriptErrorPlatform   = "platform"
)

// ScriptRunPointer is the embedded summary of a script's latest run.
type ScriptRunPointer struct {
	ID         string `json:"id"`
	State      string `json:"state"`
	CreatedAt  Time   `json:"createdAt"`
	FinishedAt *Time  `json:"finishedAt"`
}

// ScriptRunProgress is the progress a script run reported (done and total are any non-negative numbers).
type ScriptRunProgress struct {
	Done      float64  `json:"done"`
	Total     *float64 `json:"total"`
	Message   *string  `json:"message"`
	UpdatedAt Time     `json:"updatedAt"`
}

// ScriptRunSummary is one of a script's recent runs.
type ScriptRunSummary struct {
	ScriptRunPointer
	Progress *ScriptRunProgress `json:"progress"`
}

// Script is the API representation of a script (docs/api.md §2).
type Script struct {
	ID          string            `json:"id"`
	UserID      string            `json:"userId"`
	Name        string            `json:"name"`
	Language    string            `json:"language"`
	Description *string           `json:"description"`
	Source      ScriptSource      `json:"source"`
	Workspace   ScriptWorkspace   `json:"workspace"`
	Describe    *ScriptDescribe   `json:"describe"`
	LatestRun   *ScriptRunPointer `json:"latestRun"`
	// RecentRuns holds the newest runs (at most 10, newest first); only getScript and createScript return it
	// (nil when absent, so a JSON round trip keeps an empty list apart from a missing one).
	RecentRuns *[]ScriptRunSummary `json:"recentRuns,omitempty"`
	CreatedAt  Time                `json:"createdAt"`
	UpdatedAt  Time                `json:"updatedAt"`
}

// ListScriptsQuery holds the parameters of listScripts.
type ListScriptsQuery struct {
	PageQuery
	Q      string
	UserID string
}

// CreateScript is the body of createScript.
type CreateScript struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

// UploadScriptOptions are the query parameters of uploadScript.
type UploadScriptOptions struct {
	Force bool
}

// UploadScriptResult is the response of uploadScript.
type UploadScriptResult struct {
	Script  Script `json:"script"`
	Created bool   `json:"created"`
}

// ScriptWorkspaceChange is the workspace state returned by the script file routes.
type ScriptWorkspaceChange struct {
	PackSHA256 string `json:"packSha256"`
}

// WriteScriptFilesResult is the response of writeScriptFiles.
type WriteScriptFilesResult struct {
	Written   []string              `json:"written"`
	Workspace ScriptWorkspaceChange `json:"workspace"`
}

// DeleteScriptFileResult is the response of deleteScriptFile.
type DeleteScriptFileResult struct {
	Deleted   []string              `json:"deleted"`
	Workspace ScriptWorkspaceChange `json:"workspace"`
}

// ScriptRunResources are the resources of a script-run container; nil = not given (before the build).
type ScriptRunResources struct {
	CPUs      *float64 `json:"cpus"`
	MemoryMiB *int64   `json:"memoryMiB"`
}

// ScriptRunSettings are the settings of a script run: the effective values once the run was built, the
// explicit ones (nil = not given) before. Limit makes a sample run (analyses per stream; nil = all).
type ScriptRunSettings struct {
	TimeoutMs *int64             `json:"timeoutMs"`
	Resources ScriptRunResources `json:"resources"`
	Limit     *int64             `json:"limit"`
}

// ScriptRunInput is the recorded input of a script run (secrets are listed by name only).
type ScriptRunInput struct {
	Config   json.RawMessage   `json:"config"`
	Settings ScriptRunSettings `json:"settings"`
}

// ScriptRunScan is a scan a script run reads; Name is nil for an unnamed scan.
type ScriptRunScan struct {
	ID   string  `json:"id"`
	Name *string `json:"name"`
}

// ScriptRunSource is the snapshot a script run was built from: the SHA-256 of the uncompressed pack, the
// size of the stored tar.gz and the number of files.
type ScriptRunSource struct {
	PackSHA256 string `json:"packSha256"`
	PackBytes  int64  `json:"packBytes"`
	FileCount  int    `json:"fileCount"`
}

// ScriptRunRestartedFrom names the run a restart was made of; Resume means the new run received its
// checkpoint and outputs.
type ScriptRunRestartedFrom struct {
	ID     string `json:"id"`
	Resume bool   `json:"resume"`
}

// ScriptRunImage is the local image of a script run.
type ScriptRunImage struct {
	Ref    string `json:"ref"`
	Cached bool   `json:"cached"`
}

// ScriptRunError is the error of a failed script run.
type ScriptRunError struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Stack   string `json:"stack,omitempty"`
}

// ScriptRunCheckpoint describes the last checkpoint a script run saved (its state is never returned).
type ScriptRunCheckpoint struct {
	SavedAt Time  `json:"savedAt"`
	Bytes   int64 `json:"bytes"`
}

// ScriptRunOutput is a stored output file of a script run. SHA256 is the digest the script reported.
type ScriptRunOutput struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
	CreatedAt   Time   `json:"createdAt"`
}

// ScriptRunLogLine is one line of a script run's log; lines are numbered from 1.
type ScriptRunLogLine struct {
	Line   int64  `json:"line"`
	At     Time   `json:"at"`
	Stream string `json:"stream"`
	Text   string `json:"text"`
}

// ScriptRunLogState counts the lines of a script run's log: FirstLine is the first retained line and
// DroppedLines the lines the retention or the rate limit removed.
type ScriptRunLogState struct {
	Lines        int64 `json:"lines"`
	FirstLine    int64 `json:"firstLine"`
	DroppedLines int64 `json:"droppedLines"`
}

// ScriptRun is the API representation of a script run (docs/api.md §2).
type ScriptRun struct {
	ID            string                  `json:"id"`
	UserID        string                  `json:"userId"`
	ScriptID      string                  `json:"scriptId"`
	ScriptName    string                  `json:"scriptName"`
	Scans         []ScriptRunScan         `json:"scans"`
	State         string                  `json:"state"`
	Input         ScriptRunInput          `json:"input"`
	Secrets       []string                `json:"secrets"`
	Source        ScriptRunSource         `json:"source"`
	RestartedFrom *ScriptRunRestartedFrom `json:"restartedFrom"`
	Image         *ScriptRunImage         `json:"image"`
	Errors        []BuildError            `json:"errors"`
	Error         *ScriptRunError         `json:"error"`
	ExitCode      *int                    `json:"exitCode"`
	Progress      *ScriptRunProgress      `json:"progress"`
	Checkpoint    *ScriptRunCheckpoint    `json:"checkpoint"`
	Result        json.RawMessage         `json:"result"`
	Outputs       []ScriptRunOutput       `json:"outputs"`
	Log           ScriptRunLogState       `json:"log"`
	// LogTail holds the last lines of the log (at most 50 lines, 16 KiB); single-run responses only (nil when
	// absent, as for RecentRuns).
	LogTail    *[]ScriptRunLogLine `json:"logTail,omitempty"`
	CreatedAt  Time                `json:"createdAt"`
	StartedAt  *Time               `json:"startedAt"`
	FinishedAt *Time               `json:"finishedAt"`
	UpdatedAt  Time                `json:"updatedAt"`
	ExpiresAt  *Time               `json:"expiresAt"`
}

// Settled reports whether the script run reached a final state.
func (r ScriptRun) Settled() bool { return ScriptRunSettled(r.State) }

// ScriptRunSettingsInput are the settings of startScriptRun, merged over the manifest defaults when the
// run is built (explicit values win). Limit makes a sample run.
type ScriptRunSettingsInput struct {
	TimeoutMs *int64                   `json:"timeoutMs,omitempty"`
	Resources *ScriptRunResourcesInput `json:"resources,omitempty"`
	Limit     *int64                   `json:"limit,omitempty"`
}

// ScriptRunResourcesInput are the resources of a settings input.
type ScriptRunResourcesInput struct {
	CPUs      *float64 `json:"cpus,omitempty"`
	MemoryMiB *int64   `json:"memoryMiB,omitempty"`
}

// StartScriptRun is the body of startScriptRun: 1–20 scans of the script's owner, the config (a JSON
// object, default {}) and secrets the script reads as ctx.secrets (never returned).
type StartScriptRun struct {
	Scans    []string                `json:"scans"`
	Config   json.RawMessage         `json:"config,omitempty"`
	Secrets  map[string]string       `json:"secrets,omitempty"`
	Settings *ScriptRunSettingsInput `json:"settings,omitempty"`
	Confirm  bool                    `json:"confirm,omitempty"`
}

// RestartScriptRunSettings are the setting overrides of restartScriptRun. ClearLimit sends
// `"limit": null`, which removes the original run's limit (it wins over Limit).
type RestartScriptRunSettings struct {
	TimeoutMs  *int64
	Resources  *ScriptRunResourcesInput
	Limit      *int64
	ClearLimit bool
}

// MarshalJSON writes only the given overrides; ClearLimit becomes `"limit": null`.
func (s RestartScriptRunSettings) MarshalJSON() ([]byte, error) {
	out := struct {
		TimeoutMs *int64                   `json:"timeoutMs,omitempty"`
		Resources *ScriptRunResourcesInput `json:"resources,omitempty"`
		Limit     json.RawMessage          `json:"limit,omitempty"`
	}{TimeoutMs: s.TimeoutMs, Resources: s.Resources}
	switch {
	case s.ClearLimit:
		out.Limit = json.RawMessage("null")
	case s.Limit != nil:
		b, err := json.Marshal(*s.Limit)
		if err != nil {
			return nil, err
		}
		out.Limit = b
	}
	return marshalNoEscape(out)
}

// UnmarshalJSON reads the overrides; `"limit": null` sets ClearLimit.
func (s *RestartScriptRunSettings) UnmarshalJSON(data []byte) error {
	var in struct {
		TimeoutMs *int64                   `json:"timeoutMs"`
		Resources *ScriptRunResourcesInput `json:"resources"`
		Limit     json.RawMessage          `json:"limit"`
	}
	if err := json.Unmarshal(data, &in); err != nil {
		return err
	}
	*s = RestartScriptRunSettings{TimeoutMs: in.TimeoutMs, Resources: in.Resources}
	switch {
	case len(in.Limit) == 0:
	case string(in.Limit) == "null":
		s.ClearLimit = true
	default:
		var limit int64
		if err := json.Unmarshal(in.Limit, &limit); err != nil {
			return err
		}
		s.Limit = &limit
	}
	return nil
}

// RestartScriptRun is the body of restartScriptRun: a new run of the script's current folder with the
// original run's scans, config, secrets and settings; Config and Settings override them. Resume (only
// for a finished original) hands the original's checkpoint and outputs to the new run.
type RestartScriptRun struct {
	Resume   bool                      `json:"resume,omitempty"`
	Config   json.RawMessage           `json:"config,omitempty"`
	Settings *RestartScriptRunSettings `json:"settings,omitempty"`
	Confirm  bool                      `json:"confirm,omitempty"`
}

// ScriptRunLogsPage is the response of getScriptRunLogs: the lines after afterLine. NextLine continues
// the log; Complete is true when the run is terminal and no line follows.
type ScriptRunLogsPage struct {
	Lines     []ScriptRunLogLine `json:"lines"`
	FirstLine int64              `json:"firstLine"`
	NextLine  int64              `json:"nextLine"`
	Complete  bool               `json:"complete"`
}

// ScriptRunConfirmationScan is a scan listed by ScriptRunConfirmationDetails.
type ScriptRunConfirmationScan struct {
	ID       string  `json:"id"`
	Name     *string `json:"name"`
	Analyses int64   `json:"analyses"`
}

// ScriptRunConfirmationDetails are the details of confirmationRequired from startScriptRun and
// restartScriptRun without settings.limit (MCP principals only).
type ScriptRunConfirmationDetails struct {
	Scans      []ScriptRunConfirmationScan `json:"scans"`
	PackSHA256 string                      `json:"packSha256"`
}

// FileContent is one byte range of a stored file, inline (readAnalysisFile, readTestRunFile,
// readScriptRunOutput). Size and SHA256 describe the whole file; NextOffset is set when Truncated.
type FileContent struct {
	Name        string `json:"name"`
	ContentType string `json:"contentType"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	Offset      int64  `json:"offset"`
	Length      int64  `json:"length"`
	Encoding    string `json:"encoding"`
	Content     string `json:"content"`
	Truncated   bool   `json:"truncated"`
	NextOffset  *int64 `json:"nextOffset"`
}
