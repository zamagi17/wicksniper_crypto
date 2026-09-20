import { Pool } from 'pg';
import dotenv from 'dotenv';
import { BotConfig, ClosedTrade, ActivePosition } from '../types';

dotenv.config();

export class DatabaseService {
  private pool: Pool | null = null;
  public isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.initPool();
  }

  private initPool() {
    try {
      const poolConfig = process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {
            host: process.env.DB_HOST || '127.0.0.1',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            user: process.env.DB_USER || 'zamagi',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'copytrading',
          };

      this.pool = new Pool({
        ...poolConfig,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
        max: 10,
      });

      this.pool.on('error', (err: any) => {
        console.error('[Database] Idle client error:', err.message);
        this.isConnected = false;
        this.startAutoReconnect();
      });
    } catch (e: any) {
      console.warn('[Database] Inisialisasi pool gagal:', e.message);
      this.pool = null;
    }
  }

  private startAutoReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setInterval(async () => {
      if (this.isConnected) {
        if (this.reconnectTimer) {
          clearInterval(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        return;
      }
      try {
        await this.init();
      } catch {}
    }, 30000);
  }

  /**
   * Inisialisasi tabel-tabel wicksniper di PostgreSQL
   */
  public async init(): Promise<boolean> {
    if (!this.pool) return false;

    try {
      const client = await this.pool.connect();
      try {
        // 1. Tabel Konfigurasi Bot
        await client.query(`
          CREATE TABLE IF NOT EXISTS wicksniper_config (
            id INT PRIMARY KEY DEFAULT 1,
            config JSONB NOT NULL,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // 2. Tabel State Posisi & Saldo
        await client.query(`
          CREATE TABLE IF NOT EXISTS wicksniper_state (
            id INT PRIMARY KEY DEFAULT 1,
            virtual_balance NUMERIC DEFAULT 245,
            active_positions JSONB DEFAULT '[]'::jsonb,
            spikes_today INT DEFAULT 0,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // 3. Tabel Riwayat Transaksi Selesai
        await client.query(`
          CREATE TABLE IF NOT EXISTS wicksniper_trades (
            id VARCHAR(64) PRIMARY KEY,
            symbol VARCHAR(32) NOT NULL,
            side VARCHAR(16) NOT NULL,
            entry_price NUMERIC NOT NULL,
            exit_price NUMERIC NOT NULL,
            qty NUMERIC NOT NULL,
            margin_used NUMERIC NOT NULL,
            realized_pnl NUMERIC NOT NULL,
            pnl_pct NUMERIC NOT NULL,
            duration_seconds INT NOT NULL,
            exit_reason VARCHAR(64) NOT NULL,
            is_paper BOOLEAN DEFAULT TRUE,
            closed_at VARCHAR(64) NOT NULL,
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_wicksniper_trades_timestamp ON wicksniper_trades (timestamp DESC);
        `);

        this.isConnected = true;
        console.log('[Database] ✅ Berhasil terhubung ke PostgreSQL (tabel wicksniper_*)!');
        return true;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn('[Database] PostgreSQL belum aktif / tidak tersambung:', err.message);
      this.isConnected = false;
      this.startAutoReconnect();
      return false;
    }
  }

  // --- CONFIG PERSISTENCE ---
  public async loadConfig(): Promise<BotConfig | null> {
    if (!this.isConnected || !this.pool) return null;
    try {
      const res = await this.pool.query('SELECT config FROM wicksniper_config WHERE id = 1;');
      if (res.rows.length > 0 && res.rows[0].config) {
        return res.rows[0].config as BotConfig;
      }
    } catch (e: any) {
      console.error('[Database] Gagal load config dari DB:', e.message);
    }
    return null;
  }

  public async saveConfig(config: BotConfig): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_config (id, config, updated_at)
         VALUES (1, $1, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET config = $1, updated_at = CURRENT_TIMESTAMP;`,
        [JSON.stringify(config)]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan config ke DB:', e.message);
    }
  }

  // --- STATE PERSISTENCE ---
  public async loadState(): Promise<{ virtualBalance: number; activePositions: ActivePosition[]; spikesToday: number } | null> {
    if (!this.isConnected || !this.pool) return null;
    try {
      const res = await this.pool.query('SELECT * FROM wicksniper_state WHERE id = 1;');
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          virtualBalance: parseFloat(row.virtual_balance || '245'),
          activePositions: (row.active_positions as ActivePosition[]) || [],
          spikesToday: parseInt(row.spikes_today || '0', 10),
        };
      }
    } catch (e: any) {
      console.error('[Database] Gagal load state dari DB:', e.message);
    }
    return null;
  }

  public async saveState(virtualBalance: number, activePositions: ActivePosition[], spikesToday: number): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_state (id, virtual_balance, active_positions, spikes_today, updated_at)
         VALUES (1, $1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE
         SET virtual_balance = $1, active_positions = $2, spikes_today = $3, updated_at = CURRENT_TIMESTAMP;`,
        [virtualBalance, JSON.stringify(activePositions), spikesToday]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan state ke DB:', e.message);
    }
  }

  // --- TRADES PERSISTENCE ---
  public async saveTrade(t: ClosedTrade): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_trades (
           id, symbol, side, entry_price, exit_price, qty, margin_used, realized_pnl, pnl_pct, duration_seconds, exit_reason, is_paper, closed_at, timestamp
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO NOTHING;`,
        [
          t.id,
          t.symbol,
          t.side,
          t.entryPrice,
          t.exitPrice,
          t.qty,
          t.marginUsed,
          t.realizedPnl,
          t.pnlPct,
          t.durationSeconds,
          t.exitReason,
          t.isPaper,
          t.closedAt,
          t.timestamp,
        ]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan trade ke DB:', e.message);
    }
  }

  public async loadRecentTrades(limit: number = 50): Promise<ClosedTrade[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const res = await this.pool.query(
        `SELECT id, symbol, side, entry_price AS "entryPrice", exit_price AS "exitPrice",
                qty, margin_used AS "marginUsed", realized_pnl AS "realizedPnl",
                pnl_pct AS "pnlPct", duration_seconds AS "durationSeconds",
                exit_reason AS "exitReason", is_paper AS "isPaper",
                closed_at AS "closedAt", timestamp
         FROM wicksniper_trades
         ORDER BY timestamp DESC
         LIMIT $1;`,
        [limit]
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        symbol: r.symbol,
        side: r.side,
        entryPrice: parseFloat(r.entryPrice),
        exitPrice: parseFloat(r.exitPrice),
        qty: parseFloat(r.qty),
        marginUsed: parseFloat(r.marginUsed),
        realizedPnl: parseFloat(r.realizedPnl),
        pnlPct: parseFloat(r.pnlPct),
        durationSeconds: parseInt(r.durationSeconds, 10),
        exitReason: r.exitReason,
        isPaper: r.isPaper,
        closedAt: r.closedAt,
        timestamp: parseInt(r.timestamp, 10),
      }));
    } catch (e: any) {
      console.error('[Database] Gagal load trades dari DB:', e.message);
      return [];
    }
  }

  public async clearAllTrades(): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query('TRUNCATE TABLE wicksniper_trades;');
      console.log('[Database] 🧹 Tabel wicksniper_trades berhasil dibersihkan.');
    } catch (e: any) {
      console.error('[Database] Gagal truncate trades:', e.message);
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const db = new DatabaseService();
