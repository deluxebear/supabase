package hardening

import (
	"context"
	"errors"
	"math"
	"math/rand/v2"
	"sync"
	"time"
)

type CapacityObservation struct {
	RequiredBytes  int64
	AvailableBytes int64
	ObservedAt     time.Time
}

func ValidateCapacity(observation CapacityObservation, now time.Time, maxAge time.Duration, marginPercent int) error {
	if observation.RequiredBytes <= 0 || observation.AvailableBytes < 0 || maxAge <= 0 || marginPercent < 0 || marginPercent > 100 {
		return errors.New("invalid capacity safety input")
	}
	if observation.ObservedAt.After(now) || now.Sub(observation.ObservedAt) > maxAge {
		return errors.New("capacity observation is stale and must be rechecked")
	}
	requiredWithMargin := observation.RequiredBytes + int64(math.Ceil(float64(observation.RequiredBytes)*float64(marginPercent)/100))
	if observation.AvailableBytes < requiredWithMargin {
		return errors.New("restore capacity does not satisfy the safety margin")
	}
	return nil
}

type ObjectOperation func(context.Context) error

type ObjectLimiter struct {
	semaphore chan struct{}
	Retries   int
	BaseDelay time.Duration
}

func NewObjectLimiter(concurrency, retries int, baseDelay time.Duration) (*ObjectLimiter, error) {
	if concurrency < 1 || concurrency > 128 || retries < 0 || retries > 10 || baseDelay <= 0 {
		return nil, errors.New("invalid object-store concurrency/retry policy")
	}
	return &ObjectLimiter{semaphore: make(chan struct{}, concurrency), Retries: retries, BaseDelay: baseDelay}, nil
}

func (l *ObjectLimiter) Do(ctx context.Context, operation ObjectOperation) error {
	select {
	case l.semaphore <- struct{}{}:
		defer func() { <-l.semaphore }()
	case <-ctx.Done():
		return ctx.Err()
	}
	var err error
	for attempt := 0; attempt <= l.Retries; attempt++ {
		if err = operation(ctx); err == nil {
			return nil
		}
		if attempt == l.Retries {
			break
		}
		delay := l.BaseDelay * time.Duration(1<<attempt)
		jitter := time.Duration(rand.Int64N(max(1, int64(delay/4))))
		timer := time.NewTimer(delay + jitter)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}
	}
	return err
}

type BatchObserver[T any] struct {
	Limit   int
	Observe func(context.Context, T) error
}

func (b BatchObserver[T]) Run(ctx context.Context, targets []T) error {
	if b.Limit < 1 || b.Observe == nil {
		return errors.New("batch observer requires a positive limit")
	}
	sem := make(chan struct{}, b.Limit)
	var wait sync.WaitGroup
	var once sync.Once
	var firstErr error
	for _, target := range targets {
		target := target
		wait.Add(1)
		go func() {
			defer wait.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				once.Do(func() { firstErr = ctx.Err() })
				return
			}
			if err := b.Observe(ctx, target); err != nil {
				once.Do(func() { firstErr = err })
			}
		}()
	}
	wait.Wait()
	return firstErr
}
