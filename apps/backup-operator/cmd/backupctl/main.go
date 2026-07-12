package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

func main() {
	endpoint := flag.String("endpoint", "http://127.0.0.1:8080", "Operator API endpoint")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.String())
		return
	}
	if flag.NArg() != 1 || flag.Arg(0) != "capabilities" {
		fmt.Fprintln(os.Stderr, "usage: backupctl [--endpoint URL] capabilities")
		os.Exit(2)
	}
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Get(*endpoint + "/v1/capabilities")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "operator returned %s\n", response.Status)
		os.Exit(1)
	}
	var value any
	if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	output, _ := json.MarshalIndent(value, "", "  ")
	fmt.Println(string(output))
}
