package workspace

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/manifest"
)

// Git imports (docs/editor.md §9.7, docs/security.md WS-6/WS-7). git runs only here, inside a helper on
// scantor-egress, with no system or global config, https only, no redirects, no hooks, no fsmonitor, no
// submodules and the validated address pinned with http.curloptResolve, so DNS rebinding cannot switch
// hosts. The only secret is the user's own credential, passed as GIT_CONFIG_* for the exact URL host and
// redacted from every message.
const (
	// DefaultRef is fetched when no ref is given.
	DefaultRef = "HEAD"
	// MaxCandidateDepth is the deepest folder below --path searched for scantor.yaml.
	MaxCandidateDepth = 6
	// maxCandidateErrors caps the errors reported per candidate.
	maxCandidateErrors = 20
	// gitOutputCap caps the stdout and stderr kept from one git command.
	gitOutputCap = 64 << 10
	// gitErrorTail is the size of the stderr tail quoted in gitFailed messages.
	gitErrorTail = 2 << 10
)

// Folders never searched for candidates.
var candidateSkipDirs = []string{".git", "node_modules"}

// System CA bundles, in the order they are tried (Alpine/Debian, RHEL, SUSE, macOS).
var systemCABundles = []string{
	"/etc/ssl/certs/ca-certificates.crt",
	"/etc/pki/tls/certs/ca-bundle.crt",
	"/etc/ssl/ca-bundle.pem",
	"/etc/ssl/cert.pem",
}

// GitOptions are the flags shared by git-clone and git-pull.
type GitOptions struct {
	URL          string
	Ref          string
	Path         string
	Staging      string
	AllowPrivate bool
}

// PullOptions are the flags of git-pull.
type PullOptions struct {
	GitOptions
	Task string
	// BaseCommit is the commit of the last import or pull ("" when unknown).
	BaseCommit string
}

// Candidate is a folder with a scantor.yaml found in a checkout.
type Candidate struct {
	// Path is the folder relative to the repository root ("." for the root).
	Path     string           `json:"path"`
	Name     *string          `json:"name"`
	Language *string          `json:"language"`
	Valid    bool             `json:"valid"`
	Errors   []api.BuildError `json:"errors"`
	Summary  *Summary         `json:"summary"`
}

// CloneResult is the output of git-clone.
type CloneResult struct {
	Commit     string      `json:"commit"`
	Candidates []Candidate `json:"candidates"`
}

// PullResult is the output of git-pull. Changed reports whether the candidate differs from the current
// task folder; Current is null when the task folder does not exist.
type PullResult struct {
	Commit         string    `json:"commit"`
	PreviousCommit string    `json:"previousCommit"`
	FastForward    bool      `json:"fastForward"`
	Changed        bool      `json:"changed"`
	Candidate      Candidate `json:"candidate"`
	Current        *Summary  `json:"current"`
}

// Git runs the git operations of one helper.
type Git struct {
	ws  *Workspace
	cfg Config
	// lookupIP resolves host names; tests replace it.
	lookupIP func(ctx context.Context, host string) ([]netip.Addr, error)
}

// NewGit returns the git operations on ws with the helper configuration (CA bundle, credential, PATH).
func NewGit(ws *Workspace, cfg Config) *Git {
	return &Git{ws: ws, cfg: cfg, lookupIP: func(ctx context.Context, host string) ([]netip.Addr, error) {
		return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	}}
}

// Clone fetches one ref shallowly into staging/<id>/tree, checks it out (no submodules) and returns
// every scantor.yaml folder below opts.Path as a validated candidate (docs/editor.md §9.7 git-clone).
func (g *Git) Clone(ctx context.Context, opts GitOptions) (res *CloneResult, err error) {
	sub, run, err := g.prepare(ctx, &opts)
	if err != nil {
		return nil, err
	}
	defer g.ws.discardOnError(opts.Staging, &err)
	if _, err := run.git(ctx, "fetch", "--depth", "1", "--no-tags", "origin", opts.Ref); err != nil {
		return nil, err
	}
	commit, err := g.checkout(ctx, run, opts.Staging)
	if err != nil {
		return nil, err
	}
	tree, _, err := g.ws.openStagingTree(opts.Staging, "")
	if err != nil {
		return nil, err
	}
	defer tree.Close()
	dirs, err := findCandidates(ctx, tree, sub)
	if err != nil {
		return nil, err
	}
	res = &CloneResult{Commit: commit, Candidates: []Candidate{}}
	for _, dir := range dirs {
		res.Candidates = append(res.Candidates, g.candidate(ctx, tree, opts.Staging, dir, ""))
	}
	g.ws.events.Infof("fetched %s at %s: %d candidate(s)", redactedURL(opts.URL), commit, len(res.Candidates))
	return res, nil
}

// Pull fetches the commit graph of one ref without trees or blobs, checks whether it fast-forwards the
// base commit, checks it out (trees and blobs are fetched lazily) and reports the candidate at
// opts.Path and the current task folder (docs/editor.md §9.7 git-pull). The orchestrator decides.
func (g *Git) Pull(ctx context.Context, opts PullOptions) (res *PullResult, err error) {
	if err := ValidateTaskName(opts.Task); err != nil {
		return nil, err
	}
	if opts.BaseCommit != "" && !commitPattern.MatchString(opts.BaseCommit) {
		return nil, invalidArgument("invalid base commit %q: expected a full commit hash", printable(opts.BaseCommit))
	}
	sub, run, err := g.prepare(ctx, &opts.GitOptions)
	if err != nil {
		return nil, err
	}
	defer g.ws.discardOnError(opts.Staging, &err)
	if _, err := run.git(ctx, "fetch", "--filter=tree:0", "--no-tags", "origin", opts.Ref); err != nil {
		return nil, err
	}
	fastForward := false
	if opts.BaseCommit != "" {
		fastForward, err = run.isAncestor(ctx, opts.BaseCommit, "FETCH_HEAD")
		if err != nil {
			return nil, err
		}
	}
	commit, err := g.checkout(ctx, run, opts.Staging)
	if err != nil {
		return nil, err
	}
	tree, _, err := g.ws.openStagingTree(opts.Staging, "")
	if err != nil {
		return nil, err
	}
	defer tree.Close()
	res = &PullResult{Commit: commit, PreviousCommit: opts.BaseCommit, FastForward: fastForward}
	res.Candidate = g.candidate(ctx, tree, opts.Staging, sub, opts.Task)
	info, err := g.ws.taskInfo(opts.Task)
	if err != nil {
		return nil, err
	}
	if info != nil {
		current, err := g.ws.taskSummary(ctx, opts.Task)
		if err != nil {
			return nil, err
		}
		res.Current = &current
	}
	res.Changed = res.Candidate.Summary == nil || res.Current == nil || res.Candidate.Summary.PackSHA256 != res.Current.PackSHA256
	g.ws.events.Infof("fetched %s at %s (fast-forward %t, changed %t)", redactedURL(opts.URL), commit, fastForward, res.Changed)
	return res, nil
}

// prepare validates the options, resolves and pins the host, creates the staging tree and initialises
// the repository with its origin. It returns the normalised --path.
func (g *Git) prepare(ctx context.Context, opts *GitOptions) (string, *gitRunner, error) {
	if opts.Ref == "" {
		opts.Ref = DefaultRef
	}
	if err := validateRef(opts.Ref); err != nil {
		return "", nil, err
	}
	sub, err := subtreePath(opts.Path)
	if err != nil {
		return "", nil, err
	}
	target, err := g.resolveURL(ctx, opts.URL, opts.AllowPrivate)
	if err != nil {
		return "", nil, err
	}
	guard, err := g.sizeGuard(ctx)
	if err != nil {
		return "", nil, err
	}
	if err := g.ws.createStaging(opts.Staging); err != nil {
		return "", nil, err
	}
	run, err := g.runner(target, g.ws.abs(stagingPath(opts.Staging, "tree")))
	if err == nil && guard != nil {
		guard.dir = g.ws.abs(stagingPath(opts.Staging))
		run.guard = guard
	}
	if err == nil {
		_, err = run.git(ctx, "init", "--quiet")
	}
	if err == nil {
		_, err = run.git(ctx, "remote", "add", "origin", "--", opts.URL)
	}
	if err != nil {
		if rerr := g.ws.removeStaging(opts.Staging); rerr != nil {
			g.ws.events.Warnf("%v", rerr)
		}
		return "", nil, err
	}
	return sub, run, nil
}

// sizeGuard returns the guard of this run's git commands: the staging directory may grow by at most the
// room left below MaxWorkspaceBytes. nil when the workspace has no cap.
func (g *Git) sizeGuard(ctx context.Context) (*sizeGuard, error) {
	limit := g.ws.limits.MaxWorkspaceBytes
	if limit <= 0 {
		return nil, nil
	}
	wsBytes, err := g.ws.workspaceBytes(ctx)
	if err != nil {
		return nil, err
	}
	if err := g.ws.checkWorkspaceCap(wsBytes); err != nil {
		return nil, err
	}
	return &sizeGuard{budget: limit - wsBytes, limit: limit, interval: sizeGuardInterval}, nil
}

// sizeGuardInterval is how often a running git command's staging directory is measured.
const sizeGuardInterval = 250 * time.Millisecond

// sizeGuard stops a git command once its staging directory holds more than budget bytes, so a huge
// repository cannot fill the disk before the caps are checked on the checkout.
type sizeGuard struct {
	dir      string
	budget   int64
	limit    int64
	interval time.Duration
}

// watch measures the staging directory until ctx ends and calls stop once it exceeds the budget; it
// reports whether it did.
func (s *sizeGuard) watch(ctx context.Context, stop context.CancelFunc) bool {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if dirBytes(ctx, s.dir) > s.budget {
				stop()
				return true
			}
		}
	}
}

func (s *sizeGuard) err() error {
	return limitError(CodeWorkspaceFull, s.limit, -1, "the repository is too large: the workspace would grow beyond %d bytes", s.limit)
}

// dirBytes sums the sizes of the regular files below dir (lstat only). Entries that vanish while git
// works are skipped; the measurement only has to be an approximation that grows with the download.
func dirBytes(ctx context.Context, dir string) int64 {
	var total int64
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // see above: vanished entries are skipped
		}
		if ctx.Err() != nil {
			return fs.SkipAll
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total
}

// checkout checks out FETCH_HEAD detached, enforces the workspace cap on the checkout and returns the
// commit.
func (g *Git) checkout(ctx context.Context, run *gitRunner, id string) (string, error) {
	if _, err := run.git(ctx, "checkout", "--quiet", "--detach", "FETCH_HEAD"); err != nil {
		return "", err
	}
	out, err := run.git(ctx, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	commit := strings.TrimSpace(out)
	if !commitPattern.MatchString(commit) {
		return "", newError(CodeGitFailed, "git returned an invalid commit %q", printable(commit))
	}
	tree, _, err := g.ws.openStagingTree(id, "")
	if err != nil {
		return "", err
	}
	defer tree.Close()
	checkout, err := measure(ctx, tree, isHardExcluded)
	if err != nil {
		return "", err
	}
	wsBytes, err := g.ws.workspaceBytes(ctx)
	if err != nil {
		return "", err
	}
	if err := g.ws.checkWorkspaceCap(wsBytes + checkout.Bytes); err != nil {
		return "", err
	}
	return commit, nil
}

// gitTarget is a validated https URL with the address its host is pinned to.
type gitTarget struct {
	url  *url.URL
	host string
	port string
	addr netip.Addr
}

var (
	commitPattern = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
	cgnatPrefix   = netip.MustParsePrefix("100.64.0.0/10")
	// Ranges that are never public besides those the netip predicates cover.
	nonPublicPrefixes = []netip.Prefix{
		cgnatPrefix,
		netip.MustParsePrefix("0.0.0.0/8"),
		netip.MustParsePrefix("192.0.0.0/24"),
		netip.MustParsePrefix("198.18.0.0/15"),
		netip.MustParsePrefix("240.0.0.0/4"),
		netip.MustParsePrefix("64:ff9b:1::/48"),
	}
)

// resolveURL applies the URL rules: https only, no userinfo, no leading '-', a host that resolves only
// to public addresses unless allowPrivate. The first address is pinned.
func (g *Git) resolveURL(ctx context.Context, raw string, allowPrivate bool) (*gitTarget, error) {
	if strings.HasPrefix(raw, "-") {
		return nil, invalidArgument("invalid git URL: it must not start with '-'")
	}
	if strings.IndexFunc(raw, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0 {
		return nil, invalidArgument("invalid git URL: it contains whitespace or control characters")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, invalidArgument("invalid git URL: %v", redactURLError(err))
	}
	switch {
	case u.Scheme != "https":
		return nil, invalidArgument("invalid git URL: only https:// URLs are supported")
	case u.User != nil:
		return nil, invalidArgument("invalid git URL: credentials in the URL are not allowed; use a stored credential")
	case u.Opaque != "" || u.Host == "" || u.Hostname() == "":
		return nil, invalidArgument("invalid git URL: the host is missing")
	case u.Fragment != "":
		return nil, invalidArgument("invalid git URL: fragments are not allowed")
	}
	t := &gitTarget{url: u, host: strings.ToLower(u.Hostname()), port: u.Port()}
	if t.port == "" {
		t.port = "443"
	}
	if n, err := strconv.Atoi(t.port); err != nil || n < 1 || n > 65535 {
		return nil, invalidArgument("invalid git URL: invalid port")
	}
	addrs, err := g.resolve(ctx, t.host)
	if err != nil {
		return nil, err
	}
	for _, a := range addrs {
		if !allowPrivate && !isPublic(a) {
			return nil, invalidArgument("the git host %s resolves to the non-public address %s; private hosts are not allowed", t.host, a)
		}
	}
	t.addr = addrs[0]
	if c := g.cfg.GitCredential; c != nil && !strings.EqualFold(c.Host, u.Host) {
		return nil, invalidArgument("the git credential is for %s, not for %s", c.Host, u.Host)
	}
	return t, nil
}

func (g *Git) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if a, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		return []netip.Addr{a.Unmap()}, nil
	}
	rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	addrs, err := g.lookupIP(rctx, host)
	if err != nil {
		return nil, newError(CodeGitFailed, "cannot resolve the git host %s: %v", host, err)
	}
	if len(addrs) == 0 {
		return nil, newError(CodeGitFailed, "the git host %s has no addresses", host)
	}
	out := make([]netip.Addr, len(addrs))
	for i, a := range addrs {
		out[i] = a.Unmap()
	}
	return out, nil
}

// isPublic reports whether a is a public unicast address: not loopback, private (RFC 1918, ULA),
// link-local, CGNAT, unspecified, multicast or reserved.
func isPublic(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() {
		return false
	}
	for _, p := range nonPublicPrefixes {
		if p.Contains(a) {
			return false
		}
	}
	return true
}

// validateRef accepts a branch, a tag, a full commit hash or HEAD: no leading '-', no whitespace,
// control characters, ':' (a refspec) or the characters git forbids in ref names.
func validateRef(ref string) error {
	switch {
	case len(ref) > 255:
		return invalidArgument("invalid git ref: longer than 255 bytes")
	case !utf8.ValidString(ref):
		return invalidArgument("invalid git ref: not valid UTF-8")
	case strings.HasPrefix(ref, "-"):
		return invalidArgument("invalid git ref %q: it must not start with '-'", printable(ref))
	case strings.ContainsAny(ref, ":^~?*[\\") || strings.Contains(ref, ".."):
		return invalidArgument("invalid git ref %q", printable(ref))
	case strings.IndexFunc(ref, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) >= 0:
		return invalidArgument("invalid git ref %q: it contains whitespace or control characters", printable(ref))
	}
	return nil
}

func redactURLError(err error) string {
	var uerr *url.Error
	if errors.As(err, &uerr) {
		return uerr.Err.Error()
	}
	return "unparsable URL"
}

// redactedURL returns raw without userinfo, query and fragment, for messages.
func redactedURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "the repository"
	}
	return (&url.URL{Scheme: u.Scheme, Host: u.Host, Path: u.Path}).String()
}

// gitRunner runs git with the hardened environment and options of one target.
type gitRunner struct {
	bin    string
	env    []string
	opts   []string
	dir    string
	events *Events
	// guard stops commands that grow the staging directory beyond the workspace cap (nil: no cap).
	guard *sizeGuard
}

func (g *Git) runner(t *gitTarget, dir string) (*gitRunner, error) {
	bin, err := findExecutable("git", g.cfg.Path)
	if err != nil {
		return nil, err
	}
	home := g.cfg.TempDir
	if home == "" {
		home = os.TempDir()
	}
	env := []string{
		"PATH=" + g.cfg.Path,
		"HOME=" + home,
		"LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ALLOW_PROTOCOL=https",
	}
	if g.cfg.CACert != "" {
		bundle, err := writeCABundle(home, g.cfg.CACert, g.ws.events)
		if err != nil {
			return nil, err
		}
		env = append(env, "GIT_SSL_CAINFO="+bundle)
	}
	if c := g.cfg.GitCredential; c != nil {
		env = append(env, "GIT_CONFIG_COUNT=1", "GIT_CONFIG_KEY_0="+c.Key, "GIT_CONFIG_VALUE_0="+c.Value)
		addCredentialRedactions(g.ws.events, c.Value)
	}
	addr := t.addr.String()
	if t.addr.Is6() {
		addr = "[" + addr + "]"
	}
	opts := []string{
		"-c", "protocol.file.allow=never",
		"-c", "http.followRedirects=false",
		"-c", "core.hooksPath=/dev/null",
		"-c", "core.fsmonitor=false",
		"-c", "submodule.recurse=false",
		"-c", "fetch.recurseSubmodules=false",
		"-c", "http.curloptResolve=" + t.host + ":" + t.port + ":" + addr,
		"-c", "init.defaultBranch=main",
		"-c", "advice.detachedHead=false",
	}
	return &gitRunner{bin: bin, env: env, opts: opts, dir: dir, events: g.ws.events}, nil
}

// addCredentialRedactions removes the header value, its base64 token and the decoded secret from every
// message.
func addCredentialRedactions(events *Events, value string) {
	events.AddRedaction(value)
	_, token, _ := strings.Cut(value, ": ")
	events.AddRedaction(token)
	if _, b64, ok := strings.Cut(token, " "); ok {
		events.AddRedaction(b64)
		if raw, err := base64.StdEncoding.DecodeString(b64); err == nil {
			if _, secret, ok := strings.Cut(string(raw), ":"); ok && len(secret) >= 4 {
				events.AddRedaction(secret)
			}
		}
	}
}

// git runs one git command and returns its stdout. A failure is gitFailed with the redacted tail of
// stderr; a timeout or cancellation is gitFailed too.
func (r *gitRunner) git(ctx context.Context, args ...string) (string, error) {
	cmdCtx, stop := context.WithCancel(ctx)
	defer stop()
	cmd := exec.CommandContext(cmdCtx, r.bin, append(slices.Clone(r.opts), args...)...)
	// Every command runs in the staging tree, and repository discovery stops there: git never operates
	// on a repository the helper did not create.
	cmd.Dir = r.dir
	cmd.Env = append(slices.Clone(r.env), "GIT_CEILING_DIRECTORIES="+filepath.Dir(r.dir))
	cmd.WaitDelay = 5 * time.Second
	stdout := &cappedBuffer{limit: gitOutputCap}
	stderr := &cappedBuffer{limit: gitOutputCap}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	if err := cmd.Start(); err != nil {
		return "", internalError(err, "run git %s", gitOp(args))
	}
	exceeded := make(chan bool, 1)
	if r.guard != nil {
		go func() { exceeded <- r.guard.watch(cmdCtx, stop) }()
	} else {
		exceeded <- false
	}
	err := cmd.Wait()
	stop()
	if <-exceeded {
		return "", r.guard.err()
	}
	if err == nil {
		return stdout.String(), nil
	}
	op := gitOp(args)
	if ctx.Err() != nil {
		return "", newError(CodeGitFailed, "git %s timed out or was cancelled", op)
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		return "", internalError(err, "run git %s", op)
	}
	tail := strings.TrimSpace(stderr.String())
	if len(tail) > gitErrorTail {
		tail = "…" + tail[len(tail)-gitErrorTail:]
	}
	if tail == "" {
		tail = exitErr.Error()
	}
	return "", newError(CodeGitFailed, "%s", r.events.Redact(fmt.Sprintf("git %s failed: %s", op, tail)))
}

// isAncestor reports whether base is an ancestor of head; an unknown base is not an ancestor.
func (r *gitRunner) isAncestor(ctx context.Context, base, head string) (bool, error) {
	_, err := r.git(ctx, "merge-base", "--is-ancestor", base, head)
	if err == nil {
		return true, nil
	}
	var werr *Error
	if errors.As(err, &werr) && werr.Code == CodeGitFailed && ctx.Err() == nil {
		return false, nil
	}
	return false, err
}

// gitOp names the git subcommand of args for messages.
func gitOp(args []string) string {
	for _, a := range args {
		if !strings.HasPrefix(a, "-") {
			return a
		}
	}
	return "command"
}

// cappedBuffer keeps at most limit bytes; the rest is dropped (the tail of stderr is what matters, so
// the newest bytes are kept).
type cappedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	b.buf.Write(p)
	if over := b.buf.Len() - b.limit; over > 0 {
		b.buf.Next(over)
	}
	return n, nil
}

func (b *cappedBuffer) String() string { return b.buf.String() }

// findExecutable looks name up in the PATH list.
func findExecutable(name, pathList string) (string, error) {
	for _, dir := range filepath.SplitList(pathList) {
		if dir == "" {
			continue
		}
		p := filepath.Join(dir, name)
		if info, err := os.Stat(p); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", newError(CodeInternal, "%s is not installed", name)
}

// writeCABundle writes the system CA bundle followed by the custom certificates to <dir>/ca-bundle.pem,
// so the custom CAs extend the system roots and never replace them.
func writeCABundle(dir, custom string, events *Events) (string, error) {
	var bundle []byte
	for _, p := range systemCABundles {
		data, err := os.ReadFile(p) //nolint:gosec // p is one of the fixed system bundle paths
		if err == nil {
			bundle = append(bundle, data...)
			break
		}
	}
	if len(bundle) == 0 {
		events.Warnf("no system CA bundle found; trusting only SCANTOR_CA_CERT")
	} else if bundle[len(bundle)-1] != '\n' {
		bundle = append(bundle, '\n')
	}
	bundle = append(bundle, custom...)
	p := filepath.Join(dir, "ca-bundle.pem")
	if err := os.WriteFile(p, bundle, 0o600); err != nil { //nolint:gosec // p is in the helper's own temp directory
		return "", internalError(err, "write the CA bundle")
	}
	return p, nil
}

// findCandidates returns every folder below sub (depth ≤ MaxCandidateDepth, skipping .git and
// node_modules) that contains a scantor.yaml, relative to the repository root and sorted.
func findCandidates(ctx context.Context, tree *os.Root, sub string) ([]string, error) {
	start := "."
	if sub != "" {
		start = sub
		if err := noSymlinkComponents(tree, sub); err != nil {
			return nil, err
		}
		info, err := tree.Lstat(sub)
		switch {
		case errors.Is(err, fs.ErrNotExist):
			return nil, notFound(sub, "the path %q does not exist in the repository", printable(sub))
		case err != nil:
			return nil, internalError(err, "stat %s", sub)
		case !info.IsDir():
			return nil, pathError(sub, "the path %q is not a directory", printable(sub))
		}
	}
	var dirs []string
	err := fs.WalkDir(tree.FS(), start, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return internalError(err, "walk %s", p)
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			if p != start && slices.Contains(candidateSkipDirs, d.Name()) {
				return fs.SkipDir
			}
			if depth(start, p) > MaxCandidateDepth {
				return fs.SkipDir
			}
			return nil
		}
		if d.Name() == manifest.FileName {
			dirs = append(dirs, path.Dir(p))
		}
		return nil
	})
	slices.Sort(dirs)
	return dirs, err
}

// depth returns how many folders p lies below start.
func depth(start, p string) int {
	if p == start {
		return 0
	}
	rel := p
	if start != "." {
		rel = strings.TrimPrefix(p, start+"/")
	}
	return strings.Count(rel, "/") + 1
}

// candidate validates the folder dir of the checkout in staging/<id>/tree: its manifest (expectName
// applies M9), the archive rules (no symlinks, path rules, caps) and its pack summary.
func (g *Git) candidate(ctx context.Context, tree *os.Root, id, dir, expectName string) Candidate {
	c := Candidate{Path: dir, Errors: []api.BuildError{}}
	if c.Path == "" {
		c.Path = "."
	}
	addErr := func(file, msg string) {
		if len(c.Errors) < maxCandidateErrors {
			c.Errors = append(c.Errors, api.BuildError{Phase: api.BuildPhaseStatic, File: file, Message: msg})
		}
	}
	rel := dir
	if rel == "." {
		rel = ""
	}
	if rel != "" {
		if err := noSymlinkComponents(tree, rel); err != nil {
			addErr("", AsError(err).Message)
			return c
		}
		if info, err := tree.Lstat(rel); err != nil || !info.IsDir() {
			addErr("", fmt.Sprintf("the path %q does not exist in the repository", printable(rel)))
			return c
		}
	}
	root, err := tree.OpenRoot(orDot(rel))
	if err != nil {
		addErr("", fmt.Sprintf("open %s: %v", c.Path, err))
		return c
	}
	defer root.Close()
	if data, err := readManifest(root); err == nil {
		c.Name, c.Language = manifestIdentity(data)
	}
	if _, err := checkTreeManifest(root, expectName); err != nil {
		werr := AsError(err)
		if errs, ok := werr.Details["errors"].([]api.BuildError); ok {
			for _, e := range errs {
				addErr(e.File, e.Message)
			}
		} else {
			addErr(manifest.FileName, werr.Message)
		}
	}
	if err := checkImportTree(ctx, root, g.ws.limits); err != nil {
		werr := AsError(err)
		addErr(werr.Path, werr.Message)
	}
	if summary, err := g.ws.summarizeDir(ctx, g.ws.abs(path.Join(stagingPath(id, "tree"), rel))); err == nil {
		c.Summary = &summary
	} else {
		werr := AsError(err)
		addErr(werr.Path, werr.Message)
	}
	c.Valid = len(c.Errors) == 0
	return c
}

func orDot(p string) string {
	if p == "" {
		return "."
	}
	return p
}

// manifestIdentity reads name and language from a manifest even when it is invalid, so the UI can show
// invalid candidates.
func manifestIdentity(data []byte) (*string, *string) {
	var doc struct {
		Name     any `yaml:"name"`
		Language any `yaml:"language"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return nil, nil
	}
	str := func(v any) *string {
		if s, ok := v.(string); ok && s != "" {
			return &s
		}
		return nil
	}
	return str(doc.Name), str(doc.Language)
}

// checkImportTree applies the archive rules to a candidate folder without changing it (commit applies
// them again and normalises the modes): no symlinks or special files, the path rules and the caps. The
// hard-excluded .git/ and .scantor/ are skipped.
func checkImportTree(ctx context.Context, root *os.Root, limits Limits) error {
	var u treeUsage
	return fs.WalkDir(root.FS(), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return internalError(err, "walk %s", p)
		}
		if p == "." {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if isHardExcluded(p) {
			return skipEntry(d)
		}
		if err := ValidatePath(p); err != nil {
			return err
		}
		switch t := d.Type(); {
		case t&fs.ModeSymlink != 0:
			return pathError(p, "%q is a symlink; symlinks are not supported in imported tasks", printable(p))
		case t.IsDir():
			u.add(0)
		case t.IsRegular():
			info, err := d.Info()
			if err != nil {
				return internalError(err, "stat %s", p)
			}
			u.add(info.Size())
		default:
			return pathError(p, "%q is not a regular file or directory", printable(p))
		}
		return checkTaskCaps(limits, u)
	})
}
