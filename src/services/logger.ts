import { LogEntry } from '../types';

export class Logger {
  private logs: LogEntry[] = [];
  private listeners: ((log: LogEntry) => void)[] = [];

  public log(level: LogEntry['level'], message: string, symbol?: string) {
    const entry: LogEntry = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString('id-ID', { hour12: false }),
      level,
      message,
      symbol,
    };

    this.logs.unshift(entry);
    if (this.logs.length > 200) this.logs.pop();

    const prefix = `[${entry.timestamp}] [${level}]`;
    if (level === 'SNIPER') {
      console.log(`\x1b[35m🎯 ${prefix} ${message}\x1b[0m`);
    } else if (level === 'SUCCESS') {
      console.log(`\x1b[32m✅ ${prefix} ${message}\x1b[0m`);
    } else if (level === 'WARN') {
      console.log(`\x1b[33m⚠️  ${prefix} ${message}\x1b[0m`);
    } else if (level === 'ERROR') {
      console.log(`\x1b[31m❌ ${prefix} ${message}\x1b[0m`);
    } else {
      console.log(`\x1b[36mℹ️  ${prefix} ${message}\x1b[0m`);
    }

    for (const fn of this.listeners) {
      fn(entry);
    }
  }

  public getLogs(): LogEntry[] {
    return this.logs;
  }

  public onLog(callback: (log: LogEntry) => void) {
    this.listeners.push(callback);
  }
}

export const logger = new Logger();
