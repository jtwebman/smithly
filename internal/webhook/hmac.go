package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"strings"
)

// VerifySignature checks an HMAC-SHA256 signature against a body and secret.
// The signature should be in "sha256=<hex>" format (GitHub-compatible).
// Returns true if valid, false otherwise. Empty secret always returns true (skip verification).
func VerifySignature(body []byte, secret, signature string) bool {
	if secret == "" {
		return true
	}
	if signature == "" {
		return false
	}

	// Strip the "sha256=" prefix if present
	hexSig := signature
	if after, ok := strings.CutPrefix(signature, "sha256="); ok {
		hexSig = after
	}

	expected, err := hex.DecodeString(hexSig)
	if err != nil {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	computed := mac.Sum(nil)

	return subtle.ConstantTimeCompare(expected, computed) == 1
}
