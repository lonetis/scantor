//go:build integration

package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	containertypes "github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/client"
	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/container"
	"github.com/lonetis/scantor/internal/runtime"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeapi"
	"github.com/lonetis/scantor/internal/runtime/internal/fakeconn"
)

// These tests run worker mode end to end against a throwaway RabbitMQ 4.4 with a fake orchestrator: the
// test declares the per-scan topology like the reconciler (docs/queue.md §3, §4), publishes analyses as
// the admin user and reads what the runtime publishes from scantor.results.ingest.

var namePrefix = flag.String("name-prefix", "scantor-test-", "prefix of the containers the integration tests create")

const (
	rabbitImage    = "rabbitmq:4.4-management"
	rabbitUser     = "scantor"
	rabbitPassword = "scantor-integration-password"
	vhost          = "scantor"
)

type rabbit struct {
	amqpPort, mgmtPort string
}

var (
	rabbitOnce sync.Once
	shared     *rabbit
	rabbitErr  error
)

// broker starts one RabbitMQ container for all tests of the package.
func broker(t *testing.T) *rabbit {
	t.Helper()
	rabbitOnce.Do(func() { shared, rabbitErr = startRabbit() })
	if rabbitErr != nil {
		t.Fatalf("start RabbitMQ: %v", rabbitErr)
	}
	return shared
}

func startRabbit() (*rabbit, error) {
	ctx := context.Background()
	docker, err := container.NewClient("scantor-integration-test")
	if err != nil {
		return nil, err
	}
	loopback := netip.MustParseAddr("127.0.0.1")
	amqpPort, mgmtPort := network.MustParsePort("5672/tcp"), network.MustParsePort("15672/tcp")
	name := *namePrefix + "runtime-rabbitmq-" + uuid.NewString()[:8]
	created, err := docker.ContainerCreate(ctx, client.ContainerCreateOptions{
		Name: name,
		Config: &containertypes.Config{
			Image:        rabbitImage,
			Env:          []string{"RABBITMQ_DEFAULT_USER=" + rabbitUser, "RABBITMQ_DEFAULT_PASS=" + rabbitPassword},
			ExposedPorts: network.PortSet{amqpPort: {}, mgmtPort: {}},
			Labels:       map[string]string{"scantor.test": "true"},
		},
		HostConfig: &containertypes.HostConfig{PortBindings: network.PortMap{
			amqpPort: {{HostIP: loopback}}, mgmtPort: {{HostIP: loopback}},
		}},
	})
	if err != nil {
		return nil, err
	}
	afterTests = append(afterTests, func() {
		_, _ = docker.ContainerRemove(context.Background(), created.ID, client.ContainerRemoveOptions{Force: true, RemoveVolumes: true})
	})
	if _, err := docker.ContainerStart(ctx, created.ID, client.ContainerStartOptions{}); err != nil {
		return nil, err
	}
	inspect, err := docker.ContainerInspect(ctx, created.ID, client.ContainerInspectOptions{})
	if err != nil {
		return nil, err
	}
	ports := inspect.Container.NetworkSettings.Ports
	r := &rabbit{amqpPort: ports[amqpPort][0].HostPort, mgmtPort: ports[mgmtPort][0].HostPort}
	deadline := time.Now().Add(2 * time.Minute)
	for time.Now().Before(deadline) {
		if err := r.mgmt(http.MethodGet, "/api/overview", nil); err == nil {
			if conn, err := amqp.Dial(r.adminURL("/")); err == nil {
				_ = conn.Close()
				return r, nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return nil, fmt.Errorf("RabbitMQ did not become ready")
}

func (r *rabbit) adminURL(vh string) string {
	return fmt.Sprintf("amqp://%s:%s@127.0.0.1:%s/%s", rabbitUser, rabbitPassword, r.amqpPort, url.PathEscape(vh))
}

func (r *rabbit) mgmt(method, path string, body any) error {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequest(method, "http://127.0.0.1:"+r.mgmtPort+path, rd)
	if err != nil {
		return err
	}
	req.SetBasicAuth(rabbitUser, rabbitPassword)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 && (method != http.MethodDelete || resp.StatusCode != http.StatusNotFound) {
		return fmt.Errorf("%s %s: HTTP %d", method, path, resp.StatusCode)
	}
	return nil
}

// scan is the broker topology of one scan, declared like the reconciler does.
type scan struct {
	id, password string
	r            *rabbit
	admin        *amqp.Connection
	ch           *amqp.Channel
}

func (r *rabbit) scan(t *testing.T, queueArgs amqp.Table) *scan {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(r.mgmt(http.MethodPut, "/api/vhosts/"+vhost, map[string]any{"description": "scantor", "default_queue_type": "quorum"}))
	must(r.mgmt(http.MethodPut, "/api/permissions/"+vhost+"/"+rabbitUser, map[string]string{"configure": ".*", "write": ".*", "read": ".*"}))
	s := &scan{id: uuid.NewString(), password: "pw-" + uuid.NewString(), r: r}
	conn, err := amqp.Dial(r.adminURL(vhost))
	must(err)
	t.Cleanup(func() { _ = conn.Close() })
	ch, err := conn.Channel()
	must(err)
	s.admin, s.ch = conn, ch
	for _, ex := range []string{"scantor.analyses", "scantor.results"} {
		must(ch.ExchangeDeclare(ex, "topic", true, false, false, false, nil))
	}
	args := amqp.Table{"x-queue-type": "quorum", "x-delivery-limit": int64(5), "x-overflow": "reject-publish"}
	for k, v := range queueArgs {
		args[k] = v
	}
	_, err = ch.QueueDeclare(s.queue(), true, false, false, false, args)
	must(err)
	must(ch.QueueBind(s.queue(), s.id, "scantor.analyses", false, nil))
	_, err = ch.QueueDeclare(s.results(), true, false, false, false, amqp.Table{"x-queue-type": "quorum"})
	must(err)
	must(ch.QueueBind(s.results(), s.id, "scantor.results", false, nil))
	user := "scan-" + s.id
	must(r.mgmt(http.MethodPut, "/api/users/"+user, map[string]string{"password": s.password, "tags": ""}))
	must(r.mgmt(http.MethodPut, "/api/permissions/"+vhost+"/"+user, map[string]string{
		"configure": "^$", "write": `^scantor\.(analyses|results)$`, "read": `^scantor\.scan\.` + s.id + `$`,
	}))
	for _, ex := range []string{"scantor.analyses", "scantor.results"} {
		must(r.mgmt(http.MethodPut, "/api/topic-permissions/"+vhost+"/"+user, map[string]string{"exchange": ex, "write": "^" + s.id + "$", "read": "^$"}))
	}
	t.Cleanup(func() {
		_ = r.mgmt(http.MethodDelete, "/api/users/"+user, nil)
		_ = r.mgmt(http.MethodDelete, "/api/queues/"+vhost+"/"+s.queue(), nil)
		_ = r.mgmt(http.MethodDelete, "/api/queues/"+vhost+"/"+s.results(), nil)
	})
	return s
}

func (s *scan) queue() string   { return "scantor.scan." + s.id }
func (s *scan) results() string { return "scantor.results.test." + s.id[:8] }

// publish publishes an analysis message as the admin user.
func (s *scan) publish(t *testing.T, seq int64, config string) {
	t.Helper()
	body, _ := json.Marshal(runtime.AnalysisMessage{
		V: 1, AnalysisID: runtime.AnalysisID(s.id, seq), ScanID: s.id, Seq: seq, Round: 1, Attempt: 1,
		Config: json.RawMessage(config), ScheduledAt: time.Now().UnixMilli(),
	})
	err := s.ch.PublishWithContext(context.Background(), "scantor.analyses", s.id, true, false, amqp.Publishing{
		ContentType: "application/json", DeliveryMode: amqp.Persistent, Type: "analysis", Body: body,
	})
	if err != nil {
		t.Fatal(err)
	}
}

// delivered is a message the runtime published to scantor.results.
type delivered struct {
	body   map[string]any
	userID string
	typ    string
	at     time.Time
}

// collect consumes the results queue in the background.
func (s *scan) collect(t *testing.T) func() []delivered {
	t.Helper()
	ch, err := s.admin.Channel()
	if err != nil {
		t.Fatal(err)
	}
	deliveries, err := ch.Consume(s.results(), "", true, false, false, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var got []delivered
	go func() {
		for d := range deliveries {
			var m map[string]any
			_ = json.Unmarshal(d.Body, &m)
			mu.Lock()
			got = append(got, delivered{body: m, userID: d.UserId, typ: d.Type, at: time.Now()})
			mu.Unlock()
		}
	}()
	return func() []delivered {
		mu.Lock()
		defer mu.Unlock()
		return append([]delivered(nil), got...)
	}
}

func runnerBootstrap(s *scan) api.Bootstrap {
	return api.Bootstrap{
		Action: api.ActionRun,
		Worker: api.BootstrapWorker{ID: uuid.NewString(), Role: api.RoleRunner, ScanID: s.id, NodeID: uuid.NewString()},
		Scan: api.BootstrapScan{
			ID: s.id, State: "running", Round: 1, TaskConfig: json.RawMessage(`{}`),
			Settings: api.RuntimeSettings{
				Processes: 2, TimeoutMs: 10000, MaxAttempts: 2, MaxAnalysesPerProcess: 100,
				Backoff: api.Backoff{InitialMs: 1000, Factor: 2, MaxMs: 60000},
			},
		},
		Revision: api.BootstrapRevision{Entry: "main.py", ProtocolVersion: 1, Schedule: api.Schedule{Kind: "template", Template: "single"}},
		AMQP: api.BootstrapAMQP{
			URL: "amqp://127.0.0.1:" + s.r.amqpPort, VHost: vhost, Username: "scan-" + s.id, Password: s.password,
			Queue: s.queue(), AnalysesExchange: "scantor.analyses", ResultsExchange: "scantor.results", RoutingKey: s.id,
			HeartbeatSeconds: 30, ConsumerTimeoutMs: 600000,
		},
		Uploads: api.BootstrapUploads{Mode: "presigned", MaxFileBytes: 1 << 20, MaxFilesPerAnalysis: 10, TimeoutMs: 60000},
		Limits: api.BootstrapLimits{
			MaxAnalysisConfigBytes: 1 << 16, MaxResultBytes: 1 << 20, MaxResultMessageBytes: 2 << 20, LogTailBytes: 32 << 10,
			LogTailEarlierBytes: 4 << 10, StackBytes: 16 << 10, MaxAnalysesPerScan: 1 << 30, MaxProcessesPerWorker: 4,
		},
		Intervals: api.BootstrapIntervals{StatePollMs: 200, StatePollJitter: 0.1, CheckpointMs: 200, CheckpointItems: 1000, DrainGraceMs: 5000, BackpressureWaitMs: 200},
	}
}

// startWorker runs worker mode against srv in the background and returns its exit code channel.
func startWorker(t *testing.T, srv *fakeapi.Server, workerID string) (<-chan int, *bytes.Buffer) {
	t.Helper()
	argv, extra := fakeconn.Command("ok")
	dir := t.TempDir()
	cfg := runtime.Config{
		URL: srv.URL, WorkerToken: fakeapi.Token(workerID), ConnectorCmd: strconv.Quote(argv[0]) + " " + argv[1],
		WorkRoot: filepath.Join(dir, "scantor"), Environ: append(os.Environ(), extra...),
	}
	log := &syncBuffer{}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	exit := make(chan int, 1)
	go func() {
		defer cancel()
		exit <- Run(ctx, Options{Config: cfg, Stderr: log, TaskDir: dir, Unsetenv: func(string) error { return nil }})
	}()
	return exit, &log.Buffer
}

type syncBuffer struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(p)
}

func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func find(msgs []delivered, kind string, seq float64) *delivered {
	for i := range msgs {
		if msgs[i].body["kind"] == kind && msgs[i].body["seq"] == seq {
			return &msgs[i]
		}
	}
	return nil
}

func TestRunnerWithRabbitMQ(t *testing.T) {
	r := broker(t)
	s := r.scan(t, nil)
	results := s.collect(t)
	srv := fakeapi.New()
	defer srv.Close()
	boot := runnerBootstrap(s)
	var stop atomic.Bool
	srv.Snapshot(func(f *fakeapi.Server) {
		f.Bootstrap = boot
		f.State = func(req api.RuntimeStateRequest) (api.RuntimeStateResponse, int) {
			action := api.ActionRun
			if stop.Load() {
				action = api.ActionStop
			}
			return api.RuntimeStateResponse{Action: action, Processes: 2, ScanState: "running", NextPollMs: 200}, http.StatusOK
		}
	})
	exit, log := startWorker(t, srv, boot.Worker.ID)

	s.publish(t, 0, `{"name":"rabbit"}`)
	s.publish(t, 1, `{"mode":"throw"}`)
	waitFor(t, "results", time.Minute, func() bool {
		m := results()
		return find(m, "result", 0) != nil && find(m, "attempt", 1) != nil && find(m, "result", 1) != nil
	})
	m := results()
	ok, attempt, final := find(m, "result", 0), find(m, "attempt", 1), find(m, "result", 1)
	if ok.body["status"] != "succeeded" || ok.userID != "scan-"+s.id || ok.typ != "result" {
		t.Fatalf("result 0: %+v", ok)
	}
	if final.body["status"] != "failed" || final.body["attempt"] != float64(2) || attempt.typ != "attempt" {
		t.Fatalf("retry: attempt %+v final %+v", attempt.body, final.body)
	}
	// The republish carried x-opt-delivery-time ≥ now + 1 s, which the quorum queue honours.
	if gap := final.at.Sub(attempt.at); gap < 900*time.Millisecond {
		t.Fatalf("the retry ran %s after the attempt event; the delivery time was not honoured", gap)
	}

	// Consumer cancel: the queue is deleted while an analysis runs. The result is still published (the
	// delivery is detached), the re-consume finds no queue, the state poll says stop, and the worker exits 0.
	s.publish(t, 2, `{"mode":"sleep","sleepMs":1500}`)
	waitFor(t, "busy", 30*time.Second, func() bool {
		busy := false
		srv.Snapshot(func(f *fakeapi.Server) {
			if n := len(f.States); n > 0 {
				busy = len(f.States[n-1].Busy) > 0
			}
		})
		return busy
	})
	if err := r.mgmt(http.MethodDelete, "/api/queues/"+vhost+"/"+s.queue(), nil); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the detached result", 30*time.Second, func() bool { return find(results(), "result", 2) != nil })
	stop.Store(true) // the scan is terminal: the re-consume's 404 made the runtime poll
	select {
	case code := <-exit:
		if code != ExitOK {
			t.Fatalf("exit %d\n%s", code, log.String())
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("the worker did not exit\n%s", log.String())
	}
}

func TestKillSwitchEndsTheWorker(t *testing.T) {
	r := broker(t)
	s := r.scan(t, nil)
	srv := fakeapi.New()
	defer srv.Close()
	boot := runnerBootstrap(s)
	var deleted atomic.Bool
	srv.Snapshot(func(f *fakeapi.Server) {
		f.Bootstrap = boot
		f.State = func(api.RuntimeStateRequest) (api.RuntimeStateResponse, int) {
			if deleted.Load() {
				return api.RuntimeStateResponse{Action: api.ActionStop, ScanState: "cancelled"}, http.StatusOK
			}
			return api.RuntimeStateResponse{Action: api.ActionRun, Processes: 2, ScanState: "running", NextPollMs: 5000}, http.StatusOK
		}
	})
	exit, log := startWorker(t, srv, boot.Worker.ID)
	waitFor(t, "consuming", 30*time.Second, func() bool {
		consuming := false
		srv.Snapshot(func(f *fakeapi.Server) {
			for _, st := range f.States {
				consuming = consuming || st.Consuming
			}
		})
		return consuming
	})
	// Deleting the per-scan user force-closes its connections (docs/queue.md §4.4).
	deleted.Store(true)
	if err := r.mgmt(http.MethodDelete, "/api/users/scan-"+s.id, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-exit:
		if code != ExitOK {
			t.Fatalf("exit %d\n%s", code, log.String())
		}
	case <-time.After(45 * time.Second):
		t.Fatalf("the worker did not exit after the kill switch\n%s", log.String())
	}
}

// TestSchedulerBackpressureWithRabbitMQ schedules more items than the publish window holds into a queue
// limited to a few ready messages: the quorum queue nacks publishes once it is over its limit (it learns
// that with a lag, so the first window is accepted), the scheduler waits and republishes only the nacked
// seqs, and every seq arrives once the runners drain the queue.
func TestSchedulerBackpressureWithRabbitMQ(t *testing.T) {
	const items = 1500
	r := broker(t)
	s := r.scan(t, amqp.Table{"x-max-length": int64(10)})
	srv := fakeapi.New()
	defer srv.Close()
	boot := runnerBootstrap(s)
	boot.Worker.Role, boot.Worker.Epoch = api.RoleScheduler, 1
	boot.Scan.ScanConfig = json.RawMessage(fmt.Sprintf(`{"start":0,"end":%d}`, items))
	boot.Scan.Settings.Processes = 1
	boot.Revision.Schedule = api.Schedule{Kind: "template", Template: "range"}
	boot.Scheduler = &api.BootstrapScheduler{Resolved: map[string]api.Resolution{}, Uploads: map[string]api.UploadSource{}}
	srv.Snapshot(func(f *fakeapi.Server) { f.Bootstrap = boot })
	exit, log := startWorker(t, srv, boot.Worker.ID)

	// Runners: drain the queue slowly once the scheduler is in backpressure.
	ch, err := s.admin.Channel()
	if err != nil {
		t.Fatal(err)
	}
	if err := ch.Qos(10, 0, false); err != nil {
		t.Fatal(err)
	}
	seen := map[float64]bool{}
	var mu sync.Mutex
	go func() {
		time.Sleep(time.Second)
		deliveries, err := ch.Consume(s.queue(), "", false, false, false, false, nil)
		if err != nil {
			return
		}
		for d := range deliveries {
			var m map[string]any
			_ = json.Unmarshal(d.Body, &m)
			mu.Lock()
			seen[m["seq"].(float64)] = true
			mu.Unlock()
			time.Sleep(2 * time.Millisecond)
			_ = d.Ack(false)
		}
	}()
	select {
	case code := <-exit:
		if code != ExitOK {
			t.Fatalf("exit %d\n%s", code, log.String())
		}
	case <-time.After(90 * time.Second):
		t.Fatalf("the scheduler did not finish\n%s", log.String())
	}
	var backpressure bool
	srv.Snapshot(func(f *fakeapi.Server) {
		if len(f.Dones) != 1 || f.Dones[0].Outcome != api.OutcomeDone || f.Dones[0].Confirmed != items {
			t.Fatalf("done %+v", f.Dones)
		}
		for _, st := range f.States {
			if st.Scheduler != nil && st.Scheduler.Backpressure && st.Scheduler.Nacked > 0 {
				backpressure = true
			}
		}
		if len(f.Resolveds) != 1 || f.Resolveds[0].Key != "schedule" {
			t.Fatalf("resolved %+v", f.Resolveds)
		}
	})
	if !backpressure {
		t.Fatal("no state poll reported backpressure although the queue holds at most 10 ready messages")
	}
	waitFor(t, "every seq consumed", 30*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(seen) == items
	})
}
