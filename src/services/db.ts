import { Pool } from 'pg';
import dotenv from 'dotenv';
import { BotConfig, ClosedTrade, ActivePosition, SpikeAlert, SpikeSimResult, TuningHistoryRecord, DailySnapshot, CoinPerformanceRecord, UserRecord } from '../types';

dotenv.config();

export class DatabaseService {
  private pool: Pool | null = null;
  public isConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stateWriteQueues: Map<string, { virtualBalance: number; activePositions: ActivePosition[]; spikesToday: number }> = new Map();
  private stateWriteTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly STATE_WRITE_INTERVAL = 5000; // Flush every 5s
  private tuningLogsMemory: TuningHistoryRecord[] = [];
  private dailySnapshotsMemory: DailySnapshot[] = [];

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

          -- Migrasi aman: tambahkan default maxVolRatio ke config database production jika belum ada
          UPDATE wicksniper_config
          SET config = jsonb_set(
            jsonb_set(config, '{scanner,maxVolRatio}', '20'::jsonb, true),
            '{scanner,maxVolRatioCooldownMinutes}', '10'::jsonb, true
          ),
          updated_at = CURRENT_TIMESTAMP
          WHERE id = 1 AND (config->'scanner'->>'maxVolRatio') IS NULL;

          -- Migrasi aman: tambahkan default minVolRatio ke config database production jika belum ada
          UPDATE wicksniper_config
          SET config = jsonb_set(
            jsonb_set(config, '{scanner,minVolRatio}', '1.0'::jsonb, true),
            '{scanner,minVolRatioCooldownMinutes}', '5'::jsonb, true
          ),
          updated_at = CURRENT_TIMESTAMP
          WHERE id = 1 AND (config->'scanner'->>'minVolRatio') IS NULL;

          -- Migrasi aman: tambahkan default minEmaDistancePct ke smartMoney jika belum ada
          UPDATE wicksniper_config
          SET config = jsonb_set(
            config,
            '{smartMoney,minEmaDistancePct}',
            '1.0'::jsonb,
            true
          ),
          updated_at = CURRENT_TIMESTAMP
          WHERE id = 1 AND (config->'smartMoney'->>'minEmaDistancePct') IS NULL;
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
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS post_exit_30m JSONB;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS highest_price NUMERIC;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS lowest_price NUMERIC;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS mfe_pct NUMERIC;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS mae_pct NUMERIC;
          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS price_change_24h_pct NUMERIC;
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
            skip_reason TEXT,
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_wicksniper_spikes_timestamp ON wicksniper_spikes (timestamp DESC);
          ALTER TABLE wicksniper_spikes ALTER COLUMN skip_reason TYPE TEXT;
          ALTER TABLE wicksniper_spikes ADD COLUMN IF NOT EXISTS params_snapshot JSONB;
          ALTER TABLE wicksniper_spikes ADD COLUMN IF NOT EXISTS sim_result JSONB;
          ALTER TABLE wicksniper_spikes ADD COLUMN IF NOT EXISTS user_id VARCHAR(64) DEFAULT 'admin';
          CREATE INDEX IF NOT EXISTS idx_wicksniper_spikes_user_id ON wicksniper_spikes (user_id);
        `);

        // 5. Tabel Riwayat Auto-Tuning Parameter
        await client.query(`
          CREATE TABLE IF NOT EXISTS wicksniper_tuning_logs (
            id VARCHAR(64) PRIMARY KEY,
            proposal JSONB NOT NULL,
            previous_config JSONB,
            status VARCHAR(32) NOT NULL DEFAULT 'PROPOSED',
            applied_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_wicksniper_tuning_logs_created ON wicksniper_tuning_logs (created_at DESC);
        `);

        // 6. Tabel Snapshot Kinerja Harian (00:00 WIB)
        await client.query(`
          CREATE TABLE IF NOT EXISTS wicksniper_daily_snapshots (
            id VARCHAR(64) PRIMARY KEY,
            date VARCHAR(16) NOT NULL,
            trading_mode VARCHAR(16) NOT NULL,
            ending_balance NUMERIC NOT NULL,
            start_balance NUMERIC,
            daily_pnl NUMERIC NOT NULL,
            daily_pnl_pct NUMERIC NOT NULL,
            cumulative_pnl NUMERIC NOT NULL,
            total_trades INT NOT NULL,
            win_count INT NOT NULL,
            loss_count INT NOT NULL,
            win_rate NUMERIC NOT NULL,
            total_fee NUMERIC DEFAULT 0,
            gross_pnl NUMERIC DEFAULT 0,
            best_trade_symbol VARCHAR(32),
            best_trade_pnl NUMERIC,
            worst_trade_symbol VARCHAR(32),
            worst_trade_pnl NUMERIC,
            spikes_detected INT DEFAULT 0,
            strategy_breakdown JSONB,
            details JSONB,
            timestamp BIGINT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_wicksniper_daily_snapshots_date ON wicksniper_daily_snapshots (date DESC);
          CREATE INDEX IF NOT EXISTS idx_wicksniper_daily_snapshots_mode ON wicksniper_daily_snapshots (trading_mode);
        `);

        // 7. Tabel Akun & Profil R&D Multi-User
        await client.query(`
          CREATE TABLE IF NOT EXISTS wicksniper_users (
            id VARCHAR(64) PRIMARY KEY,
            username VARCHAR(64) UNIQUE NOT NULL,
            password_hash VARCHAR(256) NOT NULL,
            role VARCHAR(16) NOT NULL DEFAULT 'USER',
            display_name VARCHAR(128) NOT NULL,
            status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
            config JSONB NOT NULL,
            virtual_balance NUMERIC DEFAULT 1000,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_wicksniper_users_username ON wicksniper_users (username);

          -- Migrasi aman Multi-User ke State, Trades & Snapshots
          ALTER TABLE wicksniper_state ADD COLUMN IF NOT EXISTS user_id VARCHAR(64) DEFAULT 'admin';
          UPDATE wicksniper_state SET user_id = 'admin' WHERE user_id IS NULL;
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint WHERE conname = 'uq_wicksniper_state_user_id'
            ) THEN
              ALTER TABLE wicksniper_state ADD CONSTRAINT uq_wicksniper_state_user_id UNIQUE (user_id);
            END IF;
          END $$;

          ALTER TABLE wicksniper_trades ADD COLUMN IF NOT EXISTS user_id VARCHAR(64) DEFAULT 'admin';
          CREATE INDEX IF NOT EXISTS idx_wicksniper_trades_user_id ON wicksniper_trades (user_id);

          ALTER TABLE wicksniper_daily_snapshots ADD COLUMN IF NOT EXISTS user_id VARCHAR(64) DEFAULT 'admin';
          CREATE INDEX IF NOT EXISTS idx_wicksniper_daily_snapshots_user_id ON wicksniper_daily_snapshots (user_id);
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
  public async loadState(userId: string = 'admin'): Promise<{ virtualBalance: number; activePositions: ActivePosition[]; spikesToday: number } | null> {
    if (!this.isConnected || !this.pool) return null;
    try {
      const res = await this.pool.query('SELECT * FROM wicksniper_state WHERE user_id = $1 LIMIT 1;', [userId]);
      if (res.rows.length > 0) {
        const row = res.rows[0];
        return {
          virtualBalance: parseFloat(row.virtual_balance || '1000'),
          activePositions: (row.active_positions as ActivePosition[]) || [],
          spikesToday: parseInt(row.spikes_today || '0', 10),
        };
      } else if (userId === 'admin') {
        const fallback = await this.pool.query('SELECT * FROM wicksniper_state WHERE id = 1 LIMIT 1;');
        if (fallback.rows.length > 0) {
          const row = fallback.rows[0];
          return {
            virtualBalance: parseFloat(row.virtual_balance || '1000'),
            activePositions: (row.active_positions as ActivePosition[]) || [],
            spikesToday: parseInt(row.spikes_today || '0', 10),
          };
        }
      }
    } catch (e: any) {
      console.error(`[Database] Gagal load state untuk user ${userId} dari DB:`, e.message);
    }
    return null;
  }

  public async saveState(virtualBalance: number, activePositions: ActivePosition[], spikesToday: number, userId: string = 'admin'): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    
    // Queue the state write per user profile
    this.stateWriteQueues.set(userId, { virtualBalance, activePositions, spikesToday });
    
    // Schedule flush if not already scheduled for this user
    if (!this.stateWriteTimers.has(userId)) {
      const timer = setTimeout(() => this.flushStateWrite(userId), this.STATE_WRITE_INTERVAL);
      this.stateWriteTimers.set(userId, timer);
    }
  }

  private async flushStateWrite(userId: string): Promise<void> {
    const timer = this.stateWriteTimers.get(userId);
    if (timer) clearTimeout(timer);
    this.stateWriteTimers.delete(userId);

    const queued = this.stateWriteQueues.get(userId);
    if (!queued || !this.isConnected || !this.pool) return;
    this.stateWriteQueues.delete(userId);
    
    const { virtualBalance, activePositions, spikesToday } = queued;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_state (user_id, virtual_balance, active_positions, spikes_today, updated_at)
         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
         ON CONFLICT (user_id) DO UPDATE
         SET virtual_balance = $2, active_positions = $3, spikes_today = $4, updated_at = CURRENT_TIMESTAMP;`,
        [userId, virtualBalance, JSON.stringify(activePositions), spikesToday]
      );
    } catch (e: any) {
      console.error(`[Database] Gagal simpan state untuk user ${userId} ke DB:`, e.message);
    }
  }

  // --- TRADES PERSISTENCE ---
  public async saveTrade(t: ClosedTrade): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_trades (
           id, symbol, side, entry_price, exit_price, qty, margin_used, realized_pnl, pnl_pct, duration_seconds, exit_reason, is_paper, closed_at, timestamp, params_snapshot, layers_detail, fee, gross_pnl, layers_filled, post_exit_30m, highest_price, lowest_price, mfe_pct, mae_pct, price_change_24h_pct, user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
         ON CONFLICT (id) DO UPDATE SET 
           post_exit_30m = COALESCE(EXCLUDED.post_exit_30m, wicksniper_trades.post_exit_30m),
           highest_price = COALESCE(EXCLUDED.highest_price, wicksniper_trades.highest_price),
           lowest_price = COALESCE(EXCLUDED.lowest_price, wicksniper_trades.lowest_price),
           mfe_pct = COALESCE(EXCLUDED.mfe_pct, wicksniper_trades.mfe_pct),
           mae_pct = COALESCE(EXCLUDED.mae_pct, wicksniper_trades.mae_pct),
           price_change_24h_pct = COALESCE(EXCLUDED.price_change_24h_pct, wicksniper_trades.price_change_24h_pct),
           user_id = COALESCE(wicksniper_trades.user_id, EXCLUDED.user_id);`,
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
          t.paramsSnapshot ? JSON.stringify({ ...t.paramsSnapshot, ...(t.marketSnapshot ? { marketSnapshot: t.marketSnapshot } : {}) }) : (t.marketSnapshot ? JSON.stringify({ marketSnapshot: t.marketSnapshot }) : null),
          t.layersDetail ? JSON.stringify(t.layersDetail) : null,
          t.fee !== undefined ? t.fee : null,
          t.grossPnl !== undefined ? t.grossPnl : null,
          t.layersFilled || null,
          t.postExit30m ? JSON.stringify(t.postExit30m) : null,
          t.highestPrice !== undefined ? t.highestPrice : (t.paramsSnapshot?.highestPrice !== undefined ? parseFloat(t.paramsSnapshot.highestPrice) : null),
          t.lowestPrice !== undefined ? t.lowestPrice : (t.paramsSnapshot?.lowestPrice !== undefined ? parseFloat(t.paramsSnapshot.lowestPrice) : null),
          t.mfePct !== undefined ? t.mfePct : (t.paramsSnapshot?.mfePct !== undefined ? parseFloat(t.paramsSnapshot.mfePct) : null),
          t.maePct !== undefined ? t.maePct : (t.paramsSnapshot?.maePct !== undefined ? parseFloat(t.paramsSnapshot.maePct) : null),
          t.priceChange24hPct !== undefined && t.priceChange24hPct !== null ? t.priceChange24hPct : (t.paramsSnapshot?.priceChange24hPct !== undefined ? Number(t.paramsSnapshot.priceChange24hPct) : (t.marketSnapshot?.priceChange24hPct ?? null)),
          t.userId || 'admin',
        ]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan trade ke DB:', e.message);
    }
  }

  public async loadRecentTrades(limit: number = 50, isPaper?: boolean, userId?: string): Promise<ClosedTrade[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const conditions: string[] = [];
      const params: any[] = [limit];
      let valIdx = 2;
      if (isPaper !== undefined) {
        conditions.push(`is_paper = $${valIdx++}`);
        params.push(isPaper);
      }
      if (userId && userId !== 'ALL') {
        conditions.push(`user_id = $${valIdx++}`);
        params.push(userId);
      }
      const whereMode = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await this.pool.query(
        `SELECT id, symbol, side, entry_price AS "entryPrice", exit_price AS "exitPrice",
                qty, margin_used AS "marginUsed", realized_pnl AS "realizedPnl",
                pnl_pct AS "pnlPct", duration_seconds AS "durationSeconds",
                exit_reason AS "exitReason", is_paper AS "isPaper",
                closed_at AS "closedAt", timestamp,
                params_snapshot AS "paramsSnapshot",
                layers_detail AS "layersDetail",
                fee, gross_pnl AS "grossPnl", layers_filled AS "layersFilled",
                post_exit_30m AS "postExit30m",
                highest_price AS "highestPrice", lowest_price AS "lowestPrice",
                mfe_pct AS "mfePct", mae_pct AS "maePct",
                price_change_24h_pct AS "priceChange24hPct",
                user_id AS "userId"
         FROM wicksniper_trades
         ${whereMode}
         ORDER BY timestamp DESC
         LIMIT $1;`,
        params
      );
      return res.rows.map((r: any) => {
        const parsedSnap = typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || null;
        return {
          id: r.id,
          userId: r.userId || 'admin',
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
          strategyType: parsedSnap?.strategy || (parsedSnap?.smartMoneyFlowStatus ? 'SMART_MONEY' : undefined),
          smartMoneyFlowStatus: parsedSnap?.smartMoneyFlowStatus || null,
          slDescription: parsedSnap?.slDescription || null,
          targetTpPrice: parsedSnap?.targetTpPrice || undefined,
          targetTp2Price: parsedSnap?.targetTp2Price || undefined,
          hardSlPrice: parsedSnap?.hardSlPrice || undefined,
          highestPrice: r.highestPrice !== null && r.highestPrice !== undefined ? parseFloat(r.highestPrice) : (parsedSnap?.highestPrice !== undefined ? parseFloat(parsedSnap.highestPrice) : undefined),
          lowestPrice: r.lowestPrice !== null && r.lowestPrice !== undefined ? parseFloat(r.lowestPrice) : (parsedSnap?.lowestPrice !== undefined ? parseFloat(parsedSnap.lowestPrice) : undefined),
          mfePct: r.mfePct !== null && r.mfePct !== undefined ? parseFloat(r.mfePct) : (parsedSnap?.mfePct !== undefined ? parseFloat(parsedSnap.mfePct) : undefined),
          maePct: r.maePct !== null && r.maePct !== undefined ? parseFloat(r.maePct) : (parsedSnap?.maePct !== undefined ? parseFloat(parsedSnap.maePct) : undefined),
          entryReason: parsedSnap?.entryReason || parsedSnap?.signalReason || undefined,
          btcTrendStatus: parsedSnap?.btcTrendStatus || undefined,
          fundingRatePct: parsedSnap?.fundingRatePct !== undefined ? parseFloat(parsedSnap.fundingRatePct) : undefined,
          priceChange24hPct: r.priceChange24hPct !== null && r.priceChange24hPct !== undefined ? parseFloat(r.priceChange24hPct) : (parsedSnap?.priceChange24hPct !== undefined ? Number(parsedSnap.priceChange24hPct) : (parsedSnap?.marketSnapshot?.priceChange24hPct !== undefined ? Number(parsedSnap.marketSnapshot.priceChange24hPct) : undefined)),
          paramsSnapshot: parsedSnap,
          marketSnapshot: parsedSnap?.marketSnapshot || null,
          layersDetail: typeof r.layersDetail === 'string' ? JSON.parse(r.layersDetail) : r.layersDetail || null,
          postExit30m: typeof r.postExit30m === 'string' ? JSON.parse(r.postExit30m) : r.postExit30m || null,
        };
      });
    } catch (e: any) {
      console.error('[Database] Gagal load trades dari DB:', e.message);
      return [];
    }
  }

  public async updateTradePostExit(tradeId: string, postExit: any): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `UPDATE wicksniper_trades SET post_exit_30m = $1 WHERE id = $2;`,
        [JSON.stringify(postExit), tradeId]
      );
    } catch (e: any) {
      console.error('[Database] Gagal update post_exit_30m:', e.message);
    }
  }

  public async getTradeById(tradeId: string): Promise<ClosedTrade | null> {
    if (!this.isConnected || !this.pool) return null;
    try {
      const res = await this.pool.query(
        `SELECT id, symbol, side, entry_price AS "entryPrice", exit_price AS "exitPrice",
                qty, margin_used AS "marginUsed", realized_pnl AS "realizedPnl",
                pnl_pct AS "pnlPct", duration_seconds AS "durationSeconds",
                exit_reason AS "exitReason", is_paper AS "isPaper",
                closed_at AS "closedAt", timestamp,
                params_snapshot AS "paramsSnapshot",
                layers_detail AS "layersDetail",
                fee, gross_pnl AS "grossPnl", layers_filled AS "layersFilled",
                post_exit_30m AS "postExit30m",
                highest_price AS "highestPrice", lowest_price AS "lowestPrice",
                mfe_pct AS "mfePct", mae_pct AS "maePct",
                price_change_24h_pct AS "priceChange24hPct"
         FROM wicksniper_trades
         WHERE id = $1 LIMIT 1;`,
        [tradeId]
      );
      if (!res.rows || res.rows.length === 0) return null;
      const r = res.rows[0];
      const parsedSnap = typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || null;
      return {
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
        strategyType: parsedSnap?.strategy || (parsedSnap?.smartMoneyFlowStatus ? 'SMART_MONEY' : undefined),
        smartMoneyFlowStatus: parsedSnap?.smartMoneyFlowStatus || null,
        slDescription: parsedSnap?.slDescription || null,
        targetTpPrice: parsedSnap?.targetTpPrice || undefined,
        targetTp2Price: parsedSnap?.targetTp2Price || undefined,
        hardSlPrice: parsedSnap?.hardSlPrice || undefined,
        highestPrice: r.highestPrice !== null && r.highestPrice !== undefined ? parseFloat(r.highestPrice) : (parsedSnap?.highestPrice !== undefined ? parseFloat(parsedSnap.highestPrice) : undefined),
        lowestPrice: r.lowestPrice !== null && r.lowestPrice !== undefined ? parseFloat(r.lowestPrice) : (parsedSnap?.lowestPrice !== undefined ? parseFloat(parsedSnap.lowestPrice) : undefined),
        mfePct: r.mfePct !== null && r.mfePct !== undefined ? parseFloat(r.mfePct) : (parsedSnap?.mfePct !== undefined ? parseFloat(parsedSnap.mfePct) : undefined),
        maePct: r.maePct !== null && r.maePct !== undefined ? parseFloat(r.maePct) : (parsedSnap?.maePct !== undefined ? parseFloat(parsedSnap.maePct) : undefined),
        entryReason: parsedSnap?.entryReason || parsedSnap?.signalReason || undefined,
        btcTrendStatus: parsedSnap?.btcTrendStatus || undefined,
        fundingRatePct: parsedSnap?.fundingRatePct !== undefined ? parseFloat(parsedSnap.fundingRatePct) : undefined,
        priceChange24hPct: r.priceChange24hPct !== null && r.priceChange24hPct !== undefined ? parseFloat(r.priceChange24hPct) : (parsedSnap?.priceChange24hPct !== undefined ? Number(parsedSnap.priceChange24hPct) : (parsedSnap?.marketSnapshot?.priceChange24hPct !== undefined ? Number(parsedSnap.marketSnapshot.priceChange24hPct) : undefined)),
        paramsSnapshot: parsedSnap,
        marketSnapshot: parsedSnap?.marketSnapshot || null,
        layersDetail: typeof r.layersDetail === 'string' ? JSON.parse(r.layersDetail) : r.layersDetail || null,
        postExit30m: typeof r.postExit30m === 'string' ? JSON.parse(r.postExit30m) : r.postExit30m || null,
      };
    } catch (e: any) {
      console.error('[Database] Gagal getTradeById:', e.message);
      return null;
    }
  }

  public async getTradeStats(todayStartTs: number, isPaper?: boolean, userId?: string): Promise<{
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
      const conditions: string[] = [];
      const params: any[] = [todayStartTs];
      let valIdx = 2;
      if (isPaper !== undefined) {
        conditions.push(`is_paper = $${valIdx++}`);
        params.push(isPaper);
      }
      if (userId && userId !== 'ALL') {
        conditions.push(`user_id = $${valIdx++}`);
        params.push(userId);
      }
      const whereMode = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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

  public async getTradeDates(isPaper?: boolean, userId?: string): Promise<string[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let valIdx = 1;
      if (isPaper !== undefined) {
        conditions.push(`is_paper = $${valIdx++}`);
        params.push(isPaper);
      }
      if (userId && userId !== 'ALL') {
        conditions.push(`user_id = $${valIdx++}`);
        params.push(userId);
      }
      const whereMode = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await this.pool.query(
        `SELECT DISTINCT to_char(to_timestamp(timestamp / 1000) AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD') AS trade_date
         FROM wicksniper_trades
         ${whereMode}
         ORDER BY trade_date ASC;`,
        params
      );
      return res.rows.map((r: any) => r.trade_date).filter(Boolean);
    } catch (e: any) {
      console.error('[Database] Gagal getTradeDates:', e.message);
      return [];
    }
  }

  public async getTradesBetween(startTs: number, endTs: number, isPaper?: boolean, userId?: string): Promise<ClosedTrade[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const conditions: string[] = ['timestamp >= $1', 'timestamp <= $2'];
      const params: any[] = [startTs, endTs];
      let valIdx = 3;
      if (isPaper !== undefined) {
        conditions.push(`is_paper = $${valIdx++}`);
        params.push(isPaper);
      }
      if (userId && userId !== 'ALL') {
        conditions.push(`user_id = $${valIdx++}`);
        params.push(userId);
      }
      const whereClause = `WHERE ${conditions.join(' AND ')}`;
      const res = await this.pool.query(
        `SELECT id, symbol, side, entry_price AS "entryPrice", exit_price AS "exitPrice",
                qty, margin_used AS "marginUsed", realized_pnl AS "realizedPnl",
                pnl_pct AS "pnlPct", duration_seconds AS "durationSeconds",
                exit_reason AS "exitReason", is_paper AS "isPaper",
                closed_at AS "closedAt", timestamp,
                params_snapshot AS "paramsSnapshot",
                layers_detail AS "layersDetail",
                fee, gross_pnl AS "grossPnl", layers_filled AS "layersFilled",
                post_exit_30m AS "postExit30m",
                highest_price AS "highestPrice", lowest_price AS "lowestPrice",
                mfe_pct AS "mfePct", mae_pct AS "maePct",
                price_change_24h_pct AS "priceChange24hPct",
                user_id AS "userId"
         FROM wicksniper_trades
         ${whereClause}
         ORDER BY timestamp ASC;`,
        params
      );
      return res.rows.map((r: any) => {
        const parsedSnap = typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || null;
        return {
          id: r.id,
          userId: r.userId || 'admin',
          symbol: r.symbol,
          side: r.side,
          entryPrice: parseFloat(r.entryPrice),
          exitPrice: parseFloat(r.exitPrice),
          qty: parseFloat(r.qty),
          marginUsed: parseFloat(r.marginUsed),
          realizedPnl: parseFloat(r.realizedPnl),
          grossPnl: r.grossPnl != null ? parseFloat(r.grossPnl) : undefined,
          fee: r.fee != null ? parseFloat(r.fee) : undefined,
          pnlPct: parseFloat(r.pnlPct),
          durationSeconds: parseInt(r.durationSeconds, 10),
          exitReason: r.exitReason,
          isPaper: r.isPaper,
          closedAt: r.closedAt,
          timestamp: parseInt(r.timestamp, 10),
          layersFilled: r.layersFilled,
          paramsSnapshot: parsedSnap,
          layersDetail: typeof r.layersDetail === 'string' ? JSON.parse(r.layersDetail) : r.layersDetail || null,
        };
      });
    } catch (e: any) {
      console.error('[Database] Gagal getTradesBetween:', e.message);
      return [];
    }
  }

  public async getCoinPerformance(isPaper?: boolean, userId?: string): Promise<CoinPerformanceRecord[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let valIdx = 1;
      if (isPaper !== undefined) {
        conditions.push(`is_paper = $${valIdx++}`);
        params.push(isPaper);
      }
      if (userId && userId !== 'ALL') {
        conditions.push(`user_id = $${valIdx++}`);
        params.push(userId);
      }
      const whereMode = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await this.pool.query(
        `SELECT 
           symbol,
           COUNT(*)::int AS total_trades,
           COALESCE(SUM(CASE WHEN realized_pnl >= 0 THEN 1 ELSE 0 END), 0)::int AS win_trades,
           COALESCE(SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END), 0)::int AS loss_trades,
           COALESCE(SUM(realized_pnl), 0)::float AS total_pnl,
           COALESCE(SUM(fee), 0)::float AS total_fee,
           COALESCE(MAX(realized_pnl), 0)::float AS best_trade,
           COALESCE(MIN(realized_pnl), 0)::float AS worst_trade,
           COALESCE(AVG(duration_seconds), 0)::float AS avg_duration_seconds,
           MAX(timestamp)::bigint AS last_trade_timestamp
         FROM wicksniper_trades
         ${whereMode}
         GROUP BY symbol
         ORDER BY total_pnl DESC;`,
        params
      );

      return res.rows.map((r: any) => {
        const totalTrades = parseInt(r.total_trades, 10) || 0;
        const winTrades = parseInt(r.win_trades, 10) || 0;
        const lossTrades = parseInt(r.loss_trades, 10) || 0;
        const winRate = totalTrades > 0 ? Math.round((winTrades / totalTrades) * 1000) / 10 : 0;
        const totalPnl = Math.round((parseFloat(r.total_pnl) || 0) * 100) / 100;
        const totalFee = Math.round((parseFloat(r.total_fee) || 0) * 1000) / 1000;
        const bestTrade = Math.round((parseFloat(r.best_trade) || 0) * 100) / 100;
        const worstTrade = Math.round((parseFloat(r.worst_trade) || 0) * 100) / 100;
        const avgDurationSeconds = Math.round(parseFloat(r.avg_duration_seconds) || 0);
        const lastTradeTimestamp = parseInt(r.last_trade_timestamp, 10) || 0;

        let recommendation: 'WHITELIST_CANDIDATE' | 'NEUTRAL' | 'BLACKLIST_CANDIDATE' = 'NEUTRAL';
        if (totalTrades >= 2 && winRate >= 75 && totalPnl > 0) {
          recommendation = 'WHITELIST_CANDIDATE';
        } else if (totalTrades >= 2 && (winRate <= 40 || totalPnl < -2)) {
          recommendation = 'BLACKLIST_CANDIDATE';
        }

        return {
          symbol: r.symbol,
          totalTrades,
          winTrades,
          lossTrades,
          winRate,
          totalPnl,
          totalFee,
          bestTrade,
          worstTrade,
          avgDurationSeconds,
          lastTradeTimestamp,
          recommendation,
        };
      });
    } catch (e: any) {
      console.error('[Database] Gagal getCoinPerformance:', e.message);
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

  // --- SPIKES PERSISTENCE ---
  public async saveSpike(s: SpikeAlert): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_spikes (
           id, symbol, start_price, current_price, surge_pct, lookback_seconds, status, skip_reason, timestamp, params_snapshot, sim_result, user_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           skip_reason = EXCLUDED.skip_reason,
           params_snapshot = COALESCE(EXCLUDED.params_snapshot, wicksniper_spikes.params_snapshot),
           sim_result = COALESCE(EXCLUDED.sim_result, wicksniper_spikes.sim_result),
           user_id = COALESCE(EXCLUDED.user_id, wicksniper_spikes.user_id);`,
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
          s.paramsSnapshot ? JSON.stringify(s.paramsSnapshot) : null,
          s.simResult ? JSON.stringify(s.simResult) : null,
          s.userId || 'admin',
        ]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan spike ke DB:', e.message);
    }
  }

  public async updateSpikeSimResult(id: string, simResult: SpikeSimResult): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `UPDATE wicksniper_spikes SET sim_result = $1 WHERE id = $2;`,
        [JSON.stringify(simResult), id]
      );
    } catch (e: any) {
      console.error('[Database] Gagal update sim_result spike:', e.message);
    }
  }

  public async loadRecentSpikes(limit: number = 50, userId?: string): Promise<SpikeAlert[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const whereClause = userId ? `WHERE user_id = $2` : '';
      const params = userId ? [limit, userId] : [limit];
      const res = await this.pool.query(
        `SELECT id, symbol,
                start_price AS "startPrice",
                current_price AS "currentPrice",
                surge_pct AS "surgePct",
                lookback_seconds AS "lookbackSeconds",
                status, skip_reason AS "skipReason",
                timestamp,
                params_snapshot AS "paramsSnapshot",
                sim_result AS "simResult",
                user_id AS "userId"
         FROM wicksniper_spikes
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $1;`,
        params
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        userId: r.userId || undefined,
        symbol: r.symbol,
        startPrice: parseFloat(r.startPrice),
        currentPrice: parseFloat(r.currentPrice),
        surgePct: parseFloat(r.surgePct),
        lookbackSeconds: parseInt(r.lookbackSeconds, 10),
        status: r.status as SpikeAlert['status'],
        skipReason: r.skipReason || undefined,
        timestamp: parseInt(r.timestamp, 10),
        paramsSnapshot: typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || undefined,
        simResult: typeof r.simResult === 'string' ? JSON.parse(r.simResult) : r.simResult || undefined,
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
    strategy?: 'ALL' | 'SMART_MONEY' | 'WICK_SNIPER' | 'WICK_SNIPER_ANTI_MARTINGALE';
    userId?: string;
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

      if (options.userId && options.userId !== 'ALL') {
        conditions.push(`user_id = $${valIdx++}`);
        values.push(options.userId);
      }

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

      if (options.strategy === 'SMART_MONEY') {
        conditions.push(`(params_snapshot->>'strategy' = 'SMART_MONEY' OR (params_snapshot->>'strategy' IS NULL AND (params_snapshot->>'whaleAvgEntry' IS NOT NULL OR params_snapshot->>'whaleShortRatio' IS NOT NULL OR params_snapshot->>'whaleLongRatio' IS NOT NULL OR params_snapshot->'smartMoneyFlowStatus' IS NOT NULL)))`);
      } else if (options.strategy === 'WICK_SNIPER_ANTI_MARTINGALE') {
        conditions.push(`params_snapshot->>'strategy' = 'WICK_SNIPER_ANTI_MARTINGALE'`);
      } else if (options.strategy === 'WICK_SNIPER') {
        conditions.push(`((params_snapshot->>'strategy' IN ('WICK_SNIPER', 'EXHAUSTION_SNIPER')) OR (params_snapshot->>'strategy' IS NULL AND params_snapshot->>'whaleAvgEntry' IS NULL AND params_snapshot->>'whaleShortRatio' IS NULL AND params_snapshot->>'whaleLongRatio' IS NULL AND params_snapshot->'smartMoneyFlowStatus' IS NULL))`);
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
                fee, gross_pnl AS "grossPnl", layers_filled AS "layersFilled",
                post_exit_30m AS "postExit30m",
                highest_price AS "highestPrice", lowest_price AS "lowestPrice",
                mfe_pct AS "mfePct", mae_pct AS "maePct",
                price_change_24h_pct AS "priceChange24hPct",
                user_id AS "userId"
         FROM wicksniper_trades
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${valIdx++} OFFSET $${valIdx++};`,
        queryValues
      );

      const trades: ClosedTrade[] = res.rows.map((r: any) => {
        const parsedSnap = typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || null;
        return {
          id: r.id,
          userId: r.userId || 'admin',
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
          strategyType: parsedSnap?.strategy || (parsedSnap?.smartMoneyFlowStatus ? 'SMART_MONEY' : undefined),
          smartMoneyFlowStatus: parsedSnap?.smartMoneyFlowStatus || null,
          slDescription: parsedSnap?.slDescription || null,
          targetTpPrice: parsedSnap?.targetTpPrice || undefined,
          targetTp2Price: parsedSnap?.targetTp2Price || undefined,
          hardSlPrice: parsedSnap?.hardSlPrice || undefined,
          highestPrice: r.highestPrice !== null && r.highestPrice !== undefined ? parseFloat(r.highestPrice) : (parsedSnap?.highestPrice !== undefined ? parseFloat(parsedSnap.highestPrice) : undefined),
          lowestPrice: r.lowestPrice !== null && r.lowestPrice !== undefined ? parseFloat(r.lowestPrice) : (parsedSnap?.lowestPrice !== undefined ? parseFloat(parsedSnap.lowestPrice) : undefined),
          mfePct: r.mfePct !== null && r.mfePct !== undefined ? parseFloat(r.mfePct) : (parsedSnap?.mfePct !== undefined ? parseFloat(parsedSnap.mfePct) : undefined),
          maePct: r.maePct !== null && r.maePct !== undefined ? parseFloat(r.maePct) : (parsedSnap?.maePct !== undefined ? parseFloat(parsedSnap.maePct) : undefined),
          entryReason: parsedSnap?.entryReason || parsedSnap?.signalReason || undefined,
          btcTrendStatus: parsedSnap?.btcTrendStatus || undefined,
          fundingRatePct: parsedSnap?.fundingRatePct !== undefined ? parseFloat(parsedSnap.fundingRatePct) : undefined,
          priceChange24hPct: r.priceChange24hPct !== null && r.priceChange24hPct !== undefined ? parseFloat(r.priceChange24hPct) : (parsedSnap?.priceChange24hPct !== undefined ? Number(parsedSnap.priceChange24hPct) : (parsedSnap?.marketSnapshot?.priceChange24hPct !== undefined ? Number(parsedSnap.marketSnapshot.priceChange24hPct) : undefined)),
          paramsSnapshot: parsedSnap,
          marketSnapshot: parsedSnap?.marketSnapshot || null,
          layersDetail: typeof r.layersDetail === 'string' ? JSON.parse(r.layersDetail) : r.layersDetail || null,
          postExit30m: typeof r.postExit30m === 'string' ? JSON.parse(r.postExit30m) : r.postExit30m || null,
        };
      });

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
    userId?: string;
  }): Promise<{
    spikes: SpikeAlert[];
    total: number;
    page: number;
    totalPages: number;
    simStats: { totalSkipped: number; savedSlCount: number; missedTpCount: number; trackingCount: number; timeoutCount: number };
  }> {
    const page = Math.max(1, parseInt(String(options.page || 1), 10));
    const limit = Math.min(100, Math.max(5, parseInt(String(options.limit || 15), 10)));
    const offset = (page - 1) * limit;

    if (!this.isConnected || !this.pool) {
      return { spikes: [], total: 0, page, totalPages: 0, simStats: { totalSkipped: 0, savedSlCount: 0, missedTpCount: 0, trackingCount: 0, timeoutCount: 0 } };
    }

    try {
      const conditions: string[] = [];
      const values: any[] = [];
      let valIdx = 1;

      if (options.userId) {
        conditions.push(`user_id = $${valIdx++}`);
        values.push(options.userId);
      }

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
                timestamp,
                params_snapshot AS "paramsSnapshot",
                sim_result AS "simResult",
                user_id AS "userId"
         FROM wicksniper_spikes
         ${whereClause}
         ORDER BY timestamp DESC
         LIMIT $${valIdx++} OFFSET $${valIdx++};`,
        queryValues
      );

      const spikes: SpikeAlert[] = res.rows.map((r: any) => ({
        id: r.id,
        userId: r.userId || undefined,
        symbol: r.symbol,
        startPrice: parseFloat(r.startPrice),
        currentPrice: parseFloat(r.currentPrice),
        surgePct: parseFloat(r.surgePct),
        lookbackSeconds: parseInt(r.lookbackSeconds, 10),
        status: r.status as SpikeAlert['status'],
        skipReason: r.skipReason || undefined,
        timestamp: parseInt(r.timestamp, 10),
        paramsSnapshot: typeof r.paramsSnapshot === 'string' ? JSON.parse(r.paramsSnapshot) : r.paramsSnapshot || undefined,
        simResult: typeof r.simResult === 'string' ? JSON.parse(r.simResult) : r.simResult || undefined,
      }));

      let simStats = { totalSkipped: 0, savedSlCount: 0, missedTpCount: 0, trackingCount: 0, timeoutCount: 0 };
      try {
        const statsWhere = options.userId ? `WHERE user_id = $1` : '';
        const statsParams = options.userId ? [options.userId] : [];
        const statsRes = await this.pool.query(
          `SELECT 
             COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS total_skipped,
             COUNT(*) FILTER (WHERE status = 'SKIPPED' AND sim_result->>'outcome' = 'SAVED_SL')::int AS saved_sl,
             COUNT(*) FILTER (WHERE status = 'SKIPPED' AND sim_result->>'outcome' = 'MISSED_TP')::int AS missed_tp,
             COUNT(*) FILTER (WHERE status = 'SKIPPED' AND sim_result->>'outcome' = 'TRACKING')::int AS tracking,
             COUNT(*) FILTER (WHERE status = 'SKIPPED' AND sim_result->>'outcome' = 'TIMEOUT')::int AS timeout
           FROM wicksniper_spikes ${statsWhere};`,
          statsParams
        );
        if (statsRes.rows.length > 0) {
          const row = statsRes.rows[0];
          simStats = {
            totalSkipped: row.total_skipped || 0,
            savedSlCount: row.saved_sl || 0,
            missedTpCount: row.missed_tp || 0,
            trackingCount: row.tracking || 0,
            timeoutCount: row.timeout || 0,
          };
        }
      } catch {}

      return { spikes, total, page, totalPages, simStats };
    } catch (e: any) {
      console.error('[Database] Gagal query spikes:', e.message);
      return { spikes: [], total: 0, page, totalPages: 0, simStats: { totalSkipped: 0, savedSlCount: 0, missedTpCount: 0, trackingCount: 0, timeoutCount: 0 } };
    }
  }

  public async getSpikesCount(userId?: string): Promise<number> {
    if (!this.isConnected || !this.pool) return 0;
    try {
      const whereClause = userId ? `WHERE user_id = $1` : '';
      const params = userId ? [userId] : [];
      const res = await this.pool.query(`SELECT COUNT(*)::int AS total FROM wicksniper_spikes ${whereClause};`, params);
      return res.rows[0]?.total || 0;
    } catch (e: any) {
      return 0;
    }
  }

  public async saveTuningLog(record: TuningHistoryRecord): Promise<void> {
    const existingIdx = this.tuningLogsMemory.findIndex((l) => l.id === record.id);
    if (existingIdx !== -1) {
      this.tuningLogsMemory[existingIdx] = record;
    } else {
      this.tuningLogsMemory.unshift(record);
      if (this.tuningLogsMemory.length > 50) this.tuningLogsMemory.pop();
    }

    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_tuning_logs (id, proposal, previous_config, status, applied_at, created_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
         ON CONFLICT (id) DO UPDATE SET
           proposal = EXCLUDED.proposal,
           previous_config = EXCLUDED.previous_config,
           status = EXCLUDED.status,
           applied_at = COALESCE(EXCLUDED.applied_at, wicksniper_tuning_logs.applied_at);`,
        [
          record.id,
          JSON.stringify(record.proposal),
          JSON.stringify(record.previousConfigSnapshot),
          record.status,
          record.appliedAt ? new Date(record.appliedAt).toISOString() : null,
          record.createdAt || Date.now(),
        ]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan tuning log:', e.message);
    }
  }

  public async loadTuningLogs(limit: number = 20): Promise<TuningHistoryRecord[]> {
    if (!this.isConnected || !this.pool) {
      return this.tuningLogsMemory.slice(0, limit);
    }
    try {
      const res = await this.pool.query(
        `SELECT id, proposal, previous_config AS "previousConfig", status,
                EXTRACT(EPOCH FROM applied_at) * 1000 AS "appliedAt",
                EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
         FROM wicksniper_tuning_logs
         ORDER BY created_at DESC
         LIMIT $1;`,
        [limit]
      );
      if (res.rows.length === 0) return this.tuningLogsMemory.slice(0, limit);
      return res.rows.map((r: any) => ({
        id: r.id,
        proposal: typeof r.proposal === 'string' ? JSON.parse(r.proposal) : r.proposal,
        previousConfigSnapshot: typeof r.previousConfig === 'string' ? JSON.parse(r.previousConfig) : (r.previousConfig || {}),
        status: r.status,
        appliedAt: r.appliedAt ? parseInt(r.appliedAt, 10) : undefined,
        createdAt: parseInt(r.createdAt, 10),
      }));
    } catch (e: any) {
      console.error('[Database] Gagal load tuning logs:', e.message);
      return this.tuningLogsMemory.slice(0, limit);
    }
  }

  public async updateTuningStatus(id: string, status: string, appliedAt?: number): Promise<void> {
    const memItem = this.tuningLogsMemory.find((l) => l.id === id);
    if (memItem) {
      memItem.status = status as any;
      if (appliedAt !== undefined) memItem.appliedAt = appliedAt;
    }

    if (!this.isConnected || !this.pool) return;
    try {
      if (appliedAt !== undefined) {
        await this.pool.query(
          `UPDATE wicksniper_tuning_logs
           SET status = $1, applied_at = $2
           WHERE id = $3;`,
          [status, new Date(appliedAt).toISOString(), id]
        );
      } else {
        await this.pool.query(
          `UPDATE wicksniper_tuning_logs
           SET status = $1
           WHERE id = $2;`,
          [status, id]
        );
      }
    } catch (e: any) {
      console.error('[Database] Gagal update tuning status:', e.message);
    }
  }

  // --- DAILY SNAPSHOT PERSISTENCE ---
  public async saveDailySnapshot(s: DailySnapshot): Promise<void> {
    const idx = this.dailySnapshotsMemory.findIndex((m) => m.id === s.id);
    if (idx >= 0) {
      this.dailySnapshotsMemory[idx] = s;
    } else {
      this.dailySnapshotsMemory.unshift(s);
      if (this.dailySnapshotsMemory.length > 100) this.dailySnapshotsMemory.pop();
    }

    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_daily_snapshots (
          id, date, trading_mode, ending_balance, start_balance, daily_pnl,
          daily_pnl_pct, cumulative_pnl, total_trades, win_count, loss_count,
          win_rate, total_fee, gross_pnl, best_trade_symbol, best_trade_pnl,
          worst_trade_symbol, worst_trade_pnl, spikes_detected, strategy_breakdown,
          details, timestamp, user_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
        ) ON CONFLICT (id) DO UPDATE SET
          ending_balance = EXCLUDED.ending_balance,
          start_balance = EXCLUDED.start_balance,
          daily_pnl = EXCLUDED.daily_pnl,
          daily_pnl_pct = EXCLUDED.daily_pnl_pct,
          cumulative_pnl = EXCLUDED.cumulative_pnl,
          total_trades = EXCLUDED.total_trades,
          win_count = EXCLUDED.win_count,
          loss_count = EXCLUDED.loss_count,
          win_rate = EXCLUDED.win_rate,
          total_fee = EXCLUDED.total_fee,
          gross_pnl = EXCLUDED.gross_pnl,
          best_trade_symbol = EXCLUDED.best_trade_symbol,
          best_trade_pnl = EXCLUDED.best_trade_pnl,
          worst_trade_symbol = EXCLUDED.worst_trade_symbol,
          worst_trade_pnl = EXCLUDED.worst_trade_pnl,
          spikes_detected = EXCLUDED.spikes_detected,
          strategy_breakdown = EXCLUDED.strategy_breakdown,
          details = EXCLUDED.details,
          timestamp = EXCLUDED.timestamp,
          user_id = EXCLUDED.user_id;`,
        [
          s.id,
          s.date,
          s.tradingMode,
          s.endingBalance,
          s.startBalance ?? null,
          s.dailyPnl,
          s.dailyPnlPct,
          s.cumulativePnl,
          s.totalTrades,
          s.winCount,
          s.lossCount,
          s.winRate,
          s.totalFee ?? 0,
          s.grossPnl ?? 0,
          s.bestTradeSymbol ?? null,
          s.bestTradePnl ?? null,
          s.worstTradeSymbol ?? null,
          s.worstTradePnl ?? null,
          s.spikesDetected ?? 0,
          s.strategyBreakdown ? JSON.stringify(s.strategyBreakdown) : null,
          s.details ? JSON.stringify(s.details) : null,
          s.timestamp,
          s.userId || 'admin',
        ]
      );
    } catch (e: any) {
      console.error('[Database] Gagal simpan daily snapshot ke DB:', e.message);
    }
  }

  public async getDailySnapshots(limit: number = 30, tradingMode?: string, userId?: string): Promise<DailySnapshot[]> {
    if (!this.isConnected || !this.pool) {
      let filtered = this.dailySnapshotsMemory;
      if (tradingMode) filtered = filtered.filter((s) => s.tradingMode === tradingMode);
      if (userId && userId !== 'ALL') filtered = filtered.filter((s) => (s.userId || 'admin') === userId);
      return filtered.slice(0, limit);
    }
    try {
      const conditions: string[] = [];
      const params: any[] = [];
      let valIdx = 1;

      if (tradingMode) {
        conditions.push(`trading_mode = $${valIdx++}`);
        params.push(tradingMode);
      }
      if (userId && userId !== 'ALL') {
        conditions.push(`user_id = $${valIdx++}`);
        params.push(userId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      params.push(limit);

      const query = `
        SELECT id, date, trading_mode AS "tradingMode",
               ending_balance AS "endingBalance", start_balance AS "startBalance",
               daily_pnl AS "dailyPnl", daily_pnl_pct AS "dailyPnlPct",
               cumulative_pnl AS "cumulativePnl", total_trades AS "totalTrades",
               win_count AS "winCount", loss_count AS "lossCount", win_rate AS "winRate",
               total_fee AS "totalFee", gross_pnl AS "grossPnl",
               best_trade_symbol AS "bestTradeSymbol", best_trade_pnl AS "bestTradePnl",
               worst_trade_symbol AS "worstTradeSymbol", worst_trade_pnl AS "worstTradePnl",
               spikes_detected AS "spikesDetected", strategy_breakdown AS "strategyBreakdown",
               details, timestamp, user_id AS "userId", created_at AS "createdAt"
        FROM wicksniper_daily_snapshots
        ${whereClause}
        ORDER BY date DESC
        LIMIT $${valIdx};
      `;

      const res = await this.pool.query(query, params);
      if (res.rows.length === 0) {
        let filtered = this.dailySnapshotsMemory;
        if (tradingMode) filtered = filtered.filter((s) => s.tradingMode === tradingMode);
        if (userId && userId !== 'ALL') filtered = filtered.filter((s) => (s.userId || 'admin') === userId);
        return filtered.slice(0, limit);
      }
      return res.rows.map((r: any) => ({
        id: r.id,
        userId: r.userId || 'admin',
        date: r.date,
        tradingMode: r.tradingMode,
        endingBalance: parseFloat(r.endingBalance),
        startBalance: r.startBalance != null ? parseFloat(r.startBalance) : undefined,
        dailyPnl: parseFloat(r.dailyPnl),
        dailyPnlPct: parseFloat(r.dailyPnlPct),
        cumulativePnl: parseFloat(r.cumulativePnl),
        totalTrades: parseInt(r.totalTrades, 10),
        winCount: parseInt(r.winCount, 10),
        lossCount: parseInt(r.lossCount, 10),
        winRate: parseFloat(r.winRate),
        totalFee: r.totalFee != null ? parseFloat(r.totalFee) : 0,
        grossPnl: r.grossPnl != null ? parseFloat(r.grossPnl) : 0,
        bestTradeSymbol: r.bestTradeSymbol || undefined,
        bestTradePnl: r.bestTradePnl != null ? parseFloat(r.bestTradePnl) : undefined,
        worstTradeSymbol: r.worstTradeSymbol || undefined,
        worstTradePnl: r.worstTradePnl != null ? parseFloat(r.worstTradePnl) : undefined,
        spikesDetected: r.spikesDetected != null ? parseInt(r.spikesDetected, 10) : 0,
        strategyBreakdown: typeof r.strategyBreakdown === 'string' ? JSON.parse(r.strategyBreakdown) : (r.strategyBreakdown || undefined),
        details: typeof r.details === 'string' ? JSON.parse(r.details) : (r.details || undefined),
        timestamp: parseInt(r.timestamp, 10),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
      }));
    } catch (e: any) {
      console.error('[Database] Gagal load daily snapshots dari DB:', e.message);
      return this.dailySnapshotsMemory.slice(0, limit);
    }
  }

  // --- USER PERSISTENCE (R&D MULTI-USER) ---
  public async getUsers(): Promise<UserRecord[]> {
    if (!this.isConnected || !this.pool) return [];
    try {
      const res = await this.pool.query(
        `SELECT id, username, password_hash AS "passwordHash", role, display_name AS "displayName",
                status, config, virtual_balance AS "virtualBalance",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM wicksniper_users
         ORDER BY (CASE WHEN id = 'admin' THEN 0 ELSE 1 END), created_at ASC;`
      );
      return res.rows.map((r: any) => ({
        id: r.id,
        username: r.username,
        passwordHash: r.passwordHash,
        role: r.role,
        displayName: r.displayName,
        status: r.status,
        config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config,
        virtualBalance: parseFloat(r.virtualBalance || '1000'),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : new Date().toISOString(),
      }));
    } catch (e: any) {
      console.error('[Database] Gagal mengambil daftar user:', e.message);
      return [];
    }
  }

  public async getUserById(id: string): Promise<UserRecord | null> {
    if (!this.isConnected || !this.pool) return null;
    try {
      const res = await this.pool.query(
        `SELECT id, username, password_hash AS "passwordHash", role, display_name AS "displayName",
                status, config, virtual_balance AS "virtualBalance",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM wicksniper_users WHERE id = $1 LIMIT 1;`,
        [id]
      );
      if (res.rows.length === 0) return null;
      const r = res.rows[0];
      return {
        id: r.id,
        username: r.username,
        passwordHash: r.passwordHash,
        role: r.role,
        displayName: r.displayName,
        status: r.status,
        config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config,
        virtualBalance: parseFloat(r.virtualBalance || '1000'),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : new Date().toISOString(),
      };
    } catch (e: any) {
      console.error(`[Database] Gagal ambil user by id ${id}:`, e.message);
      return null;
    }
  }

  public async getUserByUsername(username: string): Promise<UserRecord | null> {
    if (!this.isConnected || !this.pool) return null;
    try {
      const res = await this.pool.query(
        `SELECT id, username, password_hash AS "passwordHash", role, display_name AS "displayName",
                status, config, virtual_balance AS "virtualBalance",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM wicksniper_users WHERE LOWER(username) = LOWER($1) LIMIT 1;`,
        [username]
      );
      if (res.rows.length === 0) return null;
      const r = res.rows[0];
      return {
        id: r.id,
        username: r.username,
        passwordHash: r.passwordHash,
        role: r.role,
        displayName: r.displayName,
        status: r.status,
        config: typeof r.config === 'string' ? JSON.parse(r.config) : r.config,
        virtualBalance: parseFloat(r.virtualBalance || '1000'),
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
        updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : new Date().toISOString(),
      };
    } catch (e: any) {
      console.error(`[Database] Gagal ambil user by username ${username}:`, e.message);
      return null;
    }
  }

  public async createUser(user: UserRecord): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO wicksniper_users (
           id, username, password_hash, role, display_name, status, config, virtual_balance, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (id) DO UPDATE SET
           username = EXCLUDED.username,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           config = EXCLUDED.config,
           virtual_balance = EXCLUDED.virtual_balance,
           updated_at = CURRENT_TIMESTAMP;`,
        [
          user.id,
          user.username,
          user.passwordHash,
          user.role || 'USER',
          user.displayName || user.username,
          user.status || 'ACTIVE',
          JSON.stringify(user.config),
          user.virtualBalance || 1000,
        ]
      );
    } catch (e: any) {
      console.error(`[Database] Gagal membuat user ${user.username}:`, e.message);
      throw e;
    }
  }

  public async updateUser(id: string, updates: Partial<UserRecord>): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    try {
      const setClauses: string[] = ['updated_at = CURRENT_TIMESTAMP'];
      const values: any[] = [id];
      let valIdx = 2;

      if (updates.displayName !== undefined) {
        setClauses.push(`display_name = $${valIdx++}`);
        values.push(updates.displayName);
      }
      if (updates.passwordHash !== undefined) {
        setClauses.push(`password_hash = $${valIdx++}`);
        values.push(updates.passwordHash);
      }
      if (updates.role !== undefined) {
        setClauses.push(`role = $${valIdx++}`);
        values.push(updates.role);
      }
      if (updates.status !== undefined) {
        setClauses.push(`status = $${valIdx++}`);
        values.push(updates.status);
      }
      if (updates.config !== undefined) {
        setClauses.push(`config = $${valIdx++}`);
        values.push(JSON.stringify(updates.config));
      }
      if (updates.virtualBalance !== undefined) {
        setClauses.push(`virtual_balance = $${valIdx++}`);
        values.push(updates.virtualBalance);
      }

      await this.pool.query(
        `UPDATE wicksniper_users SET ${setClauses.join(', ')} WHERE id = $1;`,
        values
      );
    } catch (e: any) {
      console.error(`[Database] Gagal update user ${id}:`, e.message);
      throw e;
    }
  }

  public async deleteUser(id: string): Promise<void> {
    if (!this.isConnected || !this.pool) return;
    if (id === 'admin') {
      throw new Error('Akun master admin tidak dapat dihapus');
    }
    try {
      await this.pool.query('DELETE FROM wicksniper_users WHERE id = $1;', [id]);
    } catch (e: any) {
      console.error(`[Database] Gagal menghapus user ${id}:`, e.message);
      throw e;
    }
  }

  public async getDailySnapshotByDate(date: string, tradingMode: string): Promise<DailySnapshot | null> {
    const list = await this.getDailySnapshots(10, tradingMode);
    return list.find((s) => s.date === date && s.tradingMode === tradingMode) || null;
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const db = new DatabaseService();
