package redact

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func TestString(t *testing.T) {
	const apiKey = "sk_scantor_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl"
	const editorKey = "sk_scantor_editor_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl"
	const nodeToken = "snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9"
	const workerToken = "swt_9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d.yJk2Xh0n4mQ8sV1bR7cT3wZ5aP9dL6fG2hK8jN0uE4o"
	cases := []struct {
		name, in       string
		mustNotContain []string
		mustContain    []string
	}{
		{"api key", "using key " + apiKey + " now", []string{apiKey[11:]}, []string{"sk_scantor_" + Mask}},
		{"editor key", editorKey, []string{editorKey[18:]}, []string{"sk_scantor_editor_" + Mask}},
		{"node token", "token=" + nodeToken, []string{nodeToken[4:]}, []string{"snt_" + Mask}},
		{"worker token keeps the id", workerToken, []string{"yJk2Xh0n4mQ8"}, []string{"swt_9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d." + Mask}},
		{"setup token", "sst_q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4j3k2l1z0x9c", []string{"q9w8e7r6t5y4"}, []string{"sst_" + Mask}},
		{"passkey token", "spk_q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4j3k2l1z0x9c", []string{"q9w8e7r6"}, []string{"spk_" + Mask}},
		{"internal capability", "sic_q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4j3k2l1z0x9c", []string{"q9w8e7r6"}, []string{"sic_" + Mask}},
		{"editor code", "/_auth?code=sec_q9w8e7r6t5y4u3i2o1p0a9s8d7f6g5h4j3k2l1z0x9c", []string{"q9w8e7r6"}, []string{"sec_" + Mask}},
		{"amqp url", "dial amqp://scan-5e1f:pW3n9Xq0vK2mB7cR5tY8uZ1aS4dF6gH@rabbitmq:5672/scantor", []string{"pW3n9Xq0"}, []string{"amqp://scan-5e1f:" + Mask + "@rabbitmq:5672"}},
		{"amqps url", "amqps://u:secretpass@amqp.example.com:443", []string{"secretpass"}, []string{"amqps://u:" + Mask + "@"}},
		{"https userinfo", "https://user:hunter2@git.example.com/repo.git", []string{"hunter2"}, []string{"https://user:" + Mask + "@git.example.com"}},
		{"presigned url", "PUT http://rustfs:9000/scantor/files/x?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abcdef0123456789&X-Amz-Expires=900", []string{"abcdef0123456789"}, []string{"X-Amz-Signature=" + Mask + "&X-Amz-Expires=900"}},
		{"setup link", "open http://localhost:3000/setup?token=sst_AAAAAAAAAAAAAAAAAAAAAAAA to create", []string{"AAAAAAAAAAAA"}, []string{"/setup?token=" + Mask}},
		{"git extraheader", `git -c http.extraheader="AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46Z2hwX3NlY3JldA==" clone`, []string{"eC1hY2Nlc3M"}, []string{"extraheader=\"" + Mask}},
		{"git config env", "GIT_CONFIG_KEY_0=http.https://github.com/.extraheader GIT_CONFIG_VALUE_0=Authorization: Bearer ghp_secret", []string{"ghp_secret"}, nil},
		{"authorization text", "Authorization: Bearer abc.def.ghi", []string{"abc.def.ghi"}, []string{"Authorization: " + Mask}},
		{"x-api-key text", "x-api-key: whatever-value", []string{"whatever-value"}, []string{"x-api-key: " + Mask}},
		{"plain text untouched", "connector did not send hello within 30s", nil, []string{"connector did not send hello within 30s"}},
		{"short prefix words untouched", "consent_screen and snt_short", nil, []string{"consent_screen and snt_short"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := String(tc.in)
			for _, s := range tc.mustNotContain {
				if strings.Contains(got, s) {
					t.Errorf("String(%q) = %q still contains %q", tc.in, got, s)
				}
			}
			for _, s := range tc.mustContain {
				if !strings.Contains(got, s) {
					t.Errorf("String(%q) = %q does not contain %q", tc.in, got, s)
				}
			}
		})
	}
}

func TestHeaders(t *testing.T) {
	h := http.Header{}
	h.Set("Authorization", "Bearer sk_scantor_x")
	h.Set("X-Api-Key", "sk_scantor_y")
	h.Set("Cookie", "scantor.session_token=abc")
	h.Set("X-Registry-Auth", "eyJ1c2VybmFtZSI6Im5vZGUifQ==")
	h.Set("X-Scantor-Internal-Auth", "sic_abc")
	h.Set("X-Scantor-Setup-Token", "sst_abc")
	h.Set("User-Agent", "scantor-node/1.4.0")
	got := Headers(h)
	for _, name := range []string{"Authorization", "X-Api-Key", "Cookie", "X-Registry-Auth", "X-Scantor-Internal-Auth", "X-Scantor-Setup-Token"} {
		if got.Get(name) != Mask {
			t.Errorf("%s = %q, want masked", name, got.Get(name))
		}
	}
	if got.Get("User-Agent") != "scantor-node/1.4.0" {
		t.Errorf("User-Agent changed: %q", got.Get("User-Agent"))
	}
	if h.Get("Authorization") == Mask {
		t.Error("Headers modified its input")
	}
}

func TestSlog(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, HandlerOptions(nil)))
	logger.Info("request", "url", "amqp://u:topsecret@h", "authorization", "Bearer x", "err", errors.New("token snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9 rejected"), "token", "plain")
	out := buf.String()
	for _, s := range []string{"topsecret", "Bearer x", "3q8ZkP2mW9xV", `"plain"`} {
		if strings.Contains(out, s) {
			t.Errorf("log output contains %q: %s", s, out)
		}
	}
}

func TestNewLogger(t *testing.T) {
	for _, format := range []string{FormatJSON, FormatText} {
		var buf bytes.Buffer
		logger := NewLogger(&buf, format, slog.LevelInfo)
		logger.Debug("hidden")
		logger.Info("pull", "auth", "x-registry-auth: eyJ1c2VybmFtZSI6Im5vZGUifQ==", "nodeToken", "snt_3q8ZkP2mW9xV7bN1cR4tY6uA0sD5fG8hJ2kL4zX7cV9")
		out := buf.String()
		if strings.Contains(out, "hidden") || strings.Contains(out, "eyJ1c2Vy") || strings.Contains(out, "3q8ZkP2mW9xV") {
			t.Errorf("%s logger output %q", format, out)
		}
		if format == FormatJSON && !strings.HasPrefix(out, "{") {
			t.Errorf("json logger output %q", out)
		}
	}
	for in, want := range map[string]slog.Level{"debug": slog.LevelDebug, "info": slog.LevelInfo, "WARN": slog.LevelWarn, "error": slog.LevelError} {
		if got, err := ParseLevel(in); err != nil || got != want {
			t.Errorf("ParseLevel(%q) = %v, %v", in, got, err)
		}
	}
	if _, err := ParseLevel("verbose"); err == nil {
		t.Error("ParseLevel accepted an invalid level")
	}
}
