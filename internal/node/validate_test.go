package node

import (
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

func testLimits() nodeLimits {
	return nodeLimits{registryHost: "registry.example.com", dindMode: DinDDisabled, cpus: 8, memoryBytes: 16 << 30}
}

func strPtr(s string) *string { return &s }

// Every check of docs/nodes.md §6.10 rejects the assignment with a message naming the field.
func TestValidateAssignment(t *testing.T) {
	sysbox := testLimits()
	sysbox.dindMode = DinDSysbox
	cases := []struct {
		name   string
		limits nodeLimits
		mutate func(*api.Assignment)
		field  string // empty: valid
	}{
		{"valid", testLimits(), func(*api.Assignment) {}, ""},
		{"valid base image", testLimits(), func(a *api.Assignment) {
			a.BaseImage = strPtr("ghcr.io/lonetis/scantor-base-js@sha256:" + strings.Repeat("0d", 32))
		}, ""},
		{"valid without capabilities", testLimits(), func(a *api.Assignment) { a.CapAdd = nil }, ""},
		{"valid DinD worker on a sysbox node", sysbox, func(a *api.Assignment) {
			a.Privileged, a.DinDMode = true, strPtr(DinDSysbox)
			a.CapAdd = []string{"SYS_ADMIN"} // ignored in DinD modes
		}, ""},
		{"worker id", testLimits(), func(a *api.Assignment) { a.WorkerID = "../etc" }, "workerId"},
		{"uppercase uuid", testLimits(), func(a *api.Assignment) { a.ScanID = strings.ToUpper(a.ScanID) }, "scanId"},
		{"user id", testLimits(), func(a *api.Assignment) { a.UserID = "" }, "userId"},
		{"foreign registry", testLimits(), func(a *api.Assignment) {
			a.Image = "evil.example.com/tasks/" + testTaskID + "@" + testDigest
		}, "image"},
		{"image by tag", testLimits(), func(a *api.Assignment) {
			a.Image = "registry.example.com/tasks/" + testTaskID + ":latest"
		}, "image"},
		{"image outside tasks/", testLimits(), func(a *api.Assignment) {
			a.Image = "registry.example.com/other/" + testTaskID + "@" + testDigest
		}, "image"},
		{"short digest", testLimits(), func(a *api.Assignment) {
			a.Image = "registry.example.com/tasks/" + testTaskID + "@sha256:abc"
		}, "image"},
		{"base image by tag", testLimits(), func(a *api.Assignment) { a.BaseImage = strPtr("ghcr.io/lonetis/scantor-base-js:1.4.0") }, "baseImage"},
		{"spec hash", testLimits(), func(a *api.Assignment) { a.SpecHash = "md5:abc" }, "specHash"},
		{"privileged without DinD mode", testLimits(), func(a *api.Assignment) { a.Privileged = true }, "privileged"},
		{"DinD mode without privileged", sysbox, func(a *api.Assignment) { a.DinDMode = strPtr(DinDSysbox) }, "privileged"},
		{"DinD on a disabled node", testLimits(), func(a *api.Assignment) {
			a.Privileged, a.DinDMode = true, strPtr(DinDPrivileged)
		}, "dindMode"},
		{"DinD mode of another node", sysbox, func(a *api.Assignment) {
			a.Privileged, a.DinDMode = true, strPtr(DinDPrivileged)
		}, "dindMode"},
		{"capability outside the allowlist", testLimits(), func(a *api.Assignment) { a.CapAdd = []string{"NET_RAW", "SYS_ADMIN"} }, "capAdd"},
		{"extra env", testLimits(), func(a *api.Assignment) { a.Env["LD_PRELOAD"] = "/tmp/x.so" }, "env"},
		{"missing URL", testLimits(), func(a *api.Assignment) { delete(a.Env, "SCANTOR_URL") }, "env"},
		{"token of another worker", testLimits(), func(a *api.Assignment) {
			a.Env["SCANTOR_WORKER_TOKEN"] = "swt_" + testWorker2 + ".mac"
		}, "env"},
		{"no CPUs", testLimits(), func(a *api.Assignment) { a.Resources.NanoCPUs = 0 }, "resources.nanoCpus"},
		{"more CPUs than the node", testLimits(), func(a *api.Assignment) { a.Resources.NanoCPUs = 9e9 }, "resources.nanoCpus"},
		{"less than the overhead", testLimits(), func(a *api.Assignment) { a.Resources.MemoryBytes = 255 << 20 }, "resources.memoryBytes"},
		{"more memory than the node", testLimits(), func(a *api.Assignment) { a.Resources.MemoryBytes = 17 << 30 }, "resources.memoryBytes"},
		{"no processes", testLimits(), func(a *api.Assignment) { a.Processes = 0 }, "processes"},
		{"too many processes", testLimits(), func(a *api.Assignment) { a.Processes = 1025 }, "processes"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := testAssignment(testWorker1)
			tc.mutate(&a)
			err := validateAssignment(a, tc.limits)
			switch {
			case tc.field == "" && err != nil:
				t.Errorf("valid assignment rejected: %v", err)
			case tc.field != "" && err == nil:
				t.Errorf("invalid assignment accepted (want an error naming %s)", tc.field)
			case tc.field != "" && !strings.HasPrefix(err.Error(), tc.field+":"):
				t.Errorf("error %q does not name %s", err, tc.field)
			}
		})
	}
}
