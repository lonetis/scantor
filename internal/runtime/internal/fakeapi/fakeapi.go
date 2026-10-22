// Package fakeapi is a fake orchestrator for the runtime's tests: an httptest server implementing the
// runtime API (/api/runtime/*, docs/api.md §8) and a presigned-PUT endpoint, with hooks to script
// responses and a record of every request.
package fakeapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/keys"
)

// Secret is the SCANTOR_SECRET the fake derives tokens from.
const Secret = "fake-secret-for-runtime-tests-only-0123456789"

// Token returns a well-formed worker token for workerID.
func Token(workerID string) string {
	t, err := keys.WorkerToken(Secret, workerID, "scan", "runner", "node")
	if err != nil {
		panic(err)
	}
	return t
}

// Server is the fake orchestrator. Hooks may be replaced before or during a test (under Lock).
type Server struct {
	*httptest.Server

	mu sync.Mutex
	// Bootstrap is returned by GET /api/runtime/bootstrap (serverTime is filled in).
	Bootstrap api.Bootstrap
	// BootstrapFailures makes the first n bootstrap calls fail with BootstrapStatus.
	BootstrapFailures int
	BootstrapStatus   int
	// State answers state polls; nil answers {action: run, processes: Bootstrap.Scan.Settings.Processes}.
	State func(api.RuntimeStateRequest) (api.RuntimeStateResponse, int)
	// Presign answers presign calls; nil presigns PUTs to this server's /s3/ prefix.
	Presign func(api.PresignRequest) (any, int)
	// Statuses are the stored analyses by seq for analyses/status.
	Statuses map[int64]api.AnalysisStatusItem
	// StatusDelay delays analyses/status responses.
	StatusDelay time.Duration
	// Epoch is the current scheduler epoch; calls with an older epoch get 409 staleEpoch.
	Epoch int
	// StoredResolutions answer scheduler/resolved with stored: false when a key exists.
	StoredResolutions map[string]api.Resolution
	// CheckpointStatus fails checkpoints with this status when non-zero.
	CheckpointStatus int
	// PutStatus fails presigned PUTs with this status when non-zero.
	PutStatus int

	// Records.
	States      []api.RuntimeStateRequest
	PresignReqs []api.PresignRequest
	StatusReqs  []api.AnalysesStatusRequest
	Resolveds   []api.SchedulerResolvedRequest
	Checkpoints []api.SchedulerCheckpointRequest
	Dones       []api.SchedulerDoneRequest
	Errors      []api.RuntimeErrorReport
	Puts        map[string]Put
	Headers     []http.Header
}

// Put is a received presigned PUT.
type Put struct {
	Body    []byte
	Headers http.Header
}

// New starts a fake orchestrator.
func New() *Server {
	s := &Server{Statuses: map[int64]api.AnalysisStatusItem{}, StoredResolutions: map[string]api.Resolution{}, Puts: map[string]Put{}, Epoch: 1}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	return s
}

// Lock locks the server's state (for reading records or changing hooks).
func (s *Server) Lock() { s.mu.Lock() }

// Unlock unlocks the server's state.
func (s *Server) Unlock() { s.mu.Unlock() }

// Snapshot runs fn with the state locked.
func (s *Server) Snapshot(fn func(s *Server)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, status int, code, message string, details any) {
	body := map[string]any{"code": code, "message": message}
	if details != nil {
		body["details"] = details
	}
	writeJSON(w, status, map[string]any{"error": body})
}

func decode[T any](r *http.Request) (T, error) {
	var v T
	err := json.NewDecoder(r.Body).Decode(&v)
	return v, err
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/s3/") {
		s.put(w, r)
		return
	}
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer swt_") {
		apiError(w, http.StatusUnauthorized, "unauthorized", "missing worker token", nil)
		return
	}
	s.mu.Lock()
	s.Headers = append(s.Headers, r.Header.Clone())
	s.mu.Unlock()
	switch r.URL.Path {
	case "/api/runtime/bootstrap":
		s.bootstrap(w)
	case "/api/runtime/state":
		s.state(w, r)
	case "/api/runtime/uploads/presign":
		s.presign(w, r)
	case "/api/runtime/analyses/status":
		s.status(w, r)
	case "/api/runtime/scheduler/resolved":
		s.resolved(w, r)
	case "/api/runtime/scheduler/checkpoint":
		s.checkpoint(w, r)
	case "/api/runtime/scheduler/done":
		s.done(w, r)
	case "/api/runtime/errors":
		s.errorReport(w, r)
	default:
		apiError(w, http.StatusNotFound, "notFound", "no such route", nil)
	}
}

func (s *Server) bootstrap(w http.ResponseWriter) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.BootstrapFailures > 0 {
		s.BootstrapFailures--
		apiError(w, s.BootstrapStatus, "unavailable", "scripted failure", nil)
		return
	}
	b := s.Bootstrap
	b.ServerTime = time.Now().UnixMilli()
	writeJSON(w, http.StatusOK, b)
}

func (s *Server) state(w http.ResponseWriter, r *http.Request) {
	req, err := decode[api.RuntimeStateRequest](r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "badRequest", err.Error(), nil)
		return
	}
	s.mu.Lock()
	s.States = append(s.States, req)
	hook := s.State
	processes := s.Bootstrap.Scan.Settings.Processes
	s.mu.Unlock()
	resp, status := api.RuntimeStateResponse{Action: api.ActionRun, Processes: processes, ScanState: "running", NextPollMs: 200}, http.StatusOK
	if hook != nil {
		resp, status = hook(req)
	}
	if status != http.StatusOK {
		apiError(w, status, "scripted", "scripted state failure", nil)
		return
	}
	resp.ServerTime = time.Now().UnixMilli()
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) presign(w http.ResponseWriter, r *http.Request) {
	req, err := decode[api.PresignRequest](r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "badRequest", err.Error(), nil)
		return
	}
	s.mu.Lock()
	s.PresignReqs = append(s.PresignReqs, req)
	hook := s.Presign
	s.mu.Unlock()
	if hook != nil {
		body, status := hook(req)
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, http.StatusOK, s.DefaultPresign(req))
}

// DefaultPresign presigns PUTs to /s3/<executionId>/<fileId> on this server.
func (s *Server) DefaultPresign(req api.PresignRequest) api.PresignResponse {
	var out api.PresignResponse
	for _, f := range req.Files {
		out.Files = append(out.Files, api.PresignedUpload{
			FileID: f.FileID, Name: f.Name, Method: http.MethodPut,
			URL:       s.URL + "/s3/" + req.ExecutionID + "/" + f.FileID + "?X-Amz-Signature=fake",
			Headers:   map[string]string{"Content-Type": f.ContentType, "Content-Length": itoa(f.Size)},
			ExpiresAt: api.NewTime(time.Now().Add(15 * time.Minute)),
		})
	}
	return out
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func (s *Server) put(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "" {
		w.WriteHeader(http.StatusBadRequest) // presigned URLs must not carry the worker token
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	status := s.PutStatus
	if status == 0 {
		s.Puts[strings.TrimPrefix(r.URL.Path, "/s3/")] = Put{Body: body, Headers: r.Header.Clone()}
	}
	s.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	req, err := decode[api.AnalysesStatusRequest](r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "badRequest", err.Error(), nil)
		return
	}
	s.mu.Lock()
	s.StatusReqs = append(s.StatusReqs, req)
	delay := s.StatusDelay
	var out api.AnalysesStatusResponse
	for _, seq := range req.Seqs {
		item, ok := s.Statuses[seq]
		if !ok {
			item = api.AnalysisStatusItem{Seq: seq}
		}
		out.Items = append(out.Items, item)
	}
	s.mu.Unlock()
	time.Sleep(delay)
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) staleEpoch(w http.ResponseWriter, epoch int) bool {
	if epoch < s.Epoch {
		apiError(w, http.StatusConflict, api.CodeStaleEpoch, "scheduler epoch was superseded", map[string]any{"currentEpoch": s.Epoch})
		return true
	}
	return false
}

func (s *Server) resolved(w http.ResponseWriter, r *http.Request) {
	req, err := decode[api.SchedulerResolvedRequest](r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "badRequest", err.Error(), nil)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.staleEpoch(w, req.Epoch) {
		return
	}
	s.Resolveds = append(s.Resolveds, req)
	if stored, ok := s.StoredResolutions[req.Key]; ok {
		writeJSON(w, http.StatusOK, api.SchedulerResolvedResponse{Stored: false, Resolution: stored})
		return
	}
	res := api.Resolution{Template: req.Template, ScanConfig: req.ScanConfig, Provenance: req.Provenance, ExpectedTotal: req.ExpectedTotal, At: api.Now()}
	s.StoredResolutions[req.Key] = res
	writeJSON(w, http.StatusOK, api.SchedulerResolvedResponse{Stored: true, Resolution: res})
}

func (s *Server) checkpoint(w http.ResponseWriter, r *http.Request) {
	req, err := decode[api.SchedulerCheckpointRequest](r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "badRequest", err.Error(), nil)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.staleEpoch(w, req.Epoch) {
		return
	}
	if s.CheckpointStatus != 0 {
		apiError(w, s.CheckpointStatus, "unavailable", "scripted checkpoint failure", nil)
		return
	}
	s.Checkpoints = append(s.Checkpoints, req)
	writeJSON(w, http.StatusOK, api.SchedulerCheckpointResponse{Confirmed: req.Confirmed, TailHash: req.TailHash, ServerTime: time.Now().UnixMilli()})
}

func (s *Server) done(w http.ResponseWriter, r *http.Request) {
	req, err := decode[api.SchedulerDoneRequest](r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "badRequest", err.Error(), nil)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.staleEpoch(w, req.Epoch) {
		return
	}
	s.Dones = append(s.Dones, req)
	state := "done"
	if req.Outcome == api.OutcomeFailed {
		state = "failed"
	}
	writeJSON(w, http.StatusOK, api.SchedulerDoneResponse{ServerTime: time.Now().UnixMilli(), Scheduling: api.SchedulingState{State: state, Confirmed: req.Confirmed}})
}

func (s *Server) errorReport(w http.ResponseWriter, r *http.Request) {
	req, err := decode[api.RuntimeErrorReport](r)
	if err != nil {
		apiError(w, http.StatusBadRequest, "badRequest", err.Error(), nil)
		return
	}
	s.mu.Lock()
	s.Errors = append(s.Errors, req)
	s.mu.Unlock()
	writeJSON(w, http.StatusAccepted, api.RuntimeErrorResponse{Recorded: true})
}

// NewID returns a fresh uuid.
func NewID() string { return uuid.NewString() }
