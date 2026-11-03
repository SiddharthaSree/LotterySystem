CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  signup_closes_at TIMESTAMPTZ NOT NULL,
  allowed_domains TEXT NOT NULL DEFAULT '',
  bonus_cap INTEGER NOT NULL DEFAULT 4 CHECK (bonus_cap BETWEEN 0 AND 100),
  prize_count INTEGER NOT NULL DEFAULT 5 CHECK (prize_count BETWEEN 1 AND 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'live', 'ended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE events ALTER COLUMN bonus_cap SET DEFAULT 4;
ALTER TABLE events ALTER COLUMN allowed_domains SET DEFAULT '';
CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  extra_bonus INTEGER NOT NULL DEFAULT 0 CHECK (extra_bonus BETWEEN 0 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, email)
);
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reward INTEGER NOT NULL DEFAULT 1 CHECK (reward BETWEEN 0 AND 100),
  active BOOLEAN NOT NULL DEFAULT TRUE
);
ALTER TABLE people ADD COLUMN IF NOT EXISTS department TEXT NOT NULL DEFAULT '' CHECK (length(department)<=80);
CREATE TABLE IF NOT EXISTS completions (
  person_id INTEGER NOT NULL REFERENCES people(id),
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  done BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (person_id, task_id)
);
CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id),
  source_key TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (person_id, source_key)
);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_number INTEGER CHECK (ticket_number BETWEEN 100000 AND 999999);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_unique_number ON tickets(ticket_number);
CREATE OR REPLACE FUNCTION next_ticket_number() RETURNS INTEGER AS $$
DECLARE
  candidate INTEGER;
  start_number INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(4262027);
  FOR attempt IN 1..64 LOOP
    candidate := 100000 + FLOOR(random() * 900000)::INTEGER;
    IF NOT EXISTS (SELECT 1 FROM tickets WHERE ticket_number=candidate) THEN
      RETURN candidate;
    END IF;
  END LOOP;
  start_number := candidate;
  SELECT 100000 + ((n + start_number - 100000) % 900000) INTO candidate
    FROM generate_series(0,899999) AS n
    WHERE NOT EXISTS (SELECT 1 FROM tickets WHERE ticket_number=100000 + ((n + start_number - 100000) % 900000))
    LIMIT 1;
  IF candidate IS NULL THEN
    RAISE EXCEPTION 'All six-digit ticket numbers are allocated. Contact the portal administrator.';
  END IF;
  RETURN candidate;
END;
$$ LANGUAGE plpgsql;
ALTER TABLE tickets ALTER COLUMN ticket_number SET DEFAULT next_ticket_number();
CREATE TABLE IF NOT EXISTS draws (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  person_id INTEGER NOT NULL REFERENCES people(id),
  ticket_id BIGINT NOT NULL REFERENCES tickets(id),
  prize_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'absent')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS one_claim_per_employee ON draws(person_id) WHERE status = 'claimed';
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_per_event ON draws(event_id) WHERE status = 'pending';
ALTER TABLE draws ADD COLUMN IF NOT EXISTS batch_id UUID;
ALTER TABLE draws ADD COLUMN IF NOT EXISTS reveal_at TIMESTAMPTZ;
ALTER TABLE draws ADD COLUMN IF NOT EXISTS requested_count INTEGER NOT NULL DEFAULT 1 CHECK (requested_count BETWEEN 1 AND 1000);
CREATE INDEX IF NOT EXISTS draws_event_reveal ON draws(event_id, reveal_at);
ALTER TABLE events ADD COLUMN IF NOT EXISTS rounds_locked_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS rounds (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 100),
  name TEXT NOT NULL,
  prize_label TEXT NOT NULL,
  winner_count INTEGER NOT NULL CHECK (winner_count BETWEEN 1 AND 1000),
  awarded_count INTEGER CHECK (awarded_count BETWEEN 0 AND 1000),
  batch_id UUID,
  rolled_at TIMESTAMPTZ,
  UNIQUE (event_id, position)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id),
  action TEXT NOT NULL,
  details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS batch_size INTEGER CHECK (batch_size BETWEEN 1 AND winner_count);
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS rolls_completed INTEGER NOT NULL DEFAULT 0 CHECK (rolls_completed>=0);
ALTER TABLE draws ADD COLUMN IF NOT EXISTS round_id INTEGER REFERENCES rounds(id);
UPDATE draws d SET round_id=r.id FROM rounds r WHERE d.round_id IS NULL AND d.event_id=r.event_id AND d.batch_id=r.batch_id;
UPDATE rounds SET rolls_completed=1 WHERE rolled_at IS NOT NULL AND rolls_completed=0;
CREATE INDEX IF NOT EXISTS tickets_person ON tickets(person_id);
CREATE INDEX IF NOT EXISTS people_event ON people(event_id);
