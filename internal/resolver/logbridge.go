package resolver

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/sirupsen/logrus"
)

// zdns logs through the global logrus logger. The bridge sends its records to the resolver's slog
// logger and turns logrus' Fatal, which zdns reaches with names from hostile zones, into a panic the
// engine recovers from instead of an os.Exit.

// fatalPanic is the value logrus' exit function panics with.
type fatalPanic struct{}

// fatalSentinel is the only panic value the engine recovers from.
var fatalSentinel any = &fatalPanic{}

// logrusLevel maps the resolver's log level to zdns' logrus level. zdns logs one Info line per query
// when it opens a socket, so only an explicit debug level enables its Info and Debug output.
func logrusLevel(l slog.Level) logrus.Level {
	switch {
	case l <= slog.LevelDebug:
		return logrus.DebugLevel
	case l >= slog.LevelError:
		return logrus.ErrorLevel
	default:
		return logrus.WarnLevel
	}
}

// slogLevel maps a logrus record level to the slog level it is logged at.
func slogLevel(l logrus.Level) slog.Level {
	switch l {
	case logrus.PanicLevel, logrus.FatalLevel, logrus.ErrorLevel:
		return slog.LevelError
	case logrus.WarnLevel:
		return slog.LevelWarn
	default: // Info, Debug, Trace: per-query detail
		return slog.LevelDebug
	}
}

// slogHook forwards logrus records to the current slog logger.
type slogHook struct {
	logger atomic.Pointer[slog.Logger]
}

func (h *slogHook) Levels() []logrus.Level { return logrus.AllLevels }

func (h *slogHook) Fire(e *logrus.Entry) error {
	l := h.logger.Load()
	if l == nil {
		return nil
	}
	attrs := make([]slog.Attr, 0, len(e.Data)+1)
	attrs = append(attrs, slog.String("component", "zdns"))
	for k, v := range e.Data {
		attrs = append(attrs, slog.String(k, fmt.Sprint(v)))
	}
	l.LogAttrs(context.Background(), slogLevel(e.Level), e.Message, attrs...)
	return nil
}

// discardFormatter skips logrus' own formatting: the hook already logged the record.
type discardFormatter struct{}

func (discardFormatter) Format(*logrus.Entry) ([]byte, error) { return nil, nil }

var (
	bridgeOnce sync.Once
	bridge     = &slogHook{}
)

// bridgeLogrus routes the global logrus logger to logger at the mapped level and makes its Fatal
// panic with fatalSentinel. It may be called again (tests run several resolvers in one process); the
// last logger wins.
func bridgeLogrus(logger *slog.Logger, level slog.Level) logrus.Level {
	bridge.logger.Store(logger)
	bridgeOnce.Do(func() {
		std := logrus.StandardLogger()
		std.SetOutput(io.Discard)
		std.SetFormatter(discardFormatter{})
		std.ReplaceHooks(logrus.LevelHooks{})
		std.AddHook(bridge)
		std.ExitFunc = func(int) { panic(fatalSentinel) }
	})
	lvl := logrusLevel(level)
	logrus.SetLevel(lvl)
	return lvl
}
