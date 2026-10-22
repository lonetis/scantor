package node

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lonetis/scantor/internal/api"
)

// fakeOrchestrator implements /api/node/* for daemon tests.
type fakeOrchestrator struct {
	t      *testing.T
	srv    *httptest.Server
	token  string
	nodeID string

	mu          sync.Mutex
	cond        *sync.Cond
	rev         int64
	workers     []api.Assignment
	logRequests []api.LogRequest
	config      api.NodeConfig
	builtIn     bool

	hellos       []api.NodeHelloRequest
	helloHeaders []http.Header
	statuses     []api.NodeStatusRequest
	logs         map[string][]api.WorkerLogsUpload
	assignCalls  int
	instanceIDs  []string

	// failNext makes the next requests of a route fail with a status and code.
	failRoutes map[string]fakeFailure
}

type fakeFailure struct {
	status  int
	code    string
	details any
	times   int // 0 = forever
}

func newFakeOrchestrator(t *testing.T, token string) *fakeOrchestrator {
	o := &fakeOrchestrator{
		t:      t,
		token:  token,
		nodeID: "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a",
		config: api.NodeConfig{
			StatusIntervalMs:       200,
			AssignmentsWaitSeconds: 1,
			OfflineAfterMs:         60000,
			DrainGraceMs:           30000,
			Registry:               api.NodeRegistryConfig{Host: "registry.example.com", Username: "node"},
			MinFreeDiskBytes:       0,
		},
		logs:       map[string][]api.WorkerLogsUpload{},
		failRoutes: map[string]fakeFailure{},
	}
	o.cond = sync.NewCond(&o.mu)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/node/hello", o.hello)
	mux.HandleFunc("GET /api/node/assignments", o.assignments)
	mux.HandleFunc("POST /api/node/status", o.status)
	mux.HandleFunc("POST /api/node/workers/{workerId}/logs", o.workerLogs)
	o.srv = httptest.NewServer(mux)
	t.Cleanup(func() {
		o.mu.Lock()
		o.rev++ // wake long-polls
		o.cond.Broadcast()
		o.mu.Unlock()
		o.srv.CloseClientConnections()
		o.srv.Close()
	})
	return o
}

func (o *fakeOrchestrator) writeError(w http.ResponseWriter, f fakeFailure) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(f.status)
	body := map[string]any{"error": map[string]any{"code": f.code, "message": f.code, "details": f.details}}
	_ = json.NewEncoder(w).Encode(body)
}

// check verifies the credential and consumes a configured failure; it returns false when it answered.
func (o *fakeOrchestrator) check(w http.ResponseWriter, r *http.Request, route string) bool {
	o.mu.Lock()
	token := o.token
	o.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+token {
		o.writeError(w, fakeFailure{status: 401, code: "unauthorized"})
		return false
	}
	if !strings.HasPrefix(r.Header.Get("User-Agent"), "scantor-node/") {
		o.t.Errorf("unexpected User-Agent %q", r.Header.Get("User-Agent"))
	}
	o.mu.Lock()
	f, ok := o.failRoutes[route]
	if ok {
		if f.times > 0 {
			f.times--
			if f.times == 0 {
				delete(o.failRoutes, route)
			} else {
				o.failRoutes[route] = f
			}
		}
	}
	o.mu.Unlock()
	if ok {
		o.writeError(w, f)
		return false
	}
	return true
}

func (o *fakeOrchestrator) fail(route string, f fakeFailure) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.failRoutes[route] = f
}

func (o *fakeOrchestrator) clearFailures() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.failRoutes = map[string]fakeFailure{}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (o *fakeOrchestrator) hello(w http.ResponseWriter, r *http.Request) {
	if !o.check(w, r, "hello") {
		return
	}
	var req api.NodeHelloRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		o.t.Errorf("hello body: %v", err)
	}
	o.mu.Lock()
	o.hellos = append(o.hellos, req)
	o.helloHeaders = append(o.helloHeaders, r.Header.Clone())
	resp := api.NodeHelloResponse{
		ServerTime: time.Now().UnixMilli(),
		Node:       api.NodeIdentity{ID: o.nodeID, Name: "test-node", BuiltIn: o.builtIn, EndpointProfile: "public", Pool: "shared", Labels: map[string]string{}},
		Config:     o.config,
	}
	o.mu.Unlock()
	writeJSON(w, resp)
}

func (o *fakeOrchestrator) assignments(w http.ResponseWriter, r *http.Request) {
	if !o.check(w, r, "assignments") {
		return
	}
	rev, _ := strconv.ParseInt(r.URL.Query().Get("rev"), 10, 64)
	wait, _ := strconv.Atoi(r.URL.Query().Get("wait"))
	o.mu.Lock()
	o.assignCalls++
	o.instanceIDs = append(o.instanceIDs, r.Header.Get(api.HeaderInstanceID))
	deadline := time.Now().Add(time.Duration(wait) * time.Second)
	if wait > 0 {
		go func() {
			select {
			case <-time.After(time.Duration(wait) * time.Second):
			case <-r.Context().Done():
			}
			o.mu.Lock()
			o.cond.Broadcast()
			o.mu.Unlock()
		}()
	}
	for wait > 0 && o.rev <= rev && time.Now().Before(deadline) && r.Context().Err() == nil {
		o.cond.Wait()
	}
	resp := api.NodeAssignments{ServerTime: time.Now().UnixMilli(), Rev: o.rev, Workers: append([]api.Assignment{}, o.workers...), LogRequests: append([]api.LogRequest{}, o.logRequests...)}
	o.mu.Unlock()
	writeJSON(w, resp)
}

func (o *fakeOrchestrator) status(w http.ResponseWriter, r *http.Request) {
	if !o.check(w, r, "status") {
		return
	}
	var req api.NodeStatusRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		o.t.Errorf("status body: %v", err)
	}
	o.mu.Lock()
	o.statuses = append(o.statuses, req)
	resp := api.NodeStatusResponse{ServerTime: time.Now().UnixMilli(), Rev: o.rev, NextStatusMs: o.config.StatusIntervalMs}
	o.mu.Unlock()
	writeJSON(w, resp)
}

func (o *fakeOrchestrator) workerLogs(w http.ResponseWriter, r *http.Request) {
	if !o.check(w, r, "logs") {
		return
	}
	var req api.WorkerLogsUpload
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		o.t.Errorf("logs body: %v", err)
	}
	o.mu.Lock()
	o.logs[r.PathValue("workerId")] = append(o.logs[r.PathValue("workerId")], req)
	// Answered requests are closed.
	o.logRequests = removeLogRequest(o.logRequests, req.RequestID)
	o.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func removeLogRequest(reqs []api.LogRequest, id string) []api.LogRequest {
	out := reqs[:0]
	for _, r := range reqs {
		if r.RequestID != id {
			out = append(out, r)
		}
	}
	return out
}

// setDesired replaces the desired set and bumps the revision.
func (o *fakeOrchestrator) setDesired(workers ...api.Assignment) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.workers = workers
	o.rev++
	o.cond.Broadcast()
}

func (o *fakeOrchestrator) addLogRequest(req api.LogRequest) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.logRequests = append(o.logRequests, req)
	o.rev++
	o.cond.Broadcast()
}

func (o *fakeOrchestrator) lastStatus() *api.NodeStatusRequest {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.statuses) == 0 {
		return nil
	}
	s := o.statuses[len(o.statuses)-1]
	return &s
}

func (o *fakeOrchestrator) statusCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.statuses)
}

func (o *fakeOrchestrator) helloCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.hellos)
}

// workerStatus returns the last reported entry of a worker.
func (o *fakeOrchestrator) workerStatus(workerID string) *api.NodeWorkerStatus {
	st := o.lastStatus()
	if st == nil {
		return nil
	}
	for _, w := range st.Workers {
		if w.WorkerID == workerID {
			return &w
		}
	}
	return nil
}
