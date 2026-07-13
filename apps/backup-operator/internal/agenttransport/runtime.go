package agenttransport

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	operatorapp "github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/orchestration"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type GRPCWorker struct {
	Listener    net.Listener
	TLS         *tls.Config
	Registry    *SessionRegistry
	Enrollments interface {
		GetAgentEnrollment(context.Context, string) (controlstore.Enrollment, error)
	}
	ShutdownTimeout time.Duration
	// MaxSessionAge bounds how long a certificate authenticated before a CA
	// activation may remain connected. Agents reconnect automatically and are
	// revalidated against the current CA bundle and enrollment fingerprint.
	MaxSessionAge time.Duration
}

func (w *GRPCWorker) Name() string { return "agent-control-grpc" }

func (w *GRPCWorker) Run(ctx context.Context) error {
	if w.Listener == nil || w.TLS == nil || w.Registry == nil || w.Enrollments == nil || w.TLS.ClientAuth != tls.RequireAndVerifyClientCert {
		return errors.New("Agent gRPC listener, strict mTLS, and session registry are required")
	}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(w.TLS.Clone())))
	maxSessionAge := w.MaxSessionAge
	if maxSessionAge <= 0 {
		maxSessionAge = 15 * time.Minute
	}
	agentv1.RegisterAgentControlServiceServer(server, &Server{Registry: w.Registry, Enrollments: w.Enrollments, MaxSessionAge: maxSessionAge})
	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(w.Listener) }()
	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}
	timeout := w.ShutdownTimeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	done := make(chan struct{})
	go func() { server.GracefulStop(); close(done) }()
	select {
	case <-done:
	case <-time.After(timeout):
		server.Stop()
		<-done
	}
	return nil
}

type RuntimeWorker interface {
	Name() string
	Run(context.Context) error
}

// Workers wires the transport registry to the durable dispatcher and
// reconcilers after the app has opened its Control Store.
func Workers(store *controlstore.Store, registry *SessionRegistry, grpcWorker *GRPCWorker, ownerID string) ([]RuntimeWorker, error) {
	if store == nil || registry == nil || grpcWorker == nil || ownerID == "" {
		return nil, errors.New("control store, Agent transport, and operator owner ID are required")
	}
	if grpcWorker.Registry != registry {
		return nil, errors.New("gRPC worker and orchestration must share one session registry")
	}
	if grpcWorker.Enrollments == nil {
		grpcWorker.Enrollments = store
	}
	return []RuntimeWorker{
		grpcWorker,
		registry,
		&orchestration.Dispatcher{Store: store, Sender: registry, OwnerID: ownerID},
		&orchestration.Reconciler{Store: store, Results: registry.Results()},
		&orchestration.OrphanReconciler{Store: store},
	}, nil
}

func AppWorkerFactory(registry *SessionRegistry, grpcWorker *GRPCWorker, ownerID string) func(operatorapp.Store) ([]operatorapp.Worker, error) {
	return func(store operatorapp.Store) ([]operatorapp.Worker, error) {
		control, ok := store.(*controlstore.Store)
		if !ok {
			return nil, errors.New("Agent orchestration requires a Control Store")
		}
		workers, err := Workers(control, registry, grpcWorker, ownerID)
		if err != nil {
			return nil, err
		}
		result := make([]operatorapp.Worker, len(workers))
		for index := range workers {
			result[index] = workers[index]
		}
		return result, nil
	}
}
