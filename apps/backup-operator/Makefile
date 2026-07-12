.PHONY: build test generate check-generated

build:
	go build ./cmd/backup-operator ./cmd/backupctl

test:
	go test ./...

generate:
	./scripts/generate-contracts.sh

check-generated:
	./scripts/check-generated.sh
