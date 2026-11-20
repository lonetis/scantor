package bundlerun

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"

	"github.com/google/uuid"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/runtime/local"
	"github.com/lonetis/scantor/internal/schema"
)

// UploadNamespace is the UUID namespace of local upload files: a file given at an upload field is the upload
// uuid.NewSHA1(UploadNamespace, <sha256 hex of its content>), so the same content always has the same id.
var UploadNamespace = uuid.MustParse("5f3c2a1e-8b47-4d6a-9e0f-3c7b1d2a4e68")

// uuidPattern matches the canonical form of a UUID, which names a platform upload.
var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// Upload is a local file given at an upload field of a config (run.json uploads).
type Upload struct {
	// Pointer is the field, /<config kind><instance pointer>, for example /scanConfig/upload.
	Pointer string `json:"pointer"`
	// Path is the file inside the container.
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	// ID is the upload id that replaced the path in the config.
	ID string `json:"id"`
}

// substituteUploads replaces every string at the upload paths of a config (kind taskConfig or scanConfig) by
// the upload id of the file it names, before validation (docs/runtime.md §15.7). A UUID-shaped value names a
// platform upload, which a bundle run cannot read; a missing file is an issue too.
func (o *Options) substituteUploads(kind string, raw json.RawMessage, pointers []string) (json.RawMessage, []Upload, []api.Issue) {
	if raw == nil || len(pointers) == 0 {
		return raw, nil, nil
	}
	doc, err := schema.ParseJSON(raw)
	if err != nil {
		return raw, nil, nil // reported by readObject
	}
	var uploads []Upload
	var issues []api.Issue
	for _, pointer := range pointers {
		doc = schema.ReplacePointer(doc, pointer, func(at string, v any) (any, bool) {
			name, ok := v.(string)
			if !ok {
				return v, false // null or not a string: the schema decides
			}
			field := "/" + kind + at
			if uuidPattern.MatchString(name) {
				issues = append(issues, api.Issue{Path: field, Message: "is a platform upload id; a bundle run reads a file of the mounted folder: give its path (relative to " + o.WorkDir + ")"})
				return v, false
			}
			path := o.workPath(name)
			sum, err := hashFile(path)
			if err != nil {
				issues = append(issues, api.Issue{Path: field, Message: fmt.Sprintf("cannot read the file %s: %v", name, err)})
				return v, false
			}
			id := uuid.NewSHA1(UploadNamespace, []byte(sum)).String()
			uploads = append(uploads, Upload{Pointer: field, Path: path, SHA256: sum, ID: id})
			return id, true
		})
	}
	if len(uploads) == 0 {
		return raw, nil, issues
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return raw, nil, append(issues, api.Issue{Path: "/" + kind, Message: err.Error()})
	}
	return out, uploads, issues
}

// hashFile returns the SHA-256 hex digest of a regular file.
func hashFile(path string) (string, error) {
	f, err := os.Open(path) //nolint:gosec // a file the recipient names
	if err != nil {
		return "", unwrapPathError(err)
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return "", unwrapPathError(err)
	}
	if !fi.Mode().IsRegular() {
		return "", errors.New("not a regular file")
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", unwrapPathError(err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// foreignUploads reports the values at the upload paths of an effective config that are not files of this
// run, for example a default naming a platform upload. reported holds the fields already reported.
func foreignUploads(kind string, effective json.RawMessage, pointers []string, uploads []Upload, reported map[string]bool) []api.Issue {
	if effective == nil || len(pointers) == 0 {
		return nil
	}
	doc, err := schema.ParseJSON(effective)
	if err != nil {
		return nil
	}
	ids := map[string]bool{}
	for _, u := range uploads {
		ids[u.ID] = true
	}
	var issues []api.Issue
	for _, pointer := range pointers {
		schema.WalkPointer(doc, pointer, func(at string, v any) {
			field := "/" + kind + at
			if v == nil || reported[field] {
				return
			}
			if s, ok := v.(string); ok && ids[s] {
				return
			}
			issues = append(issues, api.Issue{Path: field, Message: "references a platform upload, which a bundle run cannot read; give the path of a file of the mounted folder"})
		})
	}
	return issues
}

// localUploads are the uploads of the local-mode spec, served to templates on the loopback interface.
func localUploads(uploads []Upload) map[string]local.Upload {
	out := make(map[string]local.Upload, len(uploads))
	for _, u := range uploads {
		out[u.ID] = local.Upload{Path: u.Path, SHA256: u.SHA256}
	}
	return out
}
