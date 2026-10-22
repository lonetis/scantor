package taskpipe

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

func outTar(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.Name, Typeflag: e.Type, Mode: 0o644, Linkname: e.Linkname, Size: int64(len(e.Content))}
		if e.Type != tar.TypeReg {
			hdr.Size = 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if e.Type == tar.TypeReg {
			if _, err := tw.Write([]byte(e.Content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func localSpec() LocalSpec {
	return LocalSpec{
		V: LocalSpecVersion, RunID: LocalRunID, Entry: "main.py",
		TaskConfig: json.RawMessage(`{"greeting":"Hi"}`), ScanConfig: json.RawMessage(`{}`),
		Limit: 5, Processes: 1, TimeoutMs: 300000, MaxAttempts: 1,
		Backoff:               api.Backoff{InitialMs: 5000, Factor: 2, MaxMs: 600000, Jitter: true},
		MaxAnalysesPerProcess: 1000,
		DataSources:           api.DataSources{Tranco: "https://tranco-list.eu", Crux: "https://example.com/crux"},
		Uploads:               map[string]LocalUpload{}, Resolved: map[string]json.RawMessage{},
		Limits: DefaultLocalLimits(), OutDir: LocalOutDir,
	}
}

type lineCollector struct {
	mu    sync.Mutex
	lines []string
}

func (c *lineCollector) add(b []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lines = append(c.lines, string(b))
}

func TestLocalRun(t *testing.T) {
	d := newFakeDocker()
	img := *builtImage(nil)
	d.addImage(img)
	events := []string{
		`{"type":"start","at":"2026-10-21T09:10:01.020Z","runtimeVersion":"1.4.0","language":"python","protocolVersion":1,"connector":{"language":"python","version":"1.4.0"},"schedule":{"kind":"template","template":"single"},"limit":5,"processes":1}`,
		`{"type":"end","at":"2026-10-21T09:10:01.090Z","reason":"done","summary":{"analyses":1,"succeeded":1,"failed":0},"exitCode":0}`,
	}
	d.run = func(*fakeContainer) fakeRun {
		return fakeRun{stdout: events, stderr: []string{`{"level":"INFO","msg":"runtime"}`}, out: outTar(t,
			tarEntry{Name: "out/", Type: tar.TypeDir},
			tarEntry{Name: "out/files/0/f1/report.txt", Type: tar.TypeReg, Content: "report"},
			tarEntry{Name: "out/../../escape.txt", Type: tar.TypeReg, Content: "no"},
			tarEntry{Name: "out/files/0/f1/link", Type: tar.TypeSymlink, Linkname: "/etc/passwd"},
		)}
	}
	outDir := filepath.Join(t.TempDir(), ".scantor", "out", "20261021T091001Z")
	var stdout, stderr lineCollector
	res, err := LocalRun{
		Docker: d, Runtime: fakeRuntime{}, Image: builtID, Spec: localSpec(),
		Resources: api.Resources{CPUs: 0.5, MemoryMiB: 768}, OutDir: outDir,
		OnEvent: stdout.add, OnStderr: stderr.add,
	}.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 0 || res.Interrupted || res.Files != 1 || res.DebugPort != 0 {
		t.Fatalf("result %+v", res)
	}
	if !slices.Equal(stdout.lines, events) || len(stderr.lines) != 1 {
		t.Fatalf("stdout %q stderr %q", stdout.lines, stderr.lines)
	}
	data, err := os.ReadFile(filepath.Join(outDir, "files", "0", "f1", "report.txt"))
	if err != nil || string(data) != "report" {
		t.Fatalf("copied file %q %v", data, err)
	}
	if _, err := os.Lstat(filepath.Join(outDir, "files", "0", "f1", "link")); !os.IsNotExist(err) {
		t.Fatal("symlinks from the container are never written")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(filepath.Dir(outDir)), "escape.txt")); !os.IsNotExist(err) {
		t.Fatal("an escaping entry was written")
	}

	c := d.containers[0]
	cfg, hc := c.opts.Config, c.opts.HostConfig
	if want := []string{"/scantor/scantor", "runtime", "local", "--spec", "/scantor/in/spec.json"}; !slices.Equal(cfg.Entrypoint, want) {
		t.Fatalf("entrypoint %v", cfg.Entrypoint)
	}
	if !strings.HasPrefix(c.opts.Name, "scantor-t-local-") || !container.IsManaged(container.KindTestRun, c.opts.Name, cfg.Labels) || cfg.Labels["scantor.user"] != "local" {
		t.Fatalf("name %s labels %v", c.opts.Name, cfg.Labels)
	}
	if hc.Privileged || *hc.PidsLimit != 4096 || hc.Memory != (768+256)<<20 || hc.NanoCPUs != 5e8 || hc.NetworkMode != "bridge" || len(hc.Mounts) != 0 || len(hc.PortBindings) != 0 {
		t.Fatalf("host config %+v", hc)
	}
	if len(cfg.Env) != 0 {
		t.Fatalf("env %v", cfg.Env)
	}
	injected := tarFiles(t, c.injected)
	var spec map[string]any
	if err := json.Unmarshal([]byte(injected["scantor/in/spec.json"]), &spec); err != nil {
		t.Fatalf("spec.json: %v (%v)", err, injected)
	}
	if spec["runId"] != "local" || spec["entry"] != "main.py" || spec["analysisConfig"] != nil || spec["outDir"] != "/scantor/out" ||
		spec["taskConfig"].(map[string]any)["greeting"] != "Hi" || spec["limits"].(map[string]any)["maxResultBytes"].(float64) != 1<<20 {
		t.Fatalf("spec %v", spec)
	}
	if _, ok := spec["totalTimeoutMs"]; ok {
		t.Fatal("dev runs have no total timeout")
	}
	if !c.removed || !c.rmOpts.RemoveVolumes {
		t.Fatal("the container is removed")
	}
}

func TestLocalRunDebugPort(t *testing.T) {
	d := newFakeDocker()
	d.addImage(*builtImage(nil))
	d.run = func(*fakeContainer) fakeRun { return fakeRun{code: 1} }
	spec := localSpec()
	spec.Debug = true
	started := 0
	res, err := LocalRun{
		Docker: d, Runtime: fakeRuntime{}, Image: builtID, Spec: spec, Resources: api.Resources{CPUs: 1, MemoryMiB: 512},
		OutDir: t.TempDir(), OnStart: func(port int) { started = port },
	}.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if res.DebugPort != 5678 || started != 5678 || res.ExitCode != 1 || res.Files != 0 {
		t.Fatalf("result %+v, OnStart port %d", res, started)
	}
	hc := d.containers[0].opts.HostConfig
	bindings := hc.PortBindings
	if len(bindings) != 1 {
		t.Fatalf("bindings %v", bindings)
	}
	for port, b := range bindings {
		if port.String() != "5678/tcp" || len(b) != 1 || b[0].HostIP.String() != "127.0.0.1" || b[0].HostPort != "5678" {
			t.Fatalf("binding %s → %+v", port, b)
		}
	}

	// An image without SCANTOR_DEBUG_PORT cannot be debugged.
	d.addImage(imageWithConfig("sha256:99", map[string]any{"Env": []string{"PATH=/bin"}}))
	if _, err := (LocalRun{Docker: d, Runtime: fakeRuntime{}, Image: "sha256:99", Spec: spec, Resources: api.Resources{CPUs: 1, MemoryMiB: 512}}).Run(context.Background()); err == nil || !strings.Contains(err.Error(), DebugPortEnv) {
		t.Fatalf("err = %v", err)
	}
}

func TestLocalRunInterrupt(t *testing.T) {
	d := newFakeDocker()
	d.addImage(*builtImage(nil))
	d.run = func(*fakeContainer) fakeRun { return fakeRun{hang: true} }
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	res, err := LocalRun{Docker: d, Runtime: fakeRuntime{}, Image: builtID, Spec: localSpec(), Resources: api.Resources{CPUs: 1, MemoryMiB: 512}, OutDir: t.TempDir(), StopGrace: 50 * time.Millisecond}.Run(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c := d.containers[0]
	if !res.Interrupted || res.ExitCode != 137 || !slices.Equal(c.killed, []string{"SIGTERM", "SIGKILL"}) || !c.removed {
		t.Fatalf("result %+v killed %v", res, c.killed)
	}
}

func TestEffectiveConfig(t *testing.T) {
	schema := json.RawMessage(`{"type":"object","properties":{"greeting":{"type":"string","default":"Hello"},"n":{"type":"integer","minimum":1,"default":1}},"additionalProperties":false}`)
	filled, errs, err := EffectiveConfig("taskConfig", schema, nil)
	if err != nil || len(errs) != 0 {
		t.Fatal(err, errs)
	}
	var got map[string]any
	if err := json.Unmarshal(filled, &got); err != nil || got["greeting"] != "Hello" || got["n"].(float64) != 1 {
		t.Fatalf("filled %s", filled)
	}
	_, errs, err = EffectiveConfig("taskConfig", schema, json.RawMessage(`{"greeting":5,"n":0,"extra":true}`))
	if err != nil || len(errs) != 3 {
		t.Fatalf("errs %+v err %v", errs, err)
	}
	for _, e := range errs {
		if e.Phase != api.BuildPhaseConfig || !strings.HasPrefix(e.Message, "taskConfig /") {
			t.Fatalf("error %+v", e)
		}
	}
	if _, errs, err := EffectiveConfig("taskConfig", schema, json.RawMessage(`[1]`)); err != nil || len(errs) != 1 || !strings.HasPrefix(errs[0].Message, "taskConfig /:") {
		t.Fatalf("root type error: %+v %v", errs, err)
	}
	if _, _, err := EffectiveConfig("taskConfig", json.RawMessage(`{"type": 5}`), nil); err == nil {
		t.Fatal("an invalid schema is an error")
	}
}

func TestReferencedUploads(t *testing.T) {
	config := json.RawMessage(`{"list":"u1","lists":["u2",null],"byName":{"a":"u3"},"none":null}`)
	got := ReferencedUploads([]string{"/list", "/lists/*", "/byName/*", "/none", "/missing"}, config)
	slices.Sort(got)
	if want := []string{"/byName/a", "/list", "/lists/0"}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if ReferencedUploads(nil, config) != nil {
		t.Fatal("no paths, no references")
	}
}

func TestParseLocalEvent(t *testing.T) {
	ev, err := ParseLocalEvent([]byte(`{"type":"result","at":"2026-10-21T09:10:01.071Z","seq":0,"status":"succeeded","attempt":1,"config":{},"result":{"text":"Hi"},"error":null,"files":[{"id":"f1","name":"a.txt","size":1,"sha256":"x","contentType":"text/plain","path":"files/0/f1/a.txt"}],"logTail":"","attempts":[],"timings":{"scheduledAt":null,"startedAt":null,"finishedAt":null,"durationMs":40},"future":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if ev.Type != LocalEventResult || *ev.Seq != 0 || *ev.Attempt != 1 || ev.Files[0].Path != "files/0/f1/a.txt" || ev.Files[0].Name != "a.txt" || ev.Timings.DurationMs != 40 {
		t.Fatalf("event %+v", ev)
	}
	for _, bad := range []string{`not json`, `{}`, `{"type":""}`} {
		if _, err := ParseLocalEvent([]byte(bad)); err == nil {
			t.Errorf("%s: accepted", bad)
		}
	}
}
