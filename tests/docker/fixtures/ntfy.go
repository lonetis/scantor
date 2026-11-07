package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The ntfy fake (docs/testing.md §7.9): SCANTOR_NTFY_URL of the test stack points at /ntfy, where POST
// /ntfy/ accepts ntfy's JSON publish (https://docs.ntfy.sh/publish/#publish-as-json) and records the
// message per topic; GET /control/ntfy/{topic} returns the recorded messages, oldest first. Topics
// whose name starts with "protected-" need the Bearer token ntfyToken (as a reserved topic on a real
// server does) and answer 403 otherwise; topics starting with "unavailable-" always answer 503.

const (
	// ntfyToken is the access token of the protected topics; tests/helpers/fixtures-server.ts has the
	// same value.
	ntfyToken       = "tk_fixtures-ntfy-token"
	ntfyMaxMessages = 200
	ntfyMaxBody     = 64 << 10
)

var ntfyTopic = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// ntfyMessage is one recorded publish: the JSON body plus whether it carried the right token.
type ntfyMessage struct {
	ID         string   `json:"id"`
	Time       string   `json:"time"`
	Topic      string   `json:"topic"`
	Title      string   `json:"title"`
	Message    string   `json:"message"`
	Priority   int      `json:"priority"`
	Tags       []string `json:"tags"`
	Click      string   `json:"click"`
	Authorized bool     `json:"authorized"`
	UserAgent  string   `json:"userAgent"`
}

type ntfyStore struct {
	mu     sync.Mutex
	topics map[string][]ntfyMessage
}

func newNtfyStore() *ntfyStore {
	return &ntfyStore{topics: map[string][]ntfyMessage{}}
}

func ntfyError(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"code": status * 100, "http": status, "error": text})
}

// publish answers POST /ntfy/.
func (s *ntfyStore) publish(w http.ResponseWriter, r *http.Request) {
	var msg ntfyMessage
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, ntfyMaxBody)).Decode(&msg); err != nil {
		ntfyError(w, http.StatusBadRequest, "invalid request: body must be a JSON message")
		return
	}
	if !ntfyTopic.MatchString(msg.Topic) {
		ntfyError(w, http.StatusBadRequest, "invalid request: topic invalid")
		return
	}
	auth := r.Header.Get("Authorization")
	msg.Authorized = subtle.ConstantTimeCompare([]byte(auth), []byte("Bearer "+ntfyToken)) == 1
	if strings.HasPrefix(msg.Topic, "unavailable-") {
		ntfyError(w, http.StatusServiceUnavailable, "service unavailable")
		return
	}
	if strings.HasPrefix(msg.Topic, "protected-") && !msg.Authorized {
		ntfyError(w, http.StatusForbidden, "forbidden")
		return
	}
	id := make([]byte, 6)
	if _, err := rand.Read(id); err != nil {
		ntfyError(w, http.StatusInternalServerError, err.Error())
		return
	}
	msg.ID = hex.EncodeToString(id)
	msg.Time = time.Now().UTC().Format(time.RFC3339Nano)
	msg.UserAgent = r.UserAgent()
	s.mu.Lock()
	messages := append(s.topics[msg.Topic], msg)
	if len(messages) > ntfyMaxMessages {
		messages = messages[len(messages)-ntfyMaxMessages:]
	}
	s.topics[msg.Topic] = messages
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"id": msg.ID, "event": "message", "topic": msg.Topic})
}

// messages answers GET /control/ntfy/{topic}.
func (s *ntfyStore) messages(w http.ResponseWriter, r *http.Request) {
	topic := r.PathValue("topic")
	if !ntfyTopic.MatchString(topic) {
		http.Error(w, "invalid topic", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	messages := append([]ntfyMessage{}, s.topics[topic]...)
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(messages)
}
