package taskpipe

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/lonetis/scantor/internal/manifest"
)

// testManifest is a minimal valid Python manifest.
const testManifest = "scantor: 1\nname: echo\nlanguage: python\n"

// testDockerfile is the minimal Python Dockerfile of docs/tasks.md §8.1.
const testDockerfile = "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\n"

// minimalTask returns the files of a valid task folder.
func minimalTask() map[string]string {
	return map[string]string{
		"scantor.yaml":     testManifest,
		"Dockerfile":       testDockerfile,
		"main.py":          "import scantor\n",
		"requirements.txt": "",
		".dockerignore":    ".git/\n",
	}
}

// writeTree creates the files (parent directories included) below a new temporary folder.
func writeTree(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range files {
		p := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// testLimits are generous pack caps.
func testLimits() PackLimits {
	return PackLimits{MaxFiles: 5000, MaxBytes: 200 << 20, MaxPackBytes: 50 << 20}
}

// testConfig is a pipeline configuration with the .env.example defaults.
func testConfig() Config {
	return Config{
		Pack:               testLimits(),
		ManifestLimits:     manifest.DefaultLimits(),
		PublicURL:          "http://localhost:3000",
		RegistryPublicHost: "localhost:5000",
	}
}

// mustPackDir packs dir or fails the test.
func mustPackDir(t *testing.T, dir string) *Pack {
	t.Helper()
	p, err := PackDir(context.Background(), dir, testLimits())
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}
	t.Cleanup(func() {
		if err := p.Close(); err != nil {
			t.Errorf("close pack: %v", err)
		}
	})
	return p
}

// gzipOf returns the tar.gz of a pack.
func gzipOf(t *testing.T, p *Pack) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := p.WriteGzip(&buf); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
