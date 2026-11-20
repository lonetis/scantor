package runtime

import (
	"strings"
	"testing"

	"github.com/lonetis/scantor/internal/api"
)

func TestLoadConfigDataSources(t *testing.T) {
	cfg, err := LoadConfig(func(string) string { return "" }, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataSources != (api.DataSources{}) {
		t.Fatalf("unset data sources: %+v", cfg.DataSources)
	}

	env := map[string]string{
		EnvTrancoURL:    "https://tranco.example.org/",
		EnvCruxURL:      " http://mirror.internal:8080/crux ",
		EnvCruxCacheURL: "https://cache.example.org/crux-cache",
	}
	cfg, err = LoadConfig(func(k string) string { return env[k] }, nil)
	if err != nil {
		t.Fatal(err)
	}
	want := api.DataSources{Tranco: "https://tranco.example.org", Crux: "http://mirror.internal:8080/crux", CruxCache: "https://cache.example.org/crux-cache"}
	if cfg.DataSources != want {
		t.Fatalf("data sources %+v, want %+v", cfg.DataSources, want)
	}

	for _, bad := range []string{"ftp://tranco.example.org", "tranco.example.org", "https://tranco.example.org/?list=1"} {
		_, err := LoadConfig(func(k string) string {
			if k == EnvTrancoURL {
				return bad
			}
			return ""
		}, nil)
		if err == nil || !strings.Contains(err.Error(), EnvTrancoURL) {
			t.Errorf("%q: error %v", bad, err)
		}
	}
}
