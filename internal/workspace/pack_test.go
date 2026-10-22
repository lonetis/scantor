package workspace

import (
	"context"
	"errors"
	"testing"

	"github.com/lonetis/scantor/internal/taskpipe"
)

// TestPackErrorMapping pins how the pack's problems become helper errors: caps by taskpipe's typed
// PackError.Cap (never by message text), entry problems by their path.
func TestPackErrorMapping(t *testing.T) {
	limits := Limits{MaxFiles: 10, MaxBytes: 1 << 20, MaxPackBytes: 1 << 10}
	tests := []struct {
		name  string
		err   error
		code  Code
		limit int64
	}{
		{"files cap", taskpipe.PackErrors{{Cap: taskpipe.CapFiles, Message: "too many"}}, CodeTooManyFiles, 10},
		{"bytes cap", taskpipe.PackErrors{{Cap: taskpipe.CapBytes, Message: "too big"}}, CodeTooLarge, 1 << 20},
		{"pack bytes cap", taskpipe.PackErrors{{Cap: taskpipe.CapPackBytes, Message: "too big"}}, CodeTooLarge, 1 << 10},
		// The message names a cap, but only Cap counts.
		{"cap name in a message", taskpipe.PackErrors{{Message: "the task exceeds SCANTOR_TASK_MAX_FILES"}}, CodeInternal, -1},
		{"entry problem", taskpipe.PackErrors{{Path: "x/fifo", Message: "not a regular file"}}, CodeInvalidPath, -1},
		{"other failure", errors.New("disk full"), CodeInternal, -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			werr := codeOf(t, packError(tt.err, limits), tt.code)
			if tt.limit >= 0 && werr.Details["limit"] != tt.limit {
				t.Fatalf("details %v, want limit %d", werr.Details, tt.limit)
			}
		})
	}
	if err := packError(context.Canceled, limits); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation became %v", err)
	}
}
