package bundlerun

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/lonetis/scantor/internal/runtime/local"
)

func TestOutDirNames(t *testing.T) {
	o := prepareOptions(t, rangeSchedule, Flags{})
	base := filepath.Join(o.WorkDir, ResultsDir, testStamp)
	if dir := o.outDir(); dir != base {
		t.Fatalf("default %s", dir)
	}
	o.Flags.Out = "runs/first"
	if dir := o.outDir(); dir != filepath.Join(o.WorkDir, "runs", "first") {
		t.Fatalf("relative --out %s", dir)
	}
	o.Flags.Out = "/data/out"
	if dir := o.outDir(); dir != "/data/out" {
		t.Fatalf("absolute --out %s", dir)
	}
	if got := o.displayPath(filepath.Join(o.WorkDir, "runs", "first")); got != filepath.Join("runs", "first") {
		t.Fatalf("display path %s", got)
	}
	if got := o.displayPath("/data/out"); got != "/data/out" {
		t.Fatalf("display path %s", got)
	}
}

// The default run directory is claimed with an exclusive mkdir: an existing name, directory or file, gets
// the next suffix.
func TestClaimOutDir(t *testing.T) {
	work := t.TempDir()
	base := filepath.Join(work, ResultsDir, testStamp)
	for _, want := range []string{base, base + "-2"} {
		if dir, err := claimOutDir(base, nil); err != nil || dir != want {
			t.Fatalf("claim %s %v, want %s", dir, err, want)
		}
	}
	if err := os.WriteFile(base+"-3", nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if dir, err := claimOutDir(base, nil); err != nil || dir != base+"-4" {
		t.Fatalf("claim after a file %s %v", dir, err)
	}
	if fi, err := os.Stat(base + "-4"); err != nil || !fi.IsDir() {
		t.Fatalf("claimed directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(work, "file"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := claimOutDir(filepath.Join(work, "file", testStamp), nil); err == nil {
		t.Fatal("claimed below a file")
	}
}

func TestCheckOutDir(t *testing.T) {
	o := prepareOptions(t, rangeSchedule, Flags{})
	dir := filepath.Join(o.WorkDir, "results", "x")
	if issues := o.checkOutDir(dir, true); len(issues) > 0 {
		t.Fatalf("missing directory on a mount: %s", issueText(issues))
	}
	// An existing empty directory is fine; a non-empty one or a file is not.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if issues := o.checkOutDir(dir, true); len(issues) > 0 {
		t.Fatalf("empty directory: %s", issueText(issues))
	}
	if err := os.WriteFile(filepath.Join(dir, "results.jsonl"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if issues := o.checkOutDir(dir, true); !strings.Contains(issueText(issues), "is not empty") {
		t.Fatalf("non-empty directory: %s", issueText(issues))
	}
	if issues := o.checkOutDir(filepath.Join(dir, "results.jsonl"), true); !strings.Contains(issueText(issues), "is not a directory") {
		t.Fatalf("file: %s", issueText(issues))
	}
	// The default run directory is claimed fresh when the run starts: only its mount is checked.
	if issues := o.checkOutDir(dir, false); len(issues) > 0 {
		t.Fatalf("default directory that exists: %s", issueText(issues))
	}

	// The nearest existing ancestor on the device of / and below no mount point means no mount.
	fi, err := os.Stat(o.WorkDir)
	if err != nil {
		t.Fatal(err)
	}
	dev, _ := device(fi)
	o.RootDevice = func() (uint64, error) { return dev, nil }
	deeper := filepath.Join(o.WorkDir, "results", "new", "deeper")
	issues := o.checkOutDir(deeper, true)
	if text := issueText(issues); !strings.Contains(text, "is inside the container") || !strings.Contains(text, `docker run --rm -v "$PWD:`+o.WorkDir+`" localhost/scantor/echo:3`) {
		t.Fatalf("no mount: %s", text)
	}
	o.MountPoints = func() ([]string, error) { return nil, errors.New("no mountinfo") }
	if issues := o.checkOutDir(deeper, true); !strings.Contains(issueText(issues), "is inside the container") {
		t.Fatalf("no mountinfo: %s", issueText(issues))
	}
	// On the root's device (the vfs storage driver), a mount point at or above the ancestor is a mount.
	for _, point := range []string{o.WorkDir, filepath.Dir(o.WorkDir)} {
		o.MountPoints = func() ([]string, error) { return []string{"/", point + "-other", point}, nil }
		if issues := o.checkOutDir(deeper, true); len(issues) > 0 {
			t.Fatalf("mount point %s: %s", point, issueText(issues))
		}
	}
	o.MountPoints = func() ([]string, error) { return []string{"/", filepath.Join(o.WorkDir, "results", "other")}, nil }
	if issues := o.checkOutDir(deeper, true); !strings.Contains(issueText(issues), "is inside the container") {
		t.Fatalf("a mount point beside the run directory: %s", issueText(issues))
	}

	o.MountPoints = noMountPoints
	o.RootDevice = func() (uint64, error) { return 0, errors.New("no root") }
	if issues := o.checkOutDir(dir+"-new", true); !strings.Contains(issueText(issues), "cannot inspect the root file system") {
		t.Fatalf("root device error: %s", issueText(issues))
	}
	o.MountPoints = func() ([]string, error) { return []string{o.WorkDir}, nil }
	if issues := o.checkOutDir(dir+"-new", true); len(issues) > 0 {
		t.Fatalf("root device error below a mount point: %s", issueText(issues))
	}
}

func TestParseMountInfo(t *testing.T) {
	const info = `1501 1342 0:322 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/x
1502 1501 0:325 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
1503 1501 0:326 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
1504 1503 0:327 / /dev/pts rw,nosuid,noexec,relatime - devpts devpts rw,gid=5,mode=620
1505 1501 0:328 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
1506 1505 0:30 / /sys/fs/cgroup ro,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw
1507 1503 0:324 / /dev/mqueue rw,nosuid,nodev,noexec,relatime - mqueue mqueue rw
1508 1503 0:329 / /dev/shm rw,nosuid,nodev,noexec,relatime - tmpfs shm rw,size=65536k
175 166 254:1 /var/lib/hostwork /work rw,relatime shared:2 master:3 - ext4 /dev/vda1 rw
1510 1501 254:1 /var/lib/docker/containers/c/resolv.conf /etc/resolv.conf rw,relatime - ext4 /dev/vda1 rw
1511 1501 254:1 /home/a\040b /data\040in rw,relatime - ext4 /dev/vda1 rw
1512 1502 0:325 /bus /proc/bus ro,nosuid,nodev,noexec,relatime - proc proc rw
broken line
`
	got := parseMountInfo(info)
	want := []string{"/work", "/etc/resolv.conf", "/data in"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("mount points %q, want %q", got, want)
	}
	if got := unescapeMountInfo(`/a\134b\011c\9`); got != "/a\\b\tc\\9" {
		t.Fatalf("unescape %q", got)
	}
}

func TestCreateOutDirAndOwner(t *testing.T) {
	o := prepareOptions(t, rangeSchedule, Flags{})
	if o.fileOwner(o.WorkDir, 1000) != nil {
		t.Fatal("an owner without root")
	}
	owner := o.fileOwner(filepath.Join(o.WorkDir, "results", "x"), 0)
	if owner == nil || owner.UID != os.Getuid() || owner.GID != os.Getgid() {
		t.Fatalf("owner of the work directory %+v", owner)
	}
	outside := t.TempDir()
	if owner := o.fileOwner(filepath.Join(outside, "a", "b"), 0); owner == nil || owner.UID != os.Getuid() {
		t.Fatalf("owner of a directory outside %+v", owner)
	}

	dir := filepath.Join(o.WorkDir, "results", "x", "y")
	if err := createOutDir(dir, &local.FileOwner{UID: os.Getuid(), GID: os.Getgid()}); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{filepath.Join(o.WorkDir, "results"), filepath.Join(o.WorkDir, "results", "x"), dir} {
		fi, err := os.Stat(d)
		if err != nil || !fi.IsDir() {
			t.Fatalf("%s: %v", d, err)
		}
		if st := fi.Sys().(*syscall.Stat_t); int(st.Uid) != os.Getuid() {
			t.Fatalf("%s owned by %d", d, st.Uid)
		}
	}
}

func TestWithin(t *testing.T) {
	for _, tc := range []struct {
		dir, path string
		want      bool
	}{
		{"/work", "/work", true}, {"/work", "/work/results/x", true}, {"/work", "/workers", false},
		{"/work", "/data", false}, {"/work", "/work/../etc", false}, {"/work", "/work/..x", true},
	} {
		if got := within(tc.dir, filepath.Clean(tc.path)); got != tc.want {
			t.Errorf("within(%s, %s) = %v", tc.dir, tc.path, got)
		}
	}
}
