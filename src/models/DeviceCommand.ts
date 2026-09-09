import mongoose, { Document, Schema } from 'mongoose';

export interface IDeviceCommand extends Document {
  commandId: string;
  deviceId: string;
  kennelId: string;
  command: string;
  params?: Record<string, any>;
  status: 'pending' | 'sent' | 'delivered' | 'executed' | 'failed';
  result?: Record<string, any>;
  sentAt?: Date;
  deliveredAt?: Date;
  executedAt?: Date;
  failedAt?: Date;
  error?: string;
  createdAt: Date;
}

const deviceCommandSchema = new Schema<IDeviceCommand>({
  commandId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  deviceId: {
    type: String,
    required: true,
    index: true,
  },
  kennelId: {
    type: String,
    required: true,
    index: true,
  },
  command: {
    type: String,
    required: true,
  },
  params: {
    type: Schema.Types.Mixed,
  },
  status: {
    type: String,
    enum: ['pending', 'sent', 'delivered', 'executed', 'failed'],
    default: 'pending',
    index: true,
  },
  result: {
    type: Schema.Types.Mixed,
  },
  sentAt: {
    type: Date,
  },
  deliveredAt: {
    type: Date,
  },
  executedAt: {
    type: Date,
  },
  failedAt: {
    type: Date,
  },
  error: {
    type: String,
  },
}, {
  timestamps: true,
});

deviceCommandSchema.index({ deviceId: 1, createdAt: -1 });
deviceCommandSchema.index({ kennelId: 1, status: 1 });

export const DeviceCommand = mongoose.model<IDeviceCommand>('DeviceCommand', deviceCommandSchema);
