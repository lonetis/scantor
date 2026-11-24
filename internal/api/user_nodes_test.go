package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNodeRequests(t *testing.T) {
	type seen struct {
		method, path, query, body string
	}
	const nodeID = "2d9e4f1a-6b7c-4d8e-9f0a-1b2c3d4e5f6a"
	const node = `{"id":"` + nodeID + `","name":"scan-eu-1","state":"online","daemonConfig":{"values":{"maxWorkers":16,` +
		`"overrides":"all","dns":{"mode":"iterative","upstreams":["host"],"rootServers":[],"localDomains":[],"cacheSizeBytes":268435456,` +
		`"maxLookups":1000,"upstreamQps":0,"authoritativeQps":200}},"sources":{"maxWorkers":"override","dns":{"mode":"override"}},` +
		`"warnings":[],"overrides":{"maxWorkers":16,"dns":{"mode":"iterative"}},"overridesRev":3,"appliedOverridesRev":2,` +
		`"pending":true,"rejected":{},"overriddenBy":"u1","overriddenAt":"2026-11-24T09:00:00.000Z","reportedAt":"2026-11-24T09:00:01.000Z"}}`
	var got []seen
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got = append(got, seen{r.Method, r.URL.Path, r.URL.RawQuery, string(body)})
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/nodes" {
			_, _ = io.WriteString(w, `{"items":[`+node+`]}`)
			return
		}
		_, _ = io.WriteString(w, node)
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{Kind: PrincipalUser, Token: "sk_scantor_test"})
	ctx := context.Background()

	nodes, err := c.ListNodes(ctx, ListNodesQuery{})
	if err != nil || len(nodes) != 1 || nodes[0].Name != "scan-eu-1" {
		t.Fatalf("list: %+v %v", nodes, err)
	}
	if _, err := c.ListNodes(ctx, ListNodesQuery{State: "online", Pool: "remote", DaemonConfig: true}); err != nil {
		t.Fatal(err)
	}
	updated, err := c.UpdateNodeDaemonOverrides(ctx, nodeID, UpdateNodeDaemonOverrides{
		"maxWorkers": 16, "pidsLimit": nil, "dns": map[string]any{"mode": "iterative", "upstreams": []string{"host"}, "rootServers": nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	dc := updated.DaemonConfig
	if dc == nil || dc.Values.MaxWorkers != 16 || dc.Values.DNS.Mode != "iterative" || !dc.Pending || dc.OverridesRev != 3 ||
		dc.AppliedOverridesRev != 2 || string(dc.Values.Overrides) != `"all"` || dc.OverriddenBy == nil || *dc.OverriddenBy != "u1" {
		t.Fatalf("update: %+v", dc)
	}
	if _, err := c.DeleteNodeDaemonOverrides(ctx, nodeID); err != nil {
		t.Fatal(err)
	}

	want := []seen{
		{"GET", "/api/nodes", "", ""},
		{"GET", "/api/nodes", "include=daemonConfig&pool=remote&state=online", ""},
		{"PATCH", "/api/nodes/" + nodeID + "/daemon-overrides", "", `{"dns":{"mode":"iterative","rootServers":null,"upstreams":["host"]},"maxWorkers":16,"pidsLimit":null}`},
		{"DELETE", "/api/nodes/" + nodeID + "/daemon-overrides", "", ""},
	}
	if len(got) != len(want) {
		t.Fatalf("requests = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("request %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

// A refused override is a 409 with code daemonOverridesUnavailable: a validation error of the CLI (exit 2)
// whose details name the reason.
func TestDaemonOverridesUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":{"code":"daemonOverridesUnavailable","message":"not allowed","details":{"reason":"notAllowed","keys":["dns.upstreams"]}}}`)
	}))
	defer srv.Close()
	c := newTestClient(t, srv, Credential{Kind: PrincipalUser, Token: "sk_scantor_test"})
	_, err := c.UpdateNodeDaemonOverrides(context.Background(), "n1", UpdateNodeDaemonOverrides{"dns": map[string]any{"upstreams": []string{"host"}}})
	apiErr, ok := AsError(err)
	if !ok || apiErr.Code != CodeDaemonOverridesUnavailable || apiErr.ExitClass() != ExitValidation {
		t.Fatalf("err = %#v", err)
	}
	var details struct {
		Reason string   `json:"reason"`
		Keys   []string `json:"keys"`
	}
	if err := apiErr.DecodeDetails(&details); err != nil || details.Reason != "notAllowed" || len(details.Keys) != 1 {
		t.Fatalf("details = %+v, %v", details, err)
	}
}
