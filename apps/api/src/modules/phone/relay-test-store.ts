import {randomUUID} from 'node:crypto';
import {ApiFailure} from '../../errors.js';
type Match = { customer_id: string; name: string; phone: string; phone_e164: string };
type CallInput = { id: string; phone_e164: string; occurred_at: string; matches: Match[] };
type CallEvent = CallInput & { received_at: string; expires_at: string };
type Channel = { epoch: string; sequence: number; touched: number; events: { sequence: number; value: CallEvent }[]; wake: Set<() => void> };
const TTL = 120_000;

/** Live notifications for a single API process, deliberately not a durable call history. */
export class CallRelayStore {
  private channels = new Map<string, Channel>();
  constructor(private now = () => Date.now()) {}
  private channel(organization: string, user: string): Channel {
    for (const [key, channel] of this.channels) {
      if (!channel.wake.size && channel.touched < this.now() - TTL * 2) this.channels.delete(key);
    }
    const key = `${organization}:${user}`;
    let channel = this.channels.get(key);
    if (!channel) {
      if (this.channels.size >= 1000) throw new ApiFailure(429, 'Call relay capacity reached');
      channel = { epoch: randomUUID(), sequence: 0, touched: this.now(), events: [], wake: new Set() };
      this.channels.set(key, channel);
    }
    channel.touched = this.now();
    channel.events = channel.events.filter(row => Date.parse(row.value.expires_at) > this.now());
    return channel;
  }
  publish(organization: string, user: string, input: CallInput) {
    const channel = this.channel(organization, user);
    const existing = channel.events.find(row => row.value.id === input.id);
    if (existing) {
      if (existing.value.phone_e164 !== input.phone_e164 || existing.value.occurred_at !== input.occurred_at) throw new ApiFailure(409, 'Call event ID already used');
      return { event: existing.value, duplicate: true };
    }
    const event = { ...input, received_at: new Date(this.now()).toISOString(), expires_at: new Date(Math.min(this.now() + TTL, Date.parse(input.occurred_at) + TTL)).toISOString() };
    channel.events.push({ sequence: ++channel.sequence, value: event });
    if (channel.events.length > 100) channel.events.shift();
    for (const wake of [...channel.wake]) wake();
    return { event, duplicate: false };
  }
  async poll(organization: string, user: string, cursor: string, waitMs: number) {
    const channel = this.channel(organization, user);
    const read = () => {
      const [epoch, sequenceText] = cursor.split(':');
      const sequence = epoch === channel.epoch ? Number(sequenceText) || 0 : 0;
      return { items: channel.events.filter(row => row.sequence > sequence && Date.parse(row.value.expires_at) > this.now()).map(row => row.value), cursor: `${channel.epoch}:${channel.sequence}` };
    };
    const current = read();
    if (current.items.length || waitMs === 0) return current;
    if (channel.wake.size >= 4) throw new ApiFailure(429, 'Too many call listeners');
    return new Promise<ReturnType<typeof read>>(resolve => {
      const finish = () => { clearTimeout(timer); channel.wake.delete(finish); resolve(read()); };
      const timer = setTimeout(finish, Math.min(waitMs, 8000));
      channel.wake.add(finish);
    });
  }
  close() { for (const channel of this.channels.values()) for (const wake of [...channel.wake]) wake(); this.channels.clear(); }
}

