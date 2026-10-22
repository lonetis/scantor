// Package runtime holds the types shared by every part of the scantor runtime (docs/runtime.md): the
// classified Go error Error (also returned by internal/templates), the AMQP message bodies of
// schemas/messages (analysis, result, attempt), and the environment contract read by LoadConfig.
//
// The runtime itself is split into sub-packages (docs/runtime.md §1.3): bootstrap (HTTP client, state
// polls, corrected clock), amqpx (connection, slot channels, confirm publisher), pool (connector
// processes), runner (run path), scheduler (schedule path, checkpoints), local, describe, check, scerr
// (error model, truncation, retry policy), logtail, upload, canonical (RFC 8785), dind (inner dockerd)
// and worker (worker-mode wiring). This package imports none of them, so every sub-package and
// internal/templates may import it.
package runtime
