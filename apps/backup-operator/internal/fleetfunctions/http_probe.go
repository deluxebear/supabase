package fleetfunctions

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HTTPProber struct {
	BaseURL     string
	Token       string
	TokenSource func() (string, error)
	Client      *http.Client
	Timeout     time.Duration
	Interval    time.Duration
}

func (p HTTPProber) Probe(ctx context.Context, slug string, shouldExist bool) error {
	return p.ProbeRevision(ctx, slug, shouldExist, "")
}

func (p HTTPProber) ProbeRevision(ctx context.Context, slug string, shouldExist bool, expectedRevision string) error {
	base, err := url.Parse(p.BaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" || !slugPattern.MatchString(slug) {
		return errors.New("Edge Runtime probe configuration is invalid")
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + "/" + slug
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return err
	}
	token := p.Token
	if p.TokenSource != nil {
		var err error
		token, err = p.TokenSource()
		if err != nil {
			return errors.New("Edge Runtime probe token is unavailable")
		}
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	}
	timeout := p.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	interval := p.Interval
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	probeCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var lastErr error
	for {
		attempt := request.Clone(probeCtx)
		response, err := client.Do(attempt)
		if err == nil {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<10))
			response.Body.Close()
			if !shouldExist && isMissingFunctionResponse(response.StatusCode, body) {
				return nil
			}
			if shouldExist && response.StatusCode >= 200 && response.StatusCode < 300 {
				observedRevision := response.Header.Get("X-Supabase-Fleet-Revision")
				if expectedRevision == "" || observedRevision == expectedRevision {
					return nil
				}
				lastErr = errors.New("Edge Runtime probe observed a stale function revision")
			} else {
				lastErr = fmt.Errorf("Edge Runtime probe returned HTTP %d", response.StatusCode)
			}
		} else {
			lastErr = err
		}
		timer := time.NewTimer(interval)
		select {
		case <-probeCtx.Done():
			timer.Stop()
			if lastErr != nil {
				return lastErr
			}
			return probeCtx.Err()
		case <-timer.C:
		}
	}
}

func isMissingFunctionResponse(status int, body []byte) bool {
	if status == http.StatusNotFound {
		return true
	}
	message := string(body)
	return status == http.StatusInternalServerError &&
		strings.Contains(message, "InvalidWorkerCreation") &&
		strings.Contains(message, "could not find an appropriate entrypoint")
}
