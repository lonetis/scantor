package api

// Health is the response of getHealth.
type Health struct {
	Status     string            `json:"status"`
	Version    string            `json:"version"`
	Components map[string]string `json:"components"`
	Alarms     []string          `json:"alarms"`
}

// InstanceFeatures are the optional features of an instance.
type InstanceFeatures struct {
	Passkeys bool `json:"passkeys"`
	MCP      bool `json:"mcp"`
	MCPOAuth bool `json:"mcpOAuth"`
	Editor   bool `json:"editor"`
}

// InstanceLimits are the user-visible limits of an instance.
type InstanceLimits struct {
	MaxWorkersPerScan     int   `json:"maxWorkersPerScan"`
	MaxProcessesPerWorker int   `json:"maxProcessesPerWorker"`
	MaxResultBytes        int64 `json:"maxResultBytes"`
	MaxFileBytes          int64 `json:"maxFileBytes"`
	ScanConfirmThreshold  int64 `json:"scanConfirmThreshold"`
	WaitMaxSeconds        int   `json:"waitMaxSeconds"`
}

// AdminTool is one admin GUI link.
type AdminTool struct {
	Target string  `json:"target"`
	Title  string  `json:"title"`
	URL    *string `json:"url"`
}

// AdminTools lists the admin GUIs (admins only).
type AdminTools struct {
	Enabled bool        `json:"enabled"`
	Items   []AdminTool `json:"items"`
}

// InstanceUser is the caller as reported by getInstanceInfo.
type InstanceUser struct {
	ID   string `json:"id"`
	Role string `json:"role"`
}

// InstanceInfo is the response of getInstanceInfo (docs/api.md §4.1).
type InstanceInfo struct {
	Version            string           `json:"version"`
	PublicURL          string           `json:"publicUrl"`
	EditorURL          string           `json:"editorUrl"`
	MCPURL             *string          `json:"mcpUrl"`
	RegistryPublicHost string           `json:"registryPublicHost"`
	CLIImage           string           `json:"cliImage"`
	Features           InstanceFeatures `json:"features"`
	Limits             InstanceLimits   `json:"limits"`
	User               InstanceUser     `json:"user"`
	AdminTools         *AdminTools      `json:"adminTools,omitempty"`
}

// UserUsage counts a user's resources.
type UserUsage struct {
	ActiveWorkers int `json:"activeWorkers"`
	Tasks         int `json:"tasks"`
	Scans         int `json:"scans"`
}

// User is the API representation of a user (admin routes).
type User struct {
	ID               string    `json:"id"`
	Email            string    `json:"email"`
	Name             string    `json:"name"`
	Role             string    `json:"role"`
	Banned           bool      `json:"banned"`
	BanReason        *string   `json:"banReason"`
	CanRunPrivileged bool      `json:"canRunPrivileged"`
	MaxWorkers       int       `json:"maxWorkers"`
	CreatedAt        Time      `json:"createdAt"`
	UpdatedAt        Time      `json:"updatedAt"`
	Usage            UserUsage `json:"usage"`
}

// AccountCredentials summarises the sign-in credentials of an account.
type AccountCredentials struct {
	HasPassword  bool `json:"hasPassword"`
	PasskeyCount int  `json:"passkeyCount"`
}

// Account is the response of getAccount.
type Account struct {
	ID               string             `json:"id"`
	Email            string             `json:"email"`
	Name             string             `json:"name"`
	Role             string             `json:"role"`
	CanRunPrivileged bool               `json:"canRunPrivileged"`
	MaxWorkers       int                `json:"maxWorkers"`
	Credentials      AccountCredentials `json:"credentials"`
	CreatedAt        Time               `json:"createdAt"`
}

// APIKey is the API representation of an API key (never with the key itself).
type APIKey struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Start       string `json:"start"`
	ConfigID    string `json:"configId"`
	Enabled     bool   `json:"enabled"`
	CreatedAt   Time   `json:"createdAt"`
	ExpiresAt   *Time  `json:"expiresAt"`
	LastRequest *Time  `json:"lastRequest"`
}

// Node states (docs/data-model.md §6.7).
const (
	NodePending = "pending"
	NodeOnline  = "online"
	NodeOffline = "offline"
	NodeRevoked = "revoked"
)

// Endpoint profiles (docs/architecture.md §8).
const (
	ProfileInternal = "internal"
	ProfilePublic   = "public"
)

// DinD modes of a node (docs/nodes.md §6.9).
const (
	DinDDisabled   = "disabled"
	DinDSysbox     = "sysbox"
	DinDPrivileged = "privileged"
)

// NodeInstance is the lease holder of a node.
type NodeInstance struct {
	Version    string `json:"version"`
	StartedAt  Time   `json:"startedAt"`
	LastSeenAt Time   `json:"lastSeenAt"`
}

// NodeInfoRecord is the last reported info of a node.
type NodeInfoRecord struct {
	Version           string `json:"version"`
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
	ClockOffsetMs     int64  `json:"clockOffsetMs"`
}

// Node is the API representation of a node (docs/api.md §2).
type Node struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	BuiltIn         bool              `json:"builtIn"`
	State           string            `json:"state"`
	EndpointProfile string            `json:"endpointProfile"`
	TokenPrefix     string            `json:"tokenPrefix,omitempty"`
	TokenRotatedAt  *Time             `json:"tokenRotatedAt"`
	Pool            string            `json:"pool"`
	Labels          map[string]string `json:"labels"`
	MaxWorkers      *int              `json:"maxWorkers"`
	Cordoned        bool              `json:"cordoned"`
	Instance        *NodeInstance     `json:"instance"`
	Info            *NodeInfoRecord   `json:"info"`
	AssignmentsRev  int64             `json:"assignmentsRev"`
	LastSeenAt      *Time             `json:"lastSeenAt"`
	CreatedBy       *string           `json:"createdBy"`
	ActiveWorkers   int               `json:"activeWorkers"`
	CreatedAt       Time              `json:"createdAt"`
	UpdatedAt       Time              `json:"updatedAt"`
}

// CreateNode is the body of createNode.
type CreateNode struct {
	Name       string            `json:"name"`
	Pool       string            `json:"pool,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
	MaxWorkers *int              `json:"maxWorkers,omitempty"`
}

// UpdateNode is the body of updateNode. Labels replaces all labels when non-empty; set ClearLabels to
// send {} (remove every label). MaxWorkers is omitted when nil; set ClearMaxWorkers to send null. The
// Clear flags win over the values.
type UpdateNode struct {
	Name            *string           `json:"name,omitempty"`
	Pool            *string           `json:"pool,omitempty"`
	Labels          map[string]string `json:"labels,omitempty"`
	ClearLabels     bool              `json:"-"`
	MaxWorkers      *int              `json:"-"`
	ClearMaxWorkers bool              `json:"-"`
	Cordoned        *bool             `json:"cordoned,omitempty"`
}

// MarshalJSON encodes labels as the map, as {} (ClearLabels) or omits them, and maxWorkers as a number,
// as null (ClearMaxWorkers) or omits it.
func (u UpdateNode) MarshalJSON() ([]byte, error) {
	type plain UpdateNode
	out := struct {
		plain
		Labels     any `json:"labels,omitempty"`
		MaxWorkers any `json:"maxWorkers,omitempty"`
	}{plain: plain(u)}
	switch {
	case u.ClearLabels:
		out.Labels = map[string]string{}
	case len(u.Labels) > 0:
		out.Labels = u.Labels
	}
	switch {
	case u.ClearMaxWorkers:
		out.MaxWorkers = nullValue{}
	case u.MaxWorkers != nil:
		out.MaxWorkers = *u.MaxWorkers
	}
	return marshalNoEscape(out)
}

// NodeJoinEnv is the environment of a node join snippet.
type NodeJoinEnv struct {
	URL       string `json:"SCANTOR_URL"`
	NodeToken string `json:"SCANTOR_NODE_TOKEN"`
}

// NodeJoin holds the commands that start a node daemon.
type NodeJoin struct {
	DockerRun string      `json:"dockerRun"`
	Compose   string      `json:"compose"`
	Env       NodeJoinEnv `json:"env"`
}

// NodeWithToken is the response of createNode and rotateNodeToken; Token is shown once.
type NodeWithToken struct {
	Node  Node     `json:"node"`
	Token string   `json:"token"`
	Join  NodeJoin `json:"join"`
}
