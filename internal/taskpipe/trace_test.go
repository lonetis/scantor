package taskpipe

import (
	"encoding/base64"
	"encoding/json"
	"slices"
	"testing"

	"google.golang.org/protobuf/encoding/protowire"
)

// protoMsg builds a protobuf message from (field, value) pairs: string and []byte values are
// length-delimited, bool and uint64 values are varints.
func protoMsg(fields ...any) []byte {
	var b []byte
	for i := 0; i < len(fields); i += 2 {
		num := protowire.Number(fields[i].(int))
		switch v := fields[i+1].(type) {
		case string:
			b = protowire.AppendTag(b, num, protowire.BytesType)
			b = protowire.AppendString(b, v)
		case []byte:
			b = protowire.AppendTag(b, num, protowire.BytesType)
			b = protowire.AppendBytes(b, v)
		case bool:
			b = protowire.AppendTag(b, num, protowire.VarintType)
			b = protowire.AppendVarint(b, protowire.EncodeBool(v))
		case uint64:
			b = protowire.AppendTag(b, num, protowire.VarintType)
			b = protowire.AppendVarint(b, v)
		}
	}
	return b
}

// traceAux encodes a StatusResponse as the aux value of a moby.buildkit.trace message.
func traceAux(t *testing.T, status []byte) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(base64.StdEncoding.EncodeToString(status))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestTraceRendering(t *testing.T) {
	timestamp := protoMsg(1, uint64(1)) // google.protobuf.Timestamp{seconds: 1}
	updates := [][]byte{
		protoMsg(
			fieldStatusVertexes, protoMsg(fieldVertexDigest, "sha256:a", fieldVertexName, "[1/2] FROM docker.io/library/python", fieldVertexStarted, timestamp),
			fieldStatusVertexes, protoMsg(fieldVertexDigest, "sha256:b", fieldVertexName, "[2/2] RUN pip install"),
		),
		protoMsg(
			fieldStatusVertexes, protoMsg(fieldVertexDigest, "sha256:a", fieldVertexName, "[1/2] FROM docker.io/library/python", fieldVertexStarted, timestamp, fieldVertexCached, true, fieldVertexCompleted, timestamp),
			fieldStatusVertexes, protoMsg(fieldVertexDigest, "sha256:b", fieldVertexName, "[2/2] RUN pip install", fieldVertexStarted, timestamp),
			fieldStatusLogs, protoMsg(fieldLogVertex, "sha256:b", 2, uint64(1), fieldLogMsg, []byte("Collecting x\nDownloading")),
		),
		protoMsg(
			fieldStatusLogs, protoMsg(fieldLogVertex, "sha256:b", fieldLogMsg, []byte(" 1 MB\r\n")),
			fieldStatusWarnings, protoMsg(fieldWarningVertex, "sha256:b", fieldWarningShort, "InvalidDefaultArgInFrom: Default value for ARG ${SCANTOR_BASE} results in empty or invalid base image name"),
			fieldStatusWarnings, protoMsg(fieldWarningVertex, "sha256:b", fieldWarningShort, "SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data"),
		),
		protoMsg(
			fieldStatusVertexes, protoMsg(fieldVertexDigest, "sha256:b", fieldVertexName, "[2/2] RUN pip install", fieldVertexStarted, timestamp, fieldVertexCompleted, timestamp, fieldVertexError, "exit code: 1"),
			fieldStatusLogs, protoMsg(fieldLogVertex, "sha256:b", fieldLogMsg, []byte("unterminated")),
		),
	}
	type line struct{ level, text string }
	var got []line
	r := newTraceRenderer(func(level, text string) { got = append(got, line{level, text}) })
	for _, u := range updates {
		st, err := decodeTraceAux(traceAux(t, u))
		if err != nil {
			t.Fatal(err)
		}
		r.render(st)
	}
	r.close()
	want := []line{
		{LevelInfo, "#1 [1/2] FROM docker.io/library/python"},
		{LevelInfo, "#2 [2/2] RUN pip install"},
		{LevelInfo, "#2 Collecting x"},
		{LevelInfo, "#1 CACHED"},
		{LevelInfo, "#2 Downloading 1 MB"},
		{LevelWarning, "#2 SecretsUsedInArgOrEnv: Do not use ARG or ENV instructions for sensitive data"},
		{LevelInfo, "#2 unterminated"},
		{LevelInfo, "#2 ERROR: exit code: 1"},
	}
	if !slices.Equal(got, want) {
		t.Fatalf("rendered:\n%q\nwant:\n%q", got, want)
	}
}

func TestTraceMalformed(t *testing.T) {
	for _, aux := range []string{`5`, `"%%%"`, `"` + base64.StdEncoding.EncodeToString([]byte{0x0a, 0xff}) + `"`} {
		if _, err := decodeTraceAux(json.RawMessage(aux)); err == nil {
			t.Errorf("aux %s: decoded", aux)
		}
	}
}
