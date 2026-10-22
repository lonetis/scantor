package envconf

import (
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"time"
)

// Getenv is the signature of os.Getenv; LoadConfig functions receive it so tests can supply values.
type Getenv func(string) string

// Option changes how the Reader treats one variable.
type Option func(*varOptions)

type varOptions struct {
	security bool
}

// Security marks a variable as security-relevant: an invalid value aborts startup (Reader.Err) instead
// of logging a warning and falling back to the default (docs/architecture.md §10).
func Security() Option { return func(o *varOptions) { o.security = true } }

// Reader reads typed variables with defaults. An unset or empty variable takes its default. An invalid
// value of a security-relevant variable is recorded as an error; any other invalid value is recorded as
// a warning and the default applies. Messages name variables only, never values of secrets.
type Reader struct {
	getenv   Getenv
	errs     []error
	warnings []string
}

// NewReader returns a Reader over getenv (typically os.Getenv, passed in by the caller).
func NewReader(getenv Getenv) *Reader { return &Reader{getenv: getenv} }

// Err returns every recorded error of security-relevant variables, joined, or nil.
func (r *Reader) Err() error { return errors.Join(r.errs...) }

// Warnings returns the recorded warnings of invalid non-security variables.
func (r *Reader) Warnings() []string { return slices.Clone(r.warnings) }

// Lookup returns the raw value of name and whether it is set to a non-empty value.
func (r *Reader) Lookup(name string) (string, bool) {
	v := r.getenv(name)
	return v, strings.TrimSpace(v) != ""
}

func (r *Reader) invalid(name string, err error, opts []Option) {
	var o varOptions
	for _, opt := range opts {
		opt(&o)
	}
	if o.security {
		r.errs = append(r.errs, fmt.Errorf("%s: %w", name, err))
		return
	}
	r.warnings = append(r.warnings, fmt.Sprintf("%s: %v; using the default", name, err))
}

// Fail records an error for name, for checks that only the caller can make (for example a value that
// requires another variable).
func (r *Reader) Fail(name string, err error) {
	r.errs = append(r.errs, fmt.Errorf("%s: %w", name, err))
}

// String returns the value of name, or def when it is unset or empty. Surrounding whitespace is kept
// except for an all-whitespace value, which counts as empty.
func (r *Reader) String(name, def string) string {
	if v, ok := r.Lookup(name); ok {
		return v
	}
	return def
}

// Enum returns the value of name when it is one of allowed, else def (plus an error or warning).
func (r *Reader) Enum(name, def string, allowed []string, opts ...Option) string {
	v, ok := r.Lookup(name)
	if !ok {
		return def
	}
	v = strings.TrimSpace(v)
	if slices.Contains(allowed, v) {
		return v
	}
	r.invalid(name, fmt.Errorf("invalid value: use one of %s", strings.Join(allowed, ", ")), opts)
	return def
}

// Bool returns the boolean value of name, or def.
func (r *Reader) Bool(name string, def bool, opts ...Option) bool {
	v, ok := r.Lookup(name)
	if !ok {
		return def
	}
	b, err := ParseBool(v)
	if err != nil {
		r.invalid(name, err, opts)
		return def
	}
	return b
}

// List returns the list value of name, or def when it is unset or empty.
func (r *Reader) List(name string, def []string) []string {
	if v, ok := r.Lookup(name); ok {
		return ParseList(v)
	}
	return slices.Clone(def)
}

// Duration returns the duration value of name, or def.
func (r *Reader) Duration(name string, def time.Duration, opts ...Option) time.Duration {
	v, ok := r.Lookup(name)
	if !ok {
		return def
	}
	d, err := ParseDuration(v)
	if err != nil {
		r.invalid(name, err, opts)
		return def
	}
	return d
}

// ByteSize returns the byte-size value of name, or def.
func (r *Reader) ByteSize(name string, def int64, opts ...Option) int64 {
	v, ok := r.Lookup(name)
	if !ok {
		return def
	}
	n, err := ParseByteSize(v)
	if err != nil {
		r.invalid(name, err, opts)
		return def
	}
	return n
}

// Int returns the integer value of name within [min, max], or def.
func (r *Reader) Int(name string, def, minimum, maximum int64, opts ...Option) int64 {
	v, ok := r.Lookup(name)
	if !ok {
		return def
	}
	n, err := ParseInt(v)
	if err == nil && (n < minimum || n > maximum) {
		err = fmt.Errorf("invalid value: must be between %d and %d", minimum, maximum)
	}
	if err != nil {
		r.invalid(name, err, opts)
		return def
	}
	return n
}

// Days returns the whole number of days of name, or def.
func (r *Reader) Days(name string, def int, opts ...Option) int {
	v, ok := r.Lookup(name)
	if !ok {
		return def
	}
	n, err := ParseDays(v)
	if err != nil {
		r.invalid(name, err, opts)
		return def
	}
	return n
}

// PEMCertificates returns the normalised PEM bundle of name (ParsePEMCertificates), or "" when it is
// unset or invalid (plus an error or warning; trust settings are usually security-relevant).
func (r *Reader) PEMCertificates(name string, opts ...Option) string {
	v, ok := r.Lookup(name)
	if !ok {
		return ""
	}
	pem, err := ParsePEMCertificates(v)
	if err != nil {
		r.invalid(name, err, opts)
		return ""
	}
	return pem
}

// URL returns the value of name parsed as an absolute URL whose scheme is one of schemes, or def
// (which must be valid or empty). The returned string has no trailing slash.
func (r *Reader) URL(name, def string, schemes []string, opts ...Option) string {
	v, ok := r.Lookup(name)
	if !ok {
		return def
	}
	v = strings.TrimSpace(v)
	if err := checkURL(v, schemes); err != nil {
		r.invalid(name, err, opts)
		return def
	}
	return strings.TrimRight(v, "/")
}

func checkURL(v string, schemes []string) error {
	u, err := url.Parse(v)
	if err != nil {
		return errors.New("invalid URL")
	}
	if !slices.Contains(schemes, u.Scheme) {
		return fmt.Errorf("invalid URL: the scheme must be one of %s", strings.Join(schemes, ", "))
	}
	if u.Host == "" {
		return errors.New("invalid URL: missing host")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return errors.New("invalid URL: query and fragment are not allowed")
	}
	return nil
}
