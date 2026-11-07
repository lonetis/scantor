package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func ntfyServer() http.Handler {
	store := newNtfyStore()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /ntfy/{$}", store.publish)
	mux.HandleFunc("GET /control/ntfy/{topic}", store.messages)
	return mux
}

func publishTo(t *testing.T, h http.Handler, body, auth string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/ntfy/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func recorded(t *testing.T, h http.Handler, topic string) []ntfyMessage {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/control/ntfy/"+topic, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /control/ntfy/%s: %d %s", topic, rec.Code, rec.Body.String())
	}
	var out []ntfyMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestNtfyFakeRecordsPublishesPerTopic(t *testing.T) {
	h := ntfyServer()
	rec := publishTo(t, h, `{"topic":"open-1","title":"Scan done","message":"1 succeeded","priority":3,"tags":["scantor"],"click":"https://x"}`, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	got := recorded(t, h, "open-1")
	if len(got) != 1 || got[0].Title != "Scan done" || got[0].Priority != 3 || got[0].Authorized || got[0].ID == "" {
		t.Fatalf("recorded %+v", got)
	}
	if other := recorded(t, h, "open-2"); len(other) != 0 {
		t.Fatalf("other topic %+v", other)
	}
}

func TestNtfyFakeProtectedAndUnavailableTopics(t *testing.T) {
	h := ntfyServer()
	if rec := publishTo(t, h, `{"topic":"protected-1","title":"t","message":"m"}`, "Bearer wrong"); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), `"error":"forbidden"`) {
		t.Fatalf("wrong token: %d %s", rec.Code, rec.Body.String())
	}
	if rec := publishTo(t, h, `{"topic":"protected-1","title":"t","message":"m"}`, "Bearer "+ntfyToken); rec.Code != http.StatusOK {
		t.Fatalf("right token: %d %s", rec.Code, rec.Body.String())
	}
	if got := recorded(t, h, "protected-1"); len(got) != 1 || !got[0].Authorized {
		t.Fatalf("recorded %+v", got)
	}
	if rec := publishTo(t, h, `{"topic":"unavailable-1","message":"m"}`, ""); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable: %d", rec.Code)
	}
	for _, body := range []string{`{"topic":"a/b"}`, `not json`} {
		if rec := publishTo(t, h, body, ""); rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d", body, rec.Code)
		}
	}
}
