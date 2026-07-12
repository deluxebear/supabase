package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

func main() {
	modeFlag := flag.String("mode", "all", "operator, agent, or all")
	listen := flag.String("listen", "127.0.0.1:8080", "operator HTTP listen address")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version.String())
		return
	}
	mode, err := app.ParseMode(*modeFlag)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := app.Run(ctx, app.Config{Mode: mode, Listen: *listen}); err != nil {
		log.Fatal(err)
	}
}
