package pgbackrest

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

var tokenPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

type Config struct {
	Stanza         string
	PGData         string
	SocketPath     string
	RepositoryType string
	RepositoryPath string
	RetentionFull  int
}

func (c Config) Validate() error {
	if !tokenPattern.MatchString(c.Stanza) {
		return errors.New("invalid stanza")
	}
	if c.RepositoryType != "posix" && c.RepositoryType != "s3" {
		return errors.New("unsupported repository type")
	}
	for name, path := range map[string]string{"pgdata": c.PGData, "socket": c.SocketPath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsAny(path, "\r\n") {
			return fmt.Errorf("invalid %s path", name)
		}
	}
	if c.RepositoryType == "posix" && (!filepath.IsAbs(c.RepositoryPath) || filepath.Clean(c.RepositoryPath) != c.RepositoryPath) {
		return errors.New("invalid repository path")
	}
	if c.RetentionFull < 1 {
		return errors.New("retention must be positive")
	}
	return nil
}

func (c Config) Render() ([]byte, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	var builder strings.Builder
	fmt.Fprintf(&builder, "[%s]\n", c.Stanza)
	fmt.Fprintf(&builder, "pg1-path=%s\n", c.PGData)
	fmt.Fprintf(&builder, "pg1-socket-path=%s\n", c.SocketPath)
	builder.WriteString("pg1-user=postgres\n")
	fmt.Fprintf(&builder, "repo1-type=%s\n", c.RepositoryType)
	if c.RepositoryType == "posix" {
		fmt.Fprintf(&builder, "repo1-path=%s\n", c.RepositoryPath)
	}
	fmt.Fprintf(&builder, "repo1-retention-full=%d\n", c.RetentionFull)
	return []byte(builder.String()), nil
}
