// Package scantor embeds the canonical data files of the platform into the scantor binary: the schemas
// (task manifest, describe output, languages table, managed labels, connector protocol, AMQP messages,
// templates), the per-language scaffolds and the user guides. Go code reads these files only through
// this package, never from disk, so the binary is self-contained (docs/development.md §6).
//
// Paths inside each file system keep their repository prefix, for example
// Schemas.ReadFile("schemas/languages.json") or fs.Sub(Scaffolds, "scaffolds/python").
package scantor

import "embed"

// Schemas holds schemas/ (JSON Schemas and the data tables languages.json and managed-labels.json).
//
//go:embed schemas
var Schemas embed.FS

// Scaffolds holds scaffolds/, including dot files such as .dockerignore and .vscode/. Scaffold go.mod
// and go.sum files are stored as go.mod.tmpl and go.sum.tmpl and renamed when rendered.
//
//go:embed all:scaffolds
var Scaffolds embed.FS

// Guides holds the user guides under docs/guide/ (served over MCP and getGuide).
//
//go:embed docs/guide
var Guides embed.FS
