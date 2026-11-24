package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/spf13/cobra"

	scantor "github.com/lonetis/scantor"
	"github.com/lonetis/scantor/internal/api"
	"github.com/lonetis/scantor/internal/envconf"
	"github.com/lonetis/scantor/internal/resolver"
)

// The daemon configuration of a node and its daemon overrides (docs/nodes.md §6.12): `nodes
// daemon-config` shows what the node's daemon runs with, `nodes daemon-overrides set|reset` change the
// running daemon instance until it stops.

func init() {
	registerGroup("nodes", "daemon-overrides", "Set or remove the daemon overrides of a node's running daemon", false)
	registerCommand("nodes", newNodesDaemonConfigCommand)
	registerCommand("nodes daemon-overrides", newNodesDaemonOverridesSetCommand)
	registerCommand("nodes daemon-overrides", newNodesDaemonOverridesResetCommand)
}

// apiDaemonOverridesPath is the path of the overridable keys and their bounds inside scantor.Schemas.
const apiDaemonOverridesPath = "schemas/daemon-overrides.json"

// apiOverrideSpec is one key of schemas/daemon-overrides.json.
type apiOverrideSpec struct {
	Type     string   `json:"type"`
	Min      *int64   `json:"min"`
	Max      *int64   `json:"max"`
	Enum     []string `json:"enum"`
	MinItems *int     `json:"minItems"`
	MaxItems *int     `json:"maxItems"`
	Format   string   `json:"format"`
	Env      string   `json:"env"`
}

// apiOverrideSpecs reads the overridable keys once. The file is embedded, so an error is a build defect
// that the tests catch.
var apiOverrideSpecs = sync.OnceValues(func() (map[string]apiOverrideSpec, error) {
	data, err := scantor.Schemas.ReadFile(apiDaemonOverridesPath)
	if err != nil {
		return nil, err
	}
	var file struct {
		Keys map[string]apiOverrideSpec `json:"keys"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("%s: %w", apiDaemonOverridesPath, err)
	}
	if len(file.Keys) == 0 {
		return nil, fmt.Errorf("%s: no keys", apiDaemonOverridesPath)
	}
	return file.Keys, nil
})

// apiSettingKind says how a value of the daemon configuration is parsed and rendered.
type apiSettingKind int

const (
	apiKindText apiSettingKind = iota
	apiKindInt
	apiKindBytes
	apiKindDuration
	apiKindList
	apiKindCertificates
)

// flagType is the value placeholder of the setting's flag in the help text.
func (k apiSettingKind) flagType() string {
	switch k {
	case apiKindInt:
		return "int"
	case apiKindBytes:
		return "bytes"
	case apiKindDuration:
		return "duration"
	case apiKindList:
		return "list"
	default:
		return "string"
	}
}

// apiDaemonSetting is one value of the daemon configuration: its dotted key, its environment variable,
// how it renders and, when it is overridable, the flag of `nodes daemon-overrides set`.
type apiDaemonSetting struct {
	key  string
	env  string
	kind apiSettingKind
	// zero is the meaning of 0 or of an empty list, when it has one of its own.
	zero  string
	flag  string
	usage string
}

// apiDaemonSettings lists the daemon configuration in the order of its representation (docs/api.md §2,
// api.DaemonConfigValues). The overridable keys carry a flag; their bounds come from
// schemas/daemon-overrides.json.
var apiDaemonSettings = []apiDaemonSetting{
	{key: "url", env: "SCANTOR_URL"},
	{key: "builtIn", env: "SCANTOR_NODE_BUILTIN"},
	{key: "maxWorkers", env: "SCANTOR_NODE_MAX_WORKERS", kind: apiKindInt, zero: "number of CPUs", flag: "max-workers",
		usage: "daemon worker capacity; the node's capacity is the smaller of this and the admin worker limit"},
	{key: "dind", env: "SCANTOR_NODE_DIND"},
	{key: "egressDeny", env: "SCANTOR_NODE_EGRESS_DENY", kind: apiKindList, zero: "none"},
	{key: "allowUnisolatedNetworks", env: "SCANTOR_ALLOW_UNISOLATED_NETWORKS"},
	{key: "allowInsecureTransport", env: "SCANTOR_ALLOW_INSECURE_TRANSPORT"},
	{key: "caCertificates", env: "SCANTOR_CA_CERT", kind: apiKindCertificates, zero: "none"},
	{key: "pidsLimit", env: "SCANTOR_NODE_PIDS_LIMIT", kind: apiKindInt, flag: "pids-limit",
		usage: "process limit of every worker created afterwards"},
	{key: "shmSizeBytes", env: "SCANTOR_NODE_SHM_SIZE", kind: apiKindBytes, flag: "shm-size",
		usage: "/dev/shm size of every worker created afterwards"},
	{key: "nofile", env: "SCANTOR_NODE_NOFILE", kind: apiKindInt, flag: "nofile",
		usage: "open-file limit of every worker created afterwards"},
	{key: "workerLogMaxSizeBytes", env: "SCANTOR_NODE_WORKER_LOG_MAX_SIZE", kind: apiKindBytes, flag: "worker-log-max-size",
		usage: "log file size of every worker created afterwards"},
	{key: "workerLogMaxFiles", env: "SCANTOR_NODE_WORKER_LOG_MAX_FILES", kind: apiKindInt, flag: "worker-log-max-files",
		usage: "log files kept of every worker created afterwards"},
	{key: "imageRetentionMs", env: "SCANTOR_NODE_IMAGE_RETENTION", kind: apiKindDuration, flag: "image-retention",
		usage: "how long an unused task image stays on the node"},
	{key: "pullTimeoutMs", env: "SCANTOR_NODE_PULL_TIMEOUT", kind: apiKindDuration, flag: "pull-timeout",
		usage: "time limit of one image pull"},
	{key: "logLevel", env: "SCANTOR_LOG_LEVEL", flag: "log-level", usage: "log level of the daemon"},
	{key: "logFormat", env: "SCANTOR_LOG_FORMAT"},
	{key: "overrides", env: "SCANTOR_NODE_OVERRIDES", kind: apiKindList, zero: "none"},
	{key: "dns.mode", env: "SCANTOR_NODE_DNS_MODE", flag: "dns-mode", usage: "node resolver mode"},
	{key: "dns.upstreams", env: "SCANTOR_NODE_DNS_UPSTREAMS", kind: apiKindList, flag: "dns-upstreams",
		usage: "upstream servers of recursive mode, comma-separated: ip, ip:port, [v6]:port, or host for the host nameservers; " +
			"private and special-purpose servers only in the node environment"},
	{key: "dns.rootServers", env: "SCANTOR_NODE_DNS_ROOT_SERVERS", kind: apiKindList, zero: "IANA root servers", flag: "dns-root-servers",
		usage: `root servers of iterative mode, comma-separated: ip, ip:port or [v6]:port; "" for the IANA root servers; ` +
			"private and special-purpose servers only in the node environment"},
	{key: "dns.localDomains", env: "SCANTOR_NODE_DNS_LOCAL_DOMAINS", kind: apiKindList, zero: "none", flag: "dns-local-domains",
		usage: "extra domains the node resolver resolves through the host nameservers, comma-separated"},
	{key: "dns.cacheSizeBytes", env: "SCANTOR_NODE_DNS_CACHE_SIZE", kind: apiKindBytes, flag: "dns-cache-size",
		usage: "answer cache size of the node resolver"},
	{key: "dns.maxLookups", env: "SCANTOR_NODE_DNS_MAX_LOOKUPS", kind: apiKindInt, flag: "dns-max-lookups",
		usage: "lookups the node resolver runs at once"},
	{key: "dns.upstreamQps", env: "SCANTOR_NODE_DNS_UPSTREAM_QPS", kind: apiKindInt, zero: "no limit", flag: "dns-upstream-qps",
		usage: "queries per second to each upstream server; 0 for no limit"},
	{key: "dns.authoritativeQps", env: "SCANTOR_NODE_DNS_AUTHORITATIVE_QPS", kind: apiKindInt, zero: "no limit", flag: "dns-authoritative-qps",
		usage: "queries per second to each authoritative server in iterative mode; 0 for no limit"},
}

// apiDaemonSettingOf returns the setting of a dotted key.
func apiDaemonSettingOf(key string) (apiDaemonSetting, bool) {
	i := slices.IndexFunc(apiDaemonSettings, func(s apiDaemonSetting) bool { return s.key == key })
	if i < 0 {
		return apiDaemonSetting{}, false
	}
	return apiDaemonSettings[i], true
}

// ── nodes daemon-config ──────────────────────────────────────────────────────

func newNodesDaemonConfigCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "daemon-config <node>",
		Short: "Show the daemon configuration of a node",
		Long: "Show the configuration the node's daemon runs with: every value with its source (env, default or " +
			"override) and its environment variable, then the daemon overrides, whether the daemon has applied " +
			"them, the overrides it rejected and its configuration warnings. Secrets are never part of it. JSON " +
			"output is the node's daemonConfig object, null until a daemon of the node's current instance " +
			"reported it. " + apiNodeArgHelp,
		Example: "  scantor nodes daemon-config scan-eu-1",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			node, err := client.GetNode(cmd.Context(), id)
			if err != nil {
				return err
			}
			return app.Output().Print(node.DaemonConfig, func(w io.Writer) error { return apiWriteDaemonConfig(w, node) })
		},
	}
}

// apiWriteDaemonConfig prints the daemon configuration table of a node followed by its daemon overrides.
func apiWriteDaemonConfig(w io.Writer, n *api.Node) error {
	dc := n.DaemonConfig
	if dc == nil {
		_, err := fmt.Fprintf(w, "node %s has not reported a valid daemon configuration: no daemon of its current "+
			"instance has connected yet, it runs an old daemon, or the orchestrator refused its report as invalid (see "+
			"the orchestrator log)\n", n.Name)
		return err
	}
	raw, err := json.Marshal(dc.Values)
	if err != nil {
		return PlatformError(fmt.Errorf("encode the daemon configuration: %w", err))
	}
	values, err := apiFlattenTree(raw)
	if err != nil {
		return PlatformError(fmt.Errorf("decode the daemon configuration: %w", err))
	}
	sources, err := apiFlattenTree(dc.Sources)
	if err != nil {
		return PlatformError(fmt.Errorf("decode the daemon configuration sources: %w", err))
	}
	t := Table{Headers: []string{"KEY", "VALUE", "SOURCE", "ENV"}}
	for _, s := range apiDaemonSettings {
		t.Add(s.key, apiSettingText(s, values[s.key]), apiSourceText(sources[s.key]), s.env)
	}
	if err := t.Write(w); err != nil {
		return err
	}
	var kv apiKV
	if err := apiAddDaemonOverrides(&kv, dc); err != nil {
		return err
	}
	kv.add("warnings", strings.Join(dc.Warnings, "\n"))
	kv.add("reported", apiTimeValue(dc.ReportedAt))
	if _, err := fmt.Fprintln(w); err != nil {
		return err
	}
	return kv.write(w)
}

// apiAddDaemonOverrides adds the daemon overrides of a node: the overridden keys, whether the daemon has
// applied the latest revision, the keys it rejected and who changed them last.
func apiAddDaemonOverrides(kv *apiKV, dc *api.NodeDaemonConfig) error {
	overrides, err := apiOverridesText(dc.Overrides)
	if err != nil {
		return err
	}
	if overrides == "" {
		overrides = "none"
	}
	kv.add("overrides", overrides)
	switch {
	case dc.Pending:
		kv.add("pending", fmt.Sprintf("yes: revision %d is set, the daemon has applied revision %d", dc.OverridesRev, dc.AppliedOverridesRev))
	case dc.OverridesRev > 0:
		kv.add("pending", fmt.Sprintf("no: the daemon has applied revision %d", dc.AppliedOverridesRev))
	default:
		kv.add("pending", "no")
	}
	rejected, err := apiFlattenTree(dc.Rejected)
	if err != nil {
		return PlatformError(fmt.Errorf("decode the rejected daemon overrides: %w", err))
	}
	lines := make([]string, 0, len(rejected))
	for _, key := range apiOrderedKeys(rejected) {
		var message string
		if err := json.Unmarshal(rejected[key], &message); err != nil {
			message = string(rejected[key])
		}
		lines = append(lines, key+": "+message)
	}
	kv.add("rejected", strings.Join(lines, "\n"))
	if dc.OverriddenAt != nil {
		by := apiDeref(dc.OverriddenBy)
		if by == "" {
			by = "unknown"
		}
		kv.add("changed", fmt.Sprintf("%s by %s", apiTime(dc.OverriddenAt), by))
	}
	return nil
}

// apiOverridesText renders daemon overrides as "key=value, …" in the order of the configuration table;
// no overrides render as "".
func apiOverridesText(raw json.RawMessage) (string, error) {
	overrides, err := apiFlattenTree(raw)
	if err != nil {
		return "", PlatformError(fmt.Errorf("decode the daemon overrides: %w", err))
	}
	parts := make([]string, 0, len(overrides))
	for _, key := range apiOrderedKeys(overrides) {
		s, ok := apiDaemonSettingOf(key)
		if !ok {
			s = apiDaemonSetting{key: key}
		}
		parts = append(parts, key+"="+apiSettingText(s, overrides[key]))
	}
	return strings.Join(parts, ", "), nil
}

// apiSourceOf returns the source of one value of a node's daemon configuration for summaries; "" when the
// node has none or its sources do not decode (`nodes daemon-config` reports that error).
func apiSourceOf(dc *api.NodeDaemonConfig, key string) string {
	if dc == nil {
		return ""
	}
	sources, err := apiFlattenTree(dc.Sources)
	if err != nil {
		return ""
	}
	return apiSourceText(sources[key])
}

// apiSourceText renders a source; a value without one comes from its default.
func apiSourceText(raw json.RawMessage) string {
	var source string
	if len(raw) == 0 || json.Unmarshal(raw, &source) != nil || source == "" {
		return api.SourceDefault
	}
	return source
}

// apiFlattenTree turns a JSON object tree into dotted keys ({"dns": {"mode": …}} → "dns.mode"); a missing
// or null tree is empty. Arrays and scalars are leaves.
func apiFlattenTree(raw json.RawMessage) (map[string]json.RawMessage, error) {
	out := map[string]json.RawMessage{}
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || string(trimmed) == "null" {
		return out, nil
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, err
	}
	for key, value := range object {
		if trimmed := bytes.TrimSpace(value); len(trimmed) > 0 && trimmed[0] == '{' {
			children, err := apiFlattenTree(value)
			if err != nil {
				return nil, err
			}
			for child, v := range children {
				out[key+"."+child] = v
			}
			continue
		}
		out[key] = value
	}
	return out, nil
}

// apiOrderedKeys orders dotted keys like the configuration table; keys this CLI does not know follow,
// sorted.
func apiOrderedKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for _, s := range apiDaemonSettings {
		if _, ok := m[s.key]; ok {
			keys = append(keys, s.key)
		}
	}
	var unknown []string
	for key := range m {
		if _, ok := apiDaemonSettingOf(key); !ok {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	return append(keys, unknown...)
}

// apiSettingText renders one value in the environment value syntax, so it can be given back to
// `daemon-overrides set`: byte sizes with a binary suffix, durations in Go syntax, lists comma-separated.
// A value of an unexpected shape renders as its JSON.
func apiSettingText(s apiDaemonSetting, raw json.RawMessage) string {
	if trimmed := bytes.TrimSpace(raw); len(trimmed) == 0 || string(trimmed) == "null" {
		return "-"
	}
	switch s.kind {
	case apiKindInt, apiKindBytes, apiKindDuration:
		var n int64
		if err := json.Unmarshal(raw, &n); err != nil {
			return string(raw)
		}
		text := strconv.FormatInt(n, 10)
		switch s.kind {
		case apiKindBytes:
			text = envconf.FormatByteSize(n)
		case apiKindDuration:
			text = apiDurationText(n)
		}
		if n == 0 && s.zero != "" {
			text += " (" + s.zero + ")"
		}
		return text
	case apiKindList:
		var items []string
		if err := json.Unmarshal(raw, &items); err != nil {
			// The overrides allow-list is "all" or "none" instead of a list of keys.
			var word string
			if json.Unmarshal(raw, &word) == nil {
				return word
			}
			return string(raw)
		}
		if len(items) == 0 {
			if s.zero != "" {
				return s.zero
			}
			return "-"
		}
		return strings.Join(items, ",")
	case apiKindCertificates:
		var certs []api.CACertificate
		if err := json.Unmarshal(raw, &certs); err != nil {
			return string(raw)
		}
		if len(certs) == 0 {
			return s.zero
		}
		parts := make([]string, len(certs))
		for i, c := range certs {
			parts[i] = fmt.Sprintf("%s (until %s)", c.Subject, c.NotAfter.UTC().Format(time.DateOnly))
		}
		return strings.Join(parts, "; ")
	default:
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return string(raw)
		}
		switch t := v.(type) {
		case string:
			if t == "" {
				return "-"
			}
			return t
		case bool:
			return strconv.FormatBool(t)
		default:
			return string(raw)
		}
	}
}

// apiDurationText renders milliseconds in Go duration syntax without trailing zero units ("24h", "30m",
// "1h30m", "500ms").
func apiDurationText(ms int64) string {
	text := (time.Duration(ms) * time.Millisecond).String()
	if strings.HasSuffix(text, "m0s") {
		text = strings.TrimSuffix(text, "0s")
	}
	if strings.HasSuffix(text, "h0m") {
		text = strings.TrimSuffix(text, "0m")
	}
	return text
}

// ── nodes daemon-overrides set|reset ─────────────────────────────────────────

// apiOverrideFlag holds the text of one override flag. The command parses it after flag parsing, so every
// problem is a usage error naming the flag and the bounds of schemas/daemon-overrides.json.
type apiOverrideFlag struct {
	value string
	typ   string
}

func (f *apiOverrideFlag) String() string { return f.value }

func (f *apiOverrideFlag) Set(s string) error {
	f.value = s
	return nil
}

func (f *apiOverrideFlag) Type() string { return f.typ }

// apiUnsetAllDNS is the --unset key that removes every dns override.
const apiUnsetAllDNS = "dns"

func newNodesDaemonOverridesSetCommand(app *App) *cobra.Command {
	specs, specsErr := apiOverrideSpecs()
	flags := map[string]*apiOverrideFlag{}
	var unset []string
	cmd := &cobra.Command{
		Use:   "set <node>",
		Short: "Override values of the daemon configuration of a node's running daemon",
		Long: "Set daemon overrides: values that replace values of the daemon configuration in the node's running " +
			"daemon instance until it stops, so a daemon restart clears them. Only the given flags change; --unset " +
			"removes an override (a dotted key such as maxWorkers or dns.mode, or dns for every dns override). " +
			"Byte sizes take an integer with an optional KiB, MiB, GiB or TiB suffix, durations Go syntax such as " +
			"30m or 24h, and lists are comma-separated. The daemon applies the overrides with its next assignments " +
			"poll: the values of worker containers apply to workers created afterwards, and a dns change replaces " +
			"the node resolver, whose cache then starts empty. The node operator can restrict overrides with " +
			"SCANTOR_NODE_OVERRIDES. The node's capacity = min(daemon value incl. daemon override, admin worker " +
			"limit): --max-workers overrides the daemon value, scantor nodes update --max-workers sets the admin " +
			"worker limit. " + apiNodeArgHelp,
		Example: `  scantor nodes daemon-overrides set scan-eu-1 --max-workers 16 --dns-mode iterative
  scantor nodes daemon-overrides set scan-eu-1 --dns-upstreams host --dns-cache-size 1GiB
  scantor nodes daemon-overrides set scan-eu-1 --unset maxWorkers --unset dns`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if specsErr != nil {
				return PlatformError(specsErr)
			}
			body, err := apiDaemonOverridesBody(specs, flags, cmd.Flags().Changed, unset)
			if err != nil {
				return err
			}
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			node, err := client.UpdateNodeDaemonOverrides(cmd.Context(), id, body)
			if err != nil {
				return apiDaemonOverridesHint(err, args[0])
			}
			return app.Output().Print(node, func(w io.Writer) error { return apiWriteDaemonOverrides(w, node) })
		},
	}
	for _, s := range apiDaemonSettings {
		if s.flag == "" {
			continue
		}
		f := &apiOverrideFlag{typ: s.kind.flagType()}
		flags[s.key] = f
		cmd.Flags().Var(f, s.flag, apiOverrideUsage(s, specs[s.key]))
	}
	cmd.Flags().StringSliceVar(&unset, "unset", nil, "remove the override of a dotted key such as maxWorkers or dns.mode; dns removes every dns override (repeatable)")
	return cmd
}

// apiOverrideUsage is the help text of an override flag: what it sets, its environment variable and its
// bounds.
func apiOverrideUsage(s apiDaemonSetting, spec apiOverrideSpec) string {
	bounds := apiOverrideBounds(s, spec)
	if bounds == "" {
		return fmt.Sprintf("%s (%s)", s.usage, s.env)
	}
	return fmt.Sprintf("%s (%s; %s)", s.usage, s.env, bounds)
}

// apiOverrideBounds describes the bounds of an overridable key ("" when the schema has none).
func apiOverrideBounds(s apiDaemonSetting, spec apiOverrideSpec) string {
	switch {
	case len(spec.Enum) > 0:
		return apiOneOf(spec.Enum)
	case spec.Min != nil && spec.Max != nil:
		return apiValueText(s, *spec.Min) + " to " + apiValueText(s, *spec.Max)
	case spec.MaxItems != nil && spec.MinItems != nil && *spec.MinItems > 0:
		return fmt.Sprintf("%d to %d entries", *spec.MinItems, *spec.MaxItems)
	case spec.MaxItems != nil:
		return fmt.Sprintf("up to %d entries", *spec.MaxItems)
	}
	return ""
}

// apiValueText renders a number of an integer setting in its unit.
func apiValueText(s apiDaemonSetting, n int64) string {
	switch s.kind {
	case apiKindBytes:
		return envconf.FormatByteSize(n)
	case apiKindDuration:
		return apiDurationText(n)
	default:
		return strconv.FormatInt(n, 10)
	}
}

// apiOneOf renders "a, b or c".
func apiOneOf(words []string) string {
	if len(words) < 2 {
		return strings.Join(words, "")
	}
	return strings.Join(words[:len(words)-1], ", ") + " or " + words[len(words)-1]
}

// apiDaemonOverridesBody builds the merge patch of `daemon-overrides set` from the changed flags and the
// --unset keys: a set flag sends its value, an unset key null (dns: null removes every dns override).
func apiDaemonOverridesBody(specs map[string]apiOverrideSpec, flags map[string]*apiOverrideFlag, changed func(string) bool, unset []string) (api.UpdateNodeDaemonOverrides, error) {
	var unsetKeys []string
	unsetDNS := false
	for _, key := range unset {
		key = strings.TrimSpace(key)
		if key == apiUnsetAllDNS {
			unsetDNS = true
			continue
		}
		if _, ok := specs[key]; !ok {
			return nil, UsageError(fmt.Errorf("--unset %q: unknown key; use %s or %s", key, strings.Join(apiOverridableKeys(), ", "), apiUnsetAllDNS))
		}
		if !slices.Contains(unsetKeys, key) {
			unsetKeys = append(unsetKeys, key)
		}
	}

	body := api.UpdateNodeDaemonOverrides{}
	for _, s := range apiDaemonSettings {
		f, ok := flags[s.key]
		if !ok || !changed(s.flag) {
			continue
		}
		if slices.Contains(unsetKeys, s.key) {
			return nil, UsageError(fmt.Errorf("--%s and --unset %s exclude each other", s.flag, s.key))
		}
		if unsetDNS && strings.HasPrefix(s.key, "dns.") {
			return nil, UsageError(fmt.Errorf("--%s and --unset %s exclude each other", s.flag, apiUnsetAllDNS))
		}
		value, err := apiParseOverride(s, specs[s.key], f.value)
		if err != nil {
			return nil, UsageError(fmt.Errorf("--%s %q: %w", s.flag, f.value, err))
		}
		apiSetOverride(body, s.key, value)
	}
	for _, key := range unsetKeys {
		if unsetDNS && strings.HasPrefix(key, "dns.") {
			return nil, UsageError(fmt.Errorf("--unset %s already removes %s", apiUnsetAllDNS, key))
		}
		apiSetOverride(body, key, nil)
	}
	if unsetDNS {
		body[apiUnsetAllDNS] = nil
	}
	if len(body) == 0 {
		return nil, UsageError(errors.New("nothing to change: give at least one flag"))
	}
	return body, nil
}

// apiSetOverride sets a dotted key in the merge patch; dns.* keys go into the nested dns object.
func apiSetOverride(body api.UpdateNodeDaemonOverrides, key string, value any) {
	parent, child, nested := strings.Cut(key, ".")
	if !nested {
		body[key] = value
		return
	}
	object, _ := body[parent].(map[string]any)
	if object == nil {
		object = map[string]any{}
		body[parent] = object
	}
	object[child] = value
}

// apiOverridableKeys lists the dotted override keys in the order of the configuration table.
func apiOverridableKeys() []string {
	var keys []string
	for _, s := range apiDaemonSettings {
		if s.flag != "" {
			keys = append(keys, s.key)
		}
	}
	return keys
}

// apiParseOverride parses the text of an override flag into its wire value and checks it against the
// bounds of schemas/daemon-overrides.json, as the orchestrator does.
func apiParseOverride(s apiDaemonSetting, spec apiOverrideSpec, text string) (any, error) {
	switch s.kind {
	case apiKindInt, apiKindBytes, apiKindDuration:
		var n int64
		var err error
		switch s.kind {
		case apiKindBytes:
			n, err = envconf.ParseByteSize(text)
		case apiKindDuration:
			var d time.Duration
			if d, err = envconf.ParseDuration(text); err == nil {
				if d%time.Millisecond != 0 {
					return nil, errors.New("invalid duration: use whole milliseconds")
				}
				n = d.Milliseconds()
			}
		default:
			n, err = envconf.ParseInt(text)
		}
		if err != nil {
			return nil, err
		}
		switch {
		case spec.Min != nil && spec.Max != nil && (n < *spec.Min || n > *spec.Max):
			return nil, fmt.Errorf("must be between %s and %s", apiValueText(s, *spec.Min), apiValueText(s, *spec.Max))
		case spec.Min != nil && n < *spec.Min:
			return nil, fmt.Errorf("must be at least %s", apiValueText(s, *spec.Min))
		case spec.Max != nil && n > *spec.Max:
			return nil, fmt.Errorf("must be at most %s", apiValueText(s, *spec.Max))
		}
		return n, nil
	case apiKindList:
		items := envconf.ParseList(text)
		if spec.MinItems != nil && len(items) < *spec.MinItems {
			return nil, fmt.Errorf("needs at least %s", countNoun(*spec.MinItems, "entry", "entries"))
		}
		if spec.MaxItems != nil && len(items) > *spec.MaxItems {
			return nil, fmt.Errorf("allows at most %s", countNoun(*spec.MaxItems, "entry", "entries"))
		}
		for i, item := range items {
			normalised, err := apiOverrideItem(spec.Format, item)
			if err != nil {
				return nil, err
			}
			items[i] = normalised
		}
		return items, nil
	default:
		value := strings.TrimSpace(text)
		if len(spec.Enum) > 0 && !slices.Contains(spec.Enum, value) {
			return nil, fmt.Errorf("must be %s", apiOneOf(spec.Enum))
		}
		return value, nil
	}
}

// apiOverrideItem checks one list entry against the item format of schemas/daemon-overrides.json and
// returns it normalised (domain names lowercase without a trailing dot).
func apiOverrideItem(format, item string) (string, error) {
	switch format {
	case "server":
		if err := apiCheckDNSServer(item, false); err != nil {
			return "", err
		}
		return item, nil
	case "serverOrHost":
		if item == "host" {
			return item, nil
		}
		if err := apiCheckDNSServer(item, true); err != nil {
			return "", err
		}
		return item, nil
	case "domain":
		domain := strings.TrimSuffix(strings.ToLower(item), ".")
		if len(domain) > 253 || !apiDomainPattern.MatchString(domain) {
			return "", fmt.Errorf("%q is not a domain name", item)
		}
		return domain, nil
	default:
		return "", fmt.Errorf("unsupported item format %q", format)
	}
}

// apiDomainPattern is the domain name syntax of daemon overrides (orchestrator/shared/schemas/nodes.ts).
var apiDomainPattern = regexp.MustCompile(`^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$`)

// apiPortPattern is a port without leading zeros; the range is checked separately.
var apiPortPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)

// apiDNSServerAddr parses a DNS server in the syntax of daemon overrides: an IP address, ip:port or
// [v6]:port (an IPv6 address without brackets has no port; ports without leading zeros). The address may
// carry a zone, which apiCheckDNSServer refuses.
func apiDNSServerAddr(s string) (netip.Addr, bool) {
	if len(s) > 64 {
		return netip.Addr{}, false
	}
	if addr, err := netip.ParseAddr(s); err == nil {
		return addr, true
	}
	i := strings.LastIndexByte(s, ':')
	if i < 0 || !apiPortPattern.MatchString(s[i+1:]) {
		return netip.Addr{}, false
	}
	addrPort, err := netip.ParseAddrPort(s)
	if err != nil || addrPort.Port() == 0 {
		return netip.Addr{}, false
	}
	// A bracketed address must be IPv6 and an IPv4 address must not be bracketed.
	if strings.HasPrefix(s, "[") != addrPort.Addr().Is6() {
		return netip.Addr{}, false
	}
	return addrPort.Addr(), true
}

// apiDNSServerRefusedMessage is why a daemon override never names a private or special-purpose server: the
// node resolver queries such a server only when the node environment configures it (docs/nodes.md §6.12).
const apiDNSServerRefusedMessage = "private and special-purpose servers can only be configured in the node environment (SCANTOR_NODE_DNS_*)"

// apiCheckDNSServer checks a DNS server of a daemon override as the orchestrator does
// (orchestrator/shared/utils/dns-servers.ts): the syntax of apiDNSServerAddr without zone, a unicast
// address that is not IPv6 link-local, and outside the ranges the node resolver refuses unless the node
// environment names the server (resolver.AlwaysRefused, after unmapping an IPv4-mapped address).
func apiCheckDNSServer(s string, allowHost bool) error {
	addr, ok := apiDNSServerAddr(s)
	if !ok {
		if allowHost {
			return fmt.Errorf("%q is not an IP address, ip:port, [v6]:port or host", s)
		}
		return fmt.Errorf("%q is not an IP address, ip:port or [v6]:port", s)
	}
	unmapped := addr.Unmap()
	switch {
	case addr.Zone() != "":
		return fmt.Errorf("%q has a zone: zoned addresses are not supported", s)
	case unmapped.IsUnspecified() || unmapped.IsMulticast():
		return fmt.Errorf("%q is not a unicast address", s)
	case unmapped.Is6() && unmapped.IsLinkLocalUnicast():
		return fmt.Errorf("%q: IPv6 link-local addresses are not supported", s)
	case resolver.AlwaysRefused(unmapped):
		return fmt.Errorf("%q: %s", s, apiDNSServerRefusedMessage)
	}
	return nil
}

func newNodesDaemonOverridesResetCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "reset <node>",
		Short: "Remove every daemon override of a node",
		Long: "Remove every daemon override of the node's running daemon instance: the daemon returns to the values " +
			"of its environment with its next assignments poll (a dns change replaces the node resolver). Nothing " +
			"changes when no override is set. " + apiNodeArgHelp,
		Example: "  scantor nodes daemon-overrides reset scan-eu-1",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			client, err := app.APIClient()
			if err != nil {
				return err
			}
			id, err := apiResolveNode(cmd.Context(), client, args[0])
			if err != nil {
				return err
			}
			node, err := client.DeleteNodeDaemonOverrides(cmd.Context(), id)
			if err != nil {
				return apiDaemonOverridesHint(err, args[0])
			}
			return app.Output().Print(node, func(w io.Writer) error { return apiWriteDaemonOverrides(w, node) })
		},
	}
}

// apiWriteDaemonOverrides prints the daemon overrides of a node after a change.
func apiWriteDaemonOverrides(w io.Writer, n *api.Node) error {
	var kv apiKV
	kv.add("node", n.Name)
	if n.DaemonConfig == nil {
		kv.add("overrides", "none (no daemon of the node's current instance has reported its configuration)")
	} else if err := apiAddDaemonOverrides(&kv, n.DaemonConfig); err != nil {
		return err
	}
	return kv.write(w)
}

// apiDaemonOverridesHint explains a daemonOverridesUnavailable conflict by the reason in its details.
func apiDaemonOverridesHint(err error, ref string) error {
	apiErr, ok := api.AsError(err)
	if !ok || apiErr.Code != api.CodeDaemonOverridesUnavailable {
		return err
	}
	var details struct {
		Reason string   `json:"reason"`
		Keys   []string `json:"keys"`
	}
	if apiErr.DecodeDetails(&details) != nil {
		return err
	}
	var hint string
	switch details.Reason {
	case "noInstance":
		hint = "no daemon instance holds the node's lease; daemon overrides apply only to a running daemon"
	case "notReported":
		hint = "the node has not reported a valid daemon configuration (an old daemon or an invalid report; a daemon that " +
			"is still connecting reports it shortly)"
	case "notAllowed":
		keys := "these keys"
		if len(details.Keys) > 0 {
			keys = strings.Join(details.Keys, ", ")
		}
		hint = fmt.Sprintf("SCANTOR_NODE_OVERRIDES of the node does not allow overriding %s (see scantor nodes daemon-config %s)", keys, ref)
	default:
		return err
	}
	return apiWithHint(err, api.CodeDaemonOverridesUnavailable, hint)
}

// apiResolverSummary renders the node resolver of a node report: state, mode, address and error.
func apiResolverSummary(r *api.NodeResolverReport) string {
	state := r.State
	if state == "" {
		state = "unknown"
	}
	var details []string
	if r.Mode != "" && r.Mode != api.ResolverModeDisabled {
		details = append(details, r.Mode)
	}
	if r.Address != "" {
		details = append(details, r.Address)
	}
	if r.Kept {
		details = append(details, "kept for existing workers")
	}
	if len(details) > 0 {
		state += " (" + strings.Join(details, ", ") + ")"
	}
	if r.Error != nil && *r.Error != "" {
		state += ": " + *r.Error
		if r.Detail != "" {
			state += ", " + r.Detail
		}
	}
	return state
}
