/**
 * PostgreSQL Database Setup
 * Cloud feeder command path uses pg only. No Mongo.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const BACKEND_MODE = (process.env.BACKEND_MODE || 'cloud').toLowerCase();

export const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432', 10),
  database: process.env.PG_DATABASE || (BACKEND_MODE === 'edge' ? 'smartpet_edge' : 'smartpet'),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
});

export async function initializeDatabase(): Promise<void> {
  console.log(`[Database] Initializing PostgreSQL (${BACKEND_MODE} mode)...`);

  await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        device_id VARCHAR(255) UNIQUE NOT NULL,
        device_type VARCHAR(50) NOT NULL,
        name VARCHAR(255),
        location VARCHAR(255),
        api_key VARCHAR(255),
        is_online BOOLEAN DEFAULT false,
        last_seen TIMESTAMP,
        latest_value FLOAT,
        latest_event VARCHAR(50),
        config JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS device_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        device_id VARCHAR(255),
        event_type VARCHAR(50) NOT NULL,
        value FLOAT,
        unit VARCHAR(20),
        kennel_id VARCHAR(255),
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS device_commands (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        device_id VARCHAR(255) NOT NULL,
        command VARCHAR(50) NOT NULL,
        params JSONB,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        executed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        device_id VARCHAR(255) NOT NULL,
        schedule_type VARCHAR(50) NOT NULL,
        cron_expression VARCHAR(100),
        time VARCHAR(20),
        days JSONB,
        enabled BOOLEAN DEFAULT true,
        last_run TIMESTAMP,
        next_run TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID REFERENCES users(id),
        device_id VARCHAR(255),
        kennel_id VARCHAR(255),
        alert_type VARCHAR(50) NOT NULL,
        severity VARCHAR(20) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT,
        value FLOAT,
        threshold FLOAT,
        acknowledged BOOLEAN DEFAULT false,
        acknowledged_at TIMESTAMP,
        resolved BOOLEAN DEFAULT false,
        resolved_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS gateways (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gateway_id VARCHAR(255) UNIQUE NOT NULL,
        kennel_id VARCHAR(255),
        status VARCHAR(20) DEFAULT 'online',
        last_heartbeat TIMESTAMP,
        is_online BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        data JSONB NOT NULL,
        synced BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);
      CREATE INDEX IF NOT EXISTS idx_events_device ON device_events(device_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON device_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
      CREATE INDEX IF NOT EXISTS idx_sync_queue_synced ON sync_queue(synced);
  `);

  await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'owner';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kennel_id VARCHAR(255);
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS kennel_id VARCHAR(255);
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_username VARCHAR(255);
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS mqtt_password_hash VARCHAR(255);
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS food_level FLOAT;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_feed TIMESTAMP;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'offline';
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;
      ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_status_at TIMESTAMP;
      ALTER TABLE schedules ADD COLUMN IF NOT EXISTS amount FLOAT;
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
      CREATE INDEX IF NOT EXISTS idx_devices_kennel ON devices(kennel_id);
  `);

  console.log('[Database] Tables created successfully');
}

export async function seedIdentities(): Promise<void> {
  const ownerEmail = process.env.SEED_OWNER_EMAIL || 'owner@localhost';
  const staffEmail = process.env.SEED_STAFF_EMAIL || 'staff@localhost';
  const ownerPassword = process.env.SEED_OWNER_PASSWORD;
  const staffPassword = process.env.SEED_STAFF_PASSWORD;

  if (ownerPassword) {
    await upsertIdentity(ownerEmail, ownerPassword, 'owner', 'home', 'Seed Owner');
    console.log(`[seed] owner ready: ${ownerEmail} (kennel=home)`);
  } else {
    console.warn('[seed] SEED_OWNER_PASSWORD unset; owner not seeded');
  }

  if (staffPassword) {
    await upsertIdentity(staffEmail, staffPassword, 'staff', null, 'Seed Staff');
    console.log(`[seed] staff ready: ${staffEmail}`);
  } else {
    console.warn('[seed] SEED_STAFF_PASSWORD unset; staff not seeded');
  }
}

async function upsertIdentity(
  email: string,
  password: string,
  role: 'owner' | 'staff',
  kennelId: string | null,
  name: string
): Promise<void> {
  const existing = await queryOne<any>('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  const hash = await bcrypt.hash(password, 10);
  if (existing) {
    await execute(
      `UPDATE users SET password_hash = $1, role = $2, kennel_id = COALESCE(kennel_id, $3), name = COALESCE(name, $4), updated_at = NOW()
       WHERE email = $5`,
      [hash, role, kennelId, name, email.toLowerCase()]
    );
    return;
  }
  await execute(
    `INSERT INTO users (email, password_hash, name, role, kennel_id) VALUES ($1, $2, $3, $4, $5)`,
    [email.toLowerCase(), hash, name, role, kennelId]
  );
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

export async function execute(text: string, params?: any[]): Promise<void> {
  await pool.query(text, params);
}
