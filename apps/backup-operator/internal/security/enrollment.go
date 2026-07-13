package security

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

type AgentEnrollment struct {
	AgentID                string
	ProjectID              string
	CertificateFingerprint string
	Disabled               bool
}

type EnrollmentRegistry interface {
	LookupAgentEnrollment(context.Context, string) (AgentEnrollment, error)
}

type AgentIdentityVerifier struct {
	Registry EnrollmentRegistry
	Now      func() time.Time
}

func (v AgentIdentityVerifier) Verify(ctx context.Context, agentID, projectID string, certificate *x509.Certificate) (Actor, error) {
	if v.Registry == nil || certificate == nil || agentID == "" || projectID == "" {
		return Actor{}, errors.New("Agent enrollment registry, certificate, Agent, and project are required")
	}
	now := time.Now()
	if v.Now != nil {
		now = v.Now()
	}
	if now.Before(certificate.NotBefore) || !now.Before(certificate.NotAfter) {
		return Actor{}, errors.New("Agent certificate is not currently valid")
	}
	enrollment, err := v.Registry.LookupAgentEnrollment(ctx, agentID)
	if err != nil {
		return Actor{}, fmt.Errorf("look up Agent enrollment: %w", err)
	}
	if enrollment.Disabled || enrollment.AgentID != agentID || enrollment.ProjectID != projectID {
		return Actor{}, errors.New("Agent enrollment identity or project does not match")
	}
	digest := sha256.Sum256(certificate.Raw)
	actual := hex.EncodeToString(digest[:])
	if subtle.ConstantTimeCompare([]byte(actual), []byte(enrollment.CertificateFingerprint)) != 1 {
		return Actor{}, errors.New("Agent certificate is not bound to the enrollment")
	}
	return Actor{Subject: agentID, Kind: "agent", ProjectID: projectID}, nil
}

func CertificateFingerprint(certificate *x509.Certificate) string {
	if certificate == nil {
		return ""
	}
	digest := sha256.Sum256(certificate.Raw)
	return hex.EncodeToString(digest[:])
}
