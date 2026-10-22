package keys

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"math/big"
)

// RegistrySigningKey derives the ES256 registry token signing key from key("registry-signing").
//
// The P-256 private scalar is d = (k mod (n − 1)) + 1, where k is the 32-byte HKDF output read as a
// big-endian unsigned integer and n is the order of P-256. This maps every key onto the valid range
// [1, n − 1] deterministically, so the orchestrator (TypeScript) and Go derive the same key.
func RegistrySigningKey(secret string) (*ecdsa.PrivateKey, error) {
	k, err := Derive(secret, LabelRegistrySigning)
	if err != nil {
		return nil, err
	}
	n := elliptic.P256().Params().N
	d := new(big.Int).SetBytes(k)
	d.Mod(d, new(big.Int).Sub(n, big.NewInt(1)))
	d.Add(d, big.NewInt(1))
	raw := make([]byte, 32)
	d.FillBytes(raw)
	priv, err := ecdsa.ParseRawPrivateKey(elliptic.P256(), raw)
	if err != nil {
		return nil, fmt.Errorf("registry signing key: %w", err)
	}
	return priv, nil
}

// RegistrySigningKID returns the JWKS key id of a registry signing public key:
// "scantor-" + the first 16 hex characters of SHA-256 of the uncompressed public point (0x04 ‖ X ‖ Y).
func RegistrySigningKID(pub *ecdsa.PublicKey) (string, error) {
	point, err := pub.Bytes()
	if err != nil {
		return "", fmt.Errorf("registry signing kid: %w", err)
	}
	sum := sha256.Sum256(point)
	return "scantor-" + hex.EncodeToString(sum[:])[:16], nil
}
