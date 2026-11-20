// Package bundle is the format of task bundles: the names of a bundle and the bundle info
// /scantor/bundle.json that the bundle step of the task pipeline (`scantor task bundle`) bakes into the
// image and bundle mode (`scantor runtime bundle`) reads (docs/runtime.md §15.7, docs/tasks.md §9.11).
//
// The orchestrator builds the info as an allowlist from a ready revision (services/bundles/info.ts);
// Parse checks it again against schemas/bundle.schema.json and decodes it strictly, and the pipeline
// writes Marshal's output into the image, so only allowlisted keys can reach a bundle.
package bundle

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/schema"
)

const (
	// InfoVersion is the format version of the bundle info (`v`).
	InfoVersion = 1
	// InfoPath is the bundle info inside a bundle image.
	InfoPath = "/scantor/bundle.json"
	// WorkDir is the working directory of a bundle image, the recipient's mount.
	WorkDir = "/work"
	// ImagePrefix starts every bundle image name; the localhost registry domain keeps a recipient who
	// forgot `docker load` from pulling a public image of the same name.
	ImagePrefix = "localhost/scantor/"
	// SchemaPath is the path of the bundle info schema inside scantor.Schemas.
	SchemaPath = "schemas/bundle.schema.json"
	// MaxInfoBytes bounds the bundle info.
	MaxInfoBytes = 4 << 20
	// maxReportedIssues bounds the schema issues quoted in a Parse error.
	maxReportedIssues = 5
)

// Info is the bundle info (schemas/bundle.schema.json): the revision's describe output, its settings
// defaults and the platform limits.
type Info struct {
	V           int             `json:"v"`
	Image       string          `json:"image"`
	Ref         string          `json:"ref"`
	Task        string          `json:"task"`
	Revision    int             `json:"revision"`
	Language    string          `json:"language"`
	Entry       string          `json:"entry"`
	Platform    api.Platform    `json:"platform"`
	Description api.Description `json:"description"`
	Settings    Settings        `json:"settings"`
	Limits      Limits          `json:"limits"`
}

// Settings are the revision's settings defaults without workers, nodeSelector and privileged
// (docs/data-model.md §4.5.1).
type Settings struct {
	Processes             int           `json:"processes"`
	TimeoutMs             int64         `json:"timeoutMs"`
	MaxAttempts           int           `json:"maxAttempts"`
	Backoff               api.Backoff   `json:"backoff"`
	Resources             api.Resources `json:"resources"`
	MaxAnalysesPerProcess int           `json:"maxAnalysesPerProcess"`
}

// Limits are the platform limits of a bundle run: the test-run limits of the master, plus the bound of
// processes (SCANTOR_MAX_PROCESSES_PER_WORKER).
type Limits struct {
	MaxAnalysisConfigBytes int64 `json:"maxAnalysisConfigBytes"`
	MaxResultBytes         int64 `json:"maxResultBytes"`
	MaxFileBytes           int64 `json:"maxFileBytes"`
	MaxFilesPerAnalysis    int   `json:"maxFilesPerAnalysis"`
	LogTailBytes           int   `json:"logTailBytes"`
	LogTailEarlierBytes    int   `json:"logTailEarlierBytes"`
	MaxProcesses           int   `json:"maxProcesses"`
}

// ImageName returns the image name of a bundle, localhost/scantor/<task>:<revision>.
func ImageName(task string, revision int) string {
	return ImagePrefix + task + ":" + strconv.Itoa(revision)
}

// RevisionRef returns the revision reference <task>@<revision>.
func RevisionRef(task string, revision int) string {
	return task + "@" + strconv.Itoa(revision)
}

// FileName returns the file name of a bundle archive, <task>-<revision>-<os>-<arch>.bundle.tar.gz.
func FileName(task string, revision int, p api.Platform) string {
	return fmt.Sprintf("%s-%d-%s-%s.bundle.tar.gz", task, revision, p.OS, p.Arch)
}

var infoSchema struct {
	once     sync.Once
	compiled *schema.Schema
	err      error
}

func compiledSchema() (*schema.Schema, error) {
	infoSchema.once.Do(func() {
		data, err := scantor.Schemas.ReadFile(SchemaPath)
		if err != nil {
			infoSchema.err = fmt.Errorf("read embedded %s: %w", SchemaPath, err)
			return
		}
		infoSchema.compiled, infoSchema.err = schema.Compile(data)
	})
	return infoSchema.compiled, infoSchema.err
}

// Parse checks and decodes a bundle info: at most MaxInfoBytes, valid against
// schemas/bundle.schema.json, decoded without unknown fields, and with the image name and the reference
// of its task and revision. An absent warnings list of the description becomes an empty list.
func Parse(data []byte) (*Info, error) {
	if len(data) > MaxInfoBytes {
		return nil, fmt.Errorf("the bundle info is %d bytes; the limit is %d", len(data), MaxInfoBytes)
	}
	doc, err := schema.ParseJSON(data)
	if err != nil {
		return nil, fmt.Errorf("the bundle info is not JSON: %w", err)
	}
	s, err := compiledSchema()
	if err != nil {
		return nil, err
	}
	if issues := s.Validate(doc); len(issues) > 0 {
		return nil, fmt.Errorf("the bundle info does not match %s: %s", SchemaPath, issueList(issues))
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var info Info
	if err := dec.Decode(&info); err != nil {
		return nil, fmt.Errorf("decode the bundle info: %w", err)
	}
	if want := ImageName(info.Task, info.Revision); info.Image != want {
		return nil, fmt.Errorf("the bundle info names the image %q; task %s revision %d is %q", info.Image, info.Task, info.Revision, want)
	}
	if want := RevisionRef(info.Task, info.Revision); info.Ref != want {
		return nil, fmt.Errorf("the bundle info names the revision %q; task %s revision %d is %q", info.Ref, info.Task, info.Revision, want)
	}
	info.normalise()
	return &info, nil
}

// Marshal encodes the info as written into a bundle image: JSON without HTML escaping and with a
// trailing newline. Nil path lists are written as empty lists, so Parse(Marshal(i)) returns i.
func (i *Info) Marshal() ([]byte, error) {
	if i == nil {
		return nil, errors.New("no bundle info")
	}
	out := *i
	out.normalise()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(&out); err != nil {
		return nil, fmt.Errorf("encode the bundle info: %w", err)
	}
	return buf.Bytes(), nil
}

// normalise replaces nil path lists and warnings of the description with empty lists.
func (i *Info) normalise() {
	d := &i.Description
	for _, list := range []*[]string{
		&d.SecretPaths.TaskConfig, &d.SecretPaths.ScanConfig, &d.SecretPaths.AnalysisConfig, &d.SecretPaths.Result,
		&d.UploadPaths.TaskConfig, &d.UploadPaths.ScanConfig, &d.FileRefPaths, &d.Warnings,
	} {
		if *list == nil {
			*list = []string{}
		}
	}
}

func issueList(issues []schema.Issue) string {
	parts := make([]string, 0, maxReportedIssues)
	for i, is := range issues {
		if i == maxReportedIssues {
			parts = append(parts, fmt.Sprintf("and %d more", len(issues)-maxReportedIssues))
			break
		}
		path := is.Path
		if path == "" {
			path = "/"
		}
		parts = append(parts, path+": "+is.Message)
	}
	return strings.Join(parts, "; ")
}
