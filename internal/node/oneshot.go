package node

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/moby/moby/api/pkg/stdcopy"
	dcontainer "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/client"

	"github.com/lonetis/scantor/internal/container"
)

// oneShot runs a one-shot helper container of the daemon (the egress helper, the node resolver's probe)
// like `docker run --rm`: the container has the fixed name of its kind for this node, runs once, and its
// output is the result. A container of that name left behind by an interrupted run is removed first; a
// foreign container of that name is never touched.
type oneShot struct {
	docker  client.APIClient
	kind    container.Kind
	nodeID  string
	timeout time.Duration
	// what names the container in errors ("egress helper").
	what string
}

// run creates the container with create (which receives the name), starts it, waits at most timeout for
// it to exit and returns its standard output and error. The container is removed in every case, also
// after ctx was cancelled (shutdown).
func (o oneShot) run(ctx context.Context, create func(ctx context.Context, name string) (string, error)) (stdout, stderr string, err error) {
	name := container.Name(o.kind, o.nodeID)
	if err := o.removeLeftover(ctx, name); err != nil {
		return "", "", err
	}
	id, err := create(ctx, name)
	if err != nil {
		return "", "", fmt.Errorf("create %s: %w", o.what, err)
	}
	defer func() {
		rmCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
		defer cancel()
		_, _ = o.docker.ContainerRemove(rmCtx, id, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	}()
	ctx, cancel := context.WithTimeout(ctx, o.timeout)
	defer cancel()
	wait := o.docker.ContainerWait(ctx, id, client.ContainerWaitOptions{Condition: dcontainer.WaitConditionNextExit})
	if _, err := o.docker.ContainerStart(ctx, id, client.ContainerStartOptions{}); err != nil {
		return "", "", fmt.Errorf("start %s: %w", o.what, err)
	}
	select {
	case <-ctx.Done():
		return "", "", fmt.Errorf("%s: %w", o.what, ctx.Err())
	case err := <-wait.Error:
		return "", "", fmt.Errorf("wait for %s: %w", o.what, err)
	case <-wait.Result:
	}
	return o.output(ctx, id)
}

// removeLeftover removes a container of this kind and node left behind by an interrupted run. A foreign
// container with that name is never touched.
func (o oneShot) removeLeftover(ctx context.Context, name string) error {
	res, err := o.docker.ContainerInspect(ctx, name, client.ContainerInspectOptions{})
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
	if !container.IsManaged(o.kind, res.Container.Name, labels) || labels[container.LabelNode] != o.nodeID {
		return fmt.Errorf("a foreign container named %s exists; the %s is skipped", name, o.what)
	}
	if _, err := o.docker.ContainerRemove(ctx, res.Container.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true}); err != nil && !container.IsNotFound(err) {
		return fmt.Errorf("remove leftover %s: %w", name, err)
	}
	return nil
}

func (o oneShot) output(ctx context.Context, id string) (stdout, stderr string, err error) {
	rc, err := o.docker.ContainerLogs(ctx, id, client.ContainerLogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return "", "", fmt.Errorf("%s output: %w", o.what, err)
	}
	defer rc.Close()
	var out, errOut bytes.Buffer
	if _, err := stdcopy.StdCopy(&out, &errOut, rc); err != nil {
		return "", "", fmt.Errorf("%s output: %w", o.what, err)
	}
	return out.String(), errOut.String(), nil
}
