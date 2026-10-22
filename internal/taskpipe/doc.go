// Package taskpipe is the task pipeline of docs/tasks.md §9: the single implementation of packing,
// static validation, image build, describe, check and push that the orchestrator (subprocess
// `scantor task …`), the CLI (`scantor validate`, `dev run`, `dev debug`, `push`) and the workspace
// helpers share.
//
// # Seams
//
//   - PackDir and ReadPack produce the deterministic pack of a task folder or of a pack archive: the
//     build context, the revision snapshot and the unit of change detection. Its Summary.PackSHA256 is
//     the workspace hash, so every producer of that hash must use these functions.
//   - CheckStatic applies the manifest rules M1–M10 (internal/manifest), the required files of §2 and
//     the Dockerfile policy D1–D11/W1–W3 (package taskpipe/dockerfile) to a pack.
//   - Pipeline runs the three commands (Pack, CheckStatic, Build) and reports every step as events
//     (Emitter, docs/tasks.md §9.8) that end with one Result.
//   - LocalRun runs a built image in the runtime's local mode (`scantor dev run`, `dev debug`): the spec
//     (LocalSpec) is injected with the runtime, stdout carries LocalEvents (ParseLocalEvent) and
//     /scantor/out is copied out after the container exited. EffectiveConfig validates and fills the
//     configs of the spec against the described schemas.
//   - PackError.Cap names an exceeded cap, so callers map caps without parsing messages.
//
// The pipeline never needs platform credentials, except the derived registry push password for
// `build --push` (Config.RegistryPushPassword), which is only sent to the registry host of --tag.
//
// The package reads no environment: callers pass a Config built by their component's LoadConfig.
package taskpipe
