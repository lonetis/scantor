package dockerfile

import (
	"fmt"
	"net/netip"
	"regexp"
	"strings"

	"github.com/distribution/reference"
)

// imageIDPattern matches bare image ids: "sha256:<hex>" or 64 hex characters. BuildKit prefers local
// images, so an id would select any image on the build daemon.
var imageIDPattern = regexp.MustCompile(`^(?i)(sha256:[0-9a-f]*|[0-9a-f]{64})$`)

// numericHostPattern matches host names that C resolvers parse as IPv4 addresses in shorthand or
// hexadecimal notation (127.1, 0x7f.0.0.1, 2130706433).
var numericHostPattern = regexp.MustCompile(`^(?i)(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$`)

// cgnat is the shared address space of RFC 6598, used by overlay networks such as Tailscale.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

// CheckImageRef applies rule D5 to a literal image reference and returns the problem, or "" when the
// reference may be used. forbiddenHosts are additional host names (lower case, without port) of the
// platform registry and dashboard.
func CheckImageRef(ref string, forbiddenHosts []string) string {
	switch {
	case strings.Contains(ref, "$"):
		return "image references must not contain variables other than ${" + BaseArg + "}"
	case imageIDPattern.MatchString(ref):
		return "image ids are not allowed; use a name"
	}
	named, err := reference.ParseNormalizedNamed(ref)
	if err != nil {
		return fmt.Sprintf("%q is not a valid image reference: %v", ref, err)
	}
	host := hostOf(reference.Domain(named))
	if reason := forbiddenHost(host, forbiddenHosts); reason != "" {
		return reason
	}
	if strings.HasPrefix(strings.ToLower(reference.Path(named)), "tasks/") {
		return "repositories under tasks/ hold task images and can never be used in a Dockerfile"
	}
	return ""
}

// hostOf strips the port from a registry domain ("localhost:5000", "[::1]:5000").
func hostOf(domain string) string {
	if strings.HasPrefix(domain, "[") {
		if end := strings.IndexByte(domain, ']'); end > 0 {
			return strings.ToLower(domain[1:end])
		}
	}
	host, _, _ := strings.Cut(domain, ":")
	return strings.ToLower(host)
}

// forbiddenHost returns why a registry host may not be used: loopback names, the Docker host alias,
// the internal registry service, IP literals in non-public ranges, ambiguous numeric hosts and the
// platform's own hosts.
func forbiddenHost(host string, extra []string) string {
	switch {
	case host == "localhost" || strings.HasSuffix(host, ".localhost"):
		return fmt.Sprintf("the registry host %s is a loopback name", host)
	case host == "host.docker.internal":
		return "the registry host host.docker.internal is the Docker host"
	case host == "registry":
		return "image references must not point at the platform registry"
	}
	for _, h := range extra {
		if h != "" && host == strings.ToLower(h) {
			return "image references must not point at the platform registry"
		}
	}
	if ip, err := netip.ParseAddr(host); err == nil {
		ip = ip.Unmap()
		if !ip.IsGlobalUnicast() || ip.IsPrivate() || cgnat.Contains(ip) {
			return fmt.Sprintf("the registry host %s is not a public address", host)
		}
		return ""
	}
	if numericHostPattern.MatchString(host) {
		return fmt.Sprintf("the registry host %s is an ambiguous numeric address", host)
	}
	return ""
}

// scpStylePattern is BuildKit's implicit SSH transport form (user@host:path, util/sshutil), which ADD
// fetches as a git remote.
var scpStylePattern = regexp.MustCompile(`^([a-zA-Z0-9-_]+)@([a-zA-Z0-9-.]+):(.*?)(?:\?(.*?))?(?:#(.*))?$`)

// remoteSource reports whether an ADD source is a URL or a git remote rather than a local path. It
// covers every form BuildKit's ADD fetches (http(s) URLs and the git forms of dfgitutil.ParseGitRef:
// scheme://…, including *.git URLs, user@host:path and github.com/…) and rejects any other "://" too.
func remoteSource(src string) bool {
	return strings.Contains(src, "://") ||
		strings.HasPrefix(strings.ToLower(src), "github.com/") ||
		scpStylePattern.MatchString(src)
}
