/**
 * PostgreSQL Database Setup
 * Used by both Edge and Cloud modes
 */

import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Determine which database to use based on mode
const BACKEND_MODE = (process.env.BACKEND_MODE || 'cloud').toLowerCase();

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || (BACKEND_MODE === 'edge' ? 'smartpet_edge' : 'smartpet'),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
});

export async function initializeDatabase(): Promise<void> {
  console.log(`[Database] Initializing PostgreSQL (${BACKEND_MODE} mode)...`);
  
  try {
    // Create tables
    await pool.query(`
      -- Users table
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      -- Devices table
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

      -- Device events table
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

      -- Device commands table
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

      -- Schedules table
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

      -- Alerts table
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

      -- Gateways table
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

      -- Edge sync queue (for edge mode)
      CREATE TABLE IF NOT EXISTS sync_queue (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        data JSONB NOT NULL,
        synced BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
      CREATE INDEX IF NOT EXISTS idx_devices_device_id ON devices(device_id);
      CREATE INDEX IF NOT EXISTS idx_events_device ON device_events(device_id);
      CREATE INDEX IF NOT EXISTS idx_events_created ON device_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_user ON schedules(user_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts(user_id);
      CREATE INDEX IF NOT EXISTS idx_alerts_acknowledged ON alerts(acknowledged);
      CREATE INDEX IF NOT EXISTS idx_sync_queue_synced ON sync_queue(synced);
    `);
    
    console.log('[Database] Tables created successfully');
  } catch (error) {
    console.error('[Database] Error creating tables:', error);
  }
}

// Query helpers
export async function query<T>(text: string, params?: any[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows;
}

export async function queryOne<T>(text: string, params?: any[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

export async function execute(text: string, params?: any[]): Promise<void> {
  await pool.query(text, params);
}

export { pool };
