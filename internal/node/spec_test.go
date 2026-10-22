package node

import (
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"testing"

	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// specExample is the Engine API body of docs/nodes.md §6.3 (remote node, non-DinD, 2 processes of 1 CPU
// and 512 MiB), with the abbreviated digest written out.
const specExample = `{
  "Image": "registry.example.com/tasks/7f3b2c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c@sha256:4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091",
  "Entrypoint": ["/scantor/scantor", "runtime", "worker"],
  "Cmd": [],
  "Env": [
    "SCANTOR_URL=https://scantor.example.com",
    "SCANTOR_WORKER_TOKEN=swt_9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yJk2Xh0n4mQ8sV1bR7cT3wZ5aP9dL6fG2hK8jN0uE4o"
  ],
  "Labels": {
    "traefik.enable": "false",
    "com.docker.compose.project": "scantor-managed",
    "com.docker.compose.service": "",
    "scantor.managed": "true",
    "scantor.kind": "worker",
    "scantor.worker": "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
    "scantor.scan": "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f",
    "scantor.user": "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11",
    "scantor.node": "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
    "scantor.spec-hash": "sha256:5d41402abc4b2a76b9719d911017c592"
  },
  "StopSignal": "SIGTERM",
  "StopTimeout": 35,
  "HostConfig": {
    "Init": true,
    "RestartPolicy": { "Name": "no" },
    "NetworkMode": "scantor-workers",
    "CapDrop": ["ALL"],
    "CapAdd": ["NET_BIND_SERVICE", "NET_RAW"],
    "SecurityOpt": ["no-new-privileges:true"],
    "Privileged": false,
    "ReadonlyRootfs": false,
    "PidsLimit": 4096,
    "Memory": 1342177280,
    "MemorySwap": 1342177280,
    "NanoCpus": 2000000000,
    "ShmSize": 268435456,
    "Ulimits": [ { "Name": "nofile", "Soft": 65536, "Hard": 65536 } ],
    "LogConfig": { "Type": "local", "Config": { "max-size": "20m", "max-file": "3" } }
  },
  "NetworkingConfig": { "EndpointsConfig": { "scantor-workers": {} } }
}`

const testNodeID = "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"

func testSettings() workerSettings {
	return workerSettings{
		nodeID: testNodeID, network: container.NetworkWorkers, drainGraceMs: 30000,
		pidsLimit: 4096, shmSize: 256 << 20, nofile: 65536, logMaxSize: 20 << 20, logMaxFiles: 3,
	}
}

// createBody renders ContainerCreate options the way the Engine API receives them: the container
// config with HostConfig and NetworkingConfig next to it.
func createBody(t *testing.T, opts client.ContainerCreateOptions) map[string]any {
	t.Helper()
	data, err := json.Marshal(opts.Config)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	for key, v := range map[string]any{"HostConfig": opts.HostConfig, "NetworkingConfig": opts.NetworkingConfig} {
		data, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var m any
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatal(err)
		}
		body[key] = m
	}
	return body
}

// containsJSON checks that got holds every value of want (objects may carry more keys; arrays and
// scalars must be equal).
func containsJSON(t *testing.T, path string, want, got any) {
	t.Helper()
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			t.Errorf("%s = %v, want an object", path, got)
			return
		}
		for k, v := range w {
			containsJSON(t, path+"."+k, v, g[k])
		}
	case []any:
		g, ok := got.([]any)
		if !ok && len(w) == 0 && got == nil {
			return
		}
		if !ok || len(g) != len(w) {
			t.Errorf("%s = %v, want %v", path, got, want)
			return
		}
		for i := range w {
			containsJSON(t, fmt.Sprintf("%s[%d]", path, i), w[i], g[i])
		}
	default:
		omittedFalse := want == false && got == nil
		if !omittedFalse && !reflect.DeepEqual(want, got) {
			t.Errorf("%s = %v, want %v", path, got, want)
		}
	}
}

func TestWorkerSpecMatchesTheDocumentedBody(t *testing.T) {
	opts, err := workerCreateOptions(testAssignment(testWorker1), testSettings())
	if err != nil {
		t.Fatal(err)
	}
	if opts.Name != "scantor-w-"+testWorker1 {
		t.Errorf("name = %q", opts.Name)
	}
	var want map[string]any
	if err := json.Unmarshal([]byte(specExample), &want); err != nil {
		t.Fatal(err)
	}
	got := createBody(t, opts)
	containsJSON(t, "body", want, got)

	// Exactly the documented labels and environment: nothing else is added.
	if labels := got["Labels"].(map[string]any); len(labels) != len(want["Labels"].(map[string]any)) {
		t.Errorf("labels = %v", labels)
	}
	if env := got["Env"].([]any); len(env) != 2 {
		t.Errorf("env = %v", env)
	}
	// No tmpfs at /tmp, no mounts, no published ports, no user override (the image user applies).
	hc := opts.HostConfig
	if len(hc.Tmpfs) != 0 || len(hc.Mounts) != 0 || len(hc.Binds) != 0 || len(hc.PortBindings) != 0 || hc.Runtime != "" || hc.Privileged {
		t.Errorf("host config adds mounts, ports, a runtime or privileges: %+v", hc)
	}
	if opts.Config.User != "" || opts.Config.WorkingDir != "" {
		t.Errorf("user %q / workdir %q must come from the image", opts.Config.User, opts.Config.WorkingDir)
	}
}

func TestWorkerSpecPassesTransportSettingsOn(t *testing.T) {
	ws := testSettings()
	ws.caCert = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"
	ws.allowInsecure = true
	opts, err := workerCreateOptions(testAssignment(testWorker1), ws)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"SCANTOR_URL=https://scantor.example.com",
		"SCANTOR_WORKER_TOKEN=swt_" + testWorker1 + ".yJk2Xh0n4mQ8sV1bR7cT3wZ5aP9dL6fG2hK8jN0uE4o",
		"SCANTOR_CA_CERT=" + ws.caCert,
		"SCANTOR_ALLOW_INSECURE_TRANSPORT=true",
	}
	if !slices.Equal(opts.Config.Env, want) {
		t.Errorf("env = %q", opts.Config.Env)
	}
}

func TestWorkerSpecBuiltInNodeUsesTheSandbox(t *testing.T) {
	ws := testSettings()
	ws.network = container.NetworkSandbox
	opts, err := workerCreateOptions(testAssignment(testWorker1), ws)
	if err != nil {
		t.Fatal(err)
	}
	eps := opts.NetworkingConfig.EndpointsConfig
	if string(opts.HostConfig.NetworkMode) != container.NetworkSandbox || len(eps) != 1 || eps[container.NetworkSandbox] == nil {
		t.Errorf("network = %s %v", opts.HostConfig.NetworkMode, eps)
	}
}

// PRIV-2: the container spec per DinD mode (docs/nodes.md §6.9).
func TestWorkerSpecDinDModes(t *testing.T) {
	for _, mode := range []string{DinDSysbox, DinDPrivileged} {
		t.Run(mode, func(t *testing.T) {
			a := testAssignment(testWorker1)
			a.Privileged, a.DinDMode = true, strPtr(mode)
			opts, err := workerCreateOptions(a, testSettings())
			if err != nil {
				t.Fatal(err)
			}
			hc := opts.HostConfig
			if len(hc.CapDrop) != 0 || len(hc.CapAdd) != 0 || len(hc.SecurityOpt) != 0 {
				t.Errorf("DinD workers keep the default capabilities and no no-new-privileges: %v %v %v", hc.CapDrop, hc.CapAdd, hc.SecurityOpt)
			}
			wantMounts := []mount.Mount{{Type: mount.TypeVolume, Target: "/var/lib/docker"}}
			if !reflect.DeepEqual(hc.Mounts, wantMounts) {
				t.Errorf("mounts = %+v, want one anonymous /var/lib/docker volume", hc.Mounts)
			}
			switch mode {
			case DinDSysbox:
				if hc.Runtime != container.SysboxRuntime || hc.Privileged {
					t.Errorf("sysbox: runtime %q privileged %v", hc.Runtime, hc.Privileged)
				}
			case DinDPrivileged:
				if hc.Runtime != "" || !hc.Privileged {
					t.Errorf("privileged: runtime %q privileged %v", hc.Runtime, hc.Privileged)
				}
			}
			if !slices.Contains(opts.Config.Env, "SCANTOR_DIND=1") {
				t.Errorf("env = %q, want SCANTOR_DIND=1", opts.Config.Env)
			}
			// Everything else of the hardening profile stays.
			if hc.Init == nil || !*hc.Init || hc.PidsLimit == nil || *hc.PidsLimit != 4096 || hc.LogConfig.Type != "local" || hc.Memory != a.Resources.MemoryBytes {
				t.Errorf("profile = %+v", hc)
			}
		})
	}
	opts, err := workerCreateOptions(testAssignment(testWorker1), testSettings())
	if err != nil {
		t.Fatal(err)
	}
	if slices.Contains(opts.Config.Env, "SCANTOR_DIND=1") {
		t.Error("only DinD workers get SCANTOR_DIND=1")
	}
}

func TestEffectiveDinD(t *testing.T) {
	cases := []struct {
		configured string
		runtimes   []string
		want       string
		err        bool
	}{
		{DinDDisabled, nil, DinDDisabled, false},
		{DinDSysbox, []string{"runc", "sysbox-runc"}, DinDSysbox, false},
		{DinDSysbox, []string{"runc"}, DinDDisabled, true},
		{DinDPrivileged, []string{"runc"}, DinDPrivileged, false},
	}
	for _, tc := range cases {
		got, err := effectiveDinD(tc.configured, tc.runtimes)
		if got != tc.want || (err != nil) != tc.err {
			t.Errorf("effectiveDinD(%s, %v) = %s, %v", tc.configured, tc.runtimes, got, err)
		}
	}
}

func TestStopTimeoutAndLimits(t *testing.T) {
	if got := stopTimeoutSeconds(30000); got != 35 {
		t.Errorf("stop timeout = %d, want drainGraceMs/1000 + 5", got)
	}
	if got := limitsOf(testAssignment(testWorker1)); got != (api.AppliedLimits{Processes: 2, NanoCPUs: 2e9, MemoryBytes: 1342177280}) {
		t.Errorf("limits = %+v", got)
	}
}
