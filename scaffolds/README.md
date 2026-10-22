# Scaffolds

Task starters, one directory per language of `schemas/languages.json`:

| Directory | Language |
|---|---|
| `python/` | Python |
| `typescript/` | TypeScript |
| `javascript/` | JavaScript |
| `go/` | Go |

`scantor init` and the workspace helper `scantor workspace scaffold` render a scaffold together with a
template choice into a task folder that publishes unchanged. The scaffolds are embedded into the
`scantor` binary. The Go scaffold's `go.mod` and `go.sum` are stored as `go.mod.tmpl` and `go.sum.tmpl`
(`go:embed` skips directories that contain a `go.mod`) and renamed when rendered. The example tasks under
`tasks/` are not embedded and keep real `go.mod` and `go.sum` files.
