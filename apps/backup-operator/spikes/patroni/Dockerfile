FROM postgres:17-bookworm

ARG PATRONI_VERSION=4.1.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq pgbackrest python3-venv \
    && python3 -m venv /opt/patroni \
    && /opt/patroni/bin/pip install --no-cache-dir "patroni[etcd3]==${PATRONI_VERSION}" "psycopg[binary]>=3.2,<4" \
    && rm -rf /var/lib/apt/lists/*

COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY patroni.yml /etc/patroni.yml

ENV PATH="/opt/patroni/bin:${PATH}"

ENTRYPOINT ["patroni"]
CMD ["/etc/patroni.yml"]
