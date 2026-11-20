package taskpipe

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"

	"github.com/distribution/reference"
)

// The name entries of a `docker save` archive: the only entries that name the saved image. Docker 25
// and later write an OCI image layout (oci-layout, index.json, blobs/) plus the legacy manifest.json;
// the legacy repositories file appears in archives of the classic image store.
const (
	saveManifestEntry     = "manifest.json"
	saveIndexEntry        = "index.json"
	saveRepositoriesEntry = "repositories"
)

// MaxSaveNameEntry bounds a name entry of a `docker save` archive; a larger one is rejected.
const MaxSaveNameEntry = 1 << 20

// Annotations of the OCI index entries that carry an image name.
const (
	annotationImageName = "io.containerd.image.name"
	annotationRefName   = "org.opencontainers.image.ref.name"
	// annotationSourcePrefix starts the containerd annotations that name the registry and repository an
	// image was pulled from or pushed to (containerd.io/distribution.source.<host>: <repository>).
	annotationSourcePrefix = "containerd.io/distribution.source."
)

// RewriteSaveNames streams the `docker save` tar src of one image to dst with the image renamed to name
// (a tagged reference such as localhost/scantor/echo:3), so `docker load` tags it name and nothing else
// (docs/security.md BDL-2). Only the name entries change:
//
//   - manifest.json: the RepoTags of every entry become [name];
//   - index.json: the annotations of every manifests[] entry name the image (io.containerd.image.name =
//     name, org.opencontainers.image.ref.name = the tag) and lose the containerd distribution-source
//     annotations, which name the registry and repository of a pulled or pushed image;
//   - repositories: {repository: {tag: the single id}}.
//
// Every other entry, the blobs included, is copied byte for byte with its header. A name entry that is
// larger than MaxSaveNameEntry, not a regular file or not valid JSON of its format is an error.
func RewriteSaveNames(dst io.Writer, src io.Reader, name string) error {
	names, err := newSaveNames(name)
	if err != nil {
		return err
	}
	tr := tar.NewReader(src)
	tw := tar.NewWriter(dst)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read the image archive: %w", err)
		}
		rewrite := names.rewriter(hdr.Name)
		if rewrite == nil {
			if err := tw.WriteHeader(hdr); err != nil {
				return fmt.Errorf("write the image archive: %w", err)
			}
			if _, err := io.CopyN(tw, tr, hdr.Size); err != nil {
				return fmt.Errorf("copy %s: %w", hdr.Name, err)
			}
			continue
		}
		data, err := readNameEntry(tr, hdr)
		if err != nil {
			return err
		}
		out, err := rewrite(data)
		if err != nil {
			return fmt.Errorf("rewrite %s of the image archive: %w", hdr.Name, err)
		}
		h := *hdr
		h.Size = int64(len(out))
		if err := tw.WriteHeader(&h); err != nil {
			return fmt.Errorf("write the image archive: %w", err)
		}
		if _, err := tw.Write(out); err != nil {
			return fmt.Errorf("write the image archive: %w", err)
		}
	}
	if err := tw.Close(); err != nil {
		return fmt.Errorf("write the image archive: %w", err)
	}
	return nil
}

// saveNames are the spellings of the new image name in the name entries.
type saveNames struct {
	// full is the normalised reference (io.containerd.image.name), familiar the short form Docker writes
	// into RepoTags, repository the familiar repository (the key of repositories) and tag the tag.
	full, familiar, repository, tag string
}

func newSaveNames(name string) (saveNames, error) {
	named, err := reference.ParseNormalizedNamed(name)
	if err != nil {
		return saveNames{}, fmt.Errorf("invalid image name %q: %w", name, err)
	}
	tagged, ok := named.(reference.NamedTagged)
	if _, digested := named.(reference.Digested); !ok || digested {
		return saveNames{}, fmt.Errorf("the image name %q must be a tagged reference without digest", name)
	}
	return saveNames{
		full:       named.String(),
		familiar:   reference.FamiliarString(named),
		repository: reference.FamiliarName(named),
		tag:        tagged.Tag(),
	}, nil
}

// rewriter returns the rewrite of a name entry at the archive root, or nil for every other entry.
func (n saveNames) rewriter(entry string) func([]byte) ([]byte, error) {
	switch path.Clean(strings.TrimPrefix(entry, "./")) {
	case saveManifestEntry:
		return n.manifest
	case saveIndexEntry:
		return n.index
	case saveRepositoriesEntry:
		return n.repositories
	}
	return nil
}

// readNameEntry reads a name entry, at most MaxSaveNameEntry bytes of a regular file.
func readNameEntry(tr *tar.Reader, hdr *tar.Header) ([]byte, error) {
	if hdr.Typeflag != tar.TypeReg {
		return nil, fmt.Errorf("the image archive entry %s is not a regular file", hdr.Name)
	}
	if hdr.Size > MaxSaveNameEntry {
		return nil, fmt.Errorf("the image archive entry %s is %d bytes; the limit is %d", hdr.Name, hdr.Size, MaxSaveNameEntry)
	}
	data, err := io.ReadAll(io.LimitReader(tr, MaxSaveNameEntry+1))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", hdr.Name, err)
	}
	if len(data) > MaxSaveNameEntry {
		return nil, fmt.Errorf("the image archive entry %s exceeds %d bytes", hdr.Name, MaxSaveNameEntry)
	}
	return data, nil
}

// manifest sets the RepoTags of every entry of manifest.json to [familiar name].
func (n saveNames) manifest(data []byte) ([]byte, error) {
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, err
	}
	if len(entries) == 0 {
		return nil, errors.New("no image is listed")
	}
	tags, err := json.Marshal([]string{n.familiar})
	if err != nil {
		return nil, err
	}
	for i, e := range entries {
		if e == nil {
			return nil, fmt.Errorf("entry %d is not an object", i)
		}
		e["RepoTags"] = tags
	}
	return marshalVerbatim(entries)
}

// index names the image in the annotations of every manifests[] entry of index.json and drops the
// distribution-source annotations.
func (n saveNames) index(data []byte) ([]byte, error) {
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(data, &doc); err != nil {
		return nil, err
	}
	if doc == nil {
		return nil, errors.New("not an object")
	}
	var manifests []map[string]json.RawMessage
	if err := json.Unmarshal(doc["manifests"], &manifests); err != nil {
		return nil, fmt.Errorf("manifests: %w", err)
	}
	if len(manifests) == 0 {
		return nil, errors.New("no image is listed")
	}
	for i, m := range manifests {
		if m == nil {
			return nil, fmt.Errorf("manifests[%d] is not an object", i)
		}
		annotations := map[string]string{}
		if raw, ok := m["annotations"]; ok {
			if err := json.Unmarshal(raw, &annotations); err != nil {
				return nil, fmt.Errorf("manifests[%d].annotations: %w", i, err)
			}
			if annotations == nil {
				annotations = map[string]string{}
			}
		}
		for k := range annotations {
			if strings.HasPrefix(k, annotationSourcePrefix) {
				delete(annotations, k)
			}
		}
		annotations[annotationImageName] = n.full
		annotations[annotationRefName] = n.tag
		raw, err := marshalVerbatim(annotations)
		if err != nil {
			return nil, err
		}
		m["annotations"] = raw
	}
	raw, err := marshalVerbatim(manifests)
	if err != nil {
		return nil, err
	}
	doc["manifests"] = raw
	return marshalVerbatim(doc)
}

// repositories replaces the legacy repositories file, {repository: {tag: id}} of the one saved image,
// with the new repository and tag.
func (n saveNames) repositories(data []byte) ([]byte, error) {
	var repos map[string]map[string]string
	if err := json.Unmarshal(data, &repos); err != nil {
		return nil, err
	}
	var ids []string
	for _, tags := range repos {
		for _, id := range tags {
			ids = append(ids, id)
		}
	}
	if len(ids) != 1 {
		return nil, fmt.Errorf("%d image ids are listed; exactly one is expected", len(ids))
	}
	return marshalVerbatim(map[string]map[string]string{n.repository: {n.tag: ids[0]}})
}

// marshalVerbatim encodes v without HTML escaping, so raw values keep their text (apart from
// insignificant whitespace), and without a trailing newline.
func marshalVerbatim(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}
