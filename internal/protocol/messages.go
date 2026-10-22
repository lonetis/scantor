// Package protocol implements the connector protocol (docs/protocol.md): every message type of
// protocol v1 and an NDJSON codec over arbitrary readers and writers (fd 3: runtime → connector, fd 4:
// connector → runtime). Schemas live in schemas/protocol/ and are embedded; Validator checks lines
// against them.
//
// A message's `type` is not a struct field: Marshal and Encoder add it, and Decoder selects the struct
// from it. Required nullable fields are pointers without omitempty, so they encode as null.
package protocol

import "encoding/json"

// Version is the protocol version this runtime implements; it also supports Version−1.
const Version = 1

// MinVersion is the oldest protocol version this runtime still supports (N−1, but at least 1).
const MinVersion = max(1, Version-1)

// Fixed limits and timers of protocol v1 (docs/protocol.md §9, §10).
const (
	MaxLineBytes         = 8 << 20
	MaxIDLength          = 64
	MaxCredit            = 65536
	MaxLogMessageBytes   = 16 << 10
	MaxLogFieldsBytes    = 16 << 10
	MaxProgressMessage   = 256
	MaxErrorMessageBytes = 4 << 10
	MaxErrorStackBytes   = 16 << 10
	MaxErrorDetailsBytes = 4 << 10
	MaxDescriptionBytes  = 1 << 20
	MaxSchemaBytes       = 256 << 10
	MaxWarnings          = 100
	MaxWarningLength     = 1000
)

// HelloID is the fixed id of the handshake messages.
const HelloID = "hello"

// Message types.
const (
	TypeHello          = "hello"
	TypeWelcome        = "welcome"
	TypeReady          = "ready"
	TypeDescribe       = "describe"
	TypeDescription    = "description"
	TypeSchedule       = "schedule"
	TypeAnalysis       = "analysis"
	TypeDone           = "done"
	TypeRun            = "run"
	TypeResult         = "result"
	TypeError          = "error"
	TypeCancel         = "cancel"
	TypeShutdown       = "shutdown"
	TypeFile           = "file"
	TypeFileRef        = "fileRef"
	TypeLog            = "log"
	TypeProgress       = "progress"
	TypeTemplate       = "template"
	TypeTemplateItem   = "templateItem"
	TypeTemplateCredit = "templateCredit"
	TypeTemplateCancel = "templateCancel"
	TypeTemplateDone   = "templateDone"
)

// Message is any protocol message.
type Message interface {
	// MessageType returns the `type` field of the message.
	MessageType() string
}

// Modes announced in welcome.
const (
	ModeWorker   = "worker"
	ModeLocal    = "local"
	ModeDescribe = "describe"
)

// Cancel reasons.
const (
	CancelDrain = "drain"
	CancelStop  = "stop"
)

// Error types of the protocol error object.
const (
	ErrorTaskError  = "taskError"
	ErrorFatal      = "fatal"
	ErrorRetry      = "retry"
	ErrorTimeout    = "timeout"
	ErrorCrash      = "crash"
	ErrorValidation = "validation"
	ErrorPlatform   = "platform"
	ErrorCancelled  = "cancelled"
)

// Log levels.
const (
	LevelDebug   = "debug"
	LevelInfo    = "info"
	LevelWarning = "warning"
	LevelError   = "error"
)

// ProtocolRange is the {min, max} range a connector implements.
type ProtocolRange struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// ConnectorInfo identifies a connector in hello.
type ConnectorInfo struct {
	Language string `json:"language"`
	Version  string `json:"version"`
	Runtime  string `json:"runtime,omitempty"`
}

// Hello is the first message of every connector process (C → R).
type Hello struct {
	ID        string        `json:"id"`
	Protocol  ProtocolRange `json:"protocol"`
	Connector ConnectorInfo `json:"connector"`
	PID       int           `json:"pid"`
}

// RuntimeInfo identifies the runtime in welcome.
type RuntimeInfo struct {
	Version string `json:"version"`
}

// Limits are the limits announced in welcome.
type Limits struct {
	MaxLineBytes           int64 `json:"maxLineBytes"`
	MaxResultBytes         int64 `json:"maxResultBytes"`
	MaxAnalysisConfigBytes int64 `json:"maxAnalysisConfigBytes"`
	MaxFileBytes           int64 `json:"maxFileBytes"`
	MaxFilesPerAnalysis    int   `json:"maxFilesPerAnalysis"`
}

// Welcome answers hello with the negotiated version (R → C).
type Welcome struct {
	ID              string      `json:"id"`
	ProtocolVersion int         `json:"protocolVersion"`
	Mode            string      `json:"mode"`
	Runtime         RuntimeInfo `json:"runtime"`
	Limits          Limits      `json:"limits"`
	CancelGraceMs   int64       `json:"cancelGraceMs"`
}

// Ready says the entry was imported and the definition is valid (C → R).
type Ready struct {
	ID string `json:"id"`
}

// Describe requests the task description (R → C).
type Describe struct {
	ID string `json:"id"`
}

// Schemas holds the raw JSON Schemas of a description.
type Schemas struct {
	TaskConfig     json.RawMessage `json:"taskConfig"`
	ScanConfig     json.RawMessage `json:"scanConfig"`
	AnalysisConfig json.RawMessage `json:"analysisConfig"`
	Result         json.RawMessage `json:"result"`
}

// ScheduleInfo is `{kind: "custom"}` or `{kind: "template", template}`.
type ScheduleInfo struct {
	Kind     string `json:"kind"`
	Template string `json:"template,omitempty"`
}

// Description answers describe (C → R).
type Description struct {
	ID       string       `json:"id"`
	Schemas  Schemas      `json:"schemas"`
	Schedule ScheduleInfo `json:"schedule"`
	Warnings []string     `json:"warnings"`
}

// MarshalJSON encodes nil warnings as an empty list.
func (d Description) MarshalJSON() ([]byte, error) {
	type plain Description
	p := plain(d)
	if p.Warnings == nil {
		p.Warnings = []string{}
	}
	return json.Marshal(p)
}

// Ctx is the per-call context of schedule and run (docs/protocol.md §5.1). Fields that are null in
// schedule are pointers.
type Ctx struct {
	ScanID      string  `json:"scanId"`
	AnalysisID  *string `json:"analysisId"`
	Seq         *int64  `json:"seq"`
	Round       *int    `json:"round"`
	Attempt     int     `json:"attempt"`
	ExecutionID *string `json:"executionId"`
	DeadlineMs  *int64  `json:"deadlineMs"`
	TmpDir      string  `json:"tmpDir"`
	FilesDir    *string `json:"filesDir"`
}

// Schedule runs the task's schedule function (R → C).
type Schedule struct {
	ID         string          `json:"id"`
	Ctx        Ctx             `json:"ctx"`
	ScanConfig json.RawMessage `json:"scanConfig"`
	TaskConfig json.RawMessage `json:"taskConfig"`
}

// Analysis is one analysis config yielded by schedule (C → R).
type Analysis struct {
	ID     string          `json:"id"`
	Config json.RawMessage `json:"config"`
}

// Done ends a schedule; Count must equal the number of analysis messages (C → R).
type Done struct {
	ID    string `json:"id"`
	Count int64  `json:"count"`
}

// Run runs one analysis (R → C).
type Run struct {
	ID             string          `json:"id"`
	Ctx            Ctx             `json:"ctx"`
	AnalysisConfig json.RawMessage `json:"analysisConfig"`
	TaskConfig     json.RawMessage `json:"taskConfig"`
}

// Result is a successful run (C → R).
type Result struct {
	ID     string          `json:"id"`
	Result json.RawMessage `json:"result"`
}

// ErrorObject is the error field of an error message (common.schema.json#/$defs/error).
type ErrorObject struct {
	Type      string          `json:"type"`
	Message   string          `json:"message"`
	Retryable *bool           `json:"retryable,omitempty"`
	DelayMs   *int64          `json:"delayMs,omitempty"`
	Stack     string          `json:"stack,omitempty"`
	Details   json.RawMessage `json:"details,omitempty"`
}

// Error terminates the request identified by ID (both directions).
type Error struct {
	ID    string      `json:"id"`
	Error ErrorObject `json:"error"`
}

// Cancel asks the connector to abort the in-flight request ID (R → C).
type Cancel struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
}

// Shutdown asks an idle connector to exit 0 within GraceMs (R → C).
type Shutdown struct {
	ID      string `json:"id"`
	GraceMs int64  `json:"graceMs"`
}

// File registers a file written to ctx.filesDir (C → R). ContentType nil means
// application/octet-stream.
type File struct {
	ID          string  `json:"id"`
	Parent      string  `json:"parent"`
	Name        string  `json:"name"`
	Path        string  `json:"path"`
	ContentType *string `json:"contentType"`
}

// FileRefObject is the reference returned for a registered file.
type FileRefObject struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Size        int64  `json:"size"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
}

// FileRef answers file (R → C).
type FileRef struct {
	ID      string        `json:"id"`
	FileRef FileRefObject `json:"fileRef"`
}

// Log is a fire-and-forget log line (C → R); Parent is nil outside any request.
type Log struct {
	Parent  *string         `json:"parent"`
	Level   string          `json:"level"`
	Message string          `json:"message"`
	Fields  json.RawMessage `json:"fields,omitempty"`
}

// Progress reports the progress of the request Parent (C → R).
type Progress struct {
	Parent   string   `json:"parent"`
	Fraction *float64 `json:"fraction"`
	Message  *string  `json:"message"`
}

// Template starts a wrapped template stream inside a custom schedule (C → R).
type Template struct {
	ID         string          `json:"id"`
	Parent     string          `json:"parent"`
	Template   string          `json:"template"`
	ScanConfig json.RawMessage `json:"scanConfig"`
	Credit     int             `json:"credit"`
}

// TemplateItem is one item of a template stream (R → C).
type TemplateItem struct {
	ID     string          `json:"id"`
	Config json.RawMessage `json:"config"`
}

// TemplateCredit grants more items for the stream ID (C → R).
type TemplateCredit struct {
	ID     string `json:"id"`
	Credit int    `json:"credit"`
}

// TemplateCancel stops the stream ID early (C → R).
type TemplateCancel struct {
	ID string `json:"id"`
}

// TemplateDone ends the stream ID after Count items (R → C).
type TemplateDone struct {
	ID    string `json:"id"`
	Count int64  `json:"count"`
}

func (Hello) MessageType() string          { return TypeHello }
func (Welcome) MessageType() string        { return TypeWelcome }
func (Ready) MessageType() string          { return TypeReady }
func (Describe) MessageType() string       { return TypeDescribe }
func (Description) MessageType() string    { return TypeDescription }
func (Schedule) MessageType() string       { return TypeSchedule }
func (Analysis) MessageType() string       { return TypeAnalysis }
func (Done) MessageType() string           { return TypeDone }
func (Run) MessageType() string            { return TypeRun }
func (Result) MessageType() string         { return TypeResult }
func (Error) MessageType() string          { return TypeError }
func (Cancel) MessageType() string         { return TypeCancel }
func (Shutdown) MessageType() string       { return TypeShutdown }
func (File) MessageType() string           { return TypeFile }
func (FileRef) MessageType() string        { return TypeFileRef }
func (Log) MessageType() string            { return TypeLog }
func (Progress) MessageType() string       { return TypeProgress }
func (Template) MessageType() string       { return TypeTemplate }
func (TemplateItem) MessageType() string   { return TypeTemplateItem }
func (TemplateCredit) MessageType() string { return TypeTemplateCredit }
func (TemplateCancel) MessageType() string { return TypeTemplateCancel }
func (TemplateDone) MessageType() string   { return TypeTemplateDone }

// newMessage returns a pointer to a zero message of the given type, or nil for unknown types.
func newMessage(typ string) Message {
	switch typ {
	case TypeHello:
		return &Hello{}
	case TypeWelcome:
		return &Welcome{}
	case TypeReady:
		return &Ready{}
	case TypeDescribe:
		return &Describe{}
	case TypeDescription:
		return &Description{}
	case TypeSchedule:
		return &Schedule{}
	case TypeAnalysis:
		return &Analysis{}
	case TypeDone:
		return &Done{}
	case TypeRun:
		return &Run{}
	case TypeResult:
		return &Result{}
	case TypeError:
		return &Error{}
	case TypeCancel:
		return &Cancel{}
	case TypeShutdown:
		return &Shutdown{}
	case TypeFile:
		return &File{}
	case TypeFileRef:
		return &FileRef{}
	case TypeLog:
		return &Log{}
	case TypeProgress:
		return &Progress{}
	case TypeTemplate:
		return &Template{}
	case TypeTemplateItem:
		return &TemplateItem{}
	case TypeTemplateCredit:
		return &TemplateCredit{}
	case TypeTemplateCancel:
		return &TemplateCancel{}
	case TypeTemplateDone:
		return &TemplateDone{}
	}
	return nil
}

// Direction of a message.
type Direction int

// Directions.
const (
	ConnectorToRuntime Direction = iota
	RuntimeToConnector
)

var connectorToRuntime = map[string]bool{
	TypeHello: true, TypeReady: true, TypeDescription: true, TypeAnalysis: true, TypeDone: true,
	TypeResult: true, TypeError: true, TypeFile: true, TypeLog: true, TypeProgress: true,
	TypeTemplate: true, TypeTemplateCredit: true, TypeTemplateCancel: true,
}

var runtimeToConnector = map[string]bool{
	TypeWelcome: true, TypeDescribe: true, TypeSchedule: true, TypeRun: true, TypeError: true,
	TypeCancel: true, TypeShutdown: true, TypeFileRef: true, TypeTemplateItem: true, TypeTemplateDone: true,
}

// Allowed reports whether a message of type typ may travel in direction d.
func Allowed(d Direction, typ string) bool {
	if d == ConnectorToRuntime {
		return connectorToRuntime[typ]
	}
	return runtimeToConnector[typ]
}
