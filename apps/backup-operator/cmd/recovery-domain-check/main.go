package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoverydomain"
)

func main() {
	var target, control recoverydomain.Identity
	flag.StringVar(&target.SystemIdentifier, "target-system-id", "", "managed PostgreSQL system identifier")
	flag.StringVar(&target.DataDomain, "target-data-domain", "", "managed storage/lifecycle identity")
	flag.StringVar(&control.SystemIdentifier, "control-system-id", "", "control-store PostgreSQL system identifier")
	flag.StringVar(&control.DataDomain, "control-data-domain", "", "control-store storage/lifecycle identity")
	flag.Parse()

	if err := recoverydomain.ValidateIndependent(target, control); err != nil {
		fmt.Fprintf(os.Stderr, "unsafe control store: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("control store is outside the managed recovery domain")
}
