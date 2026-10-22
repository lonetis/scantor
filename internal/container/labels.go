// Package container wraps github.com/moby/moby/client for every container scantor creates: the
// managed labels of schemas/managed-labels.json, the worker hardening profile, runtime injection with
// CopyToContainer, extraction of the linux runtime binary from the scantor image, and image pulls with
// per-pull registry credentials (docs/architecture.md §7, docs/nodes.md §6, docs/tasks.md §9.6).
package container

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"

	scantor "github.com/lonetis/scantor"
)

// LabelsPath is the path of the managed label set inside scantor.Schemas.
const LabelsPath = "schemas/managed-labels.json"

// Kind is a managed object kind (the value of scantor.kind).
type Kind string

// Managed kinds.
const (
	KindWorker       Kind = "worker"
	KindHelper       Kind = "helper"
	KindBuild        Kind = "build"
	KindTestRun      Kind = "testRun"
	KindEditor       Kind = "editor"
	KindEgressHelper Kind = "egressHelper"
	KindNetwork      Kind = "network"
)

// Identity label keys.
const (
	LabelManaged  = "scantor.managed"
	LabelKind     = "scantor.kind"
	LabelWorker   = "scantor.worker"
	LabelScan     = "scantor.scan"
	LabelUser     = "scantor.user"
	LabelNode     = "scantor.node"
	LabelSpecHash = "scantor.spec-hash"
	LabelOp       = "scantor.op"
)

// Identity holds the identity label values of one object; only the keys of its kind may be set, and
// all of them must be.
type Identity struct {
	Worker   string
	Scan     string
	User     string
	Node     string
	SpecHash string
	Op       string
}

func (id Identity) values() map[string]string {
	return map[string]string{
		LabelWorker: id.Worker, LabelScan: id.Scan, LabelUser: id.User,
		LabelNode: id.Node, LabelSpecHash: id.SpecHash, LabelOp: id.Op,
	}
}

type kindSpec struct {
	Object     string   `json:"object"`
	NamePrefix string   `json:"namePrefix"`
	Names      []string `json:"names"`
	Identity   []string `json:"identity"`
}

// LabelSet is the parsed schemas/managed-labels.json.
type LabelSet struct {
	Version      int                 `json:"version"`
	Fixed        map[string]string   `json:"fixed"`
	KindKey      string              `json:"kindKey"`
	IdentityKeys map[string]string   `json:"identityKeys"`
	Kinds        map[string]kindSpec `json:"kinds"`
	Forbidden    struct {
		Pattern         string `json:"pattern"`
		CaseInsensitive bool   `json:"caseInsensitive"`
		ForbidDollar    bool   `json:"forbidDollar"`
	} `json:"forbiddenImageLabelKeys"`
	forbidden *regexp.Regexp
}

// ParseLabelSet parses and checks a managed label set.
func ParseLabelSet(data []byte) (*LabelSet, error) {
	var s LabelSet
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("parse %s: %w", LabelsPath, err)
	}
	if s.Version != 1 || s.KindKey == "" || len(s.Fixed) == 0 || len(s.Kinds) == 0 {
		return nil, fmt.Errorf("parse %s: incomplete label set", LabelsPath)
	}
	for name, k := range s.Kinds {
		for _, key := range k.Identity {
			if _, ok := s.IdentityKeys[key]; !ok {
				return nil, fmt.Errorf("parse %s: kind %s uses unknown identity key %s", LabelsPath, name, key)
			}
		}
	}
	pattern := s.Forbidden.Pattern
	if s.Forbidden.CaseInsensitive {
		pattern = "(?i)" + pattern
	}
	re, err := regexp.Compile(pattern)
	if err != nil {
		return nil, fmt.Errorf("parse %s: forbidden pattern: %w", LabelsPath, err)
	}
	s.forbidden = re
	return &s, nil
}

var (
	labelsOnce sync.Once
	labelSet   *LabelSet
	labelsErr  error
)

// Labels returns the embedded label set, parsed once.
func Labels() (*LabelSet, error) {
	labelsOnce.Do(func() {
		data, err := scantor.Schemas.ReadFile(LabelsPath)
		if err != nil {
			labelsErr = fmt.Errorf("read embedded %s: %w", LabelsPath, err)
			return
		}
		labelSet, labelsErr = ParseLabelSet(data)
	})
	return labelSet, labelsErr
}

// ManagedLabels returns the labels of an object of kind with identity id, from the embedded label set:
// the fixed labels, scantor.kind and exactly the identity labels of the kind. Passed as run-time labels
// at creation, they override image labels with the same keys.
func ManagedLabels(kind Kind, id Identity) (map[string]string, error) {
	s, err := Labels()
	if err != nil {
		return nil, err
	}
	return s.ManagedLabels(kind, id)
}

// ManagedLabels is the method form of the package function for an explicit label set.
func (s *LabelSet) ManagedLabels(kind Kind, id Identity) (map[string]string, error) {
	spec, ok := s.Kinds[string(kind)]
	if !ok {
		return nil, fmt.Errorf("unknown managed kind %q", kind)
	}
	out := make(map[string]string, len(s.Fixed)+1+len(spec.Identity))
	for k, v := range s.Fixed {
		out[k] = v
	}
	out[s.KindKey] = string(kind)
	values := id.values()
	for key, v := range values {
		required := slices.Contains(spec.Identity, key)
		switch {
		case required && v == "":
			return nil, fmt.Errorf("managed labels of kind %s need %s", kind, key)
		case !required && v != "":
			return nil, fmt.Errorf("label %s is not an identity label of kind %s", key, kind)
		case required:
			out[key] = v
		}
	}
	return out, nil
}

// NamePrefix returns the container name prefix of kind ("" for networks).
func NamePrefix(kind Kind) string {
	s, err := Labels()
	if err != nil {
		return ""
	}
	return s.Kinds[string(kind)].NamePrefix
}

// Name returns the container name of kind for id, for example "scantor-w-<workerId>".
func Name(kind Kind, id string) string { return NamePrefix(kind) + id }

// IsManaged reports whether a container is a managed object of kind: it carries the fixed labels and
// scantor.kind=<kind> and its name has the kind's prefix (LBL-5). Image labels alone can never make a
// foreign container pass, because the name prefix is checked too. name may carry Docker's leading "/".
func IsManaged(kind Kind, name string, labels map[string]string) bool {
	s, err := Labels()
	if err != nil {
		return false
	}
	spec, ok := s.Kinds[string(kind)]
	if !ok || labels[s.KindKey] != string(kind) {
		return false
	}
	for k, v := range s.Fixed {
		if labels[k] != v {
			return false
		}
	}
	name = strings.TrimPrefix(name, "/")
	if spec.Object == "network" {
		return slices.Contains(spec.Names, name)
	}
	return spec.NamePrefix != "" && strings.HasPrefix(name, spec.NamePrefix) && len(name) > len(spec.NamePrefix)
}

// ForbiddenImageLabel reports whether an image LABEL key is forbidden (Dockerfile rule D9, the
// post-build label check): it matches ^(traefik\.|com\.docker\.compose\.|scantor\.) case-insensitively
// or contains "$".
func ForbiddenImageLabel(key string) bool {
	s, err := Labels()
	if err != nil {
		return true
	}
	if s.Forbidden.ForbidDollar && strings.Contains(key, "$") {
		return true
	}
	return s.forbidden.MatchString(key)
}

// KindNames returns the managed kinds of the label set, sorted.
func (s *LabelSet) KindNames() []string {
	names := make([]string, 0, len(s.Kinds))
	for k := range s.Kinds {
		names = append(names, k)
	}
	sort.Strings(names)
	return names
}

// IdentityKeysOf returns the identity label keys of kind.
func (s *LabelSet) IdentityKeysOf(kind Kind) []string {
	return slices.Clone(s.Kinds[string(kind)].Identity)
}
