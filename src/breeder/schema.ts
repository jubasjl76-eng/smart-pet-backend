/**
 * Breeder platform schema.
 *
 * Idempotent — safe to run on every boot. Called at the end of
 * initializeDatabase() in src/database/index.ts.
 *
 * kennel_id is a VARCHAR string (the same value used as the MQTT `kennelId`,
 * e.g. "home"). One row in `kennels` per breeding operation.
 */
import { pool } from '../database/index.js';

/**
 * Full breeder DDL. Idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT
 * EXISTS). Exported so tests can run it against an ephemeral Postgres (pglite).
 */
export const BREEDER_DDL = `
    -- The breeding operation (tenant). kennels.slug is the MQTT kennelId.
    CREATE TABLE IF NOT EXISTS kennels (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      owner_user_id UUID REFERENCES users(id),
      breed_focus VARCHAR(255),
      timezone VARCHAR(64) DEFAULT 'UTC',
      emergency_state VARCHAR(20) DEFAULT 'normal',   -- normal | active
      emergency_mode VARCHAR(20),                     -- fire | flood | evac | drill
      emergency_since TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Physical locations inside the kennel.
    CREATE TABLE IF NOT EXISTS pens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'run',        -- run | whelping | yard | quarantine
      capacity INT DEFAULT 1,
      door_device_id VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Every dog on site (breeding stock + kept pups). Puppies for sale live in "puppies".
    CREATE TABLE IF NOT EXISTS animals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      call_name VARCHAR(255),
      breed VARCHAR(255),
      sex VARCHAR(10),                                -- male | female
      dob DATE,
      microchip VARCHAR(64),
      registration_no VARCHAR(128),
      sire_id UUID REFERENCES animals(id),
      dam_id UUID REFERENCES animals(id),
      collar_device_id VARCHAR(255),
      ble_tag_id VARCHAR(64),                         -- for multi-dog identification at shared devices
      current_pen_id UUID REFERENCES pens(id),
      role VARCHAR(20) DEFAULT 'breeding',            -- breeding | retired | kept-pup | guardian
      status VARCHAR(20) DEFAULT 'active',            -- active | sold | deceased
      photo_url TEXT,
      adult_weight_kg FLOAT,                          -- expected adult weight (for growth curve)
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- One care plan per animal. Diet + meds summary + vet + notes.
    CREATE TABLE IF NOT EXISTS care_plans (
      animal_id UUID PRIMARY KEY REFERENCES animals(id) ON DELETE CASCADE,
      kennel_id VARCHAR(255) NOT NULL,
      food_sku VARCHAR(255),
      grams_per_day FLOAT,
      meals_per_day INT DEFAULT 2,
      feeder_device_id VARCHAR(255),
      water_device_id VARCHAR(255),
      allergies TEXT[],
      diet_notes TEXT,
      exercise_notes TEXT,
      vet_name VARCHAR(255),
      vet_phone VARCHAR(64),
      emergency_contact VARCHAR(255),
      emergency_phone VARCHAR(64),
      notes TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by UUID REFERENCES users(id)
    );

    -- Scheduled medications. Administration is done by staff and logged (low automation).
    CREATE TABLE IF NOT EXISTS medications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      animal_id UUID REFERENCES animals(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      dose VARCHAR(128),
      route VARCHAR(64),                              -- oral | topical | injection | ...
      times_of_day TEXT[],                            -- ['08:00','20:00']
      days_of_week INT[],                             -- 0..6, empty = daily
      starts_on DATE,
      ends_on DATE,
      active BOOLEAN DEFAULT true,
      instructions TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Staff-registered "I gave this dose" record. No hardware dispenser.
    CREATE TABLE IF NOT EXISTS medication_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      medication_id UUID REFERENCES medications(id) ON DELETE CASCADE,
      animal_id UUID REFERENCES animals(id) ON DELETE CASCADE,
      scheduled_for TIMESTAMPTZ,
      administered_at TIMESTAMPTZ DEFAULT NOW(),
      administered_by UUID REFERENCES users(id),
      outcome VARCHAR(20) NOT NULL DEFAULT 'given',   -- given | skipped | refused | vomited
      note TEXT,
      photo_url TEXT
    );

    -- Litters and the puppies in them (for-sale animals + buyer pipeline).
    CREATE TABLE IF NOT EXISTS litters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      dam_id UUID REFERENCES animals(id),
      sire_id UUID REFERENCES animals(id),
      pen_id UUID REFERENCES pens(id),
      mated_on DATE,
      due_on DATE,
      whelped_at TIMESTAMPTZ,
      count_born INT,
      count_alive INT,
      status VARCHAR(20) DEFAULT 'planned',           -- planned | expecting | whelped | weaning | dispersed
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS puppies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      litter_id UUID REFERENCES litters(id) ON DELETE CASCADE,
      name VARCHAR(255),
      collar_color VARCHAR(64),                       -- how the breeder tells pups apart early
      sex VARCHAR(10),
      birth_weight_g FLOAT,
      microchip VARCHAR(64),
      ble_tag_id VARCHAR(64),
      status VARCHAR(20) DEFAULT 'available',         -- available | reserved | sold | kept | deceased
      buyer_id UUID,
      go_home_on DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS buyers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      phone VARCHAR(64),
      city VARCHAR(255),
      notes TEXT,
      status VARCHAR(20) DEFAULT 'waitlist',          -- waitlist | reserved | placed | withdrawn
      deposit_paid BOOLEAN DEFAULT false,
      wants_litter_id UUID REFERENCES litters(id),
      puppy_id UUID REFERENCES puppies(id),
      waitlist_rank INT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Weight over time. Works for adult animals and for puppies (growth curves).
    CREATE TABLE IF NOT EXISTS weight_readings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      animal_id UUID REFERENCES animals(id) ON DELETE CASCADE,
      puppy_id UUID REFERENCES puppies(id) ON DELETE CASCADE,
      grams FLOAT NOT NULL,
      source VARCHAR(20) DEFAULT 'manual',            -- manual | scale
      device_id VARCHAR(255),
      taken_at TIMESTAMPTZ DEFAULT NOW(),
      note TEXT,
      CONSTRAINT weight_subject_ck CHECK (animal_id IS NOT NULL OR puppy_id IS NOT NULL)
    );

    -- Attributed feed / water events. identified_by says how we know which dog.
    CREATE TABLE IF NOT EXISTS intake_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      kind VARCHAR(10) NOT NULL,                      -- food | water
      animal_id UUID REFERENCES animals(id),
      grams_dispensed FLOAT,
      grams_consumed FLOAT,                           -- from a scale bowl, when available
      ml_consumed FLOAT,
      identified_by VARCHAR(20) DEFAULT 'schedule',   -- schedule | ble | rfid | manual | unknown
      expected_animal_id UUID REFERENCES animals(id), -- who the pen/schedule says should be here
      mismatch BOOLEAN DEFAULT false,                 -- wrong dog at this device / in this pen
      occurred_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Consumables: food, filters, meds, bedding. Warn (do not auto-order).
    CREATE TABLE IF NOT EXISTS consumables (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      category VARCHAR(20) DEFAULT 'food',            -- food | water-filter | medication | bedding | other
      unit VARCHAR(20) DEFAULT 'kg',
      on_hand FLOAT NOT NULL DEFAULT 0,
      low_threshold FLOAT NOT NULL DEFAULT 0,
      daily_use FLOAT,                                -- manual estimate; engine refines from intake_events
      linked_device_id VARCHAR(255),
      linked_food_sku VARCHAR(255),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Automation rules (see logic/rules.ts for trigger/condition/action shapes).
    CREATE TABLE IF NOT EXISTS rules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      enabled BOOLEAN DEFAULT true,
      trigger JSONB NOT NULL,                         -- { type, ...params }
      conditions JSONB DEFAULT '[]'::jsonb,           -- [{ field, op, value }]
      actions JSONB NOT NULL DEFAULT '[]'::jsonb,     -- [{ type, ...params }]
      cooldown_seconds INT DEFAULT 300,
      last_fired_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rule_firings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rule_id UUID REFERENCES rules(id) ON DELETE CASCADE,
      kennel_id VARCHAR(255) NOT NULL,
      fired_at TIMESTAMPTZ DEFAULT NOW(),
      context JSONB,
      alert_id UUID
    );

    -- The care inbox / exception queue. Distinct from the legacy alerts table
    -- (which the feeder loop owns); this one is triage-shaped.
    CREATE TABLE IF NOT EXISTS exceptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      kind VARCHAR(64) NOT NULL,                      -- feeder-jam | missed-meal | temp-high | low-battery | wrong-pen | ...
      severity VARCHAR(20) NOT NULL DEFAULT 'info',   -- info | warning | critical
      priority INT NOT NULL DEFAULT 50,              -- 0..100, higher = sooner
      title VARCHAR(255) NOT NULL,
      detail TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'open',     -- open | acknowledged | snoozed | resolved | escalated
      device_id VARCHAR(255),
      animal_id UUID REFERENCES animals(id),
      pen_id UUID REFERENCES pens(id),
      rule_id UUID REFERENCES rules(id),
      suggested_action TEXT,
      dedup_key VARCHAR(255),                         -- collapse repeats while still open
      assigned_to UUID REFERENCES users(id),
      snoozed_until TIMESTAMPTZ,
      escalation_step INT DEFAULT 0,
      first_notified_at TIMESTAMPTZ,
      acknowledged_at TIMESTAMPTZ,
      acknowledged_by UUID REFERENCES users(id),
      resolved_at TIMESTAMPTZ,
      resolved_by UUID REFERENCES users(id),
      resolution_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Outbound notifications (one row per channel attempt).
    CREATE TABLE IF NOT EXISTS notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      exception_id UUID REFERENCES exceptions(id) ON DELETE CASCADE,
      user_id UUID REFERENCES users(id),
      channel VARCHAR(20) NOT NULL,                   -- log | webhook | sms | email | push | siren
      target VARCHAR(255),
      subject VARCHAR(255),
      body TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'queued',   -- queued | sent | failed | suppressed
      attempts INT DEFAULT 0,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );

    -- Per-user delivery preferences: quiet hours + channels + escalation chain.
    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      kennel_id VARCHAR(255),
      channels JSONB DEFAULT '["log"]'::jsonb,
      quiet_hours JSONB,                              -- { start:"22:00", end:"07:00", tz:"UTC", overrideSeverity:"critical" }
      escalation JSONB DEFAULT '[]'::jsonb,           -- [{ afterSeconds, userId?, channel, target }]
      webhook_url TEXT,
      sms_number VARCHAR(64),
      email VARCHAR(255),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Predictive maintenance: running counters per device + a serviced baseline.
    CREATE TABLE IF NOT EXISTS device_health_counters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      metric VARCHAR(40) NOT NULL,                    -- servo_cycles | pump_seconds | jam_count | rssi_ewma | door_cycles
      value FLOAT NOT NULL DEFAULT 0,
      service_limit FLOAT,                            -- raise a maintenance exception at/above this
      serviced_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (device_id, metric)
    );

    -- Automated enrichment / play rotation.
    CREATE TABLE IF NOT EXISTS enrichment_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      animal_id UUID REFERENCES animals(id) ON DELETE CASCADE,
      station VARCHAR(255) NOT NULL,
      scheduled_start TIMESTAMPTZ NOT NULL,
      scheduled_end TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) DEFAULT 'scheduled',         -- scheduled | active | done | skipped
      activity_minutes FLOAT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Emergency mode activations (fire / flood / evac / drill).
    CREATE TABLE IF NOT EXISTS emergency_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      mode VARCHAR(20) NOT NULL,                      -- fire | flood | evac | drill
      triggered_by UUID REFERENCES users(id),
      started_at TIMESTAMPTZ DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      actions JSONB DEFAULT '[]'::jsonb,              -- what the system did (doors, lights, cameras, notifies)
      note TEXT
    );

    -- Cloud-side record of device offline / power-cut windows and backfill.
    CREATE TABLE IF NOT EXISTS offline_journal (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kennel_id VARCHAR(255) NOT NULL,
      device_id VARCHAR(255) NOT NULL,
      went_offline_at TIMESTAMPTZ NOT NULL,
      came_online_at TIMESTAMPTZ,
      cause VARCHAR(20) DEFAULT 'unknown',            -- power | network | unknown
      missed_actions JSONB DEFAULT '[]'::jsonb,       -- reported by device on reconnect
      backfilled BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS kennel_id VARCHAR(255);

    CREATE INDEX IF NOT EXISTS idx_animals_kennel ON animals(kennel_id);
    CREATE INDEX IF NOT EXISTS idx_animals_pen ON animals(current_pen_id);
    CREATE INDEX IF NOT EXISTS idx_weight_animal ON weight_readings(animal_id, taken_at);
    CREATE INDEX IF NOT EXISTS idx_weight_puppy ON weight_readings(puppy_id, taken_at);
    CREATE INDEX IF NOT EXISTS idx_intake_device ON intake_events(device_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_intake_animal ON intake_events(animal_id, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_exceptions_open ON exceptions(kennel_id, status, priority DESC);
    CREATE INDEX IF NOT EXISTS idx_exceptions_dedup ON exceptions(kennel_id, dedup_key) WHERE status IN ('open','snoozed','escalated');
    CREATE INDEX IF NOT EXISTS idx_notifications_queued ON notifications(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_rules_kennel ON rules(kennel_id, enabled);
    CREATE INDEX IF NOT EXISTS idx_health_device ON device_health_counters(device_id);
    CREATE INDEX IF NOT EXISTS idx_medlog_animal ON medication_logs(animal_id, administered_at);
`;

export async function initBreederSchema(): Promise<void> {
  await pool.query(BREEDER_DDL);

  // Seed a single kennel and attach any existing users to it.
  const slug = process.env.BREEDER_KENNEL_SLUG || 'home';
  const name = process.env.BREEDER_KENNEL_NAME || 'Home Kennel';
  await pool.query(
    `INSERT INTO kennels (slug, name)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO NOTHING`,
    [slug, name]
  );
  await pool.query(
    `UPDATE kennels k
       SET owner_user_id = u.id
      FROM users u
     WHERE k.slug = $1 AND k.owner_user_id IS NULL AND u.role IN ('owner','user')`,
    [slug]
  );
  await pool.query(
    `UPDATE users SET kennel_id = $1 WHERE kennel_id IS NULL`,
    [slug]
  );

  console.log(`[Database] Breeder schema ready (kennel="${slug}")`);
}
