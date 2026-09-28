// Package sealedsecret implements the Fleet sealed-secret envelope: Studio
// encrypts secret material to one Agent's X25519 recipient key, so the
// operation record, Fleet Control, and evidence carry only ciphertext.
//
// Envelope v1: ephemeral X25519 key agreement, HKDF-SHA256 (salt is the
// ephemeral public key followed by the recipient public key, info is the
// schema), and AES-256-GCM. The additional data binds the ciphertext to the
// project, binding, configuration domain, file path, and recipient key, so an
// envelope cannot be replayed into another project, domain, or file.
package sealedsecret

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

const (
	Schema       = "supabase.fleet.sealed-secret.v1"
	keySize      = 32
	nonceSize    = 12
	maxPlaintext = 1 << 20
)

// Envelope is the JSON form carried in desired configuration documents.
type Envelope struct {
	Schema             string `json:"schema"`
	RecipientKeyID     string `json:"recipientKeyId"`
	EphemeralPublicKey string `json:"ephemeralPublicKey"`
	Nonce              string `json:"nonce"`
	Ciphertext         string `json:"ciphertext"`
}

// Context names where the plaintext may be used.
type Context struct {
	ProjectRef string
	BindingID  string
	Domain     string
	Path       string
}

func (c Context) validate() error {
	for name, value := range map[string]string{"project": c.ProjectRef, "binding": c.BindingID, "domain": c.Domain, "path": c.Path} {
		if value == "" || strings.ContainsAny(value, "\n\x00") {
			return fmt.Errorf("sealed secret %s context is invalid", name)
		}
	}
	return nil
}

// KeyID identifies a recipient public key without revealing anything secret.
func KeyID(publicKey []byte) string {
	digest := sha256.Sum256(publicKey)
	return hex.EncodeToString(digest[:16])
}

func additionalData(context Context, keyID string) []byte {
	return []byte(strings.Join([]string{Schema, context.ProjectRef, context.BindingID, context.Domain, context.Path, keyID}, "\n"))
}

func deriveKey(shared, ephemeralPublic, recipientPublic []byte) ([]byte, error) {
	salt := append(append([]byte{}, ephemeralPublic...), recipientPublic...)
	return hkdf.Key(sha256.New, shared, salt, Schema, keySize)
}

// Seal encrypts plaintext to the recipient. Studio seals in TypeScript; this
// implementation exists for tests and tooling and follows the same format.
func Seal(random io.Reader, recipientPublic []byte, context Context, plaintext []byte) (Envelope, error) {
	ephemeral, err := ecdh.X25519().GenerateKey(random)
	if err != nil {
		return Envelope{}, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(random, nonce); err != nil {
		return Envelope{}, err
	}
	return sealWith(ephemeral, nonce, recipientPublic, context, plaintext)
}

func sealWith(ephemeral *ecdh.PrivateKey, nonce, recipientPublic []byte, context Context, plaintext []byte) (Envelope, error) {
	if err := context.validate(); err != nil {
		return Envelope{}, err
	}
	if len(plaintext) == 0 || len(plaintext) > maxPlaintext {
		return Envelope{}, errors.New("sealed secret plaintext must be between 1 byte and 1 MiB")
	}
	recipient, err := ecdh.X25519().NewPublicKey(recipientPublic)
	if err != nil {
		return Envelope{}, fmt.Errorf("recipient key is invalid: %w", err)
	}
	shared, err := ephemeral.ECDH(recipient)
	if err != nil {
		return Envelope{}, err
	}
	key, err := deriveKey(shared, ephemeral.PublicKey().Bytes(), recipientPublic)
	if err != nil {
		return Envelope{}, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return Envelope{}, err
	}
	keyID := KeyID(recipientPublic)
	ciphertext := aead.Seal(nil, nonce, plaintext, additionalData(context, keyID))
	return Envelope{
		Schema: Schema, RecipientKeyID: keyID,
		EphemeralPublicKey: base64.StdEncoding.EncodeToString(ephemeral.PublicKey().Bytes()),
		Nonce:              base64.StdEncoding.EncodeToString(nonce),
		Ciphertext:         base64.StdEncoding.EncodeToString(ciphertext),
	}, nil
}

// ErrWrongRecipient means the envelope was sealed to another key, for example
// before the Agent was replaced. Studio must seal again.
var ErrWrongRecipient = errors.New("sealed_secret_recipient_mismatch")

// Open decrypts an envelope with the Agent's private key.
func Open(recipient *ecdh.PrivateKey, context Context, envelope Envelope) ([]byte, error) {
	if err := context.validate(); err != nil {
		return nil, err
	}
	if envelope.Schema != Schema {
		return nil, fmt.Errorf("unsupported sealed secret schema %q", envelope.Schema)
	}
	recipientPublic := recipient.PublicKey().Bytes()
	if envelope.RecipientKeyID != KeyID(recipientPublic) {
		return nil, ErrWrongRecipient
	}
	ephemeralPublic, err := decode(envelope.EphemeralPublicKey, keySize)
	if err != nil {
		return nil, err
	}
	nonce, err := decode(envelope.Nonce, nonceSize)
	if err != nil {
		return nil, err
	}
	ciphertext, err := base64.StdEncoding.DecodeString(envelope.Ciphertext)
	if err != nil || len(ciphertext) < 16 || len(ciphertext) > maxPlaintext+16 {
		return nil, errors.New("sealed secret ciphertext is invalid")
	}
	ephemeral, err := ecdh.X25519().NewPublicKey(ephemeralPublic)
	if err != nil {
		return nil, errors.New("sealed secret ephemeral key is invalid")
	}
	shared, err := recipient.ECDH(ephemeral)
	if err != nil {
		return nil, err
	}
	key, err := deriveKey(shared, ephemeralPublic, recipientPublic)
	if err != nil {
		return nil, err
	}
	aead, err := newAEAD(key)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, nonce, ciphertext, additionalData(context, envelope.RecipientKeyID))
	if err != nil {
		return nil, errors.New("sealed_secret_invalid: the envelope does not decrypt for this project, domain, and file")
	}
	return plaintext, nil
}

// Digest identifies an envelope. It is safe to store and report: it depends
// only on ciphertext, never on the plaintext alone.
func Digest(envelope Envelope) string {
	raw, _ := json.Marshal(envelope)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func newAEAD(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func decode(value string, size int) ([]byte, error) {
	decoded, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(decoded) != size {
		return nil, errors.New("sealed secret envelope field is invalid")
	}
	return decoded, nil
}

// LoadOrCreateRecipientKey returns the Agent's recipient key, creating it with
// mode 0600 on first use. The private key never leaves the target.
func LoadOrCreateRecipientKey(path string) (*ecdh.PrivateKey, error) {
	payload, err := os.ReadFile(path)
	if err == nil {
		raw, decodeErr := base64.StdEncoding.DecodeString(string(bytes.TrimSpace(payload)))
		if decodeErr != nil || len(raw) != keySize {
			return nil, errors.New("Fleet Agent secret recipient key file is invalid")
		}
		return ecdh.X25519().NewPrivateKey(raw)
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".secret-recipient-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(temporary.Name())
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return nil, err
	}
	if _, err := temporary.WriteString(base64.StdEncoding.EncodeToString(key.Bytes()) + "\n"); err != nil {
		temporary.Close()
		return nil, err
	}
	if err := temporary.Close(); err != nil {
		return nil, err
	}
	// Link instead of rename so two starting processes cannot both win.
	if err := os.Link(temporary.Name(), path); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return LoadOrCreateRecipientKey(path)
		}
		return nil, err
	}
	return key, nil
}
