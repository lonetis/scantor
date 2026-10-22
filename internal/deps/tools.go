//go:build tools

// Package deps pins modules that domain packages (runtime, task pipeline) use, so their versions are
// fixed in go.mod before the first import exists. The build tag keeps it out of every build;
// `go mod tidy` still sees the imports.
package deps

import (
	_ "github.com/moby/buildkit/frontend/dockerfile/instructions"
	_ "github.com/moby/buildkit/frontend/dockerfile/parser"
	_ "github.com/moby/patternmatcher"
	_ "github.com/rabbitmq/amqp091-go"
	_ "golang.org/x/sync/errgroup"
)
