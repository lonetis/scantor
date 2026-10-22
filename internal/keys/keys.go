// Package keys implements the key derivation shared by the orchestrator (server/utils/keys.ts) and
// the Go roles (docs/architecture.md §9, docs/auth.md §3):
//
//	key(label) = HKDF-SHA256(ikm = UTF-8(SCANTOR_SECRET), salt = UTF-8("scantor-v1"), info = UTF-8(label), L = 32)
//
// It also implements every credential format derived from those keys, so tests/corpora/keys-vectors.json
// can pin both implementations to the same values. Derived values are secrets: callers must never log
// them.
package keys

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
)

// Salt is the fixed HKDF salt.
const Salt = "scantor-v1"

// KeyLength is the length of every derived key in bytes.
const KeyLength = 32

// HKDF labels (docs/architecture.md §9).
const (
	LabelBetterAuth      = "better-auth"
	LabelRegistrySigning = "registry-signing"
	LabelRegistryPush    = "registry-push"
	LabelRegistryHTTP    = "registry-http"
	LabelWorkerToken     = "worker-token"
	LabelAMQP            = "amqp"
	LabelCredentials     = "credentials"
	LabelConfigSecrets   = "config-secrets"
	LabelToolsCookie     = "tools-cookie"
	LabelEditorCookie    = "editor-cookie"
	LabelBuiltinNode     = "builtin-node"
	LabelMongoQuery      = "mongo-query"
)

// Labels lists every HKDF label in the order of docs/architecture.md §9.
var Labels = []string{
	LabelBetterAuth, LabelRegistrySigning, LabelRegistryPush, LabelRegistryHTTP, LabelWorkerToken,
	LabelAMQP, LabelCredentials, LabelConfigSecrets, LabelToolsCookie, LabelEditorCookie,
	LabelBuiltinNode, LabelMongoQuery,
}

// Token prefixes.
const (
	NodeTokenPrefix   = "snt_"
	WorkerTokenPrefix = "swt_"
)

// ErrEmptySecret is returned when SCANTOR_SECRET is empty: deriving from an empty secret would produce
// predictable credentials.
var ErrEmptySecret = errors.New("SCANTOR_SECRET is empty")

// Derive returns key(label) for secret.
func Derive(secret, label string) ([]byte, error) {
	if secret == "" {
		return nil, ErrEmptySecret
	}
	return hkdf.Key(sha256.New, []byte(secret), []byte(Salt), label, KeyLength)
}

// DeriveHex returns key(label) as lowercase hex (64 characters).
func DeriveHex(secret, label string) (string, error) {
	k, err := Derive(secret, label)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(k), nil
}

// DeriveB64url returns key(label) as unpadded base64url (43 characters).
func DeriveB64url(secret, label string) (string, error) {
	k, err := Derive(secret, label)
	if err != nil {
		return "", err
	}
	return b64url(k), nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func hmacSHA256(key []byte, msg string) []byte {
	m := hmac.New(sha256.New, key)
	m.Write([]byte(msg)) // hash.Hash.Write never returns an error
	return m.Sum(nil)
}

// BetterAuthSecret returns the better-auth `secret`: hex(key("better-auth")).
func BetterAuthSecret(secret string) (string, error) { return DeriveHex(secret, LabelBetterAuth) }

// RegistryPushPassword returns the password of the registry `orchestrator` credential:
// base64url(key("registry-push")). It reaches `scantor task build --push` as
// SCANTOR_REGISTRY_PUSH_PASSWORD.
func RegistryPushPassword(secret string) (string, error) {
	return DeriveB64url(secret, LabelRegistryPush)
}

// RegistryHTTPSecret returns the registry's REGISTRY_HTTP_SECRET: hex(key("registry-http")).
func RegistryHTTPSecret(secret string) (string, error) { return DeriveHex(secret, LabelRegistryHTTP) }

// MongoQueryPassword returns the password of the read-only MongoDB user scantor_query:
// base64url(key("mongo-query")).
func MongoQueryPassword(secret string) (string, error) { return DeriveB64url(secret, LabelMongoQuery) }

// BuiltinNodeToken returns the built-in node token: "snt_" + base64url(key("builtin-node")).
func BuiltinNodeToken(secret string) (string, error) {
	k, err := DeriveB64url(secret, LabelBuiltinNode)
	if err != nil {
		return "", err
	}
	return NodeTokenPrefix + k, nil
}

// NodeTokenHash returns the stored form of a node token: lowercase hex SHA-256 of the full token string.
func NodeTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

var nodeTokenPattern = regexp.MustCompile(`^snt_[A-Za-z0-9_-]{43}$`)

// ValidNodeToken reports whether token has the node token format `snt_` + 43 base64url characters.
func ValidNodeToken(token string) bool { return nodeTokenPattern.MatchString(token) }

// WorkerTokenMAC returns base64url(HMAC-SHA256(key("worker-token"), workerId "\n" scanId "\n" role "\n" nodeId)).
func WorkerTokenMAC(secret, workerID, scanID, role, nodeID string) (string, error) {
	k, err := Derive(secret, LabelWorkerToken)
	if err != nil {
		return "", err
	}
	return b64url(hmacSHA256(k, workerID+"\n"+scanID+"\n"+role+"\n"+nodeID)), nil
}

// WorkerToken returns "swt_<workerId>.<mac>" (docs/auth.md §10.2).
func WorkerToken(secret, workerID, scanID, role, nodeID string) (string, error) {
	mac, err := WorkerTokenMAC(secret, workerID, scanID, role, nodeID)
	if err != nil {
		return "", err
	}
	return WorkerTokenPrefix + workerID + "." + mac, nil
}

var workerTokenPattern = regexp.MustCompile(`^swt_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$`)

// ParseWorkerToken splits a worker token into its worker id and MAC. ok is false when token does not
// have the format of docs/auth.md §10.2.
func ParseWorkerToken(token string) (workerID, mac string, ok bool) {
	m := workerTokenPattern.FindStringSubmatch(token)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

// AMQPPassword returns the password of the per-scan RabbitMQ user scan-<scanId>:
// base64url(HMAC-SHA256(key("amqp"), scanId)).
func AMQPPassword(secret, scanID string) (string, error) {
	k, err := Derive(secret, LabelAMQP)
	if err != nil {
		return "", err
	}
	return b64url(hmacSHA256(k, scanID)), nil
}

// EditorCookie returns the `scantor_editor` cookie value
// "v1.<userId>.<editorStartedAtMs>.<expiresAtMs>.<mac>" with
// mac = base64url(HMAC-SHA256(key("editor-cookie"), "v1.<userId>.<editorStartedAtMs>.<expiresAtMs>")).
func EditorCookie(secret, userID string, editorStartedAtMs, expiresAtMs int64) (string, error) {
	k, err := Derive(secret, LabelEditorCookie)
	if err != nil {
		return "", err
	}
	payload := "v1." + userID + "." + strconv.FormatInt(editorStartedAtMs, 10) + "." + strconv.FormatInt(expiresAtMs, 10)
	return payload + "." + b64url(hmacSHA256(k, payload)), nil
}

// ToolsCookieSignature returns the HS256 JWT signature of signingInput ("<header>.<payload>", both
// base64url) with key("tools-cookie"), as used by the `scantor_tools` cookie (docs/auth.md §11).
func ToolsCookieSignature(secret, signingInput string) (string, error) {
	k, err := Derive(secret, LabelToolsCookie)
	if err != nil {
		return "", err
	}
	return b64url(hmacSHA256(k, signingInput)), nil
}

// SecretDerivations returns, for one secret, every derived value the vectors file pins, keyed by a
// stable name. It exists for the shared vectors and must not be used to log anything.
func SecretDerivations(secret string) (map[string]string, error) {
	out := map[string]string{}
	add := func(name string, f func(string) (string, error)) error {
		v, err := f(secret)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		out[name] = v
		return nil
	}
	for name, f := range map[string]func(string) (string, error){
		"betterAuthSecret":     BetterAuthSecret,
		"registryPushPassword": RegistryPushPassword,
		"registryHttpSecret":   RegistryHTTPSecret,
		"mongoQueryPassword":   MongoQueryPassword,
		"builtinNodeToken":     BuiltinNodeToken,
	} {
		if err := add(name, f); err != nil {
			return nil, err
		}
	}
	return out, nil
}
