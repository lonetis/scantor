package taskpipe

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

// saveEntry is one entry of a test tar: a header and its content.
type saveEntry struct {
	hdr  tar.Header
	data []byte
}

func regEntry(name string, mode int64, data string) saveEntry {
	return saveEntry{hdr: tar.Header{Typeflag: tar.TypeReg, Name: name, Mode: mode, Size: int64(len(data)), ModTime: time.Unix(0, 0)}, data: []byte(data)}
}

func dirEntry(name string) saveEntry {
	return saveEntry{hdr: tar.Header{Typeflag: tar.TypeDir, Name: name, Mode: 0o755, ModTime: time.Unix(0, 0)}}
}

func writeTar(t *testing.T, entries []saveEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		h := e.hdr
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if _, err := tw.Write(e.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func readTar(t *testing.T, data []byte) []saveEntry {
	t.Helper()
	var out []saveEntry
	tr := tar.NewReader(bytes.NewReader(data))
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return out
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, saveEntry{hdr: *h, data: b})
	}
}

func rewrite(t *testing.T, saved []byte, name string) []saveEntry {
	t.Helper()
	var out bytes.Buffer
	if err := RewriteSaveNames(&out, bytes.NewReader(saved), name); err != nil {
		t.Fatal(err)
	}
	return readTar(t, out.Bytes())
}

// sameEntry reports whether a copied entry kept its header fields and content.
func sameEntry(a, b saveEntry) bool {
	return a.hdr.Name == b.hdr.Name && a.hdr.Typeflag == b.hdr.Typeflag && a.hdr.Mode == b.hdr.Mode && a.hdr.Size == b.hdr.Size &&
		a.hdr.Uid == b.hdr.Uid && a.hdr.Gid == b.hdr.Gid && a.hdr.Linkname == b.hdr.Linkname && a.hdr.ModTime.Equal(b.hdr.ModTime) &&
		bytes.Equal(a.data, b.data)
}

// checkRewritten checks that out has the entries of in in order, every entry except the name entries
// unchanged, and returns the rewritten name entries by name.
func checkRewritten(t *testing.T, in, out []saveEntry) map[string][]byte {
	t.Helper()
	if len(in) != len(out) {
		t.Fatalf("%d entries, want %d", len(out), len(in))
	}
	rewritten := map[string][]byte{}
	for i := range in {
		switch in[i].hdr.Name {
		case "manifest.json", "index.json", "repositories":
			if out[i].hdr.Name != in[i].hdr.Name || out[i].hdr.Mode != in[i].hdr.Mode || out[i].hdr.Size != int64(len(out[i].data)) {
				t.Fatalf("name entry %d header %+v", i, out[i].hdr)
			}
			rewritten[in[i].hdr.Name] = out[i].data
		default:
			if !sameEntry(in[i], out[i]) {
				t.Fatalf("entry %s changed:\n%+v %q\n%+v %q", in[i].hdr.Name, in[i].hdr, in[i].data, out[i].hdr, out[i].data)
			}
		}
	}
	return rewritten
}

func TestRewriteSaveNamesLegacyArchive(t *testing.T) {
	const layerID = "5f2e3c4d"
	in := []saveEntry{
		dirEntry(layerID + "/"),
		regEntry(layerID+"/VERSION", 0o644, "1.0"),
		regEntry(layerID+"/json", 0o644, `{"id":"`+layerID+`"}`),
		regEntry(layerID+"/layer.tar", 0o644, "layer bytes naming scantor-bundle/u1:build"),
		{hdr: tar.Header{Typeflag: tar.TypeSymlink, Name: "shared.tar", Linkname: layerID + "/layer.tar", ModTime: time.Unix(0, 0)}},
		regEntry("abc123.json", 0o644, `{"architecture":"amd64","os":"linux"}`),
		regEntry("manifest.json", 0o644, `[{"Config":"abc123.json","RepoTags":["scantor-bundle/u1:build"],"Layers":["`+layerID+`/layer.tar"]}]`),
		regEntry("repositories", 0o644, `{"scantor-bundle/u1":{"build":"`+layerID+`"}}`),
	}
	rewritten := checkRewritten(t, in, rewrite(t, writeTar(t, in), "localhost/scantor/echo:3"))

	var manifest []map[string]any
	if err := json.Unmarshal(rewritten["manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	want := []map[string]any{{"Config": "abc123.json", "RepoTags": []any{"localhost/scantor/echo:3"}, "Layers": []any{layerID + "/layer.tar"}}}
	if !reflect.DeepEqual(manifest, want) {
		t.Fatalf("manifest.json %s", rewritten["manifest.json"])
	}
	if got := string(rewritten["repositories"]); got != `{"localhost/scantor/echo":{"3":"`+layerID+`"}}` {
		t.Fatalf("repositories %s", got)
	}
}

// ociIndex is an index.json of a containerd-store `docker save`, with the distribution-source
// annotation of a pulled image.
const ociIndex = `{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[` +
	`{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:aaaa","size":856,` +
	`"annotations":{"containerd.io/distribution.source.localhost:5000":"tasks/7f3b2c1a","io.containerd.image.name":"docker.io/scantor-bundle/u1:build",` +
	`"org.opencontainers.image.ref.name":"build","org.example.kept":"yes"},"platform":{"architecture":"arm64","os":"linux"}}]}`

func TestRewriteSaveNamesOCIArchive(t *testing.T) {
	in := []saveEntry{
		dirEntry("blobs/"),
		dirEntry("blobs/sha256/"),
		regEntry("blobs/sha256/aaaa", 0o444, `{"schemaVersion":2,"config":{"digest":"sha256:cccc"},"layers":[]}`),
		regEntry("blobs/sha256/bbbb", 0o444, "\x1f\x8b binary layer"),
		regEntry("blobs/sha256/cccc", 0o444, `{"history":[{"created_by":"LABEL org.opencontainers.image.title=echo@3"}]}`),
		regEntry("index.json", 0o644, ociIndex),
		regEntry("manifest.json", 0o644, `[{"Config":"blobs/sha256/cccc","RepoTags":["scantor-bundle/u1:build"],"Layers":["blobs/sha256/bbbb"]}]`),
		regEntry("oci-layout", 0o444, `{"imageLayoutVersion":"1.0.0"}`),
	}
	rewritten := checkRewritten(t, in, rewrite(t, writeTar(t, in), "localhost/scantor/echo:3"))

	var index struct {
		SchemaVersion int    `json:"schemaVersion"`
		MediaType     string `json:"mediaType"`
		Manifests     []struct {
			MediaType   string            `json:"mediaType"`
			Digest      string            `json:"digest"`
			Size        int64             `json:"size"`
			Annotations map[string]string `json:"annotations"`
			Platform    map[string]string `json:"platform"`
		} `json:"manifests"`
	}
	if err := json.Unmarshal(rewritten["index.json"], &index); err != nil {
		t.Fatal(err)
	}
	if index.SchemaVersion != 2 || index.MediaType != "application/vnd.oci.image.index.v1+json" || len(index.Manifests) != 1 {
		t.Fatalf("index.json %s", rewritten["index.json"])
	}
	m := index.Manifests[0]
	wantAnnotations := map[string]string{
		"io.containerd.image.name":          "localhost/scantor/echo:3",
		"org.opencontainers.image.ref.name": "3",
		"org.example.kept":                  "yes",
	}
	if m.Digest != "sha256:aaaa" || m.Size != 856 || m.Platform["architecture"] != "arm64" || !reflect.DeepEqual(m.Annotations, wantAnnotations) {
		t.Fatalf("index entry %+v", m)
	}
	if strings.Contains(string(rewritten["index.json"]), "localhost:5000") || strings.Contains(string(rewritten["index.json"]), "scantor-bundle") {
		t.Fatalf("index.json still names the old image or its registry: %s", rewritten["index.json"])
	}
	if got := string(rewritten["manifest.json"]); !strings.Contains(got, `"RepoTags":["localhost/scantor/echo:3"]`) || !strings.Contains(got, `"Layers":["blobs/sha256/bbbb"]`) {
		t.Fatalf("manifest.json %s", got)
	}
}

func TestRewriteSaveNamesAddsMissingAnnotations(t *testing.T) {
	in := []saveEntry{regEntry("./index.json", 0o644, `{"schemaVersion":2,"manifests":[{"digest":"sha256:aaaa"},{"digest":"sha256:bbbb","annotations":null}]}`)}
	out := readTar(t, func() []byte {
		var buf bytes.Buffer
		if err := RewriteSaveNames(&buf, bytes.NewReader(writeTar(t, in)), "localhost/scantor/probe:12"); err != nil {
			t.Fatal(err)
		}
		return buf.Bytes()
	}())
	want := `{"manifests":[{"annotations":{"io.containerd.image.name":"localhost/scantor/probe:12","org.opencontainers.image.ref.name":"12"},"digest":"sha256:aaaa"},` +
		`{"annotations":{"io.containerd.image.name":"localhost/scantor/probe:12","org.opencontainers.image.ref.name":"12"},"digest":"sha256:bbbb"}],"schemaVersion":2}`
	if len(out) != 1 || out[0].hdr.Name != "./index.json" || string(out[0].data) != want {
		t.Fatalf("entries %+v", out)
	}
}

func TestRewriteSaveNamesErrors(t *testing.T) {
	big := regEntry("manifest.json", 0o644, "["+strings.Repeat(" ", MaxSaveNameEntry)+"]")
	cases := map[string]struct {
		entries []saveEntry
		name    string
		want    string
	}{
		"large name entry":  {[]saveEntry{big}, "localhost/scantor/echo:3", "the limit is 1048576"},
		"invalid manifest":  {[]saveEntry{regEntry("manifest.json", 0o644, "{")}, "localhost/scantor/echo:3", "rewrite manifest.json"},
		"empty manifest":    {[]saveEntry{regEntry("manifest.json", 0o644, "[]")}, "localhost/scantor/echo:3", "no image is listed"},
		"invalid index":     {[]saveEntry{regEntry("index.json", 0o644, `{"manifests":{}}`)}, "localhost/scantor/echo:3", "rewrite index.json"},
		"bad annotations":   {[]saveEntry{regEntry("index.json", 0o644, `{"manifests":[{"annotations":{"a":1}}]}`)}, "localhost/scantor/echo:3", "annotations"},
		"two repositories":  {[]saveEntry{regEntry("repositories", 0o644, `{"a":{"1":"x"},"b":{"2":"y"}}`)}, "localhost/scantor/echo:3", "2 image ids"},
		"name entry is dir": {[]saveEntry{dirEntry("index.json")}, "localhost/scantor/echo:3", "not a regular file"},
		"untagged name":     {nil, "localhost/scantor/echo", "must be a tagged reference"},
		"digest name":       {nil, "localhost/scantor/echo:3@sha256:" + strings.Repeat("a", 64), "must be a tagged reference"},
		"invalid name":      {nil, "Localhost/UPPER:3", "invalid image name"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			err := RewriteSaveNames(io.Discard, bytes.NewReader(writeTar(t, tc.entries)), tc.name)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error %v, want %q", err, tc.want)
			}
		})
	}
	if err := RewriteSaveNames(io.Discard, strings.NewReader("not a tar archive at all, but long enough to fill a header block"+strings.Repeat("x", 512)), "localhost/scantor/echo:3"); err == nil || !strings.Contains(err.Error(), "read the image archive") {
		t.Fatalf("not a tar: %v", err)
	}
}

// failingWriter fails every write.
type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestRewriteSaveNamesWriteError(t *testing.T) {
	in := []saveEntry{regEntry("blobs/sha256/aaaa", 0o444, strings.Repeat("x", 4096))}
	if err := RewriteSaveNames(failingWriter{}, bytes.NewReader(writeTar(t, in)), "localhost/scantor/echo:3"); err == nil {
		t.Fatal("a failing destination must fail the rewrite")
	}
}
