package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
)

type Envelope struct {
	Version    int    `json:"version"`
	KeyID      string `json:"keyId"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type KeyProvider interface {
	CurrentKey() (keyID string, key []byte, err error)
	Key(keyID string) ([]byte, error)
}

type EnvelopeCipher struct {
	Keys   KeyProvider
	Random io.Reader
}

func (c EnvelopeCipher) Encrypt(plaintext, additionalData []byte) (Envelope, error) {
	if c.Keys == nil {
		return Envelope{}, errors.New("secret key provider is required")
	}
	keyID, key, err := c.Keys.CurrentKey()
	if err != nil || keyID == "" {
		return Envelope{}, fmt.Errorf("load current secret key: %w", err)
	}
	aead, err := newAEAD(key)
	if err != nil {
		return Envelope{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	random := c.Random
	if random == nil {
		random = rand.Reader
	}
	if _, err := io.ReadFull(random, nonce); err != nil {
		return Envelope{}, fmt.Errorf("generate secret nonce: %w", err)
	}
	ciphertext := aead.Seal(nil, nonce, plaintext, additionalData)
	return Envelope{Version: 1, KeyID: keyID, Nonce: base64.RawStdEncoding.EncodeToString(nonce), Ciphertext: base64.RawStdEncoding.EncodeToString(ciphertext)}, nil
}

func (c EnvelopeCipher) Decrypt(envelope Envelope, additionalData []byte) ([]byte, error) {
	if c.Keys == nil || envelope.Version != 1 || envelope.KeyID == "" {
		return nil, errors.New("supported secret envelope and key provider are required")
	}
	key, err := c.Keys.Key(envelope.KeyID)
	if err != nil {
		return nil, fmt.Errorf("load secret key %q: %w", envelope.KeyID, err)
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	nonce, err := base64.RawStdEncoding.DecodeString(envelope.Nonce)
	if err != nil || len(nonce) != aead.NonceSize() {
		return nil, errors.New("invalid secret envelope nonce")
	}
	ciphertext, err := base64.RawStdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil {
		return nil, errors.New("invalid secret envelope ciphertext")
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, additionalData)
	if err != nil {
		return nil, errors.New("secret envelope authentication failed")
	}
	return plaintext, nil
}

func (c EnvelopeCipher) Rotate(envelope Envelope, additionalData []byte) (Envelope, error) {
	plaintext, err := c.Decrypt(envelope, additionalData)
	if err != nil {
		return Envelope{}, err
	}
	return c.Encrypt(plaintext, additionalData)
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	if len(key) != 16 && len(key) != 24 && len(key) != 32 {
		return nil, errors.New("AES secret key must be 16, 24, or 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
