alter table operations add column sensitive integer not null default 0;
alter table operations add column input_ciphertext blob;
alter table operations add column input_nonce blob;

create trigger operations_sensitive_payload_insert
before insert on operations
when (new.sensitive = 0 and (new.input_ciphertext is not null or new.input_nonce is not null))
  or (new.sensitive = 1 and (new.input_ciphertext is null or new.input_nonce is null))
begin
  select raise(abort, 'sensitive operation payload is incomplete');
end;
