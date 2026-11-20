package bundlerun

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/bundle"
	"github.com/lonetis/scantor/internal/runtime/local"
)

func TestDescribeJSON(t *testing.T) {
	tr := newTestRun(t, customSchedule, Flags{Describe: true, TaskConfig: `{"token":"s3cret"}`, Settings: `{"processes":3}`})
	tr.opts.JSON = true
	if code := tr.run(t); code != local.ExitOK {
		t.Fatalf("exit %d: %s", code, tr.stdout)
	}
	var d Description
	if err := json.Unmarshal([]byte(tr.stdout.String()), &d); err != nil {
		t.Fatalf("%v\n%s", err, tr.stdout)
	}
	if d.Bundle.Ref != "echo@3" || d.Bundle.Image != "localhost/scantor/echo:3" || d.Bundle.Platform.Arch != "amd64" || d.Bundle.Schedule.Kind != api.ScheduleKindCustom {
		t.Fatalf("bundle %+v", d.Bundle)
	}
	if compact(t, d.TaskConfig) != `{"greeting":"Hello","token":"***"}` || compact(t, d.ScanConfig) != `{}` || string(d.AnalysisConfig) != "null" {
		t.Fatalf("configs %s %s %s", d.TaskConfig, d.ScanConfig, d.AnalysisConfig)
	}
	if d.Settings.Processes != 3 || len(d.Issues) != 0 || len(d.SecretPaths.TaskConfig) != 1 || d.UploadPaths.ScanConfig[0] != "/upload" || d.Schemas.TaskConfig == nil {
		t.Fatalf("description %+v", d)
	}
	// A custom schedule runs processes + 1 connector processes: 4 × 512 MiB + 256 MiB, 4 CPUs.
	if d.Recommended.CPUs != 4 || d.Recommended.MemoryBytes != (4*512+256)<<20 || !strings.HasSuffix(d.Recommended.DockerFlags, "--cpus 4 --memory 2304m") || !strings.HasPrefix(d.Recommended.DockerFlags, HardeningFlags) {
		t.Fatalf("recommended %+v", d.Recommended)
	}
	if strings.Contains(tr.stdout.String(), "s3cret") {
		t.Fatal("the secret was printed")
	}
	if entries, _ := os.ReadDir(tr.opts.WorkDir); len(entries) != 0 {
		t.Fatalf("describe wrote %v", entries)
	}
}

func TestDescribeHumanWithIssues(t *testing.T) {
	tr := newTestRun(t, rangeSchedule, Flags{Describe: true, TaskConfig: `{"greeting":1}`, AnalysisConfig: `{"secret":"x"}`})
	// --describe needs no mount: the run directory is not checked.
	tr.opts.RootDevice = func() (uint64, error) { return 0, os.ErrNotExist }
	if code := tr.run(t); code != local.ExitValidation {
		t.Fatalf("exit %d", code)
	}
	out := tr.stdout.String()
	for _, want := range []string{
		"bundle:   echo@3 (localhost/scantor/echo:3)", "platform: linux/amd64", "schedule: template range",
		"analysis config (effective):", `"secret": "***"`, "settings: processes 1, timeoutMs 300000, maxAttempts 3",
		"secret paths (shown as ***): task config /token", "upload paths (give the path of a file in the mounted folder): task config none; scan config /upload",
		"recommended: 1 cpus, 768 MiB memory per container", HardeningFlags + " --cpus 1 --memory 768m localhost/scantor/echo:3",
		"issues:", "/taskConfig/greeting: ",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("describe lacks %q:\n%s", want, out)
		}
	}
}

func TestRecommended(t *testing.T) {
	s := bundle.Settings{Processes: 2, Resources: api.Resources{CPUs: 0.5, MemoryMiB: 256}}
	if r := recommended(s, false); r.CPUs != 1 || r.MemoryBytes != 768<<20 || !strings.HasSuffix(r.DockerFlags, "--cpus 1 --memory 768m") {
		t.Fatalf("template %+v", r)
	}
	if r := recommended(s, true); r.CPUs != 1.5 || r.MemoryBytes != 1024<<20 || !strings.HasSuffix(r.DockerFlags, "--cpus 1.5 --memory 1024m") {
		t.Fatalf("custom %+v", r)
	}
}
