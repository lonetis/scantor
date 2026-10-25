package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

func TestTerminalSafe(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain text, ünïcödé and emoji 🙂\n\tindented", "plain text, ünïcödé and emoji 🙂\n\tindented"},
		{"\x1b]52;c;aGk=\x07", `\x1b]52;c;aGk=\x07`},
		{"\x1b[2J\x1b[Hfake prompt", `\x1b[2J\x1b[Hfake prompt`},
		{"ok\rFAILED", "ok\nFAILED"},
		{"line\r\nnext\r\n", "line\nnext\n"},
		{"del\x7f nul\x00", `del\x7f nul\x00`},
		{"c1 \u009b31m csi", `c1 \u009b31m csi`},
		{"raw \x9b and \xff bytes", `raw \x9b and \xff bytes`},
		{"literal � replacement char", "literal � replacement char"},
	}
	for _, c := range cases {
		got := TerminalSafe(c.in)
		if got != c.want {
			t.Errorf("TerminalSafe(%q) = %q, want %q", c.in, got, c.want)
		}
		if again := TerminalSafe(got); again != got {
			t.Errorf("TerminalSafe is not idempotent for %q: %q", c.in, again)
		}
	}
}

// The writer recognises a C1 character and a CRLF split across two writes.
func TestTerminalSafeWriterSplitWrites(t *testing.T) {
	var buf bytes.Buffer
	w := &terminalSafeWriter{w: &buf}
	whole := []byte("a\u009bb\r\nc\x1bd é\r")
	for i := range whole {
		if _, err := w.Write(whole[i : i+1]); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	if want := `a\u009bb` + "\nc" + `\x1bd é` + "\n"; buf.String() != want {
		t.Fatalf("byte-wise writes gave %q, want %q", buf.String(), want)
	}
}

// Hostile task output (CLI-3): task-controlled error messages, log tails, file names and results reach
// the terminal escaped in human mode and unchanged with -o json.
func TestHostileOutputIsEscaped(t *testing.T) {
	const osc52 = "\x1b]52;c;cm0gLXJmIH4=\x07"
	f := newAPIFake(t)
	base := "/api/scans/" + apiScanID
	analysis := map[string]any{"id": apiScanID + "-0", "scanId": apiScanID, "userId": "u", "seq": 0, "round": 1, "status": "failed", "attempt": 1,
		"error":    map[string]any{"type": "taskError", "message": "boom " + osc52, "retryable": false, "phase": "run", "attempt": 1, "at": "2026-10-21T10:00:00.000Z"},
		"result":   map[string]any{"title": "\x1b]0;owned\x07"},
		"attempts": []any{}, "files": []any{map[string]any{"id": "f1", "name": "x\x1b[8m.png", "size": 1, "sha256": "x", "contentType": "image/png"}},
		"logTail":  "log " + osc52 + "\n", "createdAt": "2026-10-21T10:00:00.000Z", "updatedAt": "2026-10-21T10:00:00.000Z"}
	f.reply("GET", base+"/analyses", 200, map[string]any{"items": []any{analysis}, "nextCursor": nil})
	f.reply("GET", "/api/analyses/"+apiScanID+"-0", 200, analysis)

	for _, args := range [][]string{{"analyses", "list", apiScanID}, {"analyses", "get", apiScanID + "-0"}} {
		code, out, errOut := f.exec(args...)
		if code != 0 {
			t.Fatalf("%v: exit %d, stderr %q", args, code, errOut)
		}
		if strings.ContainsAny(out, "\x1b\x07") || !strings.Contains(out, `\x1b]52;c;`) {
			t.Errorf("%v: control characters reached stdout: %q", args, out)
		}
	}
	code, out, _ := f.exec("-o", "json", "analyses", "get", apiScanID+"-0")
	var doc api.Analysis
	if code != 0 || json.Unmarshal([]byte(out), &doc) != nil || doc.LogTail != "log "+osc52+"\n" {
		t.Fatalf("json: exit %d, logTail %q", code, doc.LogTail)
	}

	// An error message quoting task content is escaped on stderr too.
	f.fail("GET", base+"/analyses", 422, "configInvalid", "bad value "+osc52, map[string]any{"issues": []any{map[string]any{"path": "/x", "message": osc52}}})
	if code, _, errOut := f.exec("analyses", "list", apiScanID); code != ExitValidation || strings.ContainsAny(errOut, "\x1b\x07") {
		t.Fatalf("error: exit %d, stderr %q", code, errOut)
	}
}

// Raw content keeps its exact bytes when stdout is not a terminal.
func TestTerminalTextKeepsPipedBytes(t *testing.T) {
	var buf bytes.Buffer
	o := &Output{Format: FormatHuman, Out: &buf, Err: io.Discard}
	if got := o.TerminalText("\x1b[31mred\x1b[0m"); got != "\x1b[31mred\x1b[0m" {
		t.Fatalf("piped text changed: %q", got)
	}
	f := newAPIFake(t)
	f.on("GET", "/api/scans/"+apiScanID+"/workers/w1/logs", func(w http.ResponseWriter, _ *http.Request) {
		apiFakeJSON(w, http.StatusOK, map[string]any{"text": "\x1b[31mred\x1b[0m\n", "truncated": false, "pending": false, "collectedAt": "2026-10-21T10:00:00.000Z"})
	})
	if code, out, errOut := f.exec("scans", "worker", "logs", apiScanID, "w1"); code != 0 || out != "\x1b[31mred\x1b[0m\n" {
		t.Fatalf("worker logs: exit %d, out %q, stderr %q", code, out, errOut)
	}
}
