package templates

// Compiled-in data source URLs, equal to the .env.example defaults of SCANTOR_TRANCO_URL,
// SCANTOR_CRUX_URL and SCANTOR_CRUX_CACHE_URL (docs/templates.md §7.1). The CLI uses them for local runs
// and bundle mode for bundle runs, where the recipient can override them with `docker run -e`.
const (
	DefaultTrancoURL    = "https://tranco-list.eu"
	DefaultCruxURL      = "https://raw.githubusercontent.com/zakird/crux-top-lists/main"
	DefaultCruxCacheURL = "https://raw.githubusercontent.com/lonetis/crux-cache/main"
)
