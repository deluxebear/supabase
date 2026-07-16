alter table operations add column if not exists sensitive boolean not null default false;
alter table operations add column if not exists input_ciphertext bytea;
alter table operations add column if not exists input_nonce bytea;

alter table operations add constraint operations_sensitive_payload_check check (
  (not sensitive and input_ciphertext is null and input_nonce is null)
  or (sensitive and input_ciphertext is not null and input_nonce is not null)
);
