package patroni

import "context"

type PatroniLifecycle interface {
	StopPatroni(context.Context, string) error
	StartPatroni(context.Context, string) error
}

type PostgresLifecycle interface {
	StopPostgres(context.Context, string) error
	StartPostgres(context.Context, string, bool) error
}

// LifecycleController keeps Patroni and PostgreSQL process controls separate.
// isolated=true starts PostgreSQL without exposing it through Patroni/DCS.
type LifecycleController struct {
	Patroni  PatroniLifecycle
	Postgres PostgresLifecycle
}

func (c LifecycleController) StopNode(ctx context.Context, node string) error {
	if err := c.Patroni.StopPatroni(ctx, node); err != nil {
		return err
	}
	return c.Postgres.StopPostgres(ctx, node)
}

func (c LifecycleController) StartIsolatedPostgres(ctx context.Context, node string) error {
	return c.Postgres.StartPostgres(ctx, node, true)
}

func (c LifecycleController) HandBackToPatroni(ctx context.Context, node string) error {
	if err := c.Postgres.StopPostgres(ctx, node); err != nil {
		return err
	}
	return c.Patroni.StartPatroni(ctx, node)
}
