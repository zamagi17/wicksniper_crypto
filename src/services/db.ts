import { Pool } from 'pg';
import dotenv from 'dotenv';
import { BotConfig, ClosedTrade, ActivePosition, SpikeAlert } from '../types';

dotenv.config();

export class DatabaseService {
  private pool: Pool | null = null;
  public isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stateWriteQueue: any = null;
  private stateWriteTimer: NodeJS.Timeout | null = null;
  private readonly STATE_WRITE_INTERVAL = 5000; // Flush every 5s

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
            params_snapshot JSONB,
            layers_detail JSONB,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_wicksniper_trades_timestamp ON wicksniper_trades (timestamp DESC);
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS params_snapshot JSONB;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS layers_detail JSONB;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS fee NUMERIC;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS gross_pnl NUMERIC;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS layers_filled VARCHAR(32);
        `);

        // 4. Tabel Riwayat Spike Lonjakan Harga
        await client.query(`
          CREATE TABLE IF NOT EXISTS wicksniper_spikes (
            id VARCHAR(64) PRIMARY KEY,
            symbol VARCHAR(32) NOT NULL,
            start_price NUMERIC NOT NULL,
            current_price NUMERIC NOT NULL,
            surge_pct NUMERIC NOT NULL,
            lookback_seconds INT NOT NULL,
            status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
            skip_reason VARCHAR(128),
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_wicksniper_spikes_timestamp ON wicksniper_spikes (timestamp DESC);
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
    
    // Queue the state write instead of executing immediately
    this.stateWriteQueue = { virtualBalance, activePositions, spikesToday };
    
    // Schedule flush if not already scheduled
    if (!this.stateWriteTimer) {
      this.stateWriteTimer = setTimeout(() => this.flushStateWrite(), this.STATE_WRITE_INTERVAL);
    }
  }

  private async flushStateWrite(): Promise<void> {
    this.stateWriteTimer = null;
    if (!this.stateWriteQueue || !this.isConnected || !this.pool) return;
    
    const { virtualBalance, activePositions, spikesToday } = this.stateWriteQueue;
    this.stateWriteQueue = null;
    
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
           id, symbol, side, entry_price, exit_price, qty, margin_used, realized_pnl, pnl_pct, duration_seconds, exit_reason, is_paper, closed_at, timestamp, params_snapshot, layers_detail, fee, gross_pnl, layers_filled
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
          t.paramsSnapshot ? JSON.stringify(t.paramsSnapshot) : null,
          t.layersDetail ? JSON.stringify(t.layersDetail) : null,
          t.fee !== undefined ? t.fee : null,
          t.grossPnl !== undefined ? t.grossPnl : null,
          t.layersFilled || null,
        ]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan trade ke DB:', e.message);
    }
  }

  public async loadRecentTrades(limit: number = 50, isPaper?: boolean): Promise<ClosedTrade[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const whereMode = isPaper !== undefined ? 'WHERE is_paper = $2' : '';
      const params: any[] = [limit];
      if (isPaper !== undefined) params.push(isPaper);
      const res = await this.pool.query(
        `SELECT id, symbol, side, entry_price AS "entryPrice", exit_price AS "exitPrice",
                qty, margin_used AS "marginUsed", realized_pnl AS "realizedPnl",
                pnl_pct AS "pnlPct", duration_seconds AS "durationSeconds",
                exit_reason AS "exitReason", is_paper AS "isPaper",
                closed_at AS "closedAt", timestamp,
                params_snapshot AS "paramsSnapshot",
                layers_detail AS "layersDetail",
                fee, gross_pnl AS "grossPnl", layers_filled AS "layersFilled"
         FROM wicksniper_trades
         ${whereMode}
         ORDER BY timestamp DESC
         LIMIT $1;`,
        params
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
        grossPnl: r.grossPnl !== null && r.grossPnl !== undefined ? parseFloat(r.grossPnl) : undefined,
        fee: r.fee !== null && r.fee !== undefined ? parseFloat(r.fee) : undefined,
        pnlPct: parseFloat(r.pnlPct),
        durationSeconds: parseInt(r.durationSeconds, 10),
        exitReason: r.exitReason,
        isPaper: r.isPaper,
        closedAt: r.closedAt,
        timestamp: parseInt(r.timestamp, 10),
        layersFilled: r.layersFilled || undefined,
        paramsSnapshot: typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || null,
        layersDetail: typeof r.layersDetail === 'string' ? JSON.parse(r.layersDetail) : r.layersDetail || null,
      }));
    } catch (e: any) {
      console.error('[Database] Gagal load trades dari DB:', e.message);
      return [];
    }
  }

  public async getTradeStats(todayStartTs: number, isPaper?: boolean): Promise<{
    totalTrades: number;
    totalWins: number;
    accumulatedPnl: number;
    winRate: number;
    dailyTrades: number;
    dailyWinsCount: number;
    dailyLossesCount: number;
    dailyWinRate: number;
    dailyPnl: number;
  } | null> {
    if (!this.isConnected || !this.pool) return null;
    try {
      const whereMode = isPaper !== undefined ? 'WHERE is_paper = $2' : '';
      const params: any[] = [todayStartTs];
      if (isPaper !== undefined) params.push(isPaper);

      const res = await this.pool.query(
        `SELECT 
           COUNT(*)::int AS total_trades,
           COALESCE(SUM(CASE WHEN realized_pnl >= 0 THEN 1 ELSE 0 END), 0)::int AS total_wins,
           COALESCE(SUM(realized_pnl), 0)::float AS accumulated_pnl,
           COALESCE(SUM(CASE WHEN timestamp >= $1 THEN 1 ELSE 0 END), 0)::int AS daily_trades,
           COALESCE(SUM(CASE WHEN timestamp >= $1 AND realized_pnl >= 0 THEN 1 ELSE 0 END), 0)::int AS daily_wins,
           COALESCE(SUM(CASE WHEN timestamp >= $1 THEN realized_pnl ELSE 0 END), 0)::float AS daily_pnl
         FROM wicksniper_trades
         ${whereMode};`,
        params
      );
      const r = res.rows[0];
      if (!r) return null;
      const totalTrades = r.total_trades || 0;
      const totalWins = r.total_wins || 0;
      const dailyTrades = r.daily_trades || 0;
      const dailyWins = r.daily_wins || 0;
      return {
        totalTrades,
        totalWins,
        accumulatedPnl: Math.round((r.accumulated_pnl || 0) * 100) / 100,
        winRate: totalTrades > 0 ? Math.round((totalWins / totalTrades) * 1000) / 10 : 0,
        dailyTrades,
        dailyWinsCount: dailyWins,
        dailyLossesCount: dailyTrades - dailyWins,
        dailyWinRate: dailyTrades > 0 ? Math.round((dailyWins / dailyTrades) * 1000) / 10 : 0,
        dailyPnl: Math.round((r.daily_pnl || 0) * 100) / 100,
      };
    } catch (e: any) {
      console.error('[Database] Gagal hitung trade stats:', e.message);
      return null;
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

  // --- SPIKES PERSISTENCE ---
  public async saveSpike(s: SpikeAlert): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_spikes (
           id, symbol, start_price, current_price, surge_pct, lookback_seconds, status, skip_reason, timestamp
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           skip_reason = EXCLUDED.skip_reason;`,
        [
          s.id,
          s.symbol,
          s.startPrice,
          s.currentPrice,
          s.surgePct,
          s.lookbackSeconds,
          s.status,
          s.skipReason || null,
          s.timestamp,
        ]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan spike ke DB:', e.message);
    }
  }

  public async loadRecentSpikes(limit: number = 50): Promise<SpikeAlert[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const res = await this.pool.query(
        `SELECT id, symbol,
                start_price AS "startPrice",
                current_price AS "currentPrice",
                surge_pct AS "surgePct",
                lookback_seconds AS "lookbackSeconds",
                status, skip_reason AS "skipReason",
                timestamp
         FROM wicksniper_spikes
         ORDER BY timestamp DESC
         LIMIT $1;`,
        [limit]
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        symbol: r.symbol,
        startPrice: parseFloat(r.startPrice),
        currentPrice: parseFloat(r.currentPrice),
        surgePct: parseFloat(r.surgePct),
        lookbackSeconds: parseInt(r.lookbackSeconds, 10),
        status: r.status as SpikeAlert['status'],
        skipReason: r.skipReason || undefined,
        timestamp: parseInt(r.timestamp, 10),
      }));
    } catch (e: any) {
      console.error('[Database] Gagal load spikes dari DB:', e.message);
      return [];
    }
  }

  public async queryTrades(options: {
    page?: number;
    limit?: number;
    symbol?: string;
    outcome?: 'ALL' | 'WIN' | 'LOSS';
    mode?: 'ALL' | 'LIVE' | 'PAPER';
  }): Promise<{ trades: ClosedTrade[]; total: number; page: number; totalPages: number }> {
    const page = Math.max(1, parseInt(String(options.page || 1), 10));
    const limit = Math.min(100, Math.max(5, parseInt(String(options.limit || 20), 10)));
    const offset = (page - 1) * limit;

    if (!this.isConnected || !this.pool) {
      return { trades: [], total: 0, page, totalPages: 0 };
    }

    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let valIdx = 1;

      if (options.symbol && options.symbol.trim() !== '') {
        conditions.push(`symbol ILIKE $${valIdx++}`);
        values.push(`%${options.symbol.trim()}%`);
      }

      if (options.outcome === 'WIN') {
        conditions.push(`realized_pnl >= 0`);
      } else if (options.outcome === 'LOSS') {
        conditions.push(`realized_pnl < 0`);
      }

      if (options.mode === 'LIVE') {
        conditions.push(`is_paper = FALSE`);
      } else if (options.mode === 'PAPER') {
        conditions.push(`is_paper = TRUE`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRes = await this.pool.query(
        `SELECT COUNT(*) AS total FROM wicksniper_trades ${whereClause};`,
        values
      );
      const total = parseInt(countRes.rows[0]?.total || '0', 10);
      const totalPages = Math.ceil(total / limit) || 1;

      const queryValues = [...values, limit, offset];
      const res = await this.pool.query(
        `SELECT id, symbol, side, entry_price AS "entryPrice", exit_price AS "exitPrice",
                qty, margin_used AS "marginUsed", realized_pnl AS "realizedPnl",
                pnl_pct AS "pnlPct", duration_seconds AS "durationSeconds",
                exit_reason AS "exitReason", is_paper AS "isPaper",
                closed_at AS "closedAt", timestamp,
                params_snapshot AS "paramsSnapshot",
                layers_detail AS "layersDetail",
                fee, gross_pnl AS "grossPnl", layers_filled AS "layersFilled"
         FROM wicksniper_trades
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${valIdx++} OFFSET $${valIdx++};`,
        queryValues
      );

      const trades: ClosedTrade[] = res.rows.map((r: any) => ({
        id: r.id,
        symbol: r.symbol,
        side: r.side,
        entryPrice: parseFloat(r.entryPrice),
        exitPrice: parseFloat(r.exitPrice),
        qty: parseFloat(r.qty),
        marginUsed: parseFloat(r.marginUsed),
        realizedPnl: parseFloat(r.realizedPnl),
        grossPnl: r.grossPnl !== null && r.grossPnl !== undefined ? parseFloat(r.grossPnl) : undefined,
        fee: r.fee !== null && r.fee !== undefined ? parseFloat(r.fee) : undefined,
        pnlPct: parseFloat(r.pnlPct),
        durationSeconds: parseInt(r.durationSeconds, 10),
        exitReason: r.exitReason,
        isPaper: r.isPaper,
        closedAt: r.closedAt,
        timestamp: parseInt(r.timestamp, 10),
        layersFilled: r.layersFilled || undefined,
        paramsSnapshot: typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || null,
        layersDetail: typeof r.layersDetail === 'string' ? JSON.parse(r.layersDetail) : r.layersDetail || null,
      }));

      return { trades, total, page, totalPages };
    } catch (e: any) {
      console.error('[Database] Gagal query trades:', e.message);
      return { trades: [], total: 0, page, totalPages: 0 };
    }
  }

  public async querySpikes(options: {
    page?: number;
    limit?: number;
    symbol?: string;
    status?: string;
  }): Promise<{ spikes: SpikeAlert[]; total: number; page: number; totalPages: number }> {
    const page = Math.max(1, parseInt(String(options.page || 1), 10));
    const limit = Math.min(100, Math.max(5, parseInt(String(options.limit || 15), 10)));
    const offset = (page - 1) * limit;

    if (!this.isConnected || !this.pool) {
      return { spikes: [], total: 0, page, totalPages: 0 };
    }

    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let valIdx = 1;

      if (options.symbol && options.symbol.trim() !== '') {
        conditions.push(`symbol ILIKE $${valIdx++}`);
        values.push(`%${options.symbol.trim()}%`);
      }

      if (options.status && options.status !== 'ALL') {
        conditions.push(`status = $${valIdx++}`);
        values.push(options.status);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const countRes = await this.pool.query(
        `SELECT COUNT(*) AS total FROM wicksniper_spikes ${whereClause};`,
        values
      );
      const total = parseInt(countRes.rows[0]?.total || '0', 10);
      const totalPages = Math.ceil(total / limit) || 1;

      const queryValues = [...values, limit, offset];
      const res = await this.pool.query(
        `SELECT id, symbol,
                start_price AS "startPrice",
                current_price AS "currentPrice",
                surge_pct AS "surgePct",
                lookback_seconds AS "lookbackSeconds",
                status, skip_reason AS "skipReason",
                timestamp
         FROM wicksniper_spikes
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${valIdx++} OFFSET $${valIdx++};`,
        queryValues
      );

      const spikes: SpikeAlert[] = res.rows.map((r: any) => ({
        id: r.id,
        symbol: r.symbol,
        startPrice: parseFloat(r.startPrice),
        currentPrice: parseFloat(r.currentPrice),
        surgePct: parseFloat(r.surgePct),
        lookbackSeconds: parseInt(r.lookbackSeconds, 10),
        status: r.status as SpikeAlert['status'],
        skipReason: r.skipReason || undefined,
        timestamp: parseInt(r.timestamp, 10),
      }));

      return { spikes, total, page, totalPages };
    } catch (e: any) {
      console.error('[Database] Gagal query spikes:', e.message);
      return { spikes: [], total: 0, page, totalPages: 0 };
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
