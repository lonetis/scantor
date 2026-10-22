package envconf

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestParseBool(t *testing.T) {
	for in, want := range map[string]bool{"true": true, "false": false, " true ": true} {
		got, err := ParseBool(in)
		if err != nil || got != want {
			t.Errorf("ParseBool(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"", "TRUE", "yes", "1", "on"} {
		if _, err := ParseBool(in); err == nil {
			t.Errorf("ParseBool(%q) accepted an invalid value", in)
		}
	}
}

func TestParseList(t *testing.T) {
	got := ParseList(" a, b ,,c ,")
	if strings.Join(got, "|") != "a|b|c" {
		t.Fatalf("ParseList = %q", got)
	}
	if got := ParseList(""); len(got) != 0 {
		t.Fatalf("ParseList(\"\") = %q, want empty", got)
	}
}

func TestParseDuration(t *testing.T) {
	cases := map[string]time.Duration{"500ms": 500 * time.Millisecond, "30s": 30 * time.Second, "15m": 15 * time.Minute, "24h": 24 * time.Hour, "1h30m": 90 * time.Minute, "1.5h": 90 * time.Minute, "0s": 0}
	for in, want := range cases {
		got, err := ParseDuration(in)
		if err != nil || got != want {
			t.Errorf("ParseDuration(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, in := range []string{"", "5", "-1s", "1d", "abc"} {
		if _, err := ParseDuration(in); err == nil {
			t.Errorf("ParseDuration(%q) accepted an invalid value", in)
		}
	}
}

func TestParseByteSize(t *testing.T) {
	cases := map[string]int64{"0": 0, "512": 512, "64KiB": 64 * KiB, "512MiB": 512 * MiB, "10GiB": 10 * GiB, "2TiB": 2 * TiB}
	for in, want := range cases {
		got, err := ParseByteSize(in)
		if err != nil || got != want {
			t.Errorf("ParseByteSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	for _, in := range []string{"", "-1", "1KB", "1 MiB", "1.5GiB", "1mib", "99999999999999999999", "9999999999TiB"} {
		if _, err := ParseByteSize(in); err == nil {
			t.Errorf("ParseByteSize(%q) accepted an invalid value", in)
		}
	}
}

func TestFormatByteSize(t *testing.T) {
	for in, want := range map[int64]string{0: "0", 1000: "1000", 2048: "2KiB", 20 * MiB: "20MiB", 3 * GiB: "3GiB", TiB: "1TiB"} {
		if got := FormatByteSize(in); got != want {
			t.Errorf("FormatByteSize(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestParseDays(t *testing.T) {
	if n, err := ParseDays("7"); err != nil || n != 7 {
		t.Fatalf("ParseDays(7) = %d, %v", n, err)
	}
	for _, in := range []string{"-1", "1.5", "x", ""} {
		if _, err := ParseDays(in); err == nil {
			t.Errorf("ParseDays(%q) accepted an invalid value", in)
		}
	}
}

func TestReader(t *testing.T) {
	env := map[string]string{
		"B_OK":     "true",
		"B_BAD":    "yes",
		"B_SEC":    "maybe",
		"EMPTY":    "  ",
		"D_OK":     "30s",
		"D_BAD":    "30",
		"S_OK":     "1GiB",
		"I_OK":     "64",
		"I_RANGE":  "0",
		"L":        "a, b",
		"E_OK":     "remote",
		"E_BAD":    "elsewhere",
		"U_OK":     "https://example.com/",
		"U_BAD":    "ftp://example.com",
		"U_SEC":    "not a url",
		"DAYS":     "14",
		"STR":      "value",
		"STR_PADS": " v ",
	}
	r := NewReader(func(k string) string { return env[k] })

	if !r.Bool("B_OK", false) || !r.Bool("B_MISSING", true) || r.Bool("B_BAD", false) {
		t.Error("Bool values")
	}
	_ = r.Bool("B_SEC", false, Security())
	if r.String("EMPTY", "def") != "def" || r.String("STR", "") != "value" || r.String("STR_PADS", "") != " v " {
		t.Error("String values")
	}
	if r.Duration("D_OK", time.Second) != 30*time.Second || r.Duration("D_BAD", time.Second) != time.Second {
		t.Error("Duration values")
	}
	if r.ByteSize("S_OK", 0) != GiB {
		t.Error("ByteSize value")
	}
	if r.Int("I_OK", 1, 1, 100) != 64 || r.Int("I_RANGE", 5, 1, 100) != 5 {
		t.Error("Int values")
	}
	if strings.Join(r.List("L", nil), "|") != "a|b" || len(r.List("L_MISSING", []string{"x"})) != 1 {
		t.Error("List values")
	}
	if r.Enum("E_OK", "local", []string{"local", "remote"}) != "remote" || r.Enum("E_BAD", "local", []string{"local", "remote"}) != "local" {
		t.Error("Enum values")
	}
	if r.URL("U_OK", "", []string{"http", "https"}) != "https://example.com" || r.URL("U_BAD", "http://d", []string{"http", "https"}) != "http://d" {
		t.Error("URL values")
	}
	_ = r.URL("U_SEC", "", []string{"https"}, Security())
	if r.Days("DAYS", 1) != 14 {
		t.Error("Days value")
	}

	err := r.Err()
	if err == nil {
		t.Fatal("expected errors for security-relevant variables")
	}
	for _, name := range []string{"B_SEC", "U_SEC"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error does not name %s: %v", name, err)
		}
	}
	if strings.Contains(err.Error(), "maybe") || strings.Contains(err.Error(), "not a url") {
		t.Errorf("errors must name variables, never values: %v", err)
	}
	warnings := strings.Join(r.Warnings(), "\n")
	for _, name := range []string{"B_BAD", "D_BAD", "I_RANGE", "E_BAD", "U_BAD"} {
		if !strings.Contains(warnings, name) {
			t.Errorf("warnings do not name %s: %s", name, warnings)
		}
	}
}

func testCertPEM(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "scantor test CA"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestParsePEMCertificates(t *testing.T) {
	cert := testCertPEM(t)
	oneLine := strings.ReplaceAll(strings.TrimSpace(cert), "\n", `\n`)
	for name, in := range map[string]string{"multi-line": cert, "one line with \\n escapes": oneLine, "bundle": cert + cert} {
		got, err := ParsePEMCertificates(in)
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		if strings.Contains(got, `\n`) || !strings.HasPrefix(got, "-----BEGIN CERTIFICATE-----\n") || !strings.HasSuffix(got, "-----END CERTIFICATE-----\n") {
			t.Errorf("%s: not normalised: %q", name, got)
		}
	}
	for _, in := range []string{"not a certificate", "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"} {
		if _, err := ParsePEMCertificates(in); err == nil {
			t.Errorf("ParsePEMCertificates(%q) accepted an invalid bundle", in)
		}
	}

	r := NewReader(func(k string) string { return map[string]string{"CA": oneLine, "BAD": "x"}[k] })
	if got := r.PEMCertificates("CA", Security()); !strings.HasPrefix(got, "-----BEGIN") || r.PEMCertificates("UNSET") != "" {
		t.Errorf("PEMCertificates = %q", got)
	}
	if r.PEMCertificates("BAD", Security()) != "" || r.Err() == nil || !strings.Contains(r.Err().Error(), "BAD") {
		t.Errorf("invalid bundle not reported: %v", r.Err())
	}
}
