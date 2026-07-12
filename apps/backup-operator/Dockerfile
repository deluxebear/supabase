FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION=dev
ARG COMMIT=unknown
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=${VERSION} -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=${COMMIT}" -o /out/backup-operator ./cmd/backup-operator \
    && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=${VERSION} -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=${COMMIT}" -o /out/backupctl ./cmd/backupctl

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/backup-operator /usr/local/bin/backup-operator
COPY --from=build /out/backupctl /usr/local/bin/backupctl
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/backup-operator"]
