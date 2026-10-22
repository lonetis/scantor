package keys

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"strings"
	"testing"
)

// The shared vectors live with the other corpora (docs/testing.md §2) and are read by relative path.
const vectorsPath = "../../tests/corpora/keys-vectors.json"

var update = flag.Bool("update", false, "rewrite tests/corpora/keys-vectors.json from the Go implementation")

type secretValue struct {
	Secret string `json:"secret"`
	Value  string `json:"value"`
}

type vectors struct {
	Comment              string             `json:"$comment"`
	Version              int                `json:"version"`
	Salt                 string             `json:"salt"`
	HKDF                 []hkdfVector       `json:"hkdf"`
	BetterAuthSecret     []secretValue      `json:"betterAuthSecret"`
	RegistryPushPassword []secretValue      `json:"registryPushPassword"`
	RegistryHTTPSecret   []secretValue      `json:"registryHttpSecret"`
	MongoQueryPassword   []secretValue      `json:"mongoQueryPassword"`
	BuiltinNodeToken     []builtinNodeToken `json:"builtinNodeToken"`
	NodeTokenHash        []nodeTokenHash    `json:"nodeTokenHash"`
	WorkerToken          []workerToken      `json:"workerToken"`
	AMQPPassword         []amqpPassword     `json:"amqpPassword"`
	EditorCookie         []editorCookie     `json:"editorCookie"`
	ToolsCookie          []toolsCookie      `json:"toolsCookieSignature"`
	RegistrySigningKey   []signingKey       `json:"registrySigningKey"`
	Encryption           []encryption       `json:"encryption"`
}

type hkdfVector struct {
	Secret string `json:"secret"`
	Label  string `json:"label"`
	Hex    string `json:"hex"`
}

type builtinNodeToken struct {
	Secret    string `json:"secret"`
	Value     string `json:"value"`
	TokenHash string `json:"tokenHash"`
}

type nodeTokenHash struct {
	Token string `json:"token"`
	Hash  string `json:"hash"`
}

type workerToken struct {
	Secret   string `json:"secret"`
	WorkerID string `json:"workerId"`
	ScanID   string `json:"scanId"`
	Role     string `json:"role"`
	NodeID   string `json:"nodeId"`
	Value    string `json:"value"`
}

type amqpPassword struct {
	Secret string `json:"secret"`
	ScanID string `json:"scanId"`
	Value  string `json:"value"`
}

type editorCookie struct {
	Secret            string `json:"secret"`
	UserID            string `json:"userId"`
	EditorStartedAtMs int64  `json:"editorStartedAtMs"`
	ExpiresAtMs       int64  `json:"expiresAtMs"`
	Value             string `json:"value"`
}

type toolsCookie struct {
	Secret       string `json:"secret"`
	SigningInput string `json:"signingInput"`
	Signature    string `json:"signature"`
}

type signingKey struct {
	Secret string `json:"secret"`
	D      string `json:"d"`
	X      string `json:"x"`
	Y      string `json:"y"`
	KID    string `json:"kid"`
}

type encryption struct {
	Secret    string `json:"secret"`
	Label     string `json:"label"`
	AAD       string `json:"aad"`
	IV        string `json:"iv"`
	Plaintext string `json:"plaintext"`
	Value     string `json:"value"`
}

var testSecrets = []string{
	"correct horse battery staple",
	"3f9c1e0b7a2d4c6e8f0a1b2c3d4e5f60718293a4b5c6d7e8",
	"ünïcødé sëcret 🔑 with spaces",
}

const comment = "Shared key-derivation test vectors (docs/architecture.md §9, docs/auth.md §3). " +
	"key(label) = HKDF-SHA256(ikm = UTF-8(secret), salt = UTF-8(salt), info = UTF-8(label), L = 32). " +
	"Read by internal/keys (Go) and orchestrator/server/utils/keys.ts (vitest). Base64url values are unpadded. " +
	"registrySigningKey: d = (int(key('registry-signing')) mod (n-1)) + 1 on P-256, d/x/y as JWK base64url, kid = 'scantor-' + hex(sha256(0x04||X||Y))[:16]. " +
	"encryption: enc:v1:<base64url(iv)>:<base64url(ciphertext||tag)>, AES-256-GCM with key(label) and AAD. " +
	"Regenerate with: go test ./internal/keys -run TestVectors -update"

func buildVectors(t *testing.T) vectors {
	t.Helper()
	must := func(v string, err error) string {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	v := vectors{Comment: comment, Version: 1, Salt: Salt}
	for _, s := range testSecrets {
		for _, label := range Labels {
			v.HKDF = append(v.HKDF, hkdfVector{s, label, must(DeriveHex(s, label))})
		}
		v.BetterAuthSecret = append(v.BetterAuthSecret, secretValue{s, must(BetterAuthSecret(s))})
		v.RegistryPushPassword = append(v.RegistryPushPassword, secretValue{s, must(RegistryPushPassword(s))})
		v.RegistryHTTPSecret = append(v.RegistryHTTPSecret, secretValue{s, must(RegistryHTTPSecret(s))})
		v.MongoQueryPassword = append(v.MongoQueryPassword, secretValue{s, must(MongoQueryPassword(s))})
		tok := must(BuiltinNodeToken(s))
		v.BuiltinNodeToken = append(v.BuiltinNodeToken, builtinNodeToken{s, tok, NodeTokenHash(tok)})
		for _, role := range []string{"scheduler", "runner"} {
			w := workerToken{Secret: s, WorkerID: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", ScanID: "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f", Role: role, NodeID: "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"}
			w.Value = must(WorkerToken(s, w.WorkerID, w.ScanID, w.Role, w.NodeID))
			v.WorkerToken = append(v.WorkerToken, w)
		}
		a := amqpPassword{Secret: s, ScanID: "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f"}
		a.Value = must(AMQPPassword(s, a.ScanID))
		v.AMQPPassword = append(v.AMQPPassword, a)
		e := editorCookie{Secret: s, UserID: "0b6f6f0e-3c0e-4a6e-9f0e-5d1f8b0a7c11", EditorStartedAtMs: 1761037200000, ExpiresAtMs: 1761080400000}
		e.Value = must(EditorCookie(s, e.UserID, e.EditorStartedAtMs, e.ExpiresAtMs))
		v.EditorCookie = append(v.EditorCookie, e)
		tc := toolsCookie{Secret: s, SigningInput: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzY2FudG9yIiwiYXVkIjoidG9vbHMiLCJzdWIiOiIwYjZmNmYwZS0zYzBlLTRhNmUtOWYwZS01ZDFmOGIwYTdjMTEiLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3NjEwNDA4MDAsImV4cCI6MTc2MTA2OTYwMCwianRpIjoiOGMxZjZkMGUtMmEzYi00YzVkLThlOWYtMGExYjJjM2Q0ZTVmIn0"}
		tc.Signature = must(ToolsCookieSignature(s, tc.SigningInput))
		v.ToolsCookie = append(v.ToolsCookie, tc)

		priv, err := RegistrySigningKey(s)
		if err != nil {
			t.Fatal(err)
		}
		point, err := priv.PublicKey.Bytes()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := priv.Bytes()
		if err != nil {
			t.Fatal(err)
		}
		v.RegistrySigningKey = append(v.RegistrySigningKey, signingKey{
			Secret: s,
			D:      b64url(raw),
			X:      b64url(point[1:33]),
			Y:      b64url(point[33:65]),
			KID:    must(RegistrySigningKID(&priv.PublicKey)),
		})
		for _, label := range []string{LabelCredentials, LabelConfigSecrets} {
			enc := encryption{Secret: s, Label: label, AAD: "scans:5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f:/apiKey", IV: "AAECAwQFBgcICQoL", Plaintext: "real-secret-value ✓"}
			if label == LabelCredentials {
				enc.AAD = "credentials:6f5e4d3c-2b1a-4f0e-9d8c-7b6a5f4e3d2c:secretEnc"
			}
			enc.Value = encryptForVector(t, s, enc)
			v.Encryption = append(v.Encryption, enc)
		}
	}
	v.NodeTokenHash = []nodeTokenHash{
		{"snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9", NodeTokenHash("snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9")},
	}
	return v
}

// encryptForVector implements the documented value format with the standard library only.
func encryptForVector(t *testing.T, secret string, e encryption) string {
	t.Helper()
	key, err := Derive(secret, e.Label)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	iv, err := base64.RawURLEncoding.DecodeString(e.IV)
	if err != nil || len(iv) != 12 {
		t.Fatalf("iv: %v", err)
	}
	ct := gcm.Seal(nil, iv, []byte(e.Plaintext), []byte(e.AAD))
	return "enc:v1:" + e.IV + ":" + base64.RawURLEncoding.EncodeToString(ct)
}

func TestVectors(t *testing.T) {
	want := buildVectors(t)
	if *update {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(want); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll("../../tests/corpora", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(vectorsPath, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	data, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("read shared vectors: %v", err)
	}
	var got vectors
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&got); err != nil {
		t.Fatalf("decode shared vectors: %v", err)
	}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("tests/corpora/keys-vectors.json differs from the Go implementation; regenerate with -update only if the change is intended")
	}

	// Every label must be covered for every secret.
	seen := map[string]int{}
	for _, h := range got.HKDF {
		seen[h.Label]++
	}
	for _, label := range Labels {
		if seen[label] != len(testSecrets) {
			t.Errorf("label %s has %d vectors, want %d", label, seen[label], len(testSecrets))
		}
	}
	// The encryption vectors must decrypt with the standard library.
	for _, e := range got.Encryption {
		key, err := Derive(e.Secret, e.Label)
		if err != nil {
			t.Fatal(err)
		}
		parts := strings.Split(e.Value, ":")
		if len(parts) != 4 || parts[0] != "enc" || parts[1] != "v1" {
			t.Fatalf("encryption value format: %s", e.Value)
		}
		iv, _ := base64.RawURLEncoding.DecodeString(parts[2])
		ct, _ := base64.RawURLEncoding.DecodeString(parts[3])
		block, _ := aes.NewCipher(key)
		gcm, _ := cipher.NewGCM(block)
		pt, err := gcm.Open(nil, iv, ct, []byte(e.AAD))
		if err != nil || string(pt) != e.Plaintext {
			t.Fatalf("decrypt vector: %v", err)
		}
	}
}

// RFC 5869 test case 1 pins the HKDF primitive itself, independently of scantor's parameters.
func TestHKDFKnownAnswer(t *testing.T) {
	ikm, _ := hex.DecodeString("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
	salt, _ := hex.DecodeString("000102030405060708090a0b0c")
	info, _ := hex.DecodeString("f0f1f2f3f4f5f6f7f8f9")
	okm, err := hkdf.Key(sha256.New, ikm, salt, string(info), 42)
	if err != nil {
		t.Fatal(err)
	}
	want := "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
	if hex.EncodeToString(okm) != want {
		t.Fatalf("HKDF known answer mismatch")
	}
}

func TestFormats(t *testing.T) {
	s := testSecrets[0]
	tok, err := BuiltinNodeToken(s)
	if err != nil || !ValidNodeToken(tok) {
		t.Fatalf("builtin node token %q does not match the node token format", tok)
	}
	wt, err := WorkerToken(s, "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "5e1f0c2d-8a7b-4c3d-9e1f-2a3b4c5d6e7f", "runner", "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a")
	if err != nil {
		t.Fatal(err)
	}
	id, mac, ok := ParseWorkerToken(wt)
	if !ok || id != "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" || len(mac) != 43 {
		t.Fatalf("ParseWorkerToken(%q) = %q, %q, %v", wt, id, mac, ok)
	}
	if _, _, ok := ParseWorkerToken("swt_nope.abc"); ok {
		t.Fatal("ParseWorkerToken accepted a malformed token")
	}
	if p, _ := AMQPPassword(s, "x"); len(p) != 43 {
		t.Fatalf("amqp password length %d", len(p))
	}
	if h, _ := BetterAuthSecret(s); len(h) != 64 {
		t.Fatalf("better-auth secret length %d", len(h))
	}
	if _, err := Derive("", LabelAMQP); err == nil {
		t.Fatal("Derive accepted an empty secret")
	}
	if c, _ := EditorCookie(s, "u", 1, 2); !strings.HasPrefix(c, "v1.u.1.2.") {
		t.Fatalf("editor cookie %q", c)
	}
}
