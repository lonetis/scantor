package pool

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// EntryPlaceholder is the only placeholder of command templates.
const EntryPlaceholder = "{entry}"

// ParseCommand splits a command template (SCANTOR_CONNECTOR_CMD, SCANTOR_DEBUG_CMD, SCANTOR_CHECK_CMD)
// into arguments without a shell (docs/runtime.md §3.3): arguments are separated by ASCII whitespace; a
// double-quoted span belongs to one argument without its quotes, where \" and \\ are the only escapes;
// an unterminated quote is an error. Every occurrence of {entry} is then replaced by entry.
func ParseCommand(template, entry string) ([]string, error) {
	var args []string
	var cur strings.Builder
	inArg, inQuote := false, false
	for i := 0; i < len(template); i++ {
		c := template[i]
		switch {
		case inQuote:
			switch {
			case c == '"':
				inQuote = false
			case c == '\\' && i+1 < len(template) && (template[i+1] == '"' || template[i+1] == '\\'):
				i++
				cur.WriteByte(template[i])
			default:
				cur.WriteByte(c)
			}
		case c == '"':
			inQuote, inArg = true, true
		case isASCIISpace(c):
			if inArg {
				args = append(args, cur.String())
				cur.Reset()
				inArg = false
			}
		default:
			cur.WriteByte(c)
			inArg = true
		}
	}
	if inQuote {
		return nil, errors.New("command template has an unterminated quote")
	}
	if inArg {
		args = append(args, cur.String())
	}
	if len(args) == 0 {
		return nil, errors.New("command template is empty")
	}
	for i, a := range args {
		args[i] = strings.ReplaceAll(a, EntryPlaceholder, entry)
	}
	return args, nil
}

func isASCIISpace(c byte) bool {
	switch c {
	case ' ', '\t', '\n', '\v', '\f', '\r':
		return true
	}
	return false
}

// ResolveExecutable resolves the first argument like execvp (docs/runtime.md §3.3): an argument that
// contains a slash is a path, relative to dir when not absolute; any other is looked up in the PATH of
// environ.
func ResolveExecutable(arg0, dir string, environ []string) (string, error) {
	if strings.Contains(arg0, "/") {
		p := arg0
		if !filepath.IsAbs(p) {
			p = filepath.Join(dir, p)
		}
		if err := checkExecutable(p); err != nil {
			return "", err
		}
		return p, nil
	}
	path := lookupEnv(environ, "PATH")
	lastErr := fmt.Errorf("%s: not found in PATH", arg0)
	for _, d := range filepath.SplitList(path) {
		if d == "" {
			d = "."
		}
		if !filepath.IsAbs(d) {
			d = filepath.Join(dir, d)
		}
		p := filepath.Join(d, arg0)
		err := checkExecutable(p)
		if err == nil {
			return p, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			lastErr = err
		}
	}
	return "", lastErr
}

func checkExecutable(p string) error {
	st, err := os.Stat(p)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return fmt.Errorf("%s is a directory", p)
	}
	if st.Mode().Perm()&0o111 == 0 {
		return fmt.Errorf("%s is not executable", p)
	}
	return nil
}

func lookupEnv(environ []string, name string) string {
	prefix := name + "="
	for i := len(environ) - 1; i >= 0; i-- {
		if v, ok := strings.CutPrefix(environ[i], prefix); ok {
			return v
		}
	}
	return ""
}
