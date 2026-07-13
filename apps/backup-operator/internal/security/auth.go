package security

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

type AssertionValidator struct {
	Key      []byte
	Issuer   string
	Audience string
	MaxTTL   time.Duration
	Now      func() time.Time
}

func (v AssertionValidator) Validate(token string) (ServiceClaims, error) {
	now := time.Now
	if v.Now != nil {
		now = v.Now
	}
	current := now()
	claims, err := ValidateServiceJWT(token, v.Key, v.Issuer, v.Audience, current)
	if err != nil {
		return ServiceClaims{}, err
	}
	if v.MaxTTL > 0 && time.Unix(claims.Expires, 0).After(current.Add(v.MaxTTL)) {
		return ServiceClaims{}, errors.New("service assertion exceeds the maximum lifetime")
	}
	return claims, nil
}

type AccessRequest struct {
	Scope     string
	ProjectID string
}

func Authorize(claims ServiceClaims, request AccessRequest) error {
	return Authorizer{}.Authorize(claims, request)
}

type Authorizer struct {
	RoleScopes map[string][]string
}

func (a Authorizer) Authorize(claims ServiceClaims, request AccessRequest) error {
	if claims.Subject == "" || request.Scope == "" || request.ProjectID == "" {
		return errors.New("subject, scope, and project are required")
	}
	granted := slices.Clone(claims.Scopes)
	for _, role := range claims.Roles {
		granted = append(granted, a.RoleScopes[role]...)
	}
	if !slices.Contains(granted, request.Scope) && !slices.Contains(granted, "*") {
		return fmt.Errorf("subject %q lacks scope %q", claims.Subject, request.Scope)
	}
	if !slices.Contains(claims.Projects, request.ProjectID) && !slices.Contains(claims.Projects, "*") {
		return fmt.Errorf("subject %q is not authorized for project %q", claims.Subject, request.ProjectID)
	}
	return nil
}

type Actor struct {
	Subject   string
	Kind      string
	ProjectID string
	Scopes    []string
}

func (c ServiceClaims) Actor(projectID string) Actor {
	return Actor{Subject: c.Subject, Kind: "service", ProjectID: projectID, Scopes: slices.Clone(c.Scopes)}
}

type actorContextKey struct{}

func WithActor(ctx context.Context, actor Actor) context.Context {
	return context.WithValue(ctx, actorContextKey{}, actor)
}

func ActorFromContext(ctx context.Context) (Actor, bool) {
	actor, ok := ctx.Value(actorContextKey{}).(Actor)
	return actor, ok && strings.TrimSpace(actor.Subject) != ""
}
