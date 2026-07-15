package fleetfunctions

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HTTPProber struct {
	BaseURL string
	Token   string
	Client  *http.Client
}

func (p HTTPProber) Probe(ctx context.Context, slug string, shouldExist bool) error {
	base, err := url.Parse(p.BaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" || !slugPattern.MatchString(slug) {
		return errors.New("Edge Runtime probe configuration is invalid")
	}
	base.Path = strings.TrimSuffix(base.Path, "/") + "/" + slug
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	if err != nil {
		return err
	}
	if p.Token != "" {
		request.Header.Set("Authorization", "Bearer "+p.Token)
	}
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if !shouldExist && response.StatusCode == http.StatusNotFound {
		return nil
	}
	if shouldExist && response.StatusCode >= 200 && response.StatusCode < 300 {
		return nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !shouldExist {
		return fmt.Errorf("Edge Runtime probe returned HTTP %d", response.StatusCode)
	}
	return errors.New("Edge Runtime deletion probe unexpectedly found the function")
}
