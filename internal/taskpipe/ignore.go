package taskpipe

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
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

// FileSet decides which paths of a task folder a pack contains (docs/tasks.md §9.2): never .git/ and
// .scantor/, always scantor.yaml, Dockerfile and .dockerignore, and everything else unless .dockerignore
// excludes it. The pack and the workspace's cap checks share it, so both count the same entries. A nil
// FileSet applies only the hard excludes and the forced includes.
type FileSet struct {
	ignore *ignoreMatcher
}

// Inclusion is the decision of a FileSet for one path.
type Inclusion int

const (
	// Included means the pack contains the path.
	Included Inclusion = iota
	// Excluded means the pack leaves out the path and, for a directory, everything below it.
	Excluded
	// ExcludedDescend is an excluded directory below which a `!` exception may re-include paths: the pack
	// descends into it, and it becomes an entry once a path below it is included.
	ExcludedDescend
)

// NewFileSet returns the FileSet of a task folder whose .dockerignore has the content dockerignore (nil:
// the folder has none).
func NewFileSet(dockerignore []byte) (*FileSet, error) {
	if len(dockerignore) > maxIgnoreFileBytes {
		return nil, fmt.Errorf("is larger than %d bytes", maxIgnoreFileBytes)
	}
	m, err := newIgnoreMatcher(dockerignore)
	if err != nil {
		return nil, err
	}
	return &FileSet{ignore: m}, nil
}

// LoadFileSet reads the .dockerignore of the task folder root. Problems with it are PackErrors.
func LoadFileSet(root *os.Root) (*FileSet, error) {
	info, err := root.Lstat(DockerignoreName)
	if errors.Is(err, fs.ErrNotExist) {
		return &FileSet{}, nil
	}
	if err != nil {
		return nil, PackErrors{{Path: DockerignoreName, Message: err.Error()}}
	}
	if !info.Mode().IsRegular() {
		return nil, PackErrors{{Path: DockerignoreName, Message: "must be a regular file"}}
	}
	if info.Size() > maxIgnoreFileBytes {
		return nil, PackErrors{{Path: DockerignoreName, Message: fmt.Sprintf("is larger than %d bytes", maxIgnoreFileBytes)}}
	}
	data, err := root.ReadFile(DockerignoreName)
	if err != nil {
		return nil, PackErrors{{Path: DockerignoreName, Message: err.Error()}}
	}
	set, err := NewFileSet(data)
	if err != nil {
		return nil, PackErrors{{Path: DockerignoreName, Message: err.Error()}}
	}
	return set, nil
}

// Classify decides whether the pack contains the path p (a directory when isDir). An error is a
// .dockerignore pattern that cannot be matched, as a *PackError.
func (s *FileSet) Classify(p string, isDir bool) (Inclusion, error) {
	if hardExcluded(p) {
		return Excluded, nil
	}
	if forcedIncludes[p] || s == nil {
		return Included, nil
	}
	excluded, err := s.ignore.excluded(p)
	switch {
	case err != nil:
		return Excluded, &PackError{Path: DockerignoreName, Message: err.Error()}
	case !excluded:
		return Included, nil
	case isDir && s.ignore.mayIncludeBelow(p):
		return ExcludedDescend, nil
	default:
		return Excluded, nil
	}
}

func validUTF8(s string) bool { return utf8.ValidString(s) }

// cleanJoin joins a relative directory and a relative target and cleans the result.
func cleanJoin(dir, target string) string { return path.Clean(path.Join(dir, target)) }
