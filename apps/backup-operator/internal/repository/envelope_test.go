package repository

import (
	"context"
	"testing"
)

func TestEnvelopeRoundTripAndTamperDetection(t *testing.T) {
	wrapper := AESKeyWrapper{ID: "local-key-v1", Key: []byte("0123456789abcdef0123456789abcdef")}
	credentials := Credentials{"accessKey": "secret", "token": "value"}
	encrypted, err := Encrypt(context.Background(), wrapper, credentials)
	if err != nil {
		t.Fatal(err)
	}
	decrypted, err := Decrypt(context.Background(), wrapper, encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if decrypted["accessKey"] != "secret" || decrypted["token"] != "value" {
		t.Fatalf("unexpected credentials: %#v", decrypted)
	}
	encrypted.DataCiphertext[0] ^= 0xff
	if _, err := Decrypt(context.Background(), wrapper, encrypted); err == nil {
		t.Fatal("tampered ciphertext was accepted")
	}
}

func TestFingerprintExcludesCredentials(t *testing.T) {
	config := Config{Type: "s3", Endpoint: "https://s3.example", Bucket: "backups", Region: "local"}
	first, err := Fingerprint(config)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := Fingerprint(config)
	if first == "" || first != second {
		t.Fatalf("unstable fingerprint: %q %q", first, second)
	}
}
