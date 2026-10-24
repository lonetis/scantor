package main

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLogRequestsRecordsTheRequest(t *testing.T) {
	var out bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&out, nil))
	handler := logRequests(log, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot)
	}))

	tests := []struct {
		name      string
		userAgent string
	}{
		{name: "data-source client", userAgent: "scantor/dev (+https://github.com/lonetis/scantor)"},
		{name: "no User-Agent", userAgent: ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out.Reset()
			req := httptest.NewRequest(http.MethodGet, "http://fixtures.scantor.localhost:8089/tranco/download/ABC/5?x=1", nil)
			if tc.userAgent != "" {
				req.Header.Set("User-Agent", tc.userAgent)
			}
			handler.ServeHTTP(httptest.NewRecorder(), req)

			var entry struct {
				Msg       string  `json:"msg"`
				Method    string  `json:"method"`
				Host      string  `json:"host"`
				Path      string  `json:"path"`
				Status    int     `json:"status"`
				UserAgent *string `json:"userAgent"`
			}
			if err := json.Unmarshal(out.Bytes(), &entry); err != nil {
				t.Fatalf("the request log is not one JSON line: %v\n%s", err, out.String())
			}
			if entry.Msg != "request" || entry.Method != http.MethodGet || entry.Host != "fixtures.scantor.localhost:8089" ||
				entry.Path != "/tranco/download/ABC/5" || entry.Status != http.StatusTeapot {
				t.Errorf("unexpected request log entry %+v", entry)
			}
			if entry.UserAgent == nil {
				t.Fatalf("the request log has no userAgent field: %s", out.String())
			}
			if *entry.UserAgent != tc.userAgent {
				t.Errorf("userAgent = %q, want %q", *entry.UserAgent, tc.userAgent)
			}
		})
	}
}
