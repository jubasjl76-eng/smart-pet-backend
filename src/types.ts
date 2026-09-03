export type AppRole = 'owner' | 'staff';

export interface AppUser {
  id: string;
  email: string;
  name: string | null;
  role: AppRole;
  kennelId: string | null;
}

export interface DeviceRow {
  id: string;
  user_id: string | null;
  device_id: string;
  device_type: string;
  name: string | null;
  kennel_id: string | null;
  mqtt_username: string | null;
  mqtt_password_hash: string | null;
  is_online: boolean;
  last_seen: Date | string | null;
  food_level: number | null;
  last_feed: Date | string | null;
  status: string | null;
  claimed_at: Date | string | null;
  last_status_at: Date | string | null;
}

export interface ScheduleRow {
  id: string;
  user_id: string | null;
  device_id: string;
  time: string | null;
  amount: number | null;
  enabled: boolean;
}

export interface FeederStatusPayload {
  deviceId: string;
  kennelId: string;
  timestamp: number;
  status: string;
  foodLevel?: number;
  lastFeed?: number | string;
}

export interface FeedCommandPayload {
  command: 'feed';
  deviceId: string;
  kennelId: string;
  timestamp: number;
  params: { amount: number };
}

export interface ScheduleSetEntry {
  id: string;
  time: string;
  amount: number;
  enabled: boolean;
}

export interface ScheduleSetPayload {
  command: 'schedule_set';
  deviceId: string;
  kennelId: string;
  timestamp: number;
  params: { schedules: ScheduleSetEntry[] };
}
