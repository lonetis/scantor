package runtime

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/protocol"
)

// Environment contract of the runtime (docs/runtime.md §3.2). The node daemon sets SCANTOR_URL,
// SCANTOR_WORKER_TOKEN, SCANTOR_DIND and passes SCANTOR_CA_CERT and SCANTOR_ALLOW_INSECURE_TRANSPORT
// through; the base image sets the SCANTOR_LANGUAGE … SCANTOR_CHECK_CMD contract (docs/tasks.md §4.2).
// Everything else comes from bootstrap (worker mode) or the local spec (local mode).
const (
	EnvURL           = "SCANTOR_URL"
	EnvWorkerToken   = "SCANTOR_WORKER_TOKEN" //nolint:gosec // a variable name, not a credential
	EnvCACert        = "SCANTOR_CA_CERT"
	EnvAllowInsecure = "SCANTOR_ALLOW_INSECURE_TRANSPORT"
	EnvDinD          = "SCANTOR_DIND"
	EnvLanguage      = "SCANTOR_LANGUAGE"
	EnvConnectorCmd  = "SCANTOR_CONNECTOR_CMD"
	EnvDebugCmd      = "SCANTOR_DEBUG_CMD"
	EnvDebugPort     = "SCANTOR_DEBUG_PORT"
	EnvCheckCmd      = "SCANTOR_CHECK_CMD"
	EnvTmpDir        = "TMPDIR"
)

// TaskDir is the working directory of every connector and check process (the base image WORKDIR).
const TaskDir = "/task"

const defaultTmpParent = "/tmp"

// Config is the environment of the runtime. Environ is the complete environment of the runtime process
// (the image ENV plus the variables above), from which connector environments are derived
// (docs/runtime.md §3.4).
type Config struct {
	URL           string
	WorkerToken   string
	CACert        string
	AllowInsecure bool
	DinD          bool
	Language      string
	ConnectorCmd  string
	DebugCmd      string
	DebugPort     string
	CheckCmd      string
	// WorkRoot is <TMPDIR or /tmp>/scantor (docs/runtime.md §7.1).
	WorkRoot string
	Environ  []string
}

// LoadConfig reads the runtime environment. Worker-mode variables (SCANTOR_URL, SCANTOR_WORKER_TOKEN) are
// validated by RequireWorker, because the other modes do not need them. An invalid CA bundle or
// transport flag is an error (security-relevant).
func LoadConfig(getenv envconf.Getenv, environ []string) (Config, error) {
	r := envconf.NewReader(getenv)
	tmpParent := strings.TrimSpace(r.String(EnvTmpDir, defaultTmpParent))
	if !filepath.IsAbs(tmpParent) {
		tmpParent = defaultTmpParent
	}
	cfg := Config{
		URL:           strings.TrimSpace(r.String(EnvURL, "")),
		WorkerToken:   strings.TrimSpace(r.String(EnvWorkerToken, "")),
		CACert:        r.PEMCertificates(EnvCACert, envconf.Security()),
		AllowInsecure: r.Bool(EnvAllowInsecure, false, envconf.Security()),
		DinD:          strings.TrimSpace(r.String(EnvDinD, "")) == "1",
		Language:      strings.TrimSpace(r.String(EnvLanguage, "")),
		ConnectorCmd:  r.String(EnvConnectorCmd, ""),
		DebugCmd:      r.String(EnvDebugCmd, ""),
		DebugPort:     strings.TrimSpace(r.String(EnvDebugPort, "")),
		CheckCmd:      r.String(EnvCheckCmd, ""),
		WorkRoot:      filepath.Join(filepath.Clean(tmpParent), "scantor"),
		Environ:       environ,
	}
	if err := r.Err(); err != nil {
		return cfg, fmt.Errorf("invalid runtime environment: %w", err)
	}
	return cfg, nil
}

// RequireWorker checks the variables worker mode needs.
func (c Config) RequireWorker() error {
	var errs []error
	if c.URL == "" {
		errs = append(errs, fmt.Errorf("%s is not set", EnvURL))
	}
	if c.WorkerToken == "" {
		errs = append(errs, fmt.Errorf("%s is not set", EnvWorkerToken))
	}
	return errors.Join(errs...)
}

// RequireConnector checks that the image declares SCANTOR_CONNECTOR_CMD.
func (c Config) RequireConnector() error {
	if strings.TrimSpace(c.ConnectorCmd) == "" {
		return fmt.Errorf("%s is not set in the image; the task must be built on a scantor base image", EnvConnectorCmd)
	}
	return nil
}

// DefaultLimits are the limits announced in welcome when no bootstrap or spec provides them (describe
// mode, the conformance harness): the .env.example defaults of SCANTOR_MAX_RESULT_BYTES,
// SCANTOR_MAX_ANALYSIS_CONFIG_BYTES, SCANTOR_MAX_FILE_BYTES and SCANTOR_MAX_FILES_PER_ANALYSIS.
func DefaultLimits() protocol.Limits {
	return protocol.Limits{
		MaxLineBytes: protocol.MaxLineBytes, MaxResultBytes: 1 << 20, MaxAnalysisConfigBytes: 64 << 10,
		MaxFileBytes: 1 << 30, MaxFilesPerAnalysis: 100,
	}
}
