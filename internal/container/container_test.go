package container

import (
	"archive/tar"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

// The label set is read from schemas/managed-labels.json; these expectations restate
// docs/architecture.md §7 so a drift in either is caught.
func TestManagedLabelsEveryKind(t *testing.T) {
	set, err := Labels()
	if err != nil {
		t.Fatal(err)
	}
	if got := set.KindNames(); !slices.Equal(got, []string{"build", "editor", "egressHelper", "helper", "network", "testRun", "worker"}) {
		t.Fatalf("kinds = %v", got)
	}
	full := Identity{Worker: "w", Scan: "s", User: "u", Node: "n", SpecHash: "sha256:x", Op: "commit"}
	fixed := map[string]string{
		"traefik.enable": "false", "com.docker.compose.project": "scantor-managed",
		"com.docker.compose.service": "", "scantor.managed": "true",
	}
	cases := map[Kind]Identity{
		KindWorker:       {Worker: "w", Scan: "s", User: "u", Node: "n", SpecHash: "sha256:x"},
		KindHelper:       {User: "u", Op: "commit"},
		KindBuild:        {},
		KindTestRun:      {User: "u"},
		KindEditor:       {User: "u"},
		KindEgressHelper: {Node: "n"},
		KindNetwork:      {},
	}
	for kind, id := range cases {
		labels, err := ManagedLabels(kind, id)
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		for k, v := range fixed {
			if got, ok := labels[k]; !ok || got != v {
				t.Errorf("%s: %s = %q, want %q", kind, k, got, v)
			}
		}
		if labels[LabelKind] != string(kind) {
			t.Errorf("%s: scantor.kind = %q", kind, labels[LabelKind])
		}
		if len(labels) != len(fixed)+1+len(set.IdentityKeysOf(kind)) {
			t.Errorf("%s: unexpected labels %v", kind, labels)
		}
		if _, err := ManagedLabels(kind, full); err == nil && kind != KindWorker {
			t.Errorf("%s: accepted identity labels of other kinds", kind)
		}
	}
	if _, err := ManagedLabels(KindWorker, Identity{Worker: "w"}); err == nil {
		t.Error("worker labels without scan, user, node and spec hash accepted")
	}
	if _, err := ManagedLabels("pod", Identity{}); err == nil {
		t.Error("unknown kind accepted")
	}
}

func TestIsManaged(t *testing.T) {
	labels, _ := ManagedLabels(KindWorker, Identity{Worker: "w1", Scan: "s", User: "u", Node: "n", SpecHash: "h"})
	if !IsManaged(KindWorker, "/scantor-w-w1", labels) {
		t.Fatal("managed worker not recognised")
	}
	// Labels copied into a foreign container (for example through image labels) are not enough.
	if IsManaged(KindWorker, "/my-container", labels) || IsManaged(KindWorker, "scantor-w-", labels) {
		t.Fatal("foreign name recognised")
	}
	if IsManaged(KindHelper, "scantor-w-w1", labels) {
		t.Fatal("wrong kind recognised")
	}
	tampered := map[string]string{}
	for k, v := range labels {
		tampered[k] = v
	}
	tampered["com.docker.compose.project"] = "scantor"
	if IsManaged(KindWorker, "scantor-w-w1", tampered) {
		t.Fatal("tampered fixed label recognised")
	}
	netLabels, _ := ManagedLabels(KindNetwork, Identity{})
	if !IsManaged(KindNetwork, "scantor-workers", netLabels) || IsManaged(KindNetwork, "other", netLabels) {
		t.Fatal("network recognition")
	}
	if Name(KindWorker, "abc") != "scantor-w-abc" || Name(KindEditor, "u") != "scantor-editor-u" || Name(KindEgressHelper, "n") != "scantor-netpol-n" {
		t.Fatal("names")
	}
}

func TestForbiddenImageLabel(t *testing.T) {
	for key, want := range map[string]bool{
		"traefik.http.routers.x.rule": true, "Traefik.enable": true, "com.docker.compose.project": true,
		"scantor.managed": true, "SCANTOR.kind": true, "label.with.$VAR": true,
		"org.opencontainers.image.source": false, "maintainer": false, "traefik": false,
	} {
		if got := ForbiddenImageLabel(key); got != want {
			t.Errorf("ForbiddenImageLabel(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestHardeningProfile(t *testing.T) {
	mem, cpus := WorkerResources(2, api.Resources{CPUs: 1, MemoryMiB: 512})
	if mem != 1342177280 || cpus != 2000000000 {
		t.Fatalf("WorkerResources = %d, %d", mem, cpus)
	}
	p := Profile{
		CapAdd: []string{"NET_BIND_SERVICE", "NET_RAW"}, PidsLimit: 4096, MemoryBytes: mem, NanoCPUs: cpus,
		ShmSizeBytes: 256 << 20, Nofile: 65536, LogMaxSizeBytes: 20 << 20, LogMaxFiles: 3, NetworkMode: "scantor-workers",
	}
	hc, err := p.HostConfig()
	if err != nil {
		t.Fatal(err)
	}
	// Compare with the Engine API body of docs/nodes.md §6.3.
	b, _ := json.Marshal(hc)
	var got map[string]any
	_ = json.Unmarshal(b, &got)
	want := map[string]any{
		"Init": true, "NetworkMode": "scantor-workers", "CapDrop": []any{"ALL"}, "CapAdd": []any{"NET_BIND_SERVICE", "NET_RAW"},
		"SecurityOpt": []any{"no-new-privileges:true"}, "Privileged": false, "ReadonlyRootfs": false,
		"PidsLimit": float64(4096), "Memory": float64(1342177280), "MemorySwap": float64(1342177280),
		"NanoCpus": float64(2000000000), "ShmSize": float64(268435456),
	}
	for k, v := range want {
		if !jsonEqual(got[k], v) {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	if rp := got["RestartPolicy"].(map[string]any)["Name"]; rp != "no" {
		t.Errorf("RestartPolicy = %v", rp)
	}
	lc := got["LogConfig"].(map[string]any)
	if lc["Type"] != "local" || !jsonEqual(lc["Config"], map[string]any{"max-size": "20m", "max-file": "3"}) {
		t.Errorf("LogConfig = %v", lc)
	}
	if !jsonEqual(got["Ulimits"], []any{map[string]any{"Name": "nofile", "Soft": float64(65536), "Hard": float64(65536)}}) {
		t.Errorf("Ulimits = %v", got["Ulimits"])
	}
	if got["Mounts"] != nil || got["Binds"] != nil {
		t.Errorf("mounts present: %v %v", got["Mounts"], got["Binds"])
	}

	bad := p
	bad.CapAdd = []string{"SYS_ADMIN"}
	if _, err := bad.HostConfig(); err == nil {
		t.Error("capability outside the allowlist accepted")
	}
	missing := p
	missing.PidsLimit = 0
	if _, err := missing.HostConfig(); err == nil {
		t.Error("profile without PIDs limit accepted")
	}

	sysbox := p
	sysbox.DinD = DinDSysbox
	hc, _ = sysbox.HostConfig()
	if hc.Runtime != SysboxRuntime || hc.Privileged || len(hc.CapDrop) != 0 || len(hc.CapAdd) != 0 || len(hc.SecurityOpt) != 0 || len(hc.Mounts) != 1 || hc.Mounts[0].Target != "/var/lib/docker" {
		t.Errorf("sysbox = %+v", hc)
	}
	priv := p
	priv.DinD = DinDPrivileged
	hc, _ = priv.HostConfig()
	if !hc.Privileged || hc.Runtime != "" || len(hc.SecurityOpt) != 0 || len(hc.Mounts) != 1 {
		t.Errorf("privileged = %+v", hc)
	}

	bp := BuildProfile(api.Resources{CPUs: 0.5, MemoryMiB: 512})
	if bp.PidsLimit != 256 || bp.NetworkMode != NetworkNone || len(bp.CapAdd) != 0 || bp.MemoryBytes != 1<<30 || bp.NanoCPUs != 1e9 || bp.DinD != DinDNone {
		t.Errorf("build profile = %+v", bp)
	}
	bp = BuildProfile(api.Resources{CPUs: 2, MemoryMiB: 2048})
	if bp.MemoryBytes != 2048<<20+256<<20 || bp.NanoCPUs != 2e9 {
		t.Errorf("build profile resources = %+v", bp)
	}
	tp := TestRunProfile(api.Resources{CPUs: 1, MemoryMiB: 512}, "scantor-egress", nil)
	if tp.PidsLimit != 4096 || tp.MemoryBytes != 768<<20 || tp.NetworkMode != "scantor-egress" {
		t.Errorf("test-run profile = %+v", tp)
	}
}

func jsonEqual(a, b any) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return bytes.Equal(x, y)
}

func TestInjectionArchive(t *testing.T) {
	var buf bytes.Buffer
	spec := []byte(`{"v":1}`)
	if err := InjectionArchive(&buf, NewBinary([]byte("ELF")), LocalModeFiles(spec, map[string][]byte{"u2": []byte("b"), "u1": []byte("a")})); err != nil {
		t.Fatal(err)
	}
	type entry struct {
		mode     int64
		typeflag byte
		data     string
	}
	got := map[string]entry{}
	var order []string
	tr := tar.NewReader(&buf)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if hdr.Uid != 0 || hdr.Gid != 0 {
			t.Errorf("%s owned by %d:%d", hdr.Name, hdr.Uid, hdr.Gid)
		}
		data, _ := io.ReadAll(tr)
		got[hdr.Name] = entry{hdr.Mode, hdr.Typeflag, string(data)}
		order = append(order, hdr.Name)
	}
	want := map[string]entry{
		"scantor/":              {0o755, tar.TypeDir, ""},
		"scantor/scantor":       {0o755, tar.TypeReg, "ELF"},
		"scantor/in/":           {0o755, tar.TypeDir, ""},
		"scantor/in/spec.json":  {0o644, tar.TypeReg, `{"v":1}`},
		"scantor/in/uploads/":   {0o755, tar.TypeDir, ""},
		"scantor/in/uploads/u1": {0o644, tar.TypeReg, "a"},
		"scantor/in/uploads/u2": {0o644, tar.TypeReg, "b"},
		"scantor/out/":          {0o1777, tar.TypeDir, ""},
	}
	if len(got) != len(want) {
		t.Fatalf("entries = %v", order)
	}
	for name, w := range want {
		if got[name] != w {
			t.Errorf("%s = %+v, want %+v", name, got[name], w)
		}
	}
	if order[0] != "scantor/" || order[1] != "scantor/in/" {
		t.Errorf("directories must precede their contents: %v", order)
	}

	for _, bad := range []File{{Path: "etc/passwd"}, {Path: "scantor/../etc"}, {Path: "/scantor/x"}} {
		if err := InjectionArchive(io.Discard, NewBinary([]byte("x")), []File{bad}); err == nil {
			t.Errorf("accepted path %q", bad.Path)
		}
	}
	if err := InjectionArchive(io.Discard, nil, nil); err == nil {
		t.Error("accepted a missing binary")
	}
}

func TestRuntimeContainerCreateOptions(t *testing.T) {
	labels, _ := ManagedLabels(KindBuild, Identity{})
	rc := RuntimeContainer{
		Name: "scantor-b-1", Image: "sha256:abc", Mode: ModeDescribe, Args: []string{"--entry", "main.py"},
		Labels: labels, Profile: BuildProfile(api.Resources{CPUs: 1, MemoryMiB: 512}),
	}
	opts, err := rc.CreateOptions()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(opts.Config.Entrypoint, " ") != "/scantor/scantor runtime describe --entry main.py" || opts.Config.Cmd == nil || len(opts.Config.Cmd) != 0 {
		t.Fatalf("entrypoint/cmd = %v / %#v", opts.Config.Entrypoint, opts.Config.Cmd)
	}
	if opts.Config.User != "" || opts.Config.WorkingDir != "" || opts.NetworkingConfig != nil || opts.HostConfig.NetworkMode != "none" {
		t.Fatalf("options = %+v", opts)
	}
	rc.Profile = TestRunProfile(api.Resources{CPUs: 1, MemoryMiB: 512}, "scantor-egress", nil)
	opts, _ = rc.CreateOptions()
	if _, ok := opts.NetworkingConfig.EndpointsConfig["scantor-egress"]; !ok {
		t.Fatalf("network endpoints = %+v", opts.NetworkingConfig)
	}
	rc.Labels = map[string]string{"foo": "bar"}
	if _, err := rc.CreateOptions(); err == nil {
		t.Fatal("container without managed labels accepted")
	}
}

func TestRegistryAuthPadding(t *testing.T) {
	// Lengths chosen so that the JSON is not a multiple of 3 bytes: padding must be present.
	for _, pw := range []string{"snt_a", "snt_ab", "snt_abc"} {
		enc, err := RegistryAuth("node", pw, "registry.example.com")
		if err != nil {
			t.Fatal(err)
		}
		raw, err := base64.URLEncoding.DecodeString(enc) // strict: requires padding
		if err != nil {
			t.Fatalf("not padded base64url: %q: %v", enc, err)
		}
		var cfg map[string]string
		if err := json.Unmarshal(raw, &cfg); err != nil || cfg["username"] != "node" || cfg["password"] != pw || cfg["serveraddress"] != "registry.example.com" {
			t.Fatalf("auth config = %s", raw)
		}
		if strings.ContainsAny(enc, "+/") {
			t.Fatalf("not URL-safe: %q", enc)
		}
	}
}

func TestFirstRegularFile(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	_ = tw.WriteHeader(&tar.Header{Name: "dir/", Typeflag: tar.TypeDir, Mode: 0o755})
	_ = tw.WriteHeader(&tar.Header{Name: "scantor", Typeflag: tar.TypeReg, Mode: 0o755, Size: 4})
	_, _ = tw.Write([]byte("ELF!"))
	_ = tw.Close()
	var out bytes.Buffer
	if err := firstRegularFile(&buf, &out); err != nil || out.String() != "ELF!" {
		t.Fatalf("firstRegularFile = %q, %v", out.String(), err)
	}
	var empty bytes.Buffer
	_ = tar.NewWriter(&empty).Close()
	if err := firstRegularFile(&empty, io.Discard); err == nil {
		t.Fatal("empty archive accepted")
	}
}

func TestLoadBinary(t *testing.T) {
	path := t.TempDir() + "/bin"
	if _, err := LoadBinary(path); err == nil {
		t.Fatal("missing file accepted")
	}
	_ = os.WriteFile(path, []byte("x"), 0o755)
	if b, err := LoadBinary(path); err != nil || b.Size() != 1 {
		t.Fatalf("LoadBinary = %v, %v", b, err)
	}
}
