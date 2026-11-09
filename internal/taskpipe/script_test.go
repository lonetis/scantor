package taskpipe

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/moby/moby/api/types/build"
	"github.com/moby/moby/api/types/image"
	"github.com/moby/moby/api/types/jsonstream"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/version"
)

// testScriptManifest is a minimal valid script manifest.
const testScriptManifest = "scantor: 1\nname: csp-stats\nlanguage: python\n"

// scriptTag is the local tag the orchestrator gives script images: scripts/<scriptId>:<packSha256>.
const scriptTag = "scripts/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c:abc"

// minimalScript returns the files of a valid script folder.
func minimalScript() map[string]string {
	return map[string]string{
		"scantor-script.yaml": testScriptManifest,
		"Dockerfile":          testDockerfile,
		"main.py":             "from scantor.script import Script\n",
		"requirements.txt":    "",
		".dockerignore":       ".git/\n",
	}
}

func (e *pipelineEnv) buildScript(t *testing.T, files map[string]string, opts ScriptBuildOptions) *ScriptResult {
	t.Helper()
	if opts.Tag == "" {
		opts.Tag = scriptTag
	}
	return e.pipeline().BuildScript(context.Background(), Input{Dir: writeTree(t, files)}, opts)
}

// scriptEvents decodes the emitted events of a script build and checks the stream invariants: v 1,
// consecutive seq, the result last.
func (e *pipelineEnv) scriptEvents(t *testing.T) []ScriptEvent {
	t.Helper()
	var out []ScriptEvent
	dec := json.NewDecoder(bytes.NewReader(e.events.Bytes()))
	for {
		var ev ScriptEvent
		if err := dec.Decode(&ev); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		out = append(out, ev)
	}
	for i, ev := range out {
		if ev.V != 1 || ev.Seq != int64(i) {
			t.Fatalf("event %d: v %d seq %d", i, ev.V, ev.Seq)
		}
		if (ev.Type == EventResult) != (i == len(out)-1) {
			t.Fatalf("the result must be exactly the last event (event %d is %s)", i, ev.Type)
		}
	}
	return out
}

func onlyScriptError(t *testing.T, res *ScriptResult, phase api.BuildPhase, substr string) api.BuildError {
	t.Helper()
	if res.OK || len(res.Errors) != 1 || res.Errors[0].Phase != phase || !strings.Contains(res.Errors[0].Message, substr) {
		t.Fatalf("errors = %+v, want one %s error containing %q", res.Errors, phase, substr)
	}
	return res.Errors[0]
}

func TestBuildScriptSuccess(t *testing.T) {
	env := newPipelineEnv()
	files := minimalScript()
	files["scantor-script.yaml"] = testScriptManifest + "entry: src/main.py\ndefaults:\n  timeoutMs: 7200000\n  resources:\n    cpus: 2\n"
	files["src/main.py"] = files["main.py"]
	delete(files, "main.py")
	files["Dockerfile"] = testDockerfile + "CMD [\"x\"]\n"
	res := env.buildScript(t, files, ScriptBuildOptions{ScriptStaticOptions: ScriptStaticOptions{ExpectName: "csp-stats"}, ReuseExisting: true})
	if !res.OK || res.ExitCode() != 0 {
		t.Fatalf("errors: %+v", res.Errors)
	}
	if res.Image == nil || res.Image.Ref != scriptTag || res.Image.ID != builtID || res.Image.Bytes != 123<<20 || res.Image.Digest != "" {
		t.Fatalf("image = %+v", res.Image)
	}
	if *res.BaseImage != (api.ImageRef{Ref: baseRef, Digest: baseID}) {
		t.Fatalf("baseImage = %+v (the base image of the script's language)", res.BaseImage)
	}
	if res.Manifest == nil || res.Manifest.Name != "csp-stats" || res.Manifest.Language != "python" || *res.Entry != "src/main.py" {
		t.Fatalf("manifest %+v entry %v", res.Manifest, res.Entry)
	}
	if d := res.Defaults; d.TimeoutMs == nil || *d.TimeoutMs != 7200000 || d.Resources != (api.Resources{CPUs: 2, MemoryMiB: manifest.ScriptDefaultMemoryMiB}) {
		t.Fatalf("defaults %+v", res.Defaults)
	}
	if !slices.Equal(res.Warnings, []string{"Dockerfile:6: CMD is ignored; the runtime is the entrypoint (W1)"}) {
		t.Fatalf("warnings %q", res.Warnings)
	}
	if got := slices.Sorted(maps.Keys(res.DurationsMs)); !slices.Equal(got, []string{"build", "pack", "static"}) {
		t.Fatalf("durations of %v: a script build has no describe, check or push", got)
	}

	// The build is the task build: BuildKit, the pack as context, only SCANTOR_BASE. No container runs
	// (no describe, no check) and nothing is pushed.
	d := env.docker
	if len(d.buildOpts) != 1 || len(d.containers) != 0 || len(d.pushes) != 0 {
		t.Fatalf("%d builds, %d containers, %d pushes", len(d.buildOpts), len(d.containers), len(d.pushes))
	}
	bo := d.buildOpts[0]
	if bo.Version != build.BuilderBuildKit || !slices.Equal(bo.Tags, []string{scriptTag}) || bo.PullParent || len(bo.Labels) != 0 ||
		len(bo.BuildArgs) != 1 || *bo.BuildArgs["SCANTOR_BASE"] != baseRef {
		t.Fatalf("build options %+v", bo)
	}
	if ctxFiles := tarFiles(t, d.buildContexts[0]); ctxFiles["scantor-script.yaml"] == "" || ctxFiles["src/main.py"] == "" {
		t.Fatalf("build context %v", ctxFiles)
	}

	// The event stream: the task-pipeline format, ending in the script result.
	events := env.scriptEvents(t)
	last := events[len(events)-1]
	if last.Phase != api.BuildPhaseBuild || !last.Result.OK || last.Result.Image.ID != builtID {
		t.Fatalf("result event %+v", last)
	}
	for _, ev := range events {
		if ev.Phase != api.BuildPhasePack && ev.Phase != api.BuildPhaseStatic && ev.Phase != api.BuildPhaseBuild {
			t.Fatalf("event of phase %s", ev.Phase)
		}
	}
}

// The result JSON carries exactly the fields the orchestrator reads (docs/scripts.md).
func TestScriptResultJSON(t *testing.T) {
	env := newPipelineEnv()
	env.buildScript(t, minimalScript(), ScriptBuildOptions{})
	lines := strings.Split(strings.TrimSpace(env.events.String()), "\n")
	var last struct {
		Type   string                     `json:"type"`
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		t.Fatal(err)
	}
	want := []string{"baseImage", "defaults", "durationsMs", "entry", "errors", "image", "manifest", "ok", "pack", "warnings"}
	if got := slices.Sorted(maps.Keys(last.Result)); last.Type != EventResult || !slices.Equal(got, want) {
		t.Fatalf("result keys %v, want %v", got, want)
	}
	if string(last.Result["defaults"]) != `{"timeoutMs":null,"resources":{"cpus":1,"memoryMiB":1024}}` || string(last.Result["entry"]) != `"main.py"` {
		t.Fatalf("defaults %s entry %s", last.Result["defaults"], last.Result["entry"])
	}
	if string(last.Result["manifest"]) != `{"scantor":1,"name":"csp-stats","language":"python","entry":"main.py","defaults":{}}` {
		t.Fatalf("manifest %s", last.Result["manifest"])
	}
}

func TestBuildScriptReuseExisting(t *testing.T) {
	env := newPipelineEnv()
	env.docker.addImage(*builtImage(nil), scriptTag)
	res := env.buildScript(t, minimalScript(), ScriptBuildOptions{ReuseExisting: true})
	if !res.OK || len(env.docker.buildOpts) != 0 || res.Image.ID != builtID || res.BaseImage == nil {
		t.Fatalf("ok %v builds %d image %+v errors %+v", res.OK, len(env.docker.buildOpts), res.Image, res.Errors)
	}

	// Without --reuse-existing the image is rebuilt.
	env = newPipelineEnv()
	env.docker.addImage(*builtImage(nil), scriptTag)
	if res := env.buildScript(t, minimalScript(), ScriptBuildOptions{}); !res.OK || len(env.docker.buildOpts) != 1 {
		t.Fatalf("builds %d errors %+v", len(env.docker.buildOpts), res.Errors)
	}

	// An image built on an earlier base image is rebuilt on the current one.
	env = newPipelineEnv()
	stale := builtImage(nil)
	stale.ID = "sha256:3333333333333333333333333333333333333333333333333333333333333333"
	stale.RootFS.Layers = []string{"sha256:old-base", "sha256:script"}
	env.docker.addImage(*stale, scriptTag)
	res = env.buildScript(t, minimalScript(), ScriptBuildOptions{ReuseExisting: true})
	if !res.OK || len(env.docker.buildOpts) != 1 || res.Image.ID != builtID {
		t.Fatalf("ok %v builds %d image %+v", res.OK, len(env.docker.buildOpts), res.Image)
	}
}

func TestBuildScriptFailures(t *testing.T) {
	t.Run("no Docker daemon", func(t *testing.T) {
		var events bytes.Buffer
		res := New(testConfig(), NewEmitter(&events, EventsNDJSON), nil, nil).BuildScript(context.Background(), Input{Dir: writeTree(t, minimalScript())}, ScriptBuildOptions{Tag: scriptTag})
		onlyScriptError(t, res, api.BuildPhasePlatform, "needs a Docker daemon")
		if res.ExitCode() != 3 || res.Pack != nil || !strings.Contains(events.String(), `"type":"result"`) {
			t.Fatalf("exit %d pack %+v events %s", res.ExitCode(), res.Pack, events.String())
		}
	})
	t.Run("no tag", func(t *testing.T) {
		env := newPipelineEnv()
		res := env.pipeline().BuildScript(context.Background(), Input{Dir: writeTree(t, minimalScript())}, ScriptBuildOptions{})
		onlyScriptError(t, res, api.BuildPhasePlatform, "needs an image tag")
	})
	t.Run("a task folder is not a script", func(t *testing.T) {
		env := newPipelineEnv()
		res := env.buildScript(t, minimalTask(), ScriptBuildOptions{})
		be := onlyScriptError(t, res, api.BuildPhaseStatic, "scantor-script.yaml is missing: this folder has a task manifest (scantor.yaml)")
		if be.File != "scantor-script.yaml" || res.ExitCode() != 2 || res.Manifest != nil || res.Entry != nil || res.Defaults != nil || res.Pack == nil {
			t.Fatalf("error %+v exit %d result %+v", be, res.ExitCode(), res)
		}
		if len(env.docker.buildOpts) != 0 || len(env.docker.pulls) != 0 {
			t.Fatal("a failed static check must stop before the build")
		}
	})
	t.Run("static errors", func(t *testing.T) {
		env := newPipelineEnv()
		files := minimalScript()
		files["Dockerfile"] = "ARG SCANTOR_BASE\nFROM scripts/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d:abc\n"
		res := env.buildScript(t, files, ScriptBuildOptions{})
		if res.OK || res.ExitCode() != 2 || len(res.Errors) == 0 || res.Errors[0].File != "Dockerfile" || res.Manifest == nil {
			t.Fatalf("errors %+v manifest %+v", res.Errors, res.Manifest)
		}
	})
	t.Run("base image unavailable", func(t *testing.T) {
		env := newPipelineEnv()
		env.cfg.Images = version.ImageOverride{Prefix: "ghcr.io/lonetis/", Tag: "9.9.9"}
		res := env.buildScript(t, minimalScript(), ScriptBuildOptions{})
		onlyScriptError(t, res, api.BuildPhasePlatform, "pull the base image")
		if res.ExitCode() != 3 || res.Image != nil {
			t.Fatalf("exit %d image %+v", res.ExitCode(), res.Image)
		}
	})
	t.Run("build error", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.build = func(client.ImageBuildOptions) ([]jsonstream.Message, *image.InspectResponse, bool) {
			return []jsonstream.Message{{Error: &jsonstream.Error{Message: "pip install failed"}}}, nil, false
		}
		res := env.buildScript(t, minimalScript(), ScriptBuildOptions{})
		onlyScriptError(t, res, api.BuildPhaseBuild, "pip install failed")
		if res.ExitCode() != 2 || res.Image != nil || res.Manifest == nil {
			t.Fatalf("exit %d image %+v manifest %+v", res.ExitCode(), res.Image, res.Manifest)
		}
	})
	t.Run("ONBUILD images name the script build", func(t *testing.T) {
		env := newPipelineEnv()
		env.docker.addImage(imageWithConfig("sha256:aa", map[string]any{"OnBuild": []string{"RUN id"}}), "busybox:1.37")
		files := minimalScript()
		files["Dockerfile"] = testDockerfile + "COPY --from=busybox:1.37 /bin/busybox /bb\n"
		res := env.buildScript(t, files, ScriptBuildOptions{})
		onlyScriptError(t, res, api.BuildPhaseBuild, "ONBUILD triggers, which are not allowed in script builds")
	})
}

func TestBuildScriptTextEvents(t *testing.T) {
	env := newPipelineEnv()
	var out bytes.Buffer
	res := New(env.cfg, NewEmitter(&out, EventsText), env.docker, nil).BuildScript(context.Background(), Input{Dir: writeTree(t, minimalScript())}, ScriptBuildOptions{Tag: scriptTag})
	if !res.OK {
		t.Fatal(res.Errors)
	}
	text := out.String()
	for _, want := range []string{"[pack] packed 5 files", "[build] base image " + baseRef, fmt.Sprintf("[result] ok: image %s (123.0 MiB)\n", scriptTag)} {
		if !strings.Contains(text, want) {
			t.Errorf("text events lack %q:\n%s", want, text)
		}
	}

	out.Reset()
	files := minimalScript()
	delete(files, "scantor-script.yaml")
	res = New(env.cfg, NewEmitter(&out, EventsText), env.docker, nil).BuildScript(context.Background(), Input{Dir: writeTree(t, files)}, ScriptBuildOptions{Tag: scriptTag})
	want := "[result] failed with 1 error(s)\n  [static] scantor-script.yaml: scantor-script.yaml is missing: every script needs a manifest at its root\n"
	if res.OK || !strings.HasSuffix(out.String(), want) {
		t.Fatalf("text events:\n%s", out.String())
	}
}

func TestCheckScriptStaticSteps(t *testing.T) {
	tests := []struct {
		name string
		edit func(files map[string]string)
		opts ScriptStaticOptions
		// wantErr are the expected errors; wantSub, when set, is a substring of the only error instead.
		wantErr []api.BuildError
		wantSub string
	}{
		{name: "valid", edit: func(map[string]string) {}},
		{name: "expected name matches", edit: func(map[string]string) {}, opts: ScriptStaticOptions{ExpectName: "csp-stats"}},
		{
			name:    "missing manifest",
			edit:    func(f map[string]string) { delete(f, "scantor-script.yaml") },
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor-script.yaml", Message: "scantor-script.yaml is missing: every script needs a manifest at its root"}},
		},
		{
			name: "scantor-script.yml is not accepted",
			edit: func(f map[string]string) {
				f["scantor-script.yml"] = f["scantor-script.yaml"]
				delete(f, "scantor-script.yaml")
			},
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor-script.yaml", Message: "scantor-script.yaml is missing: rename scantor-script.yml to scantor-script.yaml"}},
		},
		{
			name: "a task manifest instead",
			edit: func(f map[string]string) {
				f["scantor.yaml"] = testManifest
				delete(f, "scantor-script.yaml")
			},
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor-script.yaml",
				Message: "scantor-script.yaml is missing: this folder has a task manifest (scantor.yaml); every script needs scantor-script.yaml at its root"}},
		},
		{
			name: "manifest over 64 KiB",
			edit: func(f map[string]string) {
				f["scantor-script.yaml"] = testScriptManifest + "#" + strings.Repeat("x", 64<<10) + "\n"
			},
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "scantor-script.yaml",
				Message: fmt.Sprintf("the manifest is %d bytes; the limit is 65536 (S1)", len(testScriptManifest)+64<<10+2)}},
		},
		{
			name:    "missing Dockerfile",
			edit:    func(f map[string]string) { delete(f, "Dockerfile") },
			wantErr: []api.BuildError{{Phase: api.BuildPhaseStatic, File: "Dockerfile", Message: "Dockerfile is missing: every script needs a Dockerfile at its root (FROM ${SCANTOR_BASE})"}},
		},
		{
			name: "manifest errors stop before the Dockerfile policy",
			edit: func(f map[string]string) {
				f["scantor-script.yaml"] = testScriptManifest + "kind: script\n"
				f["Dockerfile"] = "FROM alpine\n"
			},
			wantSub: "kind",
		},
		{name: "expected name", edit: func(map[string]string) {}, opts: ScriptStaticOptions{ExpectName: "other"}, wantSub: `does not match script "other"`},
		{name: "language without scripts", edit: func(f map[string]string) { f["scantor-script.yaml"] = "scantor: 1\nname: csp-stats\nlanguage: go\n" }, wantSub: "go does not support scripts"},
		{name: "default entry missing", edit: func(f map[string]string) { delete(f, "main.py") }, wantSub: `entry "main.py"`},
		{
			name: "Dockerfile policy D5 forbids script images",
			edit: func(f map[string]string) {
				f["Dockerfile"] = "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY --from=scripts/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d:abc /task /x\n"
			},
			wantSub: "(D5)",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := minimalScript()
			tt.edit(files)
			res := CheckScriptStatic(mustPackDir(t, writeTree(t, files)), tt.opts, testConfig())
			switch {
			case tt.wantSub != "":
				if len(res.Errors) != 1 || res.Errors[0].Phase != api.BuildPhaseStatic || !strings.Contains(res.Errors[0].Message, tt.wantSub) {
					t.Fatalf("errors %+v, want one containing %q", res.Errors, tt.wantSub)
				}
			case !slices.Equal(res.Errors, tt.wantErr):
				t.Fatalf("errors:\n got  %+v\n want %+v", res.Errors, tt.wantErr)
			}
			if res.Manifest != nil {
				t.Fatal("a script check never returns a task manifest")
			}
			if res.OK() && res.Script == nil {
				t.Fatal("a passing check must return the normalised script manifest")
			}
		})
	}
}

// A script manifest error names scantor-script.yaml; the task check of the same folder still wants
// scantor.yaml, so a folder can never pass both checks by accident.
func TestCheckStaticKeepsTaskAndScriptApart(t *testing.T) {
	res := CheckStatic(mustPackDir(t, writeTree(t, minimalScript())), StaticOptions{}, testConfig())
	if len(res.Errors) != 1 || res.Errors[0].Message != "scantor.yaml is missing: every task needs a manifest at its root" || res.Script != nil {
		t.Fatalf("task check of a script folder: %+v", res.Errors)
	}
	res = CheckScriptStatic(mustPackDir(t, writeTree(t, minimalScript())), ScriptStaticOptions{}, testConfig())
	if !res.OK() || res.Script.Manifest.Entry != "main.py" || res.Script.Language.Name != "python" || len(res.Warnings) != 0 {
		t.Fatalf("script check: %+v", res)
	}
}
