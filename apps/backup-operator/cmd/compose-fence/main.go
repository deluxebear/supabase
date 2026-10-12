// Command compose-fence is the write fence command of a backup Agent on a
// Docker Compose stack: compose-fence <entry-point> block|status|unblock.
//
// It reaches Docker only through the stack's backup proxy
// (BACKUP_FENCE_DOCKER_ENDPOINT) and acts only on the containers named for each
// entry point in BACKUP_FENCE_<ENTRY_POINT> variables.
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	opruntime "github.com/supabase/supabase/apps/backup-operator/internal/runtime"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

const usageExit = 64

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: compose-fence <entry-point> block|status|unblock")
		os.Exit(usageExit)
	}
	entry := writefence.EntryPoint(os.Args[1])
	known := false
	for _, required := range writefence.RequiredEntryPoints {
		known = known || required == entry
	}
	if !known {
		fmt.Fprintf(os.Stderr, "unknown entry point %q\n", entry)
		os.Exit(usageExit)
	}
	containers, err := opruntime.ComposeFenceContainers(os.Getenv)
	if err != nil {
		fail(err)
	}
	fence := opruntime.ComposeFence{Containers: containers}
	docker, err := opruntime.NewDockerClient(&http.Client{Timeout: 45 * time.Second}, os.Getenv("BACKUP_FENCE_DOCKER_ENDPOINT"), fence.AllContainers()...)
	if err != nil {
		fail(err)
	}
	fence.Docker = docker
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	output, err := fence.Run(ctx, entry, os.Args[2])
	if err != nil {
		fail(err)
	}
	if output != "" {
		fmt.Println(output)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
