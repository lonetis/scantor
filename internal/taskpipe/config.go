package taskpipe

import (
	"time"

	"github.com/lonetis/scantor/internal/manifest"
	"github.com/lonetis/scantor/internal/version"
)

// Config holds the task-pipeline settings (docs/tasks.md §9.10). The CLI fills it from its LoadConfig;
// nothing in this package reads the environment.
type Config struct {
	// Pack are the caps SCANTOR_TASK_MAX_FILES, SCANTOR_TASK_MAX_BYTES and SCANTOR_TASK_MAX_PACK_BYTES.
	Pack PackLimits
	// ManifestLimits are the instance limits of rule M8.
	ManifestLimits manifest.Limits
	// Images is the SCANTOR_IMAGE_PREFIX/SCANTOR_IMAGE_TAG override of base and scantor images.
	Images version.ImageOverride
	// BuildTimeout is SCANTOR_BUILD_TIMEOUT.
	BuildTimeout time.Duration
	// DescribeTimeout is SCANTOR_DESCRIBE_TIMEOUT, per describe and check container.
	DescribeTimeout time.Duration
	// MaxImageBytes is SCANTOR_MAX_IMAGE_BYTES.
	MaxImageBytes int64
	// BuildCacheMaxBytes is SCANTOR_BUILD_CACHE_MAX_BYTES; 0 disables pruning.
	BuildCacheMaxBytes int64
	// PublicURL (SCANTOR_PUBLIC_URL) and RegistryPublicHost (SCANTOR_REGISTRY_PUBLIC_HOST) name hosts
	// that Dockerfile image references must never use (rule D5).
	PublicURL          string
	RegistryPublicHost string
	// RegistryPushPassword is the derived `orchestrator` registry password (SCANTOR_REGISTRY_PUSH_PASSWORD),
	// required by --push.
	RegistryPushPassword string
}

// ForbiddenHosts returns the platform hosts of rule D5 (the hosts of SCANTOR_REGISTRY_PUBLIC_HOST and
// SCANTOR_PUBLIC_URL).
func (c Config) ForbiddenHosts() []string {
	var hosts []string
	for _, h := range []string{hostOfHostPort(c.RegistryPublicHost), hostOfURL(c.PublicURL)} {
		if h != "" {
			hosts = append(hosts, h)
		}
	}
	return hosts
}
