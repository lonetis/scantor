package workspace

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/version"
)

// DefaultPath is the PATH git runs with when the environment has none.
const DefaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// Config is everything a workspace helper reads from its environment. The orchestrator starts helpers
// with HOME=/tmp only; git operations additionally get SCANTOR_CA_CERT and the git credential as
// GIT_CONFIG_* variables (docs/editor.md §9.7). Limits are flags, never environment variables.
type Config struct {
	// CACert holds extra trusted CA certificates for git (SCANTOR_CA_CERT, normalised PEM).
	CACert string
	// GitCredential is the extraheader credential of the exact URL host, or nil.
	GitCredential *GitCredential
	// Images is the SCANTOR_IMAGE_PREFIX/SCANTOR_IMAGE_TAG override used for the scaffold's BaseImage.
	Images version.ImageOverride
	// Path is the PATH of git subprocesses.
	Path string
	// TempDir holds the CA bundle and is git's HOME (TMPDIR, default /tmp: a tmpfs in helpers).
	TempDir string
}

// GitCredential is the credential the orchestrator passes as GIT_CONFIG_COUNT=1,
// GIT_CONFIG_KEY_0=http.https://<host>/.extraheader and GIT_CONFIG_VALUE_0=Authorization: Basic <b64>.
type GitCredential struct {
	Host  string
	Key   string
	Value string
}

var gitCredentialKey = regexp.MustCompile(`^http\.https://([^/\s]+)/\.extraheader$`)

// LoadConfig reads the helper configuration. An invalid CA certificate or a malformed credential is an
// error (both are security-relevant).
func LoadConfig(getenv func(string) string) (Config, error) {
	r := envconf.NewReader(getenv)
	cfg := Config{
		CACert: r.PEMCertificates("SCANTOR_CA_CERT", envconf.Security()),
		Images: version.ImageOverride{
			Prefix: strings.TrimSpace(r.String("SCANTOR_IMAGE_PREFIX", "")),
			Tag:    strings.TrimSpace(r.String("SCANTOR_IMAGE_TAG", "")),
		},
		Path:    r.String("PATH", DefaultPath),
		TempDir: r.String("TMPDIR", "/tmp"),
	}
	if cfg.Images.Prefix != "" && !strings.HasSuffix(cfg.Images.Prefix, "/") {
		r.Fail("SCANTOR_IMAGE_PREFIX", errors.New(`must end with "/"`))
	}
	switch count := strings.TrimSpace(r.String("GIT_CONFIG_COUNT", "")); count {
	case "", "0":
	case "1":
		key, value := r.String("GIT_CONFIG_KEY_0", ""), r.String("GIT_CONFIG_VALUE_0", "")
		m := gitCredentialKey.FindStringSubmatch(key)
		switch {
		case m == nil:
			r.Fail("GIT_CONFIG_KEY_0", errors.New("must be http.https://<host>/.extraheader"))
		case !strings.HasPrefix(value, "Authorization: ") || strings.ContainsAny(value, "\r\n"):
			r.Fail("GIT_CONFIG_VALUE_0", errors.New(`must be a single "Authorization: …" header`))
		default:
			cfg.GitCredential = &GitCredential{Host: strings.ToLower(m[1]), Key: key, Value: value}
		}
	default:
		r.Fail("GIT_CONFIG_COUNT", fmt.Errorf("must be 0 or 1, got %q", count))
	}
	if err := r.Err(); err != nil {
		return cfg, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}
