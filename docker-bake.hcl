# The single definition of every scantor image (docs/development.md §10), used by
# `just`, the dockerized test runner and CI. Every build uses the repository root
# as its context.
#
#   docker buildx bake --load dev       dev images, tag dev (just up)
#   docker buildx bake --load test      platform images + test fixtures (test runner)
#   docker buildx bake release          multi-arch platform images (CI)
#
# The variables below are build parameters set by just and CI, not runtime
# configuration.

# Registry prefix of the platform images, with a trailing "/" (empty = local images).
variable "IMAGE_PREFIX" {
  default = ""
}

# Tag of the platform images.
variable "IMAGE_TAG" {
  default = "dev"
}

# Version compiled into the scantor binary and reported by the orchestrator and connectors.
variable "VERSION" {
  default = "dev"
}

# Git commit compiled into the scantor binary.
variable "COMMIT" {
  default = ""
}

function "image" {
  params = [name]
  result = ["${IMAGE_PREFIX}${name}:${IMAGE_TAG}"]
}

target "_common" {
  context = "."
  args = {
    VERSION      = VERSION
    COMMIT       = COMMIT
    IMAGE_PREFIX = IMAGE_PREFIX
  }
}

target "_platform" {
  inherits = ["_common"]
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/lonetis/scantor"
    "org.opencontainers.image.version"  = VERSION
    "org.opencontainers.image.revision" = COMMIT
  }
}

# ── Platform images ──────────────────────────────────────────────────────────

target "scantor" {
  inherits   = ["_platform"]
  dockerfile = "Dockerfile"
  tags       = image("scantor")
}

target "orchestrator" {
  inherits   = ["_platform"]
  dockerfile = "orchestrator/Dockerfile"
  tags       = image("scantor-orchestrator")
}

target "editor" {
  inherits   = ["_platform"]
  dockerfile = "editor/Dockerfile"
  target     = "editor"
  tags       = image("scantor-editor")
}

target "base-python" {
  inherits   = ["_platform"]
  dockerfile = "connectors/python/Dockerfile"
  target     = "base"
  tags       = image("scantor-base-python")
}

target "base-js" {
  inherits   = ["_platform"]
  dockerfile = "connectors/js/Dockerfile"
  target     = "base"
  tags       = image("scantor-base-js")
}

target "base-go" {
  inherits   = ["_platform"]
  dockerfile = "connectors/go/Dockerfile"
  target     = "base"
  tags       = image("scantor-base-go")
}

# ── Development and test images (never pushed) ───────────────────────────────

# Nuxt dev server with the scantor binary; docker-compose.dev.yml mounts the source.
target "orchestrator-dev" {
  inherits   = ["_common"]
  dockerfile = "orchestrator/Dockerfile"
  target     = "dev"
  tags       = ["scantor-orchestrator-dev:${IMAGE_TAG}"]
}

target "base-python-test" {
  inherits   = ["_common"]
  dockerfile = "connectors/python/Dockerfile"
  target     = "test"
  tags       = ["scantor-base-python:test"]
}

target "base-js-test" {
  inherits   = ["_common"]
  dockerfile = "connectors/js/Dockerfile"
  target     = "test"
  tags       = ["scantor-base-js:test"]
}

target "base-go-test" {
  inherits   = ["_common"]
  dockerfile = "connectors/go/Dockerfile"
  target     = "test"
  tags       = ["scantor-base-go:test"]
}

target "test-runner" {
  inherits   = ["_common"]
  dockerfile = "tests/docker/Dockerfile"
  tags       = ["scantor-test-runner:dev"]
}

target "test-fixtures" {
  inherits   = ["_common"]
  dockerfile = "tests/docker/fixtures/Dockerfile"
  tags       = ["scantor-test-fixtures:dev"]
}

# ── Groups ───────────────────────────────────────────────────────────────────

# The six platform images.
group "default" {
  targets = ["scantor", "orchestrator", "editor", "base-python", "base-js", "base-go"]
}

# The images of the dev stack (just up).
group "dev" {
  targets = ["scantor", "orchestrator-dev", "editor", "base-python", "base-js", "base-go"]
}

# Everything the test runner's inner stack needs.
group "test" {
  targets = ["default", "test-fixtures"]
}

group "connector-tests" {
  targets = ["base-python-test", "base-js-test", "base-go-test"]
}

# The platform images for both architectures (release-<target>). CI builds each
# target on a native runner per architecture and merges the manifests.
target "release" {
  name      = "release-${tgt}"
  matrix    = { tgt = ["scantor", "orchestrator", "editor", "base-python", "base-js", "base-go"] }
  inherits  = [tgt]
  platforms = ["linux/amd64", "linux/arm64"]
}
