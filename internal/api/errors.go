package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// Error codes of the REST API error envelope (docs/api.md §1.7).
const (
	CodeValidationFailed     = "validationFailed"
	CodeBadRequest           = "badRequest"
	CodeQueryRejected        = "queryRejected"
	CodePasskeysDisabled     = "passkeysDisabled"
	CodeUnauthorized         = "unauthorized"
	CodeSetupTokenInvalid    = "setupTokenInvalid"
	CodeForbidden            = "forbidden"
	CodeAdminRequired        = "adminRequired"
	CodeSessionRequired      = "sessionRequired"
	CodeBanned               = "banned"
	CodePrivilegedNotAllowed = "privilegedNotAllowed"
	CodeQuotaExceeded        = "quotaExceeded"
	CodeNotFound             = "notFound"
	CodeMethodNotAllowed     = "methodNotAllowed"
	CodeInvalidState         = "invalidState"
	CodeAlreadyExists        = "alreadyExists"
	CodeWorkspaceDirty       = "workspaceDirty"
	CodeGitDiverged          = "gitDiverged"
	CodeTaskInUse            = "taskInUse"
	CodeUploadInUse          = "uploadInUse"
	CodeRevisionNotReady     = "revisionNotReady"
	CodeRevisionUnavailable  = "revisionUnavailable"
	CodeNothingToRetry       = "nothingToRetry"
	CodeExportTooLarge       = "exportTooLarge"
	CodeStaleEpoch           = "staleEpoch"
	CodeNodeInstanceConflict = "nodeInstanceConflict"
	CodeBuiltInNode          = "builtInNode"
	CodeSetupCompleted       = "setupCompleted"
	CodeLastCredential       = "lastCredential" //nolint:gosec // an error code, not a credential
	CodePayloadTooLarge      = "payloadTooLarge"
	CodeUnsupportedMediaType = "unsupportedMediaType"
	CodeConfigInvalid        = "configInvalid"
	CodeConfirmationRequired = "confirmationRequired"
	CodeScanTooLarge         = "scanTooLarge"
	CodeManifestInvalid      = "manifestInvalid"
	CodeInvalidPath          = "invalidPath"
	CodeGitFailed            = "gitFailed"
	CodeIncompatibleVersion  = "incompatibleVersion"
	CodeTooManyRequests      = "tooManyRequests"
	CodeInternal             = "internal"
	CodeBrokerAlarm          = "brokerAlarm"
	CodeUnavailable          = "unavailable"
	CodeQueryTimeout         = "queryTimeout"
)

// Exit classes of the CLI (docs/development.md §6): 0 ok, 1 analysis failures, 2 validation, 3 platform.
const (
	ExitOK               = 0
	ExitAnalysisFailures = 1
	ExitValidation       = 2
	ExitPlatform         = 3
)

// Error is a decoded error response. For responses that use the error envelope
// `{"error": {"code", "message", "details"}}`, Code, Message and Details are its fields; for other
// responses (registry format, plain text, proxies) Code is derived from the status and Message holds
// the start of the body.
type Error struct {
	Status    int             `json:"status"`
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	Details   json.RawMessage `json:"details,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	Method    string          `json:"method,omitempty"`
	Path      string          `json:"path,omitempty"`
}

func (e *Error) Error() string {
	msg := e.Message
	if msg == "" {
		msg = http.StatusText(e.Status)
	}
	return fmt.Sprintf("%s %s: %s (%s, HTTP %d)", e.Method, e.Path, msg, e.Code, e.Status)
}

// ExitClass maps the error to a CLI exit class: request and content problems (4xx except 408 and 429)
// are validation errors (2); timeouts, rate limits, version mismatches and server errors are platform
// errors (3).
func (e *Error) ExitClass() int {
	switch {
	case e.Status == http.StatusRequestTimeout, e.Status == http.StatusTooManyRequests, e.Status == http.StatusUpgradeRequired:
		return ExitPlatform
	case e.Status >= 400 && e.Status < 500:
		return ExitValidation
	default:
		return ExitPlatform
	}
}

// Temporary reports whether retrying the same request may succeed.
func (e *Error) Temporary() bool {
	switch e.Status {
	case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusBadGateway,
		http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return true
	}
	return e.Status >= 500 && e.Code != CodeQueryTimeout
}

// DecodeDetails unmarshals Details into v.
func (e *Error) DecodeDetails(v any) error {
	if len(e.Details) == 0 {
		return errors.New("error has no details")
	}
	return json.Unmarshal(e.Details, v)
}

// IssueDetails is the details shape of validationFailed and configInvalid.
type IssueDetails struct {
	Issues []Issue `json:"issues"`
}

// Issue is one validation issue: a path (JSON pointer or request path) and a message.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// InvalidStateDetails is the details shape of invalidState.
type InvalidStateDetails struct {
	State   string   `json:"state"`
	Allowed []string `json:"allowed"`
}

// StaleEpochDetails is the details shape of staleEpoch.
type StaleEpochDetails struct {
	CurrentEpoch int `json:"currentEpoch"`
}

// NodeInstanceConflictDetails is the details shape of nodeInstanceConflict.
type NodeInstanceConflictDetails struct {
	RetryAfterMs int64 `json:"retryAfterMs"`
}

// IncompatibleVersionDetails is the details shape of incompatibleVersion.
type IncompatibleVersionDetails struct {
	ServerVersion string `json:"serverVersion"`
	MinVersion    string `json:"minVersion"`
}

// LimitDetails is the details shape of payloadTooLarge and tooManyRequests.
type LimitDetails struct {
	Limit  int64  `json:"limit"`
	Actual *int64 `json:"actual,omitempty"`
}

// ConfirmationDetails is the details shape of confirmationRequired and scanTooLarge.
type ConfirmationDetails struct {
	ExpectedTotal int64  `json:"expectedTotal"`
	Threshold     *int64 `json:"threshold,omitempty"`
	Max           *int64 `json:"max,omitempty"`
}

// ManifestInvalidDetails is the details shape of manifestInvalid.
type ManifestInvalidDetails struct {
	Errors []BuildError `json:"errors"`
}

// AsError returns the *Error in err's chain.
func AsError(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// IsCode reports whether err is an API error with the given code.
func IsCode(err error, code string) bool {
	e, ok := AsError(err)
	return ok && e.Code == code
}

// IsStatus reports whether err is an API error with the given HTTP status.
func IsStatus(err error, status int) bool {
	e, ok := AsError(err)
	return ok && e.Status == status
}

// errorEnvelope is the body shape of error responses.
type errorEnvelope struct {
	Error *struct {
		Code    string          `json:"code"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details"`
	} `json:"error"`
}

// registryErrors is the body shape of registry token errors (docs/api.md §6).
type registryErrors struct {
	Errors []RegistryError `json:"errors"`
}

const maxErrorBodyBytes = 64 << 10

// decodeError builds an *Error from a non-2xx response body.
func decodeError(status int, method, path, requestID string, body []byte) *Error {
	e := &Error{Status: status, Method: method, Path: path, RequestID: requestID}
	var env errorEnvelope
	if err := json.Unmarshal(body, &env); err == nil && env.Error != nil && env.Error.Code != "" {
		e.Code = env.Error.Code
		e.Message = env.Error.Message
		if len(env.Error.Details) > 0 && string(env.Error.Details) != "null" {
			e.Details = env.Error.Details
		}
		return e
	}
	var reg registryErrors
	if err := json.Unmarshal(body, &reg); err == nil && len(reg.Errors) > 0 {
		e.Code = codeForStatus(status)
		e.Message = reg.Errors[0].Message
		return e
	}
	e.Code = codeForStatus(status)
	e.Message = truncate(string(body), 512)
	return e
}

func codeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return CodeBadRequest
	case http.StatusUnauthorized:
		return CodeUnauthorized
	case http.StatusForbidden:
		return CodeForbidden
	case http.StatusNotFound:
		return CodeNotFound
	case http.StatusMethodNotAllowed:
		return CodeMethodNotAllowed
	case http.StatusConflict:
		return CodeInvalidState
	case http.StatusRequestEntityTooLarge:
		return CodePayloadTooLarge
	case http.StatusUnsupportedMediaType:
		return CodeUnsupportedMediaType
	case http.StatusUnprocessableEntity:
		return CodeConfigInvalid
	case http.StatusUpgradeRequired:
		return CodeIncompatibleVersion
	case http.StatusTooManyRequests:
		return CodeTooManyRequests
	case http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusGatewayTimeout:
		return CodeUnavailable
	default:
		return CodeInternal
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
