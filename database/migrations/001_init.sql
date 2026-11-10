CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_minor integer NOT NULL,
  total integer NOT NULL,
  reserved integer NOT NULL DEFAULT 0,
  sold integer NOT NULL DEFAULT 0,
  max_per_session integer NOT NULL DEFAULT 4,
  hold_seconds integer NOT NULL DEFAULT 300,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT sales_description_length CHECK (char_length(description) <= 2000),
  CONSTRAINT sales_price_range CHECK (price_minor BETWEEN 1 AND 100000000),
  CONSTRAINT sales_total_range CHECK (total BETWEEN 1 AND 1000000),
  CONSTRAINT sales_per_session_range CHECK (max_per_session BETWEEN 1 AND 10),
  CONSTRAINT sales_hold_range CHECK (hold_seconds BETWEEN 1 AND 3600),
  CONSTRAINT sales_window CHECK (ends_at > starts_at),
  CONSTRAINT sales_inventory CHECK (reserved >= 0 AND sold >= 0 AND reserved + sold <= total)
);

CREATE INDEX sales_starts_at_idx ON sales (starts_at);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales (id),
  session_id uuid NOT NULL REFERENCES sessions (id),
  quantity integer NOT NULL,
  unit_price_minor integer NOT NULL,
  status text NOT NULL DEFAULT 'RESERVED',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT reservations_quantity_range CHECK (quantity BETWEEN 1 AND 10),
  CONSTRAINT reservations_price_positive CHECK (unit_price_minor > 0),
  CONSTRAINT reservations_status_valid CHECK (status IN ('RESERVED', 'CONFIRMED', 'EXPIRED', 'CANCELLED')),
  CONSTRAINT reservations_resolved_consistent CHECK ((status = 'RESERVED') = (resolved_at IS NULL))
);

CREATE INDEX reservations_due_idx ON reservations (expires_at) WHERE status = 'RESERVED';
CREATE INDEX reservations_session_idx ON reservations (session_id, created_at DESC);
CREATE INDEX reservations_holder_idx ON reservations (sale_id, session_id) WHERE status IN ('RESERVED', 'CONFIRMED');

CREATE FUNCTION reservations_guard_transition() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'RESERVED' AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'illegal reservation transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.sale_id <> OLD.sale_id OR NEW.session_id <> OLD.session_id OR NEW.quantity <> OLD.quantity THEN
    RAISE EXCEPTION 'reservation identity fields are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservations_guard_transition_trg
BEFORE UPDATE ON reservations
FOR EACH ROW EXECUTE FUNCTION reservations_guard_transition();

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE REFERENCES reservations (id),
  sale_id uuid NOT NULL REFERENCES sales (id),
  session_id uuid NOT NULL REFERENCES sessions (id),
  quantity integer NOT NULL,
  total_minor integer NOT NULL,
  payment_status text NOT NULL DEFAULT 'SIMULATED_PAID',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orders_quantity_range CHECK (quantity BETWEEN 1 AND 10),
  CONSTRAINT orders_total_positive CHECK (total_minor > 0),
  CONSTRAINT orders_payment_status_valid CHECK (payment_status = 'SIMULATED_PAID')
);

CREATE INDEX orders_sale_idx ON orders (sale_id);
CREATE INDEX orders_session_idx ON orders (session_id, created_at DESC);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations (id),
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_attempts_outcome_valid CHECK (outcome IN ('SUCCESS', 'FAILED'))
);

CREATE INDEX payment_attempts_reservation_idx ON payment_attempts (reservation_id);

CREATE TABLE idempotency_keys (
  session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, scope, key),
  CONSTRAINT idempotency_scope_valid CHECK (scope IN ('reserve', 'checkout')),
  CONSTRAINT idempotency_key_length CHECK (char_length(key) BETWEEN 8 AND 128)
);

CREATE INDEX idempotency_created_idx ON idempotency_keys (created_at);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_attempts_nonnegative CHECK (attempts >= 0)
);

CREATE INDEX outbox_pending_idx ON outbox (next_attempt_at, id) WHERE published_at IS NULL;
CREATE INDEX outbox_published_idx ON outbox (published_at) WHERE published_at IS NOT NULL;

CREATE TABLE worker_status (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
