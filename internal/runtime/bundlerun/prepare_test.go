package bundlerun

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/templates"
)

// prepareOptions are the options of a run prepared in a fresh work directory on a "mount".
func prepareOptions(t *testing.T, schedule api.Schedule, flags Flags) Options {
	t.Helper()
	return Options{
		Info: testInfo(t, schedule), Flags: flags, WorkDir: t.TempDir(), Stdin: strings.NewReader(""),
		Now: func() time.Time { return testNow }, RootDevice: mounted, MountPoints: noMountPoints,
	}.withDefaults()
}

func issueText(issues []api.Issue) string {
	var parts []string
	for _, is := range issues {
		parts = append(parts, is.Path+": "+is.Message)
	}
	return strings.Join(parts, "\n")
}

func TestPrepareDefaults(t *testing.T) {
	o := prepareOptions(t, rangeSchedule, Flags{})
	p, issues := o.prepare()
	if len(issues) > 0 {
		t.Fatal(issueText(issues))
	}
	if compact(t, p.taskConfig) != `{"greeting":"Hello","token":null}` || compact(t, p.scanConfig) != `{"end":10,"start":0,"step":1}` || p.analysisConfig != nil {
		t.Fatalf("configs %s %s %s", p.taskConfig, p.scanConfig, p.analysisConfig)
	}
	if p.settings != o.Info.Settings || p.custom {
		t.Fatalf("settings %+v custom %v", p.settings, p.custom)
	}
	if p.outDir != filepath.Join(o.WorkDir, ResultsDir, testStamp) || p.owner != nil && os.Geteuid() != 0 {
		t.Fatalf("out dir %s owner %+v", p.outDir, p.owner)
	}
	spec := o.spec(p)
	if spec.RunID != RunID || spec.Entry != "main.py" || spec.Limit != 0 || spec.Processes != 1 || spec.OutDir != p.outDir ||
		spec.DataSources.Tranco != templates.DefaultTrancoURL || spec.DataSources.Crux != templates.DefaultCruxURL ||
		spec.DataSources.CruxCache != templates.DefaultCruxCacheURL || spec.Limits.LogTailBytes != 32768 || len(spec.Resolved) != 0 {
		t.Fatalf("spec %+v", spec)
	}
	o.Config.DataSources = api.DataSources{Tranco: "https://mirror.example.org"}
	if ds := o.spec(p).DataSources; ds.Tranco != "https://mirror.example.org" || ds.Crux != templates.DefaultCruxURL {
		t.Fatalf("data sources %+v", ds)
	}
}

func TestPrepareConfigValues(t *testing.T) {
	o := prepareOptions(t, rangeSchedule, Flags{TaskConfig: "@task.json", ScanConfig: "-", Limit: 4, TotalTimeout: 90 * time.Second})
	if err := os.WriteFile(filepath.Join(o.WorkDir, "task.json"), []byte(`{"greeting":"Hi"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	o.Stdin = strings.NewReader(`{"end":4}`)
	p, issues := o.prepare()
	if len(issues) > 0 {
		t.Fatal(issueText(issues))
	}
	if compact(t, p.taskConfig) != `{"greeting":"Hi","token":null}` || compact(t, p.scanConfig) != `{"end":4,"start":0,"step":1}` {
		t.Fatalf("configs %s %s", p.taskConfig, p.scanConfig)
	}
	if spec := o.spec(p); spec.Limit != 4 || spec.TotalTimeoutMs != 90000 {
		t.Fatalf("spec %+v", spec)
	}
}

// An analysis config skips the schedule: the scan config is {} unless given.
func TestPrepareAnalysisConfig(t *testing.T) {
	o := prepareOptions(t, customSchedule, Flags{AnalysisConfig: `{"x":1}`})
	p, issues := o.prepare()
	if len(issues) > 0 {
		t.Fatal(issueText(issues))
	}
	if compact(t, p.analysisConfig) != `{"name":"world","x":1}` || string(p.scanConfig) != `{}` || p.custom {
		t.Fatalf("analysis %s scan %s custom %v", p.analysisConfig, p.scanConfig, p.custom)
	}
	if !o.spec(p).HasAnalysisConfig() {
		t.Fatal("the spec has no analysis config")
	}
	o = prepareOptions(t, customSchedule, Flags{})
	if p, _ := o.prepare(); !p.custom {
		t.Fatal("a custom schedule is not custom")
	}
}

func TestPrepareIssues(t *testing.T) {
	cases := []struct {
		name     string
		schedule api.Schedule
		flags    Flags
		want     []string
	}{
		{"invalid JSON", rangeSchedule, Flags{TaskConfig: `{"greeting":`}, []string{"--task-config: is not valid JSON"}},
		{"not an object", rangeSchedule, Flags{ScanConfig: `[1]`}, []string{"--scan-config: must be a JSON object"}},
		{"missing file", rangeSchedule, Flags{TaskConfig: `@nope.json`}, []string{"--task-config: cannot read nope.json"}},
		{"two stdin values", rangeSchedule, Flags{TaskConfig: "-", ScanConfig: "-"}, []string{"stdin: can be the value of one flag only (-)"}},
		{"schema", rangeSchedule, Flags{TaskConfig: `{"greeting":5,"other":1}`}, []string{"/taskConfig/greeting: ", "/taskConfig/other: is not allowed (unknown property)"}},
		{"masked secret", rangeSchedule, Flags{TaskConfig: `{"token":"***"}`}, []string{`/taskConfig/token: is the mask "***" of a secret`}},
		{"template validation", rangeSchedule, Flags{ScanConfig: `{"step":0}`}, []string{"/scanConfig"}},
		{"negative flags", rangeSchedule, Flags{Limit: -1, TotalTimeout: -time.Second, Processes: -2}, []string{"--limit: must not be negative", "--total-timeout: must not be negative", "--processes: must be at least 1"}},
		{"log tails", rangeSchedule, Flags{LogTails: "some"}, []string{"--log-tails: must be failed, all or none"}},
		{"settings", rangeSchedule, Flags{Settings: `{"resources":{"cpus":2}}`}, []string{"settings.resources: is not a setting of a bundle run: set the container's limits with docker run --cpus and --memory"}},
		{"analysis config", singleSchedule, Flags{AnalysisConfig: `{"name":3}`}, []string{"/analysisConfig/name: "}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			o := prepareOptions(t, tc.schedule, tc.flags)
			_, issues := o.prepare()
			text := issueText(issues)
			for _, want := range tc.want {
				if !strings.Contains(text, want) {
					t.Errorf("issues lack %q:\n%s", want, text)
				}
			}
		})
	}
}

func TestPrepareUploads(t *testing.T) {
	o := prepareOptions(t, api.Schedule{Kind: api.ScheduleKindTemplate, Template: "list"}, Flags{ScanConfig: `{"upload":"t.txt"}`})
	file := filepath.Join(o.WorkDir, "t.txt")
	if err := os.WriteFile(file, []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p, issues := o.prepare()
	if len(issues) > 0 {
		t.Fatal(issueText(issues))
	}
	const sum = "73cb3858a687a8494ca3323053016282f3dad39d42cf62ca4e79dda2aac7d9ac" // sha256("x\n")
	id := uuid.NewSHA1(UploadNamespace, []byte(sum)).String()
	if len(p.uploads) != 1 || p.uploads[0] != (Upload{Pointer: "/scanConfig/upload", Path: file, SHA256: sum, ID: id}) {
		t.Fatalf("uploads %+v", p.uploads)
	}
	var scan map[string]any
	if err := json.Unmarshal(p.scanConfig, &scan); err != nil || scan["upload"] != id {
		t.Fatalf("scan config %s", p.scanConfig)
	}
	if u := o.spec(p).Uploads[id]; u.Path != file || u.SHA256 != sum {
		t.Fatalf("spec uploads %+v", o.spec(p).Uploads)
	}

	for flags, want := range map[string]string{
		`{"upload":"4E3D2C1B-0A9F-4E8D-8C7B-6A5F4E3D2C1B"}`: "/scanConfig/upload: is a platform upload id",
		`{"upload":"missing.txt"}`:                          "/scanConfig/upload: cannot read the file missing.txt",
		`{"upload":"."}`:                                    "/scanConfig/upload: cannot read the file .: not a regular file",
	} {
		o := prepareOptions(t, api.Schedule{Kind: api.ScheduleKindTemplate, Template: "list"}, Flags{ScanConfig: flags})
		if _, issues := o.prepare(); !strings.Contains(issueText(issues), want) {
			t.Errorf("%s: issues %s", flags, issueText(issues))
		}
	}

	// A default at an upload field names a platform upload.
	o = prepareOptions(t, customSchedule, Flags{})
	o.Info.Description.Schemas.ScanConfig = json.RawMessage(`{"type":"object","properties":{"upload":{"type":"string","default":"4e3d2c1b-0a9f-4e8d-8c7b-6a5f4e3d2c1b"}}}`)
	if _, issues := o.prepare(); !strings.Contains(issueText(issues), "/scanConfig/upload: references a platform upload") {
		t.Fatalf("issues %s", issueText(issues))
	}
}

func TestDescribeNeedsNoMount(t *testing.T) {
	o := prepareOptions(t, rangeSchedule, Flags{Describe: true})
	o.RootDevice = func() (uint64, error) { return 0, os.ErrNotExist }
	p, issues := o.prepare()
	if len(issues) > 0 || p.outDir != "" {
		t.Fatalf("describe checked the run directory: %s %q", issueText(issues), p.outDir)
	}
}
