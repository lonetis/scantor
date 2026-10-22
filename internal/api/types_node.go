package api

// Wire types of the node API (/api/node/*, docs/api.md §7). Every response carries serverTime (epoch
// milliseconds); the daemon keeps clockOffsetMs = serverTime + rtt/2 − localNow (see ClockOffset).

// Header names of the machine APIs.
const (
	HeaderVersion    = "X-Scantor-Version"
	HeaderInstanceID = "X-Scantor-Instance-Id"
	HeaderRequestID  = "X-Request-Id"
	HeaderWait       = "Scantor-Wait"
)

// Values of the Scantor-Wait response header.
const (
	WaitSettled = "settled"
	WaitTimeout = "timeout"
)

// NodeHelloInfo is the host information a daemon reports in hello.
type NodeHelloInfo struct {
	Hostname          string `json:"hostname"`
	OS                string `json:"os"`
	Arch              string `json:"arch"`
	Kernel            string `json:"kernel"`
	DockerVersion     string `json:"dockerVersion"`
	CPUs              int    `json:"cpus"`
	MemoryBytes       int64  `json:"memoryBytes"`
	DiskFreeBytes     int64  `json:"diskFreeBytes"`
	DinDMode          string `json:"dindMode"`
	MaxWorkers        int    `json:"maxWorkers"`
	EgressDenyApplied bool   `json:"egressDenyApplied"`
}

// NodeContainer is a managed worker container found at daemon start (for adoption).
type NodeContainer struct {
	WorkerID    string `json:"workerId"`
	ContainerID string `json:"containerId"`
	State       string `json:"state"`
	SpecHash    string `json:"specHash"`
}

// NodeHelloRequest is the body of POST /api/node/hello. InstanceID is "<docker engine id>:<nonce>".
type NodeHelloRequest struct {
	InstanceID string          `json:"instanceId"`
	Version    string          `json:"version"`
	Info       NodeHelloInfo   `json:"info"`
	Containers []NodeContainer `json:"containers"`
}

// NodeIdentity is the node record as returned by hello.
type NodeIdentity struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	BuiltIn         bool              `json:"builtIn"`
	EndpointProfile string            `json:"endpointProfile"`
	Pool            string            `json:"pool"`
	Labels          map[string]string `json:"labels"`
}

// NodeRegistryConfig tells the daemon how to authenticate task image pulls.
type NodeRegistryConfig struct {
	Host     string `json:"host"`
	Username string `json:"username"`
}

// NodeConfig are the orchestrator-side settings delivered in hello.
type NodeConfig struct {
	StatusIntervalMs       int64              `json:"statusIntervalMs"`
	AssignmentsWaitSeconds int                `json:"assignmentsWaitSeconds"`
	OfflineAfterMs         int64              `json:"offlineAfterMs"`
	DrainGraceMs           int64              `json:"drainGraceMs"`
	Registry               NodeRegistryConfig `json:"registry"`
	MinFreeDiskBytes       int64              `json:"minFreeDiskBytes"`
}

// NodeHelloResponse is the response of POST /api/node/hello.
type NodeHelloResponse struct {
	ServerTime int64        `json:"serverTime"`
	Node       NodeIdentity `json:"node"`
	Config     NodeConfig   `json:"config"`
}

// AssignmentResources are the container limits of an assignment:
// memoryBytes = processes × memoryMiB × 1 MiB + 256 MiB, nanoCpus = processes × cpus × 10⁹.
type AssignmentResources struct {
	NanoCPUs    int64 `json:"nanoCpus"`
	MemoryBytes int64 `json:"memoryBytes"`
}

// Assignment is one entry of a node's desired worker set.
type Assignment struct {
	WorkerID   string              `json:"workerId"`
	ScanID     string              `json:"scanId"`
	UserID     string              `json:"userId"`
	Role       string              `json:"role"`
	SpecHash   string              `json:"specHash"`
	Image      string              `json:"image"`
	BaseImage  *string             `json:"baseImage"`
	Processes  int                 `json:"processes"`
	Resources  AssignmentResources `json:"resources"`
	Privileged bool                `json:"privileged"`
	DinDMode   *string             `json:"dindMode"`
	CapAdd     []string            `json:"capAdd"`
	Env        map[string]string   `json:"env"`
}

// LogRequest asks the daemon for a fresh log tail of a worker.
type LogRequest struct {
	RequestID string `json:"requestId"`
	WorkerID  string `json:"workerId"`
	TailBytes int    `json:"tailBytes"`
}

// NodeAssignments is the response of GET /api/node/assignments: always the complete desired set.
type NodeAssignments struct {
	ServerTime  int64        `json:"serverTime"`
	Rev         int64        `json:"rev"`
	Workers     []Assignment `json:"workers"`
	LogRequests []LogRequest `json:"logRequests"`
}

// Reported worker states of a node status (docs/api.md §7.3).
const (
	NodeWorkerPulling  = "pulling"
	NodeWorkerStarting = "starting"
	NodeWorkerRunning  = "running"
	NodeWorkerBackoff  = "backoff"
	NodeWorkerStopping = "stopping"
	NodeWorkerRemoved  = "removed"
	NodeWorkerError    = "error"
)

// Error codes of reported workers.
const (
	NodeWorkerImagePullFailed  = "imagePullFailed"
	NodeWorkerCreateFailed     = "createFailed"
	NodeWorkerPlatformMismatch = "platformMismatch"
)

// AppliedLimits are the limits a daemon applied to a worker container.
type AppliedLimits struct {
	Processes   int   `json:"processes"`
	NanoCPUs    int64 `json:"nanoCpus"`
	MemoryBytes int64 `json:"memoryBytes"`
}

// NodeWorkerExit is the last exit of a worker container (logTail ≤ 4 KiB).
type NodeWorkerExit struct {
	ExitCode  int    `json:"exitCode"`
	OOMKilled bool   `json:"oomKilled"`
	At        Time   `json:"at"`
	LogTail   string `json:"logTail"`
}

// NodeWorkerPull describes an image pull in progress.
type NodeWorkerPull struct {
	Image     string `json:"image"`
	StartedAt Time   `json:"startedAt"`
}

// NodeWorkerFailure describes why a worker could not be pulled or created.
type NodeWorkerFailure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// NodeWorkerStatus is one worker entry of a status report.
type NodeWorkerStatus struct {
	WorkerID      string             `json:"workerId"`
	State         string             `json:"state"`
	ContainerID   string             `json:"containerId,omitempty"`
	StartedAt     *Time              `json:"startedAt,omitempty"`
	Restarts      *int               `json:"restarts,omitempty"`
	Applied       *AppliedLimits     `json:"applied,omitempty"`
	LastExit      *NodeWorkerExit    `json:"lastExit,omitempty"`
	NextRestartAt *Time              `json:"nextRestartAt,omitempty"`
	Pull          *NodeWorkerPull    `json:"pull,omitempty"`
	Error         *NodeWorkerFailure `json:"error,omitempty"`
}

// NodeStatusInfo is the host information repeated in every status report.
type NodeStatusInfo struct {
	Version           string `json:"version"`
	CPUs              int    `json:"cpus"`
	MemoryBytes       int64  `json:"memoryBytes"`
	DiskFreeBytes     int64  `json:"diskFreeBytes"`
	DinDMode          string `json:"dindMode"`
	MaxWorkers        int    `json:"maxWorkers"`
	EgressDenyApplied bool   `json:"egressDenyApplied"`
}

// NodeStatusRequest is the body of POST /api/node/status: a complete snapshot of the node's workers.
type NodeStatusRequest struct {
	InstanceID    string             `json:"instanceId"`
	AppliedRev    int64              `json:"appliedRev"`
	ClockOffsetMs int64              `json:"clockOffsetMs"`
	Info          NodeStatusInfo     `json:"info"`
	Workers       []NodeWorkerStatus `json:"workers"`
}

// NodeStatusResponse is the response of POST /api/node/status; Rev > appliedRev means "poll
// assignments now".
type NodeStatusResponse struct {
	ServerTime   int64 `json:"serverTime"`
	Rev          int64 `json:"rev"`
	NextStatusMs int64 `json:"nextStatusMs"`
}

// WorkerLogsUpload is the body of POST /api/node/workers/{workerId}/logs.
type WorkerLogsUpload struct {
	RequestID   string `json:"requestId"`
	Text        string `json:"text"`
	Bytes       int    `json:"bytes"`
	Truncated   bool   `json:"truncated"`
	CollectedAt Time   `json:"collectedAt"`
}
