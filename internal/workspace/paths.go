package workspace

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf8"
)

// Path limits of docs/editor.md §9.5.
const (
	MaxPathBytes    = 1024
	MaxSegmentBytes = 255
	MaxPathDepth    = 32
)

// StagingDir is the reserved staging folder at the root of a user's workspace (docs/editor.md §9.6).
const StagingDir = ".scantor-staging"

// Hard excludes: never part of a task folder (docs/tasks.md §2).
var hardExcludes = []string{".git", ".scantor"}

// ValidatePath checks a path from a request, an archive or a file map against the rules of
// docs/editor.md §9.5: relative and '/'-separated, valid UTF-8, no NUL, backslash or leading '/', no
// empty, '.' or '..' segments, segments ≤ 255 bytes, path ≤ 1024 bytes, depth ≤ 32, and not inside
// .scantor-staging. A violation is an invalidPath error naming the path.
func ValidatePath(p string) error {
	if reason := pathViolation(p); reason != "" {
		return pathError(p, "invalid path %q: %s", printable(p), reason)
	}
	return nil
}

func pathViolation(p string) string {
	switch {
	case p == "":
		return "the path is empty"
	case !utf8.ValidString(p):
		return "the path is not valid UTF-8"
	case strings.ContainsRune(p, 0):
		return "the path contains a NUL byte"
	case strings.ContainsRune(p, '\\'):
		return "the path contains a backslash"
	case strings.HasPrefix(p, "/"):
		return "the path must be relative"
	case len(p) > MaxPathBytes:
		return fmt.Sprintf("the path is longer than %d bytes", MaxPathBytes)
	}
	segments := strings.Split(p, "/")
	if len(segments) > MaxPathDepth {
		return fmt.Sprintf("the path is deeper than %d levels", MaxPathDepth)
	}
	for _, s := range segments {
		switch {
		case s == "":
			return "the path contains an empty segment"
		case s == "." || s == "..":
			return fmt.Sprintf("the path contains a %q segment", s)
		case len(s) > MaxSegmentBytes:
			return fmt.Sprintf("a path segment is longer than %d bytes", MaxSegmentBytes)
		}
	}
	if segments[0] == StagingDir {
		return "the path is inside the reserved " + StagingDir + " folder"
	}
	return ""
}

// printable quotes a path for messages without its NUL bytes and invalid UTF-8.
func printable(p string) string {
	p = strings.ToValidUTF8(p, "�")
	return strings.ReplaceAll(p, "\x00", `\0`)
}

// optionalPath validates a path that may also be "" (the task root, used by list and delete-files).
func optionalPath(p string) error {
	if p == "" {
		return nil
	}
	return ValidatePath(p)
}

// subtreePath normalises the --path of git operations and the --from of commit: "", "." and "./" mean
// the root ("" is returned); anything else must be a valid relative path (a trailing '/' is dropped).
func subtreePath(p string) (string, error) {
	p = strings.TrimSuffix(strings.TrimPrefix(p, "./"), "/")
	if p == "" || p == "." {
		return "", nil
	}
	if err := ValidatePath(p); err != nil {
		return "", err
	}
	return p, nil
}

// archiveName normalises the name of an archive entry: one leading "./" and one trailing "/" are
// dropped. It reports root=true for the archive root itself ("." or "./"), which is skipped.
func archiveName(name string) (clean string, root bool) {
	clean = strings.TrimPrefix(name, "./")
	clean = strings.TrimSuffix(clean, "/")
	if clean == "" || clean == "." {
		return "", true
	}
	return clean, false
}

// isHardExcluded reports whether p lies in a hard-excluded folder (.git/, .scantor/) at any depth, the
// same rule the pack applies, so content the pack never sees is never stored in a task folder either.
func isHardExcluded(p string) bool {
	for seg := range strings.SplitSeq(p, "/") {
		if slices.Contains(hardExcludes, seg) {
			return true
		}
	}
	return false
}

var (
	taskNamePattern  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`)
	uuidPattern      = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	userIDPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	stagingIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
	sha256Pattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// reservedTaskNames are the names a task can never have (schemas/task-manifest.schema.json).
var reservedTaskNames = []string{"upload", "import-git", "new", "latest"}

// ValidateTaskName checks a task name (the folder name below the workspace root) against the manifest
// rules: a slug of at most 64 characters, not a uuid and not a reserved word.
func ValidateTaskName(name string) error {
	switch {
	case !taskNamePattern.MatchString(name):
		return invalidArgument("invalid task name %q: use 1–64 lowercase letters, digits and inner hyphens", printable(name))
	case uuidPattern.MatchString(name):
		return invalidArgument("invalid task name %q: a task name cannot be a uuid", name)
	case slices.Contains(reservedTaskNames, name):
		return invalidArgument("invalid task name %q: the name is reserved", name)
	}
	return nil
}

// ValidateUserID checks a user id (a lowercase uuid, docs/data-model.md §1). init and purge touch only
// a directory of exactly this name.
func ValidateUserID(id string) error {
	if !userIDPattern.MatchString(id) {
		return invalidArgument("invalid user id %q: expected a lowercase uuid", printable(id))
	}
	return nil
}

// ValidateStagingID checks a staging id (the orchestrator uses uuids).
func ValidateStagingID(id string) error {
	if !stagingIDPattern.MatchString(id) {
		return invalidArgument("invalid staging id %q: use 1–64 letters, digits, '-' and '_'", printable(id))
	}
	return nil
}
