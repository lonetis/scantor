package api

// Bundle states (docs/data-model.md §6.12).
const (
	BundleQueued  = "queued"
	BundleRunning = "running"
	BundleReady   = "ready"
	BundleFailed  = "failed"
)

// Bundle is the API representation of a revision's bundle (docs/api.md §2): a gzip Docker image archive
// of the revision that runs with only Docker.
type Bundle struct {
	ID             string         `json:"id"`
	Revision       BundleRevision `json:"revision"`
	State          string         `json:"state"`
	Image          string         `json:"image"`
	Platform       Platform       `json:"platform"`
	Bytes          *int64         `json:"bytes"`
	SHA256         *string        `json:"sha256"`
	ScantorVersion *string        `json:"scantorVersion"`
	Error          *BundleError   `json:"error"`
	CreatedAt      Time           `json:"createdAt"`
	StartedAt      *Time          `json:"startedAt"`
	FinishedAt     *Time          `json:"finishedAt"`
	ExpiresAt      Time           `json:"expiresAt"`
	// Download is set only when the bundle is ready; the URL is presigned anew with every response.
	Download *BundleDownload `json:"download"`
	// Commands are the recipient's copy-paste lines.
	Commands BundleCommands `json:"commands"`
}

// BundleRevision identifies the revision of a bundle.
type BundleRevision struct {
	ID     string `json:"id"`
	Number int    `json:"number"`
	Ref    string `json:"ref"`
}

// BundleError is the error of a failed bundle.
type BundleError = CodeMessage

// BundleDownload is the presigned download of a ready bundle, an application/gzip attachment named
// FileName.
type BundleDownload struct {
	URL       string `json:"url"`
	ExpiresAt Time   `json:"expiresAt"`
	FileName  string `json:"fileName"`
}

// BundleCommands are the commands that load, run and describe a bundle on the recipient's machine.
type BundleCommands struct {
	Load     string `json:"load"`
	Run      string `json:"run"`
	Describe string `json:"describe"`
}

// Settled reports whether the bundle reached ready or failed (the settle condition of
// getRevisionBundle?wait).
func (b Bundle) Settled() bool { return b.State == BundleReady || b.State == BundleFailed }
