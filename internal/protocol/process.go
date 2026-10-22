package protocol

import "time"

// The connector-visible process contract (docs/protocol.md §10.2): file descriptors, the protocol
// environment variables the runtime sets for every connector process, and the handshake and termination
// timers of protocol v1 (§10.3, §10.4).

// File descriptors of a connector process.
const (
	// InFD is the fd the connector reads runtime requests from.
	InFD = 3
	// OutFD is the fd the connector writes its messages to.
	OutFD = 4
)

// Environment variables the runtime sets for every connector process.
const (
	// EnvInFD carries InFD.
	EnvInFD = "SCANTOR_PROTOCOL_IN_FD"
	// EnvOutFD carries OutFD.
	EnvOutFD = "SCANTOR_PROTOCOL_OUT_FD"
	// EnvVersions carries SupportedVersions() (informational; negotiation happens in hello/welcome).
	EnvVersions = "SCANTOR_PROTOCOL_VERSIONS"
	// EnvProcessIndex carries the 0-based slot index, stable across respawns of the slot.
	EnvProcessIndex = "SCANTOR_PROCESS_INDEX"
)

// RuntimeOnlyEnv lists the variables the runtime removes from the environment of connector processes,
// so user code never sees platform credentials (docs/runtime.md §3.4).
var RuntimeOnlyEnv = []string{
	"SCANTOR_WORKER_TOKEN",
	"SCANTOR_URL",
	"SCANTOR_CA_CERT",
	"SCANTOR_ALLOW_INSECURE_TRANSPORT",
}

// Timers of protocol v1. Debug mode (`scantor dev debug`) disables the hello and ready timeouts.
const (
	// HelloTimeout bounds the time from spawn to hello.
	HelloTimeout = 30 * time.Second
	// ReadyTimeout bounds the time from welcome to ready (imports can be slow).
	ReadyTimeout = 120 * time.Second
	// DescriptionTimeout bounds the time from describe to description.
	DescriptionTimeout = 60 * time.Second
	// CancelGrace is the time a connector has to end a cancelled request (welcome.cancelGraceMs).
	CancelGrace = 5 * time.Second
	// ShutdownGrace is the time an idle connector has to exit after shutdown (shutdown.graceMs).
	ShutdownGrace = 5 * time.Second
)
