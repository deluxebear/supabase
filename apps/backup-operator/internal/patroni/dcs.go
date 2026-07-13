package patroni

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type KV struct {
	Value    string
	Revision int64
}

var ErrDCSKeyNotFound = errors.New("DCS key not found")

type KVBackend interface {
	Get(context.Context, string) (KV, error)
	CompareAndSwap(context.Context, string, int64, string) (bool, error)
}

// DCSAdapter maps Patroni's leader/history keys onto a revisioned backend.
// It never creates or transfers the leader lock: Patroni remains its owner.
type DCSAdapter struct {
	Backend             KVBackend
	Prefix              string
	Now                 func() time.Time
	PollInterval        time.Duration
	LeaderExpiryTimeout time.Duration
}

func (d DCSAdapter) Observe(ctx context.Context) (DCSState, error) {
	if d.Backend == nil || d.Prefix == "" {
		return DCSState{}, errors.New("DCS backend and Patroni prefix are required")
	}
	leader, err := d.Backend.Get(ctx, d.key("leader"))
	if err != nil {
		return DCSState{}, fmt.Errorf("read DCS leader: %w", err)
	}
	history, err := d.Backend.Get(ctx, d.key("history"))
	if err != nil {
		return DCSState{}, fmt.Errorf("read DCS history: %w", err)
	}
	return DCSState{Healthy: leader.Value != "", Leader: leader.Value, HistoryID: history.Value, Revision: strconv.FormatInt(max(leader.Revision, history.Revision), 10), ObservedAt: d.now()}, nil
}

// WaitLeaderLockExpired waits for Patroni's leased leader key to disappear.
// A matching member name is not proof that a restarted Patroni process owns
// the old lease, so recovery handback must never accept or mutate that key.
func (d DCSAdapter) WaitLeaderLockExpired(ctx context.Context) error {
	if d.Backend == nil || d.Prefix == "" {
		return errors.New("DCS backend and Patroni prefix are required")
	}
	timeout := d.LeaderExpiryTimeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	interval := d.PollInterval
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		leader, err := d.Backend.Get(waitCtx, d.key("leader"))
		if errors.Is(err, ErrDCSKeyNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read DCS leader while waiting for lease expiry: %w", err)
		}
		select {
		case <-waitCtx.Done():
			return fmt.Errorf("leader lock for %q did not expire: %w", leader.Value, waitCtx.Err())
		case <-ticker.C:
		}
	}
}

func (d DCSAdapter) Reconcile(ctx context.Context, leader string, timeline uint64) error {
	if leader == "" || timeline < 1 {
		return errors.New("leader and recovered timeline are required")
	}
	currentLeader, err := d.Backend.Get(ctx, d.key("leader"))
	if err != nil && !errors.Is(err, ErrDCSKeyNotFound) {
		return err
	}
	if err == nil && currentLeader.Value != leader {
		return fmt.Errorf("DCS leader changed from recovery primary %q to %q", leader, currentLeader.Value)
	}
	history, err := d.Backend.Get(ctx, d.key("history"))
	if err != nil {
		return err
	}
	var entries []any
	if strings.TrimSpace(history.Value) != "" && json.Unmarshal([]byte(history.Value), &entries) != nil {
		return errors.New("DCS timeline history is not valid JSON")
	}
	entries = append(entries, []any{timeline, nil, "backup-operator PITR"})
	encoded, err := json.Marshal(entries)
	if err != nil {
		return err
	}
	swapped, err := d.Backend.CompareAndSwap(ctx, d.key("history"), history.Revision, string(encoded))
	if err != nil {
		return err
	}
	if !swapped {
		return errors.New("DCS history changed concurrently")
	}
	return nil
}

func (d DCSAdapter) key(suffix string) string { return strings.TrimRight(d.Prefix, "/") + "/" + suffix }
func (d DCSAdapter) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

// EtcdHTTPBackend implements the etcd v3 JSON gateway subset required above.
type EtcdHTTPBackend struct {
	BaseURL string
	Client  *http.Client
	Token   string
}

func (e EtcdHTTPBackend) Get(ctx context.Context, key string) (KV, error) {
	request := map[string]string{"key": base64.StdEncoding.EncodeToString([]byte(key))}
	var response struct {
		KVs []struct {
			Value       string `json:"value"`
			ModRevision string `json:"mod_revision"`
		} `json:"kvs"`
	}
	if err := e.post(ctx, "/v3/kv/range", request, &response); err != nil {
		return KV{}, err
	}
	if len(response.KVs) == 0 {
		return KV{}, fmt.Errorf("%w: %s", ErrDCSKeyNotFound, key)
	}
	if len(response.KVs) != 1 {
		return KV{}, fmt.Errorf("DCS key %q is ambiguous", key)
	}
	value, err := base64.StdEncoding.DecodeString(response.KVs[0].Value)
	if err != nil {
		return KV{}, err
	}
	revision, err := strconv.ParseInt(response.KVs[0].ModRevision, 10, 64)
	if err != nil {
		return KV{}, err
	}
	return KV{Value: string(value), Revision: revision}, nil
}

func (e EtcdHTTPBackend) CompareAndSwap(ctx context.Context, key string, revision int64, value string) (bool, error) {
	encodedKey := base64.StdEncoding.EncodeToString([]byte(key))
	payload := map[string]any{
		"compare": []any{map[string]any{"key": encodedKey, "target": "MOD", "result": "EQUAL", "mod_revision": strconv.FormatInt(revision, 10)}},
		"success": []any{map[string]any{"request_put": map[string]string{"key": encodedKey, "value": base64.StdEncoding.EncodeToString([]byte(value))}}},
		"failure": []any{},
	}
	var response struct {
		Succeeded bool `json:"succeeded"`
	}
	if err := e.post(ctx, "/v3/kv/txn", payload, &response); err != nil {
		return false, err
	}
	return response.Succeeded, nil
}

func (e EtcdHTTPBackend) post(ctx context.Context, path string, payload, output any) error {
	base, err := url.Parse(e.BaseURL)
	if err != nil || base.Scheme != "https" || base.Host == "" || base.RawQuery != "" || base.Fragment != "" {
		return errors.New("valid HTTPS etcd gateway URL is required")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	base.Path = strings.TrimRight(base.Path, "/") + path
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, base.String(), bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if e.Token != "" {
		request.Header.Set("Authorization", "Bearer "+e.Token)
	}
	client := e.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("etcd HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(output)
}
