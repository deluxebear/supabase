package repository

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

type Config struct {
	Type     string `json:"type"`
	Endpoint string `json:"endpoint"`
	Bucket   string `json:"bucket,omitempty"`
	Path     string `json:"path,omitempty"`
	Region   string `json:"region,omitempty"`
}

type Credentials map[string]string

func Fingerprint(config Config) (string, error) {
	encoded, err := json.Marshal(config)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

type KeyWrapper interface {
	KeyID() string
	Wrap(context.Context, []byte) ([]byte, error)
	Unwrap(context.Context, []byte) ([]byte, error)
}

type EncryptedCredentials struct {
	Version        int    `json:"version"`
	KeyID          string `json:"keyId"`
	WrappedKey     []byte `json:"wrappedKey"`
	DataNonce      []byte `json:"dataNonce"`
	DataCiphertext []byte `json:"dataCiphertext"`
}

func Encrypt(ctx context.Context, wrapper KeyWrapper, credentials Credentials) (EncryptedCredentials, error) {
	if wrapper == nil || wrapper.KeyID() == "" {
		return EncryptedCredentials{}, errors.New("key wrapper is required")
	}
	plaintext, err := json.Marshal(credentials)
	if err != nil {
		return EncryptedCredentials{}, err
	}
	dek := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return EncryptedCredentials{}, err
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return EncryptedCredentials{}, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return EncryptedCredentials{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return EncryptedCredentials{}, err
	}
	wrapped, err := wrapper.Wrap(ctx, dek)
	if err != nil {
		return EncryptedCredentials{}, err
	}
	return EncryptedCredentials{
		Version:        1,
		KeyID:          wrapper.KeyID(),
		WrappedKey:     wrapped,
		DataNonce:      nonce,
		DataCiphertext: aead.Seal(nil, nonce, plaintext, []byte(wrapper.KeyID())),
	}, nil
}

func Decrypt(ctx context.Context, wrapper KeyWrapper, encrypted EncryptedCredentials) (Credentials, error) {
	if encrypted.Version != 1 || encrypted.KeyID != wrapper.KeyID() {
		return nil, errors.New("unsupported envelope version or key ID")
	}
	dek, err := wrapper.Unwrap(ctx, encrypted.WrappedKey)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, encrypted.DataNonce, encrypted.DataCiphertext, []byte(encrypted.KeyID))
	if err != nil {
		return nil, fmt.Errorf("decrypt credentials: %w", err)
	}
	var credentials Credentials
	if err := json.Unmarshal(plaintext, &credentials); err != nil {
		return nil, err
	}
	return credentials, nil
}

// AESKeyWrapper is the lightweight local implementation. Production can
// replace it with KMS/Vault while keeping the envelope format unchanged.
type AESKeyWrapper struct {
	ID  string
	Key []byte
}

func (w AESKeyWrapper) KeyID() string { return w.ID }

func (w AESKeyWrapper) Wrap(_ context.Context, plaintext []byte) ([]byte, error) {
	return seal(w.Key, plaintext, []byte(w.ID))
}

func (w AESKeyWrapper) Unwrap(_ context.Context, ciphertext []byte) ([]byte, error) {
	return open(w.Key, ciphertext, []byte(w.ID))
}

func seal(key, plaintext, additional []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, aead.Seal(nil, nonce, plaintext, additional)...), nil
}

func open(key, ciphertext, additional []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(ciphertext) < aead.NonceSize() {
		return nil, errors.New("wrapped key is truncated")
	}
	return aead.Open(nil, ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():], additional)
}

type AccessTester interface {
	Check(context.Context, Config, Credentials) error
}
