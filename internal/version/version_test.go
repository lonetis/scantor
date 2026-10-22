package version

import "testing"

func TestImageRef(t *testing.T) {
	origPrefix, origVersion := ImagePrefix, Version
	t.Cleanup(func() { ImagePrefix, Version = origPrefix, origVersion })

	tests := []struct {
		name        string
		prefix, ver string
		override    ImageOverride
		want        string
	}{
		{"dev build", "", "dev", ImageOverride{}, "scantor-base-python:dev"},
		{"release build", "ghcr.io/lonetis/", "1.4.0", ImageOverride{}, "ghcr.io/lonetis/scantor-base-python:1.4.0"},
		{"override replaces the pair", "ghcr.io/lonetis/", "1.4.0-3-gabc", ImageOverride{Prefix: "ghcr.io/lonetis/", Tag: "latest"}, "ghcr.io/lonetis/scantor-base-python:latest"},
		{"override with empty prefix", "ghcr.io/lonetis/", "1.4.0", ImageOverride{Prefix: "", Tag: "dev"}, "scantor-base-python:dev"},
		{"prefix without tag is ignored", "", "dev", ImageOverride{Prefix: "ghcr.io/lonetis/"}, "scantor-base-python:dev"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ImagePrefix, Version = tc.prefix, tc.ver
			if got := ImageRef("scantor-base-python", tc.override); got != tc.want {
				t.Fatalf("ImageRef = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestIsRelease(t *testing.T) {
	for v, want := range map[string]bool{
		"1.4.0": true, "0.0.1": true, "10.20.30": true,
		"dev": false, "v1.4.0": false, "1.4": false, "1.4.0-3-gabc": false, "01.2.3": false,
	} {
		if got := IsRelease(v); got != want {
			t.Errorf("IsRelease(%q) = %v, want %v", v, got, want)
		}
	}
}
