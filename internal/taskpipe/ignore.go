package taskpipe

import (
	"bytes"
	"fmt"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/moby/patternmatcher"
	"github.com/moby/patternmatcher/ignorefile"
)

// maxIgnoreFileBytes bounds .dockerignore.
const maxIgnoreFileBytes = 1 << 20

// ignoreMatcher applies .dockerignore with Docker's semantics (moby/patternmatcher, including `!`
// exceptions). A nil matcher excludes nothing.
type ignoreMatcher struct {
	pm *patternmatcher.PatternMatcher
	// exceptions are the patterns of the `!` lines, without the `!`.
	exceptions []string
}

// newIgnoreMatcher parses the content of a .dockerignore file.
func newIgnoreMatcher(data []byte) (*ignoreMatcher, error) {
	patterns, err := ignorefile.ReadAll(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("read .dockerignore: %w", err)
	}
	if len(patterns) == 0 {
		return nil, nil
	}
	pm, err := patternmatcher.New(patterns)
	if err != nil {
		return nil, fmt.Errorf("invalid .dockerignore pattern: %w", err)
	}
	m := &ignoreMatcher{pm: pm}
	for _, p := range pm.Patterns() {
		if p.Exclusion() {
			m.exceptions = append(m.exceptions, p.String())
		}
	}
	return m, nil
}

// excluded reports whether .dockerignore excludes p (the path itself or one of its parents matches,
// and no later exception re-includes it).
func (m *ignoreMatcher) excluded(p string) (bool, error) {
	if m == nil {
		return false, nil
	}
	return m.pm.MatchesOrParentMatches(p)
}

// mayIncludeBelow reports whether an exception could re-include something below the excluded directory
// dir, in which case the walk must descend into it. Exceptions with wildcards are assumed to match.
func (m *ignoreMatcher) mayIncludeBelow(dir string) bool {
	if m == nil {
		return false
	}
	prefix := dir + "/"
	for _, ex := range m.exceptions {
		if strings.ContainsAny(ex, `*?[\`) || strings.HasPrefix(ex+"/", prefix) {
			return true
		}
	}
	return false
}

func validUTF8(s string) bool { return utf8.ValidString(s) }

// cleanJoin joins a relative directory and a relative target and cleans the result.
func cleanJoin(dir, target string) string { return path.Clean(path.Join(dir, target)) }
