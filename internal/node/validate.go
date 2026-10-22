package node

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
)

// Assignment validation (docs/nodes.md §6.10). The master is trusted, but a malformed assignment must
// never produce a dangerous container: an assignment that fails a check is reported as error
// createFailed (the message names the field) and is never created.

var (
	uuidPattern     = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	digestPattern   = regexp.MustCompile(`@sha256:[0-9a-f]{64}$`)
	specHashPattern = regexp.MustCompile(`^sha256:[0-9a-f]+$`)
)

// Worker environment keys an assignment may carry.
const (
	envURL         = "SCANTOR_URL"
	envWorkerToken = "SCANTOR_WORKER_TOKEN" //nolint:gosec // a variable name, not a credential
)

// Bounds of processes per worker.
const (
	minProcesses = 1
	maxProcesses = 1024
)

// nodeLimits are the facts an assignment is validated against.
type nodeLimits struct {
	registryHost string
	dindMode     string // effective mode
	cpus         int
	memoryBytes  int64
}

// validateAssignment checks a against §6.10 and returns an error naming the first offending field.
func validateAssignment(a api.Assignment, lim nodeLimits) error {
	for _, f := range []struct{ name, value string }{{"workerId", a.WorkerID}, {"scanId", a.ScanID}, {"userId", a.UserID}} {
		if !uuidPattern.MatchString(f.value) {
			return fmt.Errorf("%s: must be a uuid", f.name)
		}
	}
	if err := validateImage(a.Image, lim.registryHost); err != nil {
		return err
	}
	if a.BaseImage != nil && !digestPattern.MatchString(*a.BaseImage) {
		return errors.New("baseImage: must be null or reference a digest (@sha256:<64 hex>)")
	}
	if !specHashPattern.MatchString(a.SpecHash) {
		return errors.New("specHash: must be sha256:<hex>")
	}
	if err := validateDinD(a, lim.dindMode); err != nil {
		return err
	}
	if a.DinDMode == nil {
		for _, c := range a.CapAdd {
			if !slices.Contains(container.AllowedCapAdd, c) {
				return fmt.Errorf("capAdd: %s is not allowed (allowed: %s)", c, strings.Join(container.AllowedCapAdd, ", "))
			}
		}
	}
	if err := validateEnv(a); err != nil {
		return err
	}
	switch {
	case a.Resources.NanoCPUs <= 0:
		return errors.New("resources.nanoCpus: must be greater than 0")
	case a.Resources.NanoCPUs > int64(lim.cpus)*1e9:
		return fmt.Errorf("resources.nanoCpus: %d exceeds the node's %d CPUs", a.Resources.NanoCPUs, lim.cpus)
	case a.Resources.MemoryBytes < container.MemoryOverheadBytes:
		return errors.New("resources.memoryBytes: must be at least 256 MiB")
	case a.Resources.MemoryBytes > lim.memoryBytes:
		return fmt.Errorf("resources.memoryBytes: %d exceeds the node's memory of %d bytes", a.Resources.MemoryBytes, lim.memoryBytes)
	case a.Processes < minProcesses || a.Processes > maxProcesses:
		return fmt.Errorf("processes: must be between %d and %d", minProcesses, maxProcesses)
	}
	return nil
}

// validateImage checks "<registry host>/tasks/<uuid>@sha256:<64 hex>".
func validateImage(image, registryHost string) error {
	prefix := registryHost + "/tasks/"
	rest, ok := strings.CutPrefix(image, prefix)
	if registryHost == "" || !ok {
		return fmt.Errorf("image: must be %s<taskId>@sha256:<digest>", prefix)
	}
	taskID, digest, ok := strings.Cut(rest, "@")
	if !ok || !uuidPattern.MatchString(taskID) || !digestPattern.MatchString("@"+digest) {
		return fmt.Errorf("image: must be %s<taskId>@sha256:<digest>", prefix)
	}
	return nil
}

// validateDinD checks privileged == (dindMode != null) and that a DinD mode equals the node's own
// effective mode, which must not be disabled.
func validateDinD(a api.Assignment, effective string) error {
	if a.Privileged != (a.DinDMode != nil) {
		return errors.New("privileged: must be true exactly when dindMode is set")
	}
	if a.DinDMode == nil {
		return nil
	}
	if effective == DinDDisabled {
		return errors.New("dindMode: DinD is disabled on this node")
	}
	if *a.DinDMode != effective {
		return fmt.Errorf("dindMode: %q does not match the node's mode %q", *a.DinDMode, effective)
	}
	return nil
}

// validateEnv allows exactly SCANTOR_URL and SCANTOR_WORKER_TOKEN; the token must belong to the worker.
func validateEnv(a api.Assignment) error {
	for k := range a.Env {
		if k != envURL && k != envWorkerToken {
			return fmt.Errorf("env: %s is not allowed", k)
		}
	}
	if a.Env[envURL] == "" {
		return fmt.Errorf("env: %s is required", envURL)
	}
	if !strings.HasPrefix(a.Env[envWorkerToken], "swt_"+a.WorkerID+".") {
		return fmt.Errorf("env: %s must be a token of worker %s", envWorkerToken, a.WorkerID)
	}
	return nil
}
