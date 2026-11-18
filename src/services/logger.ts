import { AsyncLocalStorage } from 'node:async_hooks';
import { LogEntry } from '../types';

export const userLogContext = new AsyncLocalStorage<string>();

export class Logger {
  private logs: LogEntry[] = [];
  private listeners: ((log: LogEntry) => void)[] = [];

  public log(level: LogEntry['level'], message: string, symbol?: string, userId?: string) {
    const resolvedUserId = userId || userLogContext.getStore();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const timestamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      userId: resolvedUserId,
      timestamp,
      time: now.getTime(),
      level,
      message,
      symbol,
    };

    this.logs.push(entry);
    if (this.logs.length > 300) this.logs.shift();

    const tag = resolvedUserId ? `[${resolvedUserId}] ` : '';
    const prefix = `[${entry.timestamp}] [${level}] ${tag}`;
    if (level === 'SNIPER') {
      console.log(`\x1b[35m🎯 ${prefix}${message}\x1b[0m`);
    } else if (level === 'SUCCESS') {
      console.log(`\x1b[32m✅ ${prefix}${message}\x1b[0m`);
    } else if (level === 'WARN') {
      console.log(`\x1b[33m⚠️  ${prefix}${message}\x1b[0m`);
    } else if (level === 'ERROR') {
      console.log(`\x1b[31m❌ ${prefix}${message}\x1b[0m`);
    } else {
      console.log(`\x1b[36mℹ️  ${prefix}${message}\x1b[0m`);
    }

    for (const fn of this.listeners) {
      fn(entry);
    }
  }

  public getLogs(userId?: string): LogEntry[] {
    if (!userId || userId === 'all') return [...this.logs];
    return this.logs.filter((l) => !l.userId || l.userId === userId);
  }

  public onLog(callback: (log: LogEntry) => void) {
    this.listeners.push(callback);
  }
}

export const logger = new Logger();
