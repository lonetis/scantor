package dockerfile

import (
	"slices"
	"strings"
	"testing"
)

const header = "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\n"

func rules(issues []Issue) []string {
	out := make([]string, len(issues))
	for i, is := range issues {
		out[i] = is.Rule
	}
	return out
}

func TestCheckImageRef(t *testing.T) {
	forbidden := []string{"registry.scantor.example", "scantor.example"}
	for ref, want := range map[string]string{
		"python:3.14-slim":                        "",
		"docker.io/library/alpine:3.24":           "",
		"ghcr.io/astral-sh/uv:0.13.4":             "",
		"quay.io/example/tools@sha256:" + hex64:   "",
		"8.8.8.8:5000/tools:1":                    "",
		"[2001:4860:4860::8888]:5000/tools:1":     "",
		"localhost:5000/tasks/x:y":                "loopback",
		"LOCALHOST:5000/x":                        "loopback",
		"registry.localhost/x":                    "loopback",
		"host.docker.internal:5000/x":             "Docker host",
		"registry:5000/x":                         "platform registry",
		"registry/x":                              "",
		"registry.scantor.example:443/x":          "platform registry",
		"scantor.example/x/y:1":                   "platform registry",
		"127.0.0.1:5000/x":                        "not a public address",
		"0.0.0.0:5000/x":                          "not a public address",
		"[::]:5000/x":                             "not a public address",
		"[::1]:5000/x":                            "not a public address",
		"[fd00::1]:5000/x":                        "not a public address",
		"[fe80::1]:5000/x":                        "not a public address",
		"10.1.2.3/x":                              "not a public address",
		"172.16.0.1/x":                            "not a public address",
		"192.168.1.1/x":                           "not a public address",
		"169.254.169.254/x":                       "not a public address",
		"100.64.0.1/x":                            "not a public address",
		"[::ffff:127.0.0.1]:5000/x":               "not a valid image reference",
		"127.1:5000/x":                            "ambiguous numeric",
		"0x7f.0.0.1:5000/x":                       "ambiguous numeric",
		"2130706433:5000/x":                       "ambiguous numeric",
		"tasks/x:y":                               "tasks/",
		"ghcr.io/TASKS/x:1":                       "must be lowercase",
		"sha256:" + hex64:                         "image ids",
		hex64:                                     "image ids",
		"${OTHER}":                                "variables",
		"Alpine:3":                                "not a valid image reference",
		"example.com/repo with space":             "not a valid image reference",
		"docker.io/library/tasks-helper:1":        "",
		"ghcr.io/example/tasks/x:1":               "",
		"registry.example.com:5000/library/x:1.0": "",
	} {
		got := CheckImageRef(ref, forbidden)
		if (want == "") != (got == "") || !strings.Contains(got, want) {
			t.Errorf("CheckImageRef(%q) = %q, want %q", ref, got, want)
		}
	}
}

const hex64 = "4e5f6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091"

func TestRemoteSource(t *testing.T) {
	for src, want := range map[string]bool{
		"vendor.tar.gz":                         false,
		"scripts/":                              false,
		"repo.git":                              false,
		"https://example.com/x":                 true,
		"http://169.254.169.254/":               true,
		"git://example.com/repo":                true,
		"git@github.com:example/repo.git":       true,
		"github.com/example/repo":               true,
		"GitHub.com/example/repo":               true,
		"s3://bucket/key":                       true,
		"user@host.example:path/to/repo#branch": true,
	} {
		if got := remoteSource(src); got != want {
			t.Errorf("remoteSource(%q) = %v, want %v", src, got, want)
		}
	}
}

func TestCheckCollectsExternalImages(t *testing.T) {
	res := Check([]byte("ARG SCANTOR_BASE\n"+
		"FROM golang:1.27-alpine AS build\n"+
		"FROM build AS more\n"+
		"FROM ${SCANTOR_BASE}\n"+
		"COPY --from=build /x /x\n"+
		"COPY --from=0 /y /y\n"+
		"COPY --from=busybox:1.37 /bin/busybox /bin/busybox\n"+
		"RUN --mount=type=bind,from=alpine:3.24,target=/mnt true\n"+
		"COPY --from=golang:1.27-alpine /usr/local/go/VERSION /VERSION\n"), Options{HasDockerignore: true})
	if !res.OK() {
		t.Fatal(res.Errors)
	}
	want := []ImageRef{{"golang:1.27-alpine", 2}, {"busybox:1.37", 7}, {"alpine:3.24", 8}}
	if !slices.Equal(res.External, want) {
		t.Fatalf("External = %v, want %v", res.External, want)
	}
}

func TestCheckRules(t *testing.T) {
	tests := []struct {
		name       string
		dockerfile string
		errors     []string
		warnings   []string
	}{
		{"minimal", header + "COPY . .\n", nil, nil},
		{"stage names are case-insensitive", "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE} AS Base\nFROM base\n", nil, nil},
		{"final stage from a later-declared name is not a stage", "ARG SCANTOR_BASE\nFROM later\nFROM ${SCANTOR_BASE} AS later\nFROM alpine:3.24\n", []string{"D4"}, nil},
		{"COPY --from a later stage is an image reference", "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY --from=later /x /x\nFROM ${SCANTOR_BASE} AS later\n", nil, nil},
		{"index of a later stage is not a stage", "ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nCOPY --from=1 /x /x\nFROM ${SCANTOR_BASE}\n", []string{"D5"}, nil},
		{"index of the current stage", header + "COPY --from=0 /x /x\n", []string{"D5"}, nil},
		{"ADD with variable in a quoted source", header + "ARG U=https://x\nADD \"$U\" /x\n", []string{"D7"}, nil},
		{"W2 names the variable", header + "ENV SCANTOR_DEBUG_PORT=1234 OTHER=1\n", nil, []string{"W2"}},
		{"W1 only in the final image", "ARG SCANTOR_BASE\nFROM alpine:3.24 AS tools\nCMD [\"sh\"]\nFROM ${SCANTOR_BASE}\nCMD [\"x\"]\n", nil, []string{"W1"}},
		{"W3 without a .dockerignore", header, nil, []string{"W3"}},
		{"BUILDKIT args in lower case", header + "ARG buildkit_syntax=x\n", []string{"D10"}, nil},
		{"quoted BUILDKIT args", header + "ARG \"BUILDKIT_SBOM_SCAN_STAGE\"=true\nARG 'BUILDKIT_X'\n", []string{"D10", "D10"}, nil},
		{"escaped BUILDKIT arg", header + "ARG BUILD\\KIT_X=1\n", []string{"D10"}, nil},
		{"quoted BUILDKIT meta arg", "ARG SCANTOR_BASE\nARG \"BUILDKIT_SYNTAX\"=x\nFROM ${SCANTOR_BASE}\n", []string{"D10"}, nil},
		{"quoted base arg does not declare it", "ARG \"SCANTOR_BASE\"\nFROM ${SCANTOR_BASE}\n", []string{"D3"}, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := Check([]byte(tt.dockerfile), Options{HasDockerignore: tt.name != "W3 without a .dockerignore"})
			if got := rules(res.Errors); !slices.Equal(got, tt.errors) {
				t.Errorf("errors %v (%v), want %v", got, res.Errors, tt.errors)
			}
			if got := rules(res.Warnings); !slices.Equal(got, tt.warnings) {
				t.Errorf("warnings %v (%v), want %v", got, res.Warnings, tt.warnings)
			}
		})
	}
}

func TestCheckSyntaxAfterEscape(t *testing.T) {
	// BuildKit reads parser directives only before the first comment that is not a directive; a syntax
	// directive after another directive is still a directive.
	res := Check([]byte("# escape=\\\n# syntax=evil/frontend\n"+header), Options{HasDockerignore: true})
	if got := rules(res.Errors); !slices.Equal(got, []string{"D2"}) {
		t.Fatalf("errors %v, want D2", res.Errors)
	}
}

func TestCheckBounds(t *testing.T) {
	big := header + "RUN echo " + strings.Repeat("x", MaxBytes) + "\n"
	res := Check([]byte(big), Options{})
	if got := rules(res.Errors); !slices.Equal(got, []string{"D1"}) || res.Errors[0].Line != 0 {
		t.Fatalf("oversized Dockerfile: %v", res.Errors)
	}
	if !strings.HasSuffix(res.Errors[0].Text(), "(D1)") {
		t.Fatalf("Text() = %q", res.Errors[0].Text())
	}
}

func TestCheckNeverPanics(t *testing.T) {
	for _, input := range []string{
		"", "\x00\x01\x02", "FROM", "ARG", "RUN --mount=", "RUN --mount=type=bind,from=", "COPY --from= / /",
		"ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nRUN <<EOF\n", "ONBUILD", "LABEL", "LABEL =x", "ADD", "FROM a AS",
		"ARG SCANTOR_BASE\nFROM ${SCANTOR_BASE}\nRUN --network=${X} true\n",
		strings.Repeat("\\\n", 1000),
	} {
		res := Check([]byte(input), Options{})
		if input != "" && res.OK() && !strings.Contains(input, "SCANTOR_BASE") {
			t.Errorf("Check(%q) passed", input)
		}
	}
}
