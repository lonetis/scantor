package node

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os/exec"
	"slices"
	"strings"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/container"
)

// The egress deny helper (docs/nodes.md §9, docs/security.md SB-4). Workers must not reach cloud
// metadata endpoints or other operator-chosen ranges. A one-shot host-network helper container with
// NET_ADMIN (the daemon's own image) runs `scantor node egress-apply`, which maintains the chain
// SCANTOR-EGRESS and jumps to it from DOCKER-USER. It is best effort: failures are logged and reported
// as egressDenyApplied: false.

// EgressChain is the iptables chain the egress helper maintains.
const EgressChain = "SCANTOR-EGRESS"

// dockerUserChain is Docker's chain for user rules on forwarded container traffic.
const dockerUserChain = "DOCKER-USER"

// xtablesLock is the lock file iptables-legacy shares with dockerd.
const xtablesLock = "/run/xtables.lock"

// EgressResult is the JSON line `scantor node egress-apply` prints: applied is true only when every
// CIDR of every family is in place; families maps "ipv4"/"ipv6" to the backend used or to the error.
type EgressResult struct {
	Applied  bool              `json:"applied"`
	Families map[string]string `json:"families"`
	Errors   []string          `json:"errors"`
}

// CommandRunner runs a command with stdin as its standard input (empty: none) and returns its combined
// output.
type CommandRunner func(ctx context.Context, stdin, name string, args ...string) (string, error)

// ExecRunner runs commands with os/exec.
func ExecRunner(ctx context.Context, stdin, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

type egressFamily struct {
	name     string
	backends []string
	reject   string
}

var egressFamilies = []egressFamily{
	{name: "ipv4", backends: []string{"iptables-nft", "iptables-legacy"}, reject: "icmp-admin-prohibited"},
	{name: "ipv6", backends: []string{"ip6tables-nft", "ip6tables-legacy"}, reject: "icmp6-adm-prohibited"},
}

// EgressApply applies the deny list with iptables (run inside the helper container). For each address
// family with at least one CIDR it picks the first backend (nft, then legacy) whose DOCKER-USER chain
// exists, which must be Docker's own backend, replaces the rules of SCANTOR-EGRESS with REJECT rules
// (which fail fast instead of timing out) in one transaction and makes sure DOCKER-USER jumps to it
// first.
func EgressApply(ctx context.Context, cidrs []netip.Prefix, run CommandRunner) EgressResult {
	res := EgressResult{Applied: true, Families: map[string]string{}, Errors: []string{}}
	for _, fam := range egressFamilies {
		var list []string
		for _, p := range cidrs {
			if (fam.name == "ipv4") == p.Addr().Is4() {
				list = append(list, p.String())
			}
		}
		if len(list) == 0 {
			continue
		}
		backend := ""
		for _, b := range fam.backends {
			if _, err := run(ctx, "", b, "-w", "-n", "-L", dockerUserChain); err == nil {
				backend = b
				break
			}
		}
		if backend == "" {
			res.fail(fam.name, dockerUserChain+" chain not found")
			continue
		}
		if err := applyChain(ctx, run, backend, fam.reject, list); err != nil {
			res.fail(fam.name, err.Error())
			continue
		}
		res.Families[fam.name] = backend
	}
	return res
}

func (r *EgressResult) fail(family, msg string) {
	r.Applied = false
	r.Families[family] = msg
	r.Errors = append(r.Errors, family+": "+msg)
}

// applyChain makes SCANTOR-EGRESS hold exactly one REJECT rule per CIDR, in order, and makes
// DOCKER-USER jump to it first. The rules are replaced with one `<backend>-restore --noflush`
// transaction: declaring the chain creates it, or flushes it within the same commit, and every other
// chain is left alone. Flushing and appending with separate commands would leave the chain empty, and
// the metadata ranges reachable, between the flush and the first append while DOCKER-USER already
// jumps to it. A chain that already holds the desired rules is not written at all. On the first run the
// chain is complete before the jump is inserted.
func applyChain(ctx context.Context, run CommandRunner, ipt, reject string, cidrs []string) error {
	rules := make([]string, len(cidrs))
	for i, c := range cidrs {
		rules[i] = "-A " + EgressChain + " -d " + c + " -j REJECT --reject-with " + reject
	}
	if !chainHolds(ctx, run, ipt, rules) {
		restore := ipt + "-restore"
		input := "*filter\n:" + EgressChain + " - [0:0]\n" + strings.Join(rules, "\n") + "\nCOMMIT\n"
		if out, err := run(ctx, input, restore, "-w", "--noflush"); err != nil {
			return commandError(restore, "--noflush", out, err)
		}
	}
	if _, err := run(ctx, "", ipt, "-w", "-C", dockerUserChain, "-j", EgressChain); err == nil {
		return nil
	}
	if out, err := run(ctx, "", ipt, "-w", "-I", dockerUserChain, "1", "-j", EgressChain); err != nil {
		return commandError(ipt, "-I "+dockerUserChain, out, err)
	}
	return nil
}

// chainHolds reports whether SCANTOR-EGRESS exists and holds exactly rules, in order (`-S` prints
// rules in the restore syntax). Any failure counts as a mismatch, so the chain is rewritten.
func chainHolds(ctx context.Context, run CommandRunner, ipt string, rules []string) bool {
	out, err := run(ctx, "", ipt, "-w", "-S", EgressChain)
	if err != nil {
		return false
	}
	var have []string
	for line := range strings.Lines(out) {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "-A ") {
			have = append(have, line)
		}
	}
	return slices.Equal(have, rules)
}

func commandError(ipt, op, out string, err error) error {
	msg := strings.TrimSpace(out)
	if msg == "" {
		msg = err.Error()
	}
	return fmt.Errorf("%s %s: %s", ipt, op, truncateUTF8(msg, 512))
}

// egressHelper runs the helper container on the local Docker daemon.
type egressHelper struct {
	docker  client.APIClient
	nodeID  string
	imageID string
	deny    []netip.Prefix
	timeout time.Duration
	// networkMode is "host"; tests run the helper in an isolated network namespace instead.
	networkMode string
}

// errBindSourceMissing marks a ContainerCreate failure caused by a missing /run/xtables.lock on the
// host: no legacy iptables has run there since boot, so the helper can run without the bind.
func isMissingBindSource(err error) bool {
	return err != nil && strings.Contains(err.Error(), "bind source path does not exist")
}

// run executes the helper once and returns its result.
func (h egressHelper) run(ctx context.Context) (EgressResult, error) {
	name := container.Name(container.KindEgressHelper, h.nodeID)
	if err := h.removeLeftover(ctx, name); err != nil {
		return EgressResult{}, err
	}
	id, err := h.create(ctx, name, true)
	if isMissingBindSource(err) {
		id, err = h.create(ctx, name, false)
	}
	if err != nil {
		return EgressResult{}, fmt.Errorf("create egress helper: %w", err)
	}
	defer func() {
		// Cleanup also runs when ctx was cancelled (shutdown), like `docker run --rm`.
		rmCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_, _ = h.docker.ContainerRemove(rmCtx, id, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}()
	ctx, cancel := context.WithTimeout(ctx, h.timeout)
	defer cancel()
	wait := h.docker.ContainerWait(ctx, id, client.ContainerWaitOptions{Condition: dcontainer.WaitConditionNextExit})
	if _, err := h.docker.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return EgressResult{}, fmt.Errorf("start egress helper: %w", err)
	}
	select {
	case <-ctx.Done():
		return EgressResult{}, fmt.Errorf("egress helper: %w", ctx.Err())
	case err := <-wait.Error:
		return EgressResult{}, fmt.Errorf("wait for egress helper: %w", err)
	case <-wait.Result:
	}
	stdout, stderr, err := h.output(ctx, id)
	if err != nil {
		return EgressResult{}, err
	}
	var res EgressResult
	line := lastLine(stdout)
	if err := json.Unmarshal([]byte(line), &res); err != nil {
		return EgressResult{}, fmt.Errorf("egress helper printed no result: %s", truncateUTF8(strings.TrimSpace(stdout+" "+stderr), 512))
	}
	return res, nil
}

// removeLeftover removes a helper container left behind by an interrupted run. A foreign container
// with that name is never touched.
func (h egressHelper) removeLeftover(ctx context.Context, name string) error {
	res, err := h.docker.ContainerInspect(ctx, name, client.ContainerInspectOptions{})
	if err != nil {
		if container.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("inspect %s: %w", name, err)
	}
	labels := map[string]string{}
	if res.Container.Config != nil {
		labels = res.Container.Config.Labels
	}
	if !container.IsManaged(container.KindEgressHelper, res.Container.Name, labels) || labels[container.LabelNode] != h.nodeID {
		return fmt.Errorf("a foreign container named %s exists; the egress helper is skipped", name)
	}
	if _, err := h.docker.ContainerRemove(ctx, res.Container.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !container.IsNotFound(err) {
		return fmt.Errorf("remove leftover %s: %w", name, err)
	}
	return nil
}

func (h egressHelper) create(ctx context.Context, name string, bindLock bool) (string, error) {
	labels, err := container.ManagedLabels(container.KindEgressHelper, container.Identity{Node: h.nodeID})
	if err != nil {
		return "", err
	}
	deny := make([]string, len(h.deny))
	for i, p := range h.deny {
		deny[i] = p.String()
	}
	hc := &dcontainer.HostConfig{
		NetworkMode:    dcontainer.NetworkMode(h.networkMode),
		CapDrop:        []string{"ALL"},
		CapAdd:         []string{"NET_ADMIN", "NET_RAW"},
		SecurityOpt:    []string{"no-new-privileges:true"},
		ReadonlyRootfs: true,
		Tmpfs:          map[string]string{"/run": "size=1m"},
		RestartPolicy:  dcontainer.RestartPolicy{Name: dcontainer.RestartPolicyDisabled},
	}
	if bindLock {
		hc.Mounts = []mount.Mount{{Type: mount.TypeBind, Source: xtablesLock, Target: xtablesLock}}
	}
	res, err := h.docker.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name: name,
		Config: &dcontainer.Config{
			Image:      h.imageID,
			Entrypoint: []string{container.ImageBinaryPath},
			Cmd:        []string{"node", "egress-apply", "--deny", strings.Join(deny, ",")},
			User:       "0:0",
			Labels:     labels,
		},
		HostConfig: hc,
	})
	if err != nil {
		return "", err
	}
	return res.ID, nil
}

func (h egressHelper) output(ctx context.Context, id string) (stdout, stderr string, err error) {
	rc, err := h.docker.ContainerLogs(ctx, id, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return "", "", fmt.Errorf("egress helper output: %w", err)
	}
	defer rc.Close()
	var out, errOut bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, &errOut, rc); err != nil {
		return "", "", fmt.Errorf("egress helper output: %w", err)
	}
	return out.String(), errOut.String(), nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// errEgressSkipped is returned when the helper cannot run because the daemon does not know its own
// image (self-inspection failed).
var errEgressSkipped = errors.New("the egress helper is skipped: the daemon's own container image is unknown (self-inspection failed)")
