package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func computeHMAC(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifySignature_Valid(t *testing.T) {
	body := []byte(`{"action":"push"}`)
	secret := "test-secret"
	sig := computeHMAC(body, secret)

	if !VerifySignature(body, secret, sig) {
		t.Error("expected valid signature")
	}
}

func TestVerifySignature_Invalid(t *testing.T) {
	body := []byte(`{"action":"push"}`)
	secret := "test-secret"
	sig := "sha256=0000000000000000000000000000000000000000000000000000000000000000"

	if VerifySignature(body, secret, sig) {
		t.Error("expected invalid signature")
	}
}

func TestVerifySignature_EmptySecret(t *testing.T) {
	body := []byte(`{"action":"push"}`)
	if !VerifySignature(body, "", "anything") {
		t.Error("empty secret should skip verification")
	}
}

func TestVerifySignature_MalformedHeader(t *testing.T) {
	body := []byte(`{"action":"push"}`)
	secret := "test-secret"

	// Empty signature with non-empty secret
	if VerifySignature(body, secret, "") {
		t.Error("empty signature should fail")
	}

	// Invalid hex
	if VerifySignature(body, secret, "sha256=not-hex-data") {
		t.Error("malformed hex should fail")
	}

	// No prefix, invalid hex
	if VerifySignature(body, secret, "zzz") {
		t.Error("malformed signature should fail")
	}
}
