import fs from 'fs';
import path from 'path';
import { ActivePosition, BotConfig, ClosedTrade, EngineStatus, GridLayer, SpikeAlert } from '../types';
import { binanceFutures } from './binance';
import { SpikeScanner } from './scanner';
import { logger } from './logger';
import { db } from './db';
import { telegram } from './telegram';
import { Candle } from './dataFetcher';
import { isBottomRejectionCandle } from './backtester';

export class WickSniperEngine {
  private config: BotConfig;
  private configPath: string;
  private isRunning: boolean = false;
  private scanner: SpikeScanner;
  private virtualBalance: number = 1000;
  private activePositions: Map<string, ActivePosition> = new Map();
  private deployingSymbols: Set<string> = new Set(); // Kunci slot konkurensi (Anti-Race Condition lonjakan bersamaan)
  private priceMomentum: Map<string, { price: number; time: number }[]> = new Map();
  private closingSymbols: Set<string> = new Set();
  private syncingTpSymbols: Set<string> = new Set();
  private orderAudit: Map<string, { lastEvent: string; lastTs: number; status: string }> = new Map();
  private closedTrades: ClosedTrade[] = [];
  private cachedDbStats: {
    totalTrades: number;
    totalWins: number;
    accumulatedPnl: number;
    winRate: number;
    dailyTrades: number;
    dailyWinsCount: number;
    dailyLossesCount: number;
    dailyWinRate: number;
    dailyPnl: number;
  } | null = null;
  private spikesDetectedToday: number = 0;
  private lastResetDateWib: string = '';
  private statusListeners: ((status: EngineStatus) => void)[] = [];
  private configListeners: ((config: BotConfig) => void)[] = [];
  private lastSyncedConfigJson: string = '';
  private tickInterval: NodeJS.Timeout | null = null;
  private realBalance: number = 0;
  private liveAvailableBalance: number = 0;
  private lastWeightWarnAt: number = 0;
  private lastHeartbeatAt: number = Date.now();
  private candle1mCache: Map<string, { open: number; openTime: number; fetchedAt: number }> = new Map();

  constructor(configPath: string) {
    this.configPath = configPath;
    this.config = this.loadConfig();
    this.virtualBalance = this.config.paperTrading?.initialVirtualBalance || 1000;
    this.scanner = new SpikeScanner(this.config.scanner);
    telegram.updateConfig(this.config.telegram);
    if (this.config.apiKey && this.config.apiSecret) {
      binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
    }
    this.initListeners();
    if (this.config.tradingMode === 'LIVE') {
      setTimeout(() => {
        this.syncLiveBalance().then(() => this.broadcastStatus()).catch(() => { });
      }, 1500);
    }
  }

  private loadConfig(): BotConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch (e: any) {
      console.error('Gagal memuat config:', e.message);
    }
    return {
      tradingMode: 'PAPER',
      apiKey: '',
      apiSecret: '',
      isTestnet: false,
      leverage: 5,
      marginType: 'CROSSED',
      scanner: {
        enabled: true,
        spikeLookbackSeconds: 20,
        spikeMinPercent: 2.0,
        volumeSpikeMultiplier: 2.0,
        minPriceUsdt: 0.005,
        maxPriceUsdt: 2000,
        excludeSymbols: ['USDCUSDT', 'FDUSDUSDT', 'BTCUSDT', 'ETHUSDT'],
        cooldownMinutes: 20,
        pollingIntervalMs: 1000,
        upperWickPullbackEnabled: false,
        upperWickPullbackMinPct: 0.3,
        upperWickPullbackMaxWaitSeconds: 5,
        min24hVolumeUsdt: 1500000,
        maxSpreadPct: 0.25,
      },
      grid: {
        maxConcurrentCoins: 2,
        totalLayers: 25,
        layerSpacingPct: 1.2,
        marginPerLayerUsdt: 3.0,
        martingaleMultiplier: 1.1,
        maxTotalMarginPerCoin: 50.0,
      },
      exit: {
        takeProfitPct: 1.2,
        trailingTpEnabled: false,
        trailingCallbackPct: 0.4,
        hardStopLossPct: 4.5,
        trailingSlEnabled: false,
        trailingSlMaxReturnRatio: 2.5,
        trailingSlTiers: [
          { filledLayerMin: 0, percentOfBase: 1.0 },
          { filledLayerMin: 1, percentOfBase: 0.8 },
          { filledLayerMin: 3, percentOfBase: 0.6 },
          { filledLayerMin: 5, percentOfBase: 0.3 },
        ],
        maxHoldMinutes: 60,
        earlyExitMomentumEnabled: false,
        earlyExitMinBullishCandles: 3,
        earlyExitMinRisePct: 0.5,
        earlyExitCooldownMinutes: 60,
        hardStopCooldownMinutes: 180,
        partialTpEnabled: false,
        partialTpRatio: 0.5,
        bepDefenseEnabled: true,
        bepMaxLayersTrigger: 0,
        bepFastFillEnabled: true,
        bepFastFillSeconds: 120,
        bepFastFillMinLayers: 0,
        bepBufferPct: 0.08,
        bepCooldownMinutes: 15,
        extendHoldOnRedCandleEnabled: true,
        extendHoldSeconds: 30,
        maxHoldExtensions: 6,
      },
      paperTrading: {
        initialVirtualBalance: 245.0,
      },
      telegram: {
        enabled: false,
        botToken: '',
        chatId: '',
        notifyOnNewOrder: true,
        notifyOnLayerFill: false,
        notifyOnClose: true,
      },
      security: {
        password: 'admin123',
      },
      server: {
        port: 3005,
      },
    };
  }

  public async saveConfig(newConfig: Partial<BotConfig>): Promise<BotConfig> {
    const oldBalance = this.config.paperTrading?.initialVirtualBalance;
    this.config = {
      ...this.config,
      ...newConfig,
      exit: { ...this.config.exit, ...(newConfig.exit || {}) },
      scanner: { ...this.config.scanner, ...(newConfig.scanner || {}) },
      grid: { ...this.config.grid, ...(newConfig.grid || {}) },
      telegram: { ...this.config.telegram, ...(newConfig.telegram || {}) },
      security: { ...this.config.security, ...(newConfig.security || {}) },
    };
    this.scanner.updateConfig(this.config.scanner);
    if (this.config.telegram) {
      telegram.updateConfig(this.config.telegram);
    }
    if (this.isRunning) {
      binanceFutures.startTickerWebSocket(this.config.scanner.dataSource, this.config.scanner.pollingIntervalMs).catch(() => {});
    }
    if (this.config.apiKey && this.config.apiSecret) {
      binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
    }
    if (
      newConfig.paperTrading?.initialVirtualBalance !== undefined &&
      newConfig.paperTrading.initialVirtualBalance !== oldBalance
    ) {
      this.virtualBalance = newConfig.paperTrading.initialVirtualBalance;
      await db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });
      logger.log('INFO', `💰 Saldo Paper Trading disesuaikan ke $${this.virtualBalance.toFixed(2)} USDT.`);
    }
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
      logger.log('INFO', '⚙️ Konfigurasi Wick Sniper berhasil diperbarui.');
    } catch (e: any) {
      logger.log('ERROR', `Gagal menyimpan konfigurasi: ${e.message}`);
    }
    await db.saveConfig(this.config).catch(() => { });
    const reloadedDb = await db.loadConfig().catch(() => null);
    this.lastSyncedConfigJson = reloadedDb ? JSON.stringify(reloadedDb) : JSON.stringify(this.config);
    if (this.config.tradingMode === 'LIVE') {
      binanceFutures.startUserDataStream().catch(() => {});
      this.syncLiveBalance().then(() => this.broadcastStatus()).catch(() => { });
    }
    this.broadcastConfig();
    this.broadcastStatus();
    return this.config;
  }

  public getConfig(): BotConfig {
    return this.config;
  }

  private initListeners() {
    this.scanner.onSpike((alert: SpikeAlert) => {
      this.handleSpikeAlert(alert);
    });

    binanceFutures.onTickers((tickers: any[]) => {
      this.onPriceTick(tickers);
    });

    binanceFutures.onOrderTradeUpdate((order: any) => {
      this.handleUserOrderTradeUpdate(order).catch((err: any) => {
        logger.log('ERROR', `❌ [USER DATA STREAM HANDLER ERROR] ${err?.message || err}`);
      });
    });
  }

  private auditOrderEvent(symbol: string, event: string, details: Record<string, any> = {}) {
    const payload = {
      event,
      ts: Date.now(),
      ...details,
    };
    this.orderAudit.set(symbol, {
      lastEvent: event,
      lastTs: payload.ts,
      status: details.status || 'OK',
    });

    const compactSummary = Object.entries(payload)
      .filter(([key]) => key !== 'event' && key !== 'ts')
      .map(([key, value]) => {
        const rendered = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return `${key}=${rendered}`;
      })
      .join(' | ');

    logger.log('INFO', `🧾 [ORDER AUDIT] ${symbol} | ${event} | ${compactSummary || 'status=OK'}`, symbol);
  }

  private auditTradeLifecycle(symbol: string, phase: 'OPEN_SHORT_REQUESTED' | 'OPEN_SHORT_CONFIRMED' | 'GRID_LAYER_PLACED' | 'TP_LIMIT_PLACED' | 'PARTIAL_CLOSE_REQUESTED' | 'PARTIAL_CLOSE_CONFIRMED' | 'FULL_CLOSE_REQUESTED' | 'FULL_CLOSE_CONFIRMED' | 'DB_TRADE_FINALIZED' | 'TRAILING_SL_UPDATED', details: Record<string, any> = {}) {
    this.auditOrderEvent(symbol, phase, details);
  }

  public async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    await db.init();
    if (db.isConnected) {
      const dbCfg = await db.loadConfig();
      if (dbCfg) {
        this.config = {
          ...this.config,
          ...dbCfg,
          exit: { ...this.config.exit, ...(dbCfg.exit || {}) },
          scanner: { ...this.config.scanner, ...(dbCfg.scanner || {}) },
          grid: { ...this.config.grid, ...(dbCfg.grid || {}) },
          telegram: { ...this.config.telegram, ...(dbCfg.telegram || {}) },
          security: { ...this.config.security, ...(dbCfg.security || {}) },
        };
        this.scanner.updateConfig(this.config.scanner);
        if (this.config.telegram) {
          telegram.updateConfig(this.config.telegram);
        }
        this.lastSyncedConfigJson = JSON.stringify(dbCfg);
        if (this.config.apiKey && this.config.apiSecret) {
          binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
        }
      } else {
        await db.saveConfig(this.config);
        this.lastSyncedConfigJson = JSON.stringify(this.config);
      }
      const dbState = await db.loadState();
      if (dbState) {
        this.virtualBalance = dbState.virtualBalance;
        this.spikesDetectedToday = dbState.spikesToday || 0;
        if (dbState.activePositions && dbState.activePositions.length > 0) {
          for (const pos of dbState.activePositions) {
            this.activePositions.set(pos.symbol, pos);
          }
        }
      }
      await this.syncTradesFromDb();
      const dbSpikes = await db.loadRecentSpikes(50);
      if (dbSpikes.length > 0) {
        this.scanner.setRecentSpikes(dbSpikes);
        logger.log('INFO', `📡 [DATABASE] ${dbSpikes.length} riwayat spike dimuat dari PostgreSQL.`);
      }
    }

    logger.log('SUCCESS', `🚀 [WICK SNIPER ENGINE AKTIF] Mode: ${this.config.tradingMode} | Leverage: ${this.config.leverage}x`);
    logger.log('INFO', `🎯 Target Spike: >= +${this.config.scanner.spikeMinPercent}% dalam ${this.config.scanner.spikeLookbackSeconds}s | TP: ${this.config.exit.takeProfitPct}% | Hard SL: ${this.config.exit.hardStopLossPct}%`);

    await binanceFutures.syncTime();
    await binanceFutures.loadExchangeInfo();
    await binanceFutures.startTickerWebSocket(this.config.scanner.dataSource, this.config.scanner.pollingIntervalMs);
    this.scanner.start();

    // Pulihkan status cooldown koin dari riwayat trade terakhir di database agar tidak hilang saat restart
    try {
      const recentTrades = await db.loadRecentTrades(30);
      const now = Date.now();
      for (const t of recentTrades) {
        if (!t.symbol || !t.timestamp) continue;
        const cooldownMins =
          t.exitReason === 'EARLY_MOMENTUM_EXIT'
            ? this.config.exit.earlyExitCooldownMinutes || 60
            : t.exitReason === 'HARD_STOP_LOSS'
              ? this.config.exit.hardStopCooldownMinutes || 180
              : t.exitReason === 'BEP_DEFENSE'
                ? this.config.exit.bepCooldownMinutes || 15
                : this.config.scanner.cooldownMinutes || 10;
        const expiry = t.timestamp + cooldownMins * 60 * 1000;
        if (expiry > now) {
          const remainingMinutes = Math.ceil((expiry - now) / 60000);
          this.scanner.setCooldown(t.symbol, remainingMinutes);
          logger.log(
            'INFO',
            `⏳ [COOLDOWN DIPULIHKAN] ${t.symbol} masih dalam cooldown (${remainingMinutes}m tersisa sampai ${new Date(expiry).toLocaleTimeString('id-ID')}).`,
            t.symbol
          );
        }
      }
    } catch (e: any) {
      console.warn('Gagal memulihkan cooldown trade sebelumnya:', e.message);
    }

    if (this.config.tradingMode === 'LIVE') {
      await binanceFutures.checkPositionMode();
      await binanceFutures.startUserDataStream().catch((e: any) => {
        logger.log('WARN', `⚠️ [USER STREAM START FAILED] ${e.message}`);
      });
      await this.syncLivePositions();
      await this.syncLiveBalance();
    }

    // Heartbeat ticker, time-limit check tiap 1 detik, sync live position tiap 5s, & sinkronisasi DB tiap 5 detik
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    let tickCount = 0;
    this.tickInterval = setInterval(async () => {
        this.checkDailyReset();
        await this.checkTimeLimitsAndTrailing();
        this.broadcastStatus();
        tickCount++;
        // Relaksasi interval sync posisi dan balance ke 5 detik (dari 3 detik) untuk menghemat kuota REST
        if (tickCount % 5 === 0 && this.config.tradingMode === 'LIVE') {
          await this.syncLivePositions();
          await this.syncLiveBalance();
        }
        if (tickCount % 5 === 0) {
          await this.syncConfigFromDb();
          await this.syncTradesFromDb();
        }

        // Heartbeat Telegram Berkala (Laporan Status Rutin)
        const hbHours = this.config.telegram?.heartbeatIntervalHours ?? 6;
        if (hbHours > 0 && Date.now() - this.lastHeartbeatAt >= hbHours * 3600 * 1000) {
          this.lastHeartbeatAt = Date.now();
          this.sendHeartbeatReport().catch(() => {});
        }

        // Peringatan Kuota API (Weight): Hanya muncul jika pemakaian kuota sudah >= 80% agar terminal tetap bersih
        const currentWeight = binanceFutures.lastUsedWeight;
        const ord10s = binanceFutures.getOrderCount10s();
        const weightPct = Math.round((currentWeight / 2400) * 100);
        const ordPct = Math.round((ord10s / 300) * 100);

        if ((weightPct >= 80 || ordPct >= 80) && (!this.lastWeightWarnAt || Date.now() - this.lastWeightWarnAt > 20000)) {
          this.lastWeightWarnAt = Date.now();
          logger.log(
            'WARN',
            `⚠️ [API WEIGHT ALERT] Pemakaian kuota API Binance tinggi: REST ${currentWeight}/2400 (${weightPct}%) | Orders 10s: ${ord10s}/300 (${ordPct}%)!`
          );
        }
        // Jika bot dihentikan dan semua posisi sudah tertutup, bersihkan interval
        if (!this.isRunning && this.activePositions.size === 0 && this.tickInterval) {
          clearInterval(this.tickInterval);
          this.tickInterval = null;
        }
      }, 1000);
  }

  public stop() {
    this.isRunning = false;
    logger.log('WARN', '🛑 Wick Sniper Engine dinonaktifkan (Tidak akan membuka trade baru).');
    if (this.activePositions.size > 0) {
      logger.log('INFO', `🛡️ Masih terdapat ${this.activePositions.size} posisi aktif. Bot tetap mengawal TP/SL hingga semua posisi selesai ditutup.`);
    } else {
      if (this.tickInterval) {
        clearInterval(this.tickInterval);
        this.tickInterval = null;
      }
    }
    this.broadcastStatus();
  }

  /**
   * Menangani Spike Lonjakan Harga yang baru saja dideteksi Scanner
   */
  private async handleSpikeAlert(alert: SpikeAlert) {
    if (!this.isRunning) return;
    this.spikesDetectedToday++;

    const symbol = alert.symbol;

    // Proteksi lapis ganda: Cek apakah koin masih dalam masa cooldown
    if (this.scanner.isCoolingDown(symbol)) {
      alert.status = 'SKIPPED';
      alert.skipReason = `Koin ${symbol} masih dalam masa jeda cooldown antar trade`;
      logger.log('INFO', `⏳ [COOLDOWN SKIP] Lonjakan pada ${symbol} diabaikan karena masih dalam masa cooldown.`, symbol);
      db.saveSpike(alert).catch(() => { });
      return;
    }

    // Proteksi Circuit Breaker (Rem Kerugian Harian Maksimal)
    const maxDailyLoss = this.config.risk?.maxDailyLossUsdt ?? 0;
    if (maxDailyLoss > 0) {
      const todayStartTs = this.getStartOfDayWibTimestamp();
      const currentDailyPnl = this.cachedDbStats
        ? this.cachedDbStats.dailyPnl
        : Math.round(this.closedTrades.filter(t => t.timestamp >= todayStartTs).reduce((acc, t) => acc + t.realizedPnl, 0) * 100) / 100;

      if (currentDailyPnl <= -Math.abs(maxDailyLoss)) {
        alert.status = 'SKIPPED';
        alert.skipReason = `Circuit Breaker: Rugi harian ($${currentDailyPnl.toFixed(2)}) mencapai batas maks (-$${maxDailyLoss})`;
        logger.log(
          'WARN',
          `🛑 [CIRCUIT BREAKER] Penembakan spike ${symbol} dibatalkan! Rugi hari ini: $${currentDailyPnl.toFixed(2)} USDT <= -$${maxDailyLoss} USDT.`,
          symbol
        );
        telegram.notifyEmergencyAlert(
          'Circuit Breaker Harian Terpicu 🛑',
          `Akumulasi kerugian hari ini mencapai $${currentDailyPnl.toFixed(2)} USDT (Batas Maksimal: -$${maxDailyLoss} USDT).\n\nBot otomatis menghentikan penembakan koin baru sampai 00:00 WIB demi mengamankan sisa modal Anda.`,
          symbol
        );
        db.saveSpike(alert).catch(() => {});
        return;
      }
    }

    // Proteksi Batas Saldo Bebas Minimal (Min Safety Balance Floor)
    const minSafetyBalance = this.config.risk?.minSafetyBalanceUsdt ?? 0;
    if (this.config.tradingMode === 'LIVE' && minSafetyBalance > 0 && this.liveAvailableBalance > 0) {
      if (this.liveAvailableBalance < minSafetyBalance) {
        alert.status = 'SKIPPED';
        alert.skipReason = `Saldo bebas ($${this.liveAvailableBalance.toFixed(2)}) di bawah batas aman ($${minSafetyBalance})`;
        logger.log(
          'WARN',
          `🛡️ [MIN BALANCE SKIP] Saldo bebas ($${this.liveAvailableBalance.toFixed(2)} USDT) kurang dari batas aman ($${minSafetyBalance} USDT). Lonjakan ${symbol} dilewati.`,
          symbol
        );
        telegram.notifyEmergencyAlert(
          'Saldo Bebas di Bawah Batas Aman 🛡️',
          `Saldo bebas saat ini $${this.liveAvailableBalance.toFixed(2)} USDT kurang dari batas aman ($${minSafetyBalance} USDT).\n\nPenembakan spike dibatalkan agar tidak membuka posisi tanpa jaring pengaman.`,
          symbol
        );
        db.saveSpike(alert).catch(() => {});
        return;
      }
    }

    // Proteksi Lapis 1 (SYNCHRONOUS ATOMIC LOCK):
    // Cek kuota posisi aktif + order yang SEDANG dalam proses penembakan jaringan
    const maxCoins = this.config.grid.maxConcurrentCoins;
    const currentActiveAndDeploying = this.activePositions.size + this.deployingSymbols.size;
    if (currentActiveAndDeploying >= maxCoins) {
      alert.status = 'SKIPPED';
      alert.skipReason = `Maksimal posisi aktif (${maxCoins}) tercapai`;
      logger.log('WARN', `⚡ Spike terdeteksi pada ${symbol} (+${alert.surgePct}%), namun dilewati: Kuota koin penuh (${currentActiveAndDeploying}/${maxCoins}).`);
      db.saveSpike(alert).catch(() => { });
      return;
    }

    // Cek apakah koin ini sudah aktif atau sedang dalam proses penembakan
    if (this.activePositions.has(symbol) || this.deployingSymbols.has(symbol)) {
      alert.status = 'SKIPPED';
      alert.skipReason = `Sudah ada posisi aktif atau order sedang diproses pada ${symbol}`;
      db.saveSpike(alert).catch(() => { });
      return;
    }

    // KUNCI SLOT SEKETIKA SECARA SYNCHRONOUS SEBELUM ANY AWAIT BERJALAN!
    // Ini menghentikan koin lain yang spike di milidetik yang sama agar tidak menembus batas kuota.
    this.deployingSymbols.add(symbol);

    try {
      // Cek kuota aktual di Binance (untuk mode LIVE)
      if (this.config.tradingMode === 'LIVE') {
        try {
          const livePositions = await binanceFutures.getAllOpenPositions();
          const effectiveLiveCount = Math.max(this.activePositions.size, livePositions.length) + (this.deployingSymbols.size - 1);
          if (effectiveLiveCount >= maxCoins) {
            alert.status = 'SKIPPED';
            alert.skipReason = `Maksimal posisi aktif di Binance (${maxCoins}) tercapai`;
            logger.log('WARN', `⚡ Spike pada ${symbol} dilewati: Kuota Binance aktual penuh (${effectiveLiveCount}/${maxCoins}).`);
            db.saveSpike(alert).catch(() => { });
            return;
          }

          const livePos = await binanceFutures.getOpenPosition(symbol);
          if (livePos && Math.abs(livePos.positionAmt) > 0) {
            alert.status = 'SKIPPED';
            alert.skipReason = `Posisi aktif sudah ada di Binance pada ${symbol} (Qty: ${Math.abs(livePos.positionAmt)})`;
            logger.log('WARN', `⚠️ [SKIP ORDER BARU] ${symbol} sudah punya posisi aktif di Binance.`);
            db.saveSpike(alert).catch(() => { });
            return;
          }
        } catch (e: any) {
          logger.log('WARN', `⚠️ [CHECK LIVE POSISI] Gagal mengecek posisi aktif Binance ${symbol}: ${e.message}`);
        }
      }

      // Filter Penolakan Bawah Ekstrem (Bottom Rejection / Sweep) secepat kilat (Non-blocking fail-open)
      if (this.config.scanner?.skipBottomRejectionEnabled) {
        try {
          const client = await binanceFutures.getHttpClient();
          const klineRes = await client.get('/fapi/v1/klines', {
            params: { symbol, interval: '1m', limit: 2 },
            timeout: 700,
          });
          if (Array.isArray(klineRes.data) && klineRes.data.length >= 2) {
            const k = klineRes.data[klineRes.data.length - 2];
            const prevCandle: Candle = {
              openTime: k[0],
              open: parseFloat(k[1]),
              high: parseFloat(k[2]),
              low: parseFloat(k[3]),
              close: parseFloat(k[4]),
              volume: parseFloat(k[5]),
              closeTime: k[6],
              tradesCount: k[8] ? parseInt(k[8]) : 0,
            };

            const minRange = this.config.scanner.bottomRejectionMinRangePct ?? 1.5;
            const wickRatio = this.config.scanner.bottomRejectionWickRatio ?? 2.0;

            if (isBottomRejectionCandle(prevCandle, minRange, wickRatio, 1.0)) {
              const rangePct = (((prevCandle.high - prevCandle.low) / prevCandle.low) * 100).toFixed(1);
              alert.status = 'SKIPPED';
              alert.skipReason = `Candle 1m sebelumnya Bottom Rejection / Sweep ekstrem (Rentang: ${rangePct}%)`;
              const sweepCooldownMins = this.config.scanner.cooldownMinutes || 10;
              this.scanner.setCooldown(symbol, sweepCooldownMins);
              logger.log(
                'INFO',
                `🛡️ [BOTTOM REJECTION FILTER] Lonjakan ${symbol} dilewati: Terdeteksi liquidity sweep bawah ekstrem pada candle 1m sebelumnya (Rentang: ${rangePct}%). Diistirahatkan ${sweepCooldownMins}m.`,
                symbol
              );
              db.saveSpike(alert).catch(() => { });
              return;
            }
          }
        } catch (e: any) {
          logger.log('INFO', `[BOTTOM REJECTION FILTER] Lewati cek kline cepat ${symbol}: ${e.message}`);
        }
      }

      // Filter Konfirmasi Ekor Atas / Pullback Mikro (Mencegah Monster Pump Runaway)
      let confirmedEntryPrice = alert.currentPrice;
      if (this.config.scanner?.upperWickPullbackEnabled) {
        const minPullbackPct = this.config.scanner.upperWickPullbackMinPct ?? 0.3;
        const maxWaitSec = this.config.scanner.upperWickPullbackMaxWaitSeconds ?? 5;
        const deadline = Date.now() + maxWaitSec * 1000;
        let peakPrice = alert.currentPrice;
        let isConfirmed = false;
        let pullbackTicks = 0;

        logger.log(
          'INFO',
          `⏳ [UPPER WICK WAIT] ${symbol}: Menunggu konfirmasi ekor atas (pullback min ${minPullbackPct}% dari puncak) maks ${maxWaitSec}s...`,
          symbol
        );

        while (Date.now() < deadline) {
          const livePrice = this.scanner.getCurrentPrice(symbol);
          if (livePrice > peakPrice) {
            peakPrice = livePrice; // Pompa masih berlangsung, perbarui puncak
            pullbackTicks = 0;
          } else if (livePrice > 0 && livePrice <= peakPrice * (1 - minPullbackPct / 100)) {
            pullbackTicks++;
            // Tunggu konfirmasi bertahan setidaknya 2 tick polling (~300ms) untuk memastikan bukan noise/flick sesaat
            if (pullbackTicks >= 2) {
              const actualPullbackPct = (((peakPrice - livePrice) / peakPrice) * 100).toFixed(2);
              isConfirmed = true;
              confirmedEntryPrice = livePrice;
              logger.log(
                'SNIPER',
                `🎯 [UPPER WICK CONFIRMED] ${symbol}: Terkonfirmasi pantulan ekor atas stabil! Puncak $${peakPrice.toFixed(4)} → Reversal $${livePrice.toFixed(4)} (-${actualPullbackPct}%). Menembakkan jaring SHORT...`,
                symbol
              );
              break;
            }
          } else {
            pullbackTicks = 0;
          }
          await new Promise((r) => setTimeout(r, 150));
        }

        if (!isConfirmed) {
          alert.status = 'SKIPPED';
          alert.skipReason = `Monster Pump / Runaway: Tidak ada konfirmasi ekor atas (-${minPullbackPct}%) dalam ${maxWaitSec}s`;
          const runawayCooldownMins = this.config.scanner.upperWickCooldownMinutes ?? this.config.scanner.cooldownMinutes ?? 10;
          this.scanner.setCooldown(symbol, runawayCooldownMins);
          logger.log(
            'WARN',
            `🛡️ [UPPER WICK FILTER] Lonjakan ${symbol} dilewati: Harga terus melaju tanpa pullback ${minPullbackPct}% dalam ${maxWaitSec}s. Saldo aman dari monster pump (cooldown ${runawayCooldownMins}m).`,
            symbol
          );
          db.saveSpike(alert).catch(() => { });
          return;
        }
      }

      // Proteksi Spread Guard: Cek apakah selisih Ask - Bid terlalu renggang (likuiditas tipis/orderbook kosong)
      if (this.config.tradingMode === 'LIVE' && this.config.scanner?.maxSpreadPct && this.config.scanner.maxSpreadPct > 0) {
        try {
          const spreadInfo = await binanceFutures.getOrderbookSpread(symbol);
          if (spreadInfo && spreadInfo.spreadPct > this.config.scanner.maxSpreadPct) {
            alert.status = 'SKIPPED';
            alert.skipReason = `Spread Bid-Ask terlalu lebar (${spreadInfo.spreadPct.toFixed(2)}% > maks ${this.config.scanner.maxSpreadPct}%)`;
            const spreadCooldownMins = Math.min(this.config.scanner.cooldownMinutes || 5, 5);
            this.scanner.setCooldown(symbol, spreadCooldownMins);
            logger.log(
              'WARN',
              `🛡️ [SPREAD GUARD] ${symbol} dilewati: Spread pasar terlalu lebar (${spreadInfo.spreadPct.toFixed(2)}% > maks ${this.config.scanner.maxSpreadPct}%). Orderbook tipis, aman dari jebakan slippage (cooldown ${spreadCooldownMins}m).`,
              symbol
            );
            db.saveSpike(alert).catch(() => {});
            return;
          }
        } catch {}
      }

      alert.status = 'EXECUTING';
      logger.log('SNIPER', `🚨 [SPONGE SPIKE DETECTED] ${symbol} melonjak +${alert.surgePct}% dalam ${alert.lookbackSeconds}s! Menembakkan Jaring SHORT bertingkat...`, symbol);
      db.saveSpike(alert).catch(() => { });

      await this.deployGridLadder(symbol, confirmedEntryPrice, alert.surgePct, alert.lookbackSeconds);
    } finally {
      // Lepaskan kunci konkurensi (slot kini sudah resmi tercatat di this.activePositions atau dibatalkan)
      this.deployingSymbols.delete(symbol);
    }
  }

  /**
   * Membuat dan menembakkan Jaring Order SHORT bertingkat
   */
  private async deployGridLadder(
    symbol: string,
    currentPrice: number,
    surgePct: number = 0,
    lookbackSeconds: number = 20
  ) {
    const gridCfg = this.config.grid;
    const exitCfg = this.config.exit;
    let leverage = this.config.leverage || 5;
    const prec = binanceFutures.getPrecision(symbol);

    const layers: GridLayer[] = [];
    let currentMargin = gridCfg.marginPerLayerUsdt;
    let totalPlannedMargin = 0;

    // Layer 0: Langsung terisi di harga pasar saat spike (Market / Immediate entry)
    let layer0Planned = (currentMargin * leverage) / currentPrice;
    if (layer0Planned * currentPrice < prec.minNotional) {
      layer0Planned = (prec.minNotional * 1.05) / currentPrice;
    }
    const layer0Qty = parseFloat(binanceFutures.formatQty(symbol, layer0Planned));
    const layer0ActualMargin = (layer0Qty * currentPrice) / leverage;

    if (layer0ActualMargin > gridCfg.maxTotalMarginPerCoin) {
      logger.log(
        'WARN',
        `⚠️ [SKIP TRADE] ${symbol}: Margin minimum Layer 0 ($${layer0ActualMargin.toFixed(2)}) melebihi batas maxTotalMarginPerCoin ($${gridCfg.maxTotalMarginPerCoin}). Koin dibatalkan untuk melindungi modal.`,
        symbol
      );
      return;
    }

    layers.push({
      layerIndex: 0,
      price: currentPrice,
      qty: layer0Qty,
      marginUsdt: layer0ActualMargin,
      status: 'FILLED',
      filledAt: Date.now(),
    });
    totalPlannedMargin += layer0ActualMargin;

    // Layer 1 hingga N: Diletakkan berjarak layerSpacingPct di atas harga pasar
    for (let i = 1; i < gridCfg.totalLayers; i++) {
      currentMargin *= gridCfg.martingaleMultiplier;

      const layerPrice = currentPrice * (1 + (i * gridCfg.layerSpacingPct) / 100);
      let layerPlanned = (currentMargin * leverage) / layerPrice;
      if (layerPlanned * layerPrice < prec.minNotional) {
        layerPlanned = (prec.minNotional * 1.05) / layerPrice;
      }
      const layerQty = parseFloat(binanceFutures.formatQty(symbol, layerPlanned));
      const layerActualMargin = (layerQty * layerPrice) / leverage;

      // Proteksi ketat: Pastikan akumulasi margin nyata TIDAK MELEBIHI batas maxTotalMarginPerCoin!
      if (totalPlannedMargin + layerActualMargin > gridCfg.maxTotalMarginPerCoin) {
        break;
      }

      layers.push({
        layerIndex: i,
        price: parseFloat(binanceFutures.formatPrice(symbol, layerPrice)),
        qty: layerQty,
        marginUsdt: layerActualMargin,
        status: 'PENDING',
      });
      totalPlannedMargin += layerActualMargin;
    }

    const initialPos: ActivePosition = {
      id: `${symbol}_${Date.now()}`,
      symbol,
      side: 'SHORT',
      leverage,
      totalQty: layer0Qty,
      avgEntryPrice: currentPrice,
      currentPrice,
      unrealizedPnl: 0,
      pnlPct: 0,
      peakPnlPct: 0,
      totalMarginUsed: layers[0].marginUsdt,
      layers,
      openedAt: Date.now(),
      targetTpPrice: currentPrice * (1 - exitCfg.takeProfitPct / 100),
      hardSlPrice: currentPrice * (1 + exitCfg.hardStopLossPct / 100),
      status: 'SNIPING',
    };

    if (this.config.tradingMode === 'LIVE') {
      // Defensive double-check: jangan pernah menaruh order baru jika Binance sudah aktif di symbol yang sama
      try {
        const existingLivePos = await binanceFutures.getOpenPosition(symbol);
        if (existingLivePos && Math.abs(existingLivePos.positionAmt) > 0) {
          logger.log('WARN', `⚠️ [BLOCK DUPLICATE ENTRY] ${symbol} sudah punya posisi aktif di Binance (${Math.abs(existingLivePos.positionAmt)}). Membatalkan order tambahan agar tidak avg down.`);
          return;
        }
      } catch (e: any) {
        logger.log('WARN', `⚠️ [BLOCK DUPLICATE ENTRY] Gagal cek posisi live ${symbol}: ${e.message}`);
      }

      // Live Trading: Jalankan setLeverage & setMarginType
      try {
        const [actualLev] = await Promise.all([
          binanceFutures.setLeverage(symbol, leverage),
          binanceFutures.setMarginType(symbol, this.config.marginType || 'CROSSED'),
        ]);
        if (actualLev && actualLev > 0 && actualLev !== leverage) {
          logger.log('INFO', `ℹ️ [LEVERAGE DISESUAIKAN] ${symbol}: Binance membatasi leverage koin ini ke ${actualLev}x (Config: ${leverage}x).`, symbol);
          leverage = actualLev;
          initialPos.leverage = actualLev;
        }
      } catch { }

      // 1. Eksekusi market order untuk layer 0 (Mendukung One-Way & Hedge Mode)
      this.auditTradeLifecycle(symbol, 'OPEN_SHORT_REQUESTED', {
        side: 'SELL',
        qty: layer0Qty,
        price: currentPrice,
        status: 'SENT',
      });

      const res0 = await binanceFutures.openMarketOrder(symbol, 'SELL', layer0Qty);
      if (!res0?.orderId) {
        const errMsg = binanceFutures.lastOrderError || 'Cek saldo USDT atau izin Futures API Key.';
        logger.log(
          'ERROR',
          `❌ [ORDER GAGAL] Gagal membuka Layer 0 SHORT untuk ${symbol} di Binance! Membatalkan penempatan jaring. Alasan: ${errMsg}`,
          symbol
        );
        telegram.notifyMarginInsufficient(symbol, 'Membuka Posisi Awal (Layer #0)', {
          reason: errMsg,
          availableBalance: this.liveAvailableBalance > 0 ? this.liveAvailableBalance : undefined,
          requiredAmount: (currentPrice * layer0Qty) / leverage,
        });

        // Auto-Cooldown: Jika order ditolak Binance (misal koin Pre-Market / not whitelisted / margin),
        // pasang cooldown agar scanner tidak berulang kali menembak koin yang sama & membuang kuota API.
        const isNotWhitelisted = errMsg.toLowerCase().includes('white list') || errMsg.toLowerCase().includes('whitelist');
        const cooldownMins = isNotWhitelisted ? 120 : (this.config.scanner.cooldownMinutes || 20);
        this.scanner.setCooldown(symbol, cooldownMins);
        logger.log('INFO', `⏳ [AUTO-COOLDOWN] ${symbol} diberi cooldown ${cooldownMins} menit untuk mencegah spam order gagal.`, symbol);
        return;
      }
      layers[0].orderId = String(res0.orderId);

      // Sinkronisasi HARGA & KUANTITAS EKSEKUSI RIIL dari Binance matching engine
      let executedQty = parseFloat(res0.executedQty || '0');
      let cumQuote = parseFloat(res0.cumQuote || '0');
      let realEntryPrice = parseFloat(res0.avgPrice || '0');
      if ((!realEntryPrice || realEntryPrice <= 0) && executedQty > 0 && cumQuote > 0) {
        realEntryPrice = cumQuote / executedQty;
      }

      // Jika avgPrice masih 0 (karena Binance Futures API merespon status NEW seketika sebelum pembukuan fill selesai),
      // gunakan getOrder() dan query posisi riil untuk memastikan harga modal bot 100% SAMA PERSIS dengan Binance
      if (!realEntryPrice || realEntryPrice <= 0) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        try {
          if (res0.orderId) {
            const filledOrder = await binanceFutures.getOrder(symbol, res0.orderId);
            if (filledOrder && parseFloat(filledOrder.avgPrice || '0') > 0) {
              realEntryPrice = parseFloat(filledOrder.avgPrice);
              executedQty = parseFloat(filledOrder.executedQty || '0');
            }
          }
          if (!realEntryPrice || realEntryPrice <= 0) {
            const realPos = await binanceFutures.getOpenPosition(symbol);
            if (realPos && Math.abs(realPos.positionAmt) > 0 && realPos.entryPrice > 0) {
              realEntryPrice = realPos.entryPrice;
              executedQty = Math.abs(realPos.positionAmt);
            }
          }
          if (!realEntryPrice || realEntryPrice <= 0) {
            const recentTrades = await binanceFutures.getUserTrades(symbol, 5);
            const entryTrade = recentTrades.find(
              (t: any) => t.side === 'SELL' && (!res0.orderId || String(t.orderId) === String(res0.orderId))
            ) || recentTrades.find((t: any) => t.side === 'SELL');
            if (entryTrade && parseFloat(entryTrade.price) > 0) {
              realEntryPrice = parseFloat(entryTrade.price);
              executedQty = parseFloat(entryTrade.qty || '0');
            }
          }
        } catch (e: any) {
          console.warn(`[Sync Entry] Gagal mengambil posisi riil Binance: ${e.message}`);
        }
      }

      if (realEntryPrice > 0) {
        layers[0].price = realEntryPrice;
        initialPos.avgEntryPrice = realEntryPrice;
        initialPos.currentPrice = realEntryPrice;
        this.auditTradeLifecycle(symbol, 'OPEN_SHORT_CONFIRMED', {
          side: 'SELL',
          qty: executedQty || layer0Qty,
          entryPrice: realEntryPrice,
          status: 'CONFIRMED',
        });
        if (executedQty > 0) {
          layers[0].qty = executedQty;
          initialPos.totalQty = executedQty;
          layers[0].marginUsdt = (executedQty * realEntryPrice) / leverage;
          initialPos.totalMarginUsed = layers[0].marginUsdt;
        }

        // Sinkronkan ulang harga Limit Order layer 1 ke atas dengan jangkar harga eksekusi riil (realEntryPrice)
        let runningMargin = gridCfg.marginPerLayerUsdt;
        let runningTotalMargin = layers[0].marginUsdt;
        const validLayers = [layers[0]];

        for (let i = 1; i < layers.length; i++) {
          runningMargin *= gridCfg.martingaleMultiplier;
          const layerPrice = realEntryPrice * (1 + (i * gridCfg.layerSpacingPct) / 100);
          let layerPlanned = (runningMargin * leverage) / layerPrice;
          if (layerPlanned * layerPrice < prec.minNotional) {
            layerPlanned = (prec.minNotional * 1.05) / layerPrice;
          }
          const formattedPrice = parseFloat(binanceFutures.formatPrice(symbol, layerPrice));
          const formattedQty = parseFloat(binanceFutures.formatQty(symbol, layerPlanned));
          const actualMargin = (formattedQty * formattedPrice) / leverage;

          if (runningTotalMargin + actualMargin > gridCfg.maxTotalMarginPerCoin) {
            break;
          }

          layers[i].price = formattedPrice;
          layers[i].qty = formattedQty;
          layers[i].marginUsdt = actualMargin;
          validLayers.push(layers[i]);
          runningTotalMargin += actualMargin;
        }
        layers.length = 0;
        layers.push(...validLayers);
        initialPos.layers = layers;

        // Hitung ulang target TP dan SL berdasarkan harga eksekusi riil Binance
        initialPos.targetTpPrice = realEntryPrice * (1 - exitCfg.takeProfitPct / 100);
        initialPos.hardSlPrice = realEntryPrice * (1 + exitCfg.hardStopLossPct / 100);
        logger.log(
          'INFO',
          `🎯 [LIVE FILL SYNC] ${symbol} Layer #0 terisi riil di Binance @ $${realEntryPrice.toFixed(6)} | Grid Jaring & Target TP disinkronkan ke $${initialPos.targetTpPrice.toFixed(6)}`,
          symbol
        );
      }

      // SMART GRID QUEUE: Hanya pasang maksimal 2 layer teratas di Binance (QUEUE_DEPTH = 2).
      // Sisa layer (3, 4, ...) disimpan di antrean memori bot dan baru dipasang jika layer sebelumnya terisi.
      // Ini mencegah bencana TAKEUSDT di mana layer 3, 4, 5 terisi setelah Take Profit tereksekusi.
      const QUEUE_DEPTH = 2;
      const initialActiveLayers = layers.slice(1, 1 + QUEUE_DEPTH);
      const queuedLayers = layers.slice(1 + QUEUE_DEPTH);

      const batchPayload = initialActiveLayers.map((l) => ({
        symbol,
        side: 'SELL',
        type: 'LIMIT',
        quantity: binanceFutures.formatQty(symbol, l.qty),
        price: binanceFutures.formatPrice(symbol, l.price),
        timeInForce: 'GTC',
      }));

      this.activePositions.set(symbol, initialPos);

      // PRIORITAS UTAMA: Pasang Limit Take Profit SEKETIKA secara paralel (tanpa menunggu batch order selesai)
      // Ini memangkas 200-300ms delay agar order Limit TP langsung siap menangkap pullback wick
      const tpPromise = this.syncLiveTakeProfitOrder(initialPos).catch(() => { });

      if (batchPayload.length > 0) {
        for (const layer of initialActiveLayers) {
          this.auditTradeLifecycle(symbol, 'GRID_LAYER_PLACED', {
            layerIndex: layer.layerIndex,
            side: 'SELL',
            price: layer.price,
            qty: layer.qty,
            status: 'SENT',
          });
        }

        binanceFutures.sendBatchOrders(batchPayload).then((batchRes) => {
          let placedCount = 0;
          let failedCount = 0;
          let failureReason = '';

          for (let i = 0; i < batchRes.length && i < initialActiveLayers.length; i++) {
            const item = batchRes[i];
            const targetLayer = initialActiveLayers[i];
            if (item?.orderId) {
              targetLayer.orderId = String(item.orderId);
              placedCount++;
            } else {
              failedCount++;
              targetLayer.status = 'CANCELLED';
              const code = item?.code || item?.error?.code;
              const msg = item?.msg || item?.error?.msg || (typeof item === 'string' ? item : '');
              if (!failureReason && (code || msg)) {
                failureReason = code ? `[${code}] ${msg}` : msg;
              }
            }
          }

          if (queuedLayers.length > 0) {
            logger.log(
              'INFO',
              `⏳ [SMART GRID QUEUE] ${symbol}: ${placedCount} order limit terpasang di Binance (Layer #1..#${initialActiveLayers.length}). ${queuedLayers.length} layer berikutnya (Layer #${initialActiveLayers.length + 1}..#${layers.length - 1}) disimpan dalam antrean bot.`,
              symbol
            );
          }

          const totalRequested = initialActiveLayers.length;
          if (failedCount > 0 || placedCount < totalRequested) {
            const isMarginError = failureReason.toLowerCase().includes('margin') || failureReason.includes('-2019');
            const reasonText = isMarginError
              ? `Margin Insufficient (Saldo USDT tidak cukup)`
              : (failureReason || 'Order ditolak Binance');

            logger.log(
              'WARN',
              `⚠️ [GRID KURANG SALDO / DITOLAK] ${symbol}: Hanya ${placedCount}/${totalRequested} jaring terpasang. Alasan: ${reasonText}`,
              symbol
            );

            telegram.notifyMarginInsufficient(symbol, 'Penempatan Jaring Averaging (Layer 1+)', {
              placedLayers: placedCount,
              totalLayers: totalRequested,
              reason: reasonText,
              availableBalance: this.liveAvailableBalance > 0 ? this.liveAvailableBalance : undefined,
            });
          }
        }).catch((err: any) => {
          logger.log('ERROR', `❌ [BATCH GRID ERROR] ${symbol}: ${err.message}`, symbol);
          telegram.notifyMarginInsufficient(symbol, 'Penempatan Jaring Averaging (Layer 1+)', {
            placedLayers: 0,
            totalLayers: initialActiveLayers.length,
            reason: err.message,
            availableBalance: this.liveAvailableBalance > 0 ? this.liveAvailableBalance : undefined,
          });
        });
      }

      await tpPromise;
    } else {
      this.activePositions.set(symbol, initialPos);
    }
    db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });

    telegram.notifyNewOrder(
      initialPos,
      this.config.tradingMode,
      surgePct,
      lookbackSeconds,
      gridCfg.layerSpacingPct,
      exitCfg.takeProfitPct,
      exitCfg.hardStopLossPct
    );

    logger.log(
      'SUCCESS',
      `🎯 [JARING SHORT DITERBITKAN] ${symbol}: ${layers.length} Layer terpasang. Layer #0 terisi di $${initialPos.avgEntryPrice.toFixed(6)}. Target TP: $${initialPos.targetTpPrice.toFixed(6)} (-${exitCfg.takeProfitPct}%)`,
      symbol
    );
  }

  /**
   * Pembaruan live harga dari WebSocket untuk mengecek trigger jaring dan TP/SL
   */
  private async onPriceTick(tickers: any[]) {
    if (this.activePositions.size === 0) return;

    for (const t of tickers) {
      const symbol = t.s;
      const pos = this.activePositions.get(symbol);
      if (!pos) continue;
      if (pos.status === 'CLOSING' || pos.status === 'CLOSED') continue;

      const currentPrice = parseFloat(t.c || t.p || '0');
      if (currentPrice <= 0) continue;

      pos.currentPrice = currentPrice;
      const samples = this.priceMomentum.get(symbol) || [];
      samples.push({ price: currentPrice, time: Date.now() });
      const recentSamples = samples.filter((sample) => Date.now() - sample.time <= 90_000).slice(-8);
      this.priceMomentum.set(symbol, recentSamples);

      // 1. Cek layer fill (hanya untuk mode PAPER: simulasi pengisian jaring)
      // Pada mode LIVE, layer diisi langsung oleh matching engine Binance dan disinkronkan di syncLivePositions
      if (this.config.tradingMode === 'PAPER') {
        let layersChanged = false;
        for (const layer of pos.layers) {
          if (layer.status === 'PENDING' && currentPrice >= layer.price) {
            layer.status = 'FILLED';
            layer.filledAt = Date.now();
            layersChanged = true;
            logger.log(
              'SNIPER',
              `🕸️ [LAYER TERISI PAPER] ${symbol} Layer #${layer.layerIndex} terisi @ $${layer.price} (Qty: ${layer.qty}, Margin: $${layer.marginUsdt.toFixed(2)})`,
              symbol
            );
            telegram.notifyLayerFill(
              pos,
              layer,
              pos.layers.filter((l) => l.status === 'FILLED').length,
              pos.layers.length
            );
            // Update trailing SL when layer fills
            this.updateTrailingSL(pos);
          }
        }

        // 2. Jika ada layer baru yang terisi, hitung ulang Average Entry Price & Target TP
        if (layersChanged) {
          this.recalculatePositionAverage(pos);
          db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });
        }
      }

      // 3. Hitung Floating PnL
      // Untuk posisi SHORT: PnL = (AvgEntry - CurrentPrice) * TotalQty
      const pnl = (pos.avgEntryPrice - currentPrice) * pos.totalQty;
      pos.unrealizedPnl = Math.round(pnl * 100) / 100;
      pos.pnlPct = Math.round(((pos.avgEntryPrice - currentPrice) / pos.avgEntryPrice) * pos.leverage * 1000) / 10;

      if (pos.pnlPct > pos.peakPnlPct) {
        pos.peakPnlPct = pos.pnlPct;
      }

      // 4. Evaluasi Kondisi Exit:
      // A. HARD STOP LOSS (Proteksi Runaway Pump)
      // Guard: Minimal 5 detik sejak posisi dibuka untuk menghindari false trigger akibat volatilitas awal
      const slAgeMs = Date.now() - pos.openedAt;
      if (currentPrice >= pos.hardSlPrice && (pos.partialTpDone || slAgeMs >= 5000)) {
        if (pos.partialTpDone) {
          logger.log(
            'INFO',
            `🛡️ [BEP PROTECTION TRIGGERED] ${pos.symbol}: Harga kembali ke BEP $${pos.hardSlPrice.toFixed(6)}. Sisa posisi ditutup impas (0% rugi) setelah mengamankan Partial TP!`,
            pos.symbol
          );
          this.closePosition(pos, 'TRAILING_TP', currentPrice);
        } else {
          logger.log(
            'WARN',
            `🛑 [HARD SL TRIGGERED] ${pos.symbol}: Harga $${currentPrice} >= Hard SL $${pos.hardSlPrice.toFixed(6)} (Avg Entry: $${pos.avgEntryPrice.toFixed(6)}, SL%: ${((pos.hardSlPrice / pos.avgEntryPrice - 1) * 100).toFixed(2)}%, Umur: ${(slAgeMs / 1000).toFixed(1)}s)`,
            pos.symbol
          );
          this.closePosition(pos, 'HARD_STOP_LOSS', currentPrice);
        }
        continue;
      }

      if (this.shouldEarlyExitMomentum(pos, recentSamples)) {
        logger.log(
          'WARN',
          `⚠️ [EARLY MOMENTUM EXIT] ${pos.symbol}: Harga di atas average entry dan momentum naik memenuhi parameter proteksi.`,
          pos.symbol
        );
        this.closePosition(pos, 'EARLY_MOMENTUM_EXIT', currentPrice);
        continue;
      }

      // B. TAKE PROFIT PULLBACK (DILENGKAPI STAGE 1 PARTIAL TP & BEP PROTECTION)
      // Jika Trailing TP sedang aktif, serahkan seluruh evaluasi runner ke Section C
      if (pos.trailingTpActive) {
        // Biarkan Section C menangani trailing runner & callback
      } else {
        const tradeAgeMs = Date.now() - pos.openedAt;
        if (currentPrice <= pos.targetTpPrice && currentPrice < pos.avgEntryPrice && tradeAgeMs >= 3000) {
          if (this.config.tradingMode === 'LIVE') {
            // JIKA TRAILING TP DIAKTIFKAN:
            // Aktifkan runner jika harga dump tembus lebih dalam (>= 0.3% di bawah target TP)
            if (this.config.exit.trailingTpEnabled && currentPrice <= pos.targetTpPrice * 0.997) {
              pos.trailingTpActive = true;
              pos.lowestPrice = currentPrice;
              logger.log(
                'INFO',
                `🚀 [TRAILING TP AKTIF] ${pos.symbol}: Harga menembus target TP awal ke $${currentPrice.toFixed(6)}. Mengaktifkan Trailing Runner untuk memburu profit lebih dalam...`,
                pos.symbol
              );
              if (pos.tpOrderId) binanceFutures.cancelOrder(pos.symbol, pos.tpOrderId).catch(() => {});
              if (pos.tp2OrderId) binanceFutures.cancelOrder(pos.symbol, pos.tp2OrderId).catch(() => {});
              pos.tpOrderId = undefined;
              pos.tp2OrderId = undefined;
              continue;
            }

            // Mode LIVE: Order Limit TP Maker sudah antre di Binance matching engine.
            // DILARANG melempar Market Order di sini! Matching engine Binance mengeksekusi sebagai MAKER (0.02% fee, 0 slippage).
            // Notifikasi pengisian akan diterima instan melalui Private User Data Stream / syncLivePositions.
            continue;
          } else {
            // Mode PAPER TRADING:
            if (this.config.exit.partialTpEnabled && !pos.partialTpDone && pos.totalQty > 0) {
              const ratio = this.config.exit.partialTpRatio || 0.5;
              const desiredPartialQty = pos.totalQty * ratio;
              const safePartialQty = parseFloat(binanceFutures.formatQty(pos.symbol, desiredPartialQty));
              if (safePartialQty > 0 && safePartialQty < pos.totalQty) {
                const partialPnl = Math.round((pos.avgEntryPrice - currentPrice) * safePartialQty * 100) / 100;
                this.virtualBalance += partialPnl;
                pos.totalQty = parseFloat(binanceFutures.formatQty(pos.symbol, pos.totalQty - safePartialQty));
                pos.partialTpDone = true;
                pos.partialRealizedPnl = (pos.partialRealizedPnl || 0) + partialPnl;
                if (pos.layers) {
                  for (const l of pos.layers) {
                    if (l.status === 'PENDING') l.status = 'CANCELLED';
                  }
                }
                pos.hardSlPrice = pos.avgEntryPrice * (1 - 0.0008);
                pos.targetTp2Price = pos.avgEntryPrice * (1 - (this.config.exit.takeProfitPct * 2) / 100);
                pos.targetTpPrice = pos.targetTp2Price;
                logger.log(
                  'SUCCESS',
                  `🎯 [STAGE 1 PARTIAL TP 50%] ${pos.symbol}: Cuan +$${partialPnl.toFixed(2)} berhasil diamankan! Grid pending dibatalkan, Hard SL dipindah ke BEP: $${pos.hardSlPrice.toFixed(4)}. Sisa ${pos.totalQty} koin memburu Stage 2 TP @ $${pos.targetTpPrice.toFixed(4)}.`,
                  pos.symbol
                );
                telegram.notifyPartialTp(
                  pos.symbol,
                  partialPnl,
                  pos.totalQty,
                  pos.avgEntryPrice,
                  pos.targetTpPrice
                );
                this.broadcastStatus();
                db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });
                continue;
              }
            }

            if (this.config.exit.trailingTpEnabled) {
              pos.trailingTpActive = true;
              pos.lowestPrice = Math.min(pos.lowestPrice || currentPrice, currentPrice);
              continue;
            }

            this.closePosition(pos, 'TAKE_PROFIT', currentPrice);
            continue;
          }
        }
      }

      // C. TRAILING TAKE PROFIT (DILENGKAPI GEMBOK PROFIT ANTI-MINUS & ANTI-SLIPPAGE)
      const trailingAgeMs = Date.now() - pos.openedAt;
      if (this.config.exit.trailingTpEnabled && pos.trailingTpActive && trailingAgeMs >= 3000) {
        // Catat titik harga terendah (profit terdalam untuk posisi SHORT)
        pos.lowestPrice = Math.min(pos.lowestPrice || currentPrice, currentPrice);

        // Batas Harga Maksimum Aman (Profit Floor):
        // Wajib minimal 0.6% di bawah avgEntryPrice (menutupi fee roundtrip taker + buffer slippage pantulan wick)
        const minRequiredProfitPct = Math.max(0.6, (this.config.exit.trailingCallbackPct || 0.4) * 1.5);
        const safeTrailingMaxPrice = pos.avgEntryPrice * (1 - minRequiredProfitPct / 100);

        // PROTEKSI 1: Jika pantulan harga memantul naik mendekati BEP (di atas batas aman), DILARANG tutup rugi!
        // Segera batalkan mode trailing dan pasang kembali Limit TP Maker di Binance agar posisi tetap terjaga dalam jaring
        if (currentPrice > safeTrailingMaxPrice) {
          logger.log(
            'WARN',
            `🛡️ [TRAILING RE-ANCHOR GUARD] ${pos.symbol}: Pantulan harga mendekati BEP ($${currentPrice.toFixed(6)} > batas aman $${safeTrailingMaxPrice.toFixed(6)}). Trailing TP distandbykan & Limit TP dipasang kembali di Binance agar posisi tetap aman dalam jaring.`,
            pos.symbol
          );
          pos.trailingTpActive = false;
          pos.lowestPrice = undefined;
          pos.peakPnlPct = 0;
          if (this.config.tradingMode === 'LIVE') {
            this.syncLiveTakeProfitOrder(pos).catch(() => {});
          }
          continue;
        }

        // PROTEKSI 2: Hitung callback dari titik terendah riil
        const callbackPct = this.config.exit.trailingCallbackPct || 0.4;
        const bouncePct = ((currentPrice - pos.lowestPrice) / pos.lowestPrice) * 100;

        if (bouncePct >= callbackPct && currentPrice <= safeTrailingMaxPrice) {
          logger.log(
            'SUCCESS',
            `🎯 [TRAILING TP HIT] ${pos.symbol}: Memantul +${bouncePct.toFixed(2)}% dari harga terendah $${pos.lowestPrice.toFixed(6)} ➜ Mengamankan profit di $${currentPrice.toFixed(6)} (Cuan aman di bawah batas $${safeTrailingMaxPrice.toFixed(6)}).`,
            pos.symbol
          );
          this.closePosition(pos, 'TRAILING_TP', currentPrice);
          continue;
        }
      }
    }
  }

  private shouldEarlyExitMomentum(pos: ActivePosition, samples: { price: number; time: number }[]): boolean {
    const exitCfg = this.config.exit;
    if (!exitCfg.earlyExitMomentumEnabled || pos.partialTpDone || samples.length < 2) return false;
    if (pos.currentPrice <= pos.avgEntryPrice) return false;

    const installedLayerCount = pos.layers.filter((layer) => layer.status !== 'CANCELLED').length;
    const filledLayerCount = pos.layers.filter((layer) => layer.status === 'FILLED').length;
    const minimumFilledLayers = Math.ceil(installedLayerCount / 2);
    if (installedLayerCount === 0 || filledLayerCount < minimumFilledLayers) return false;

    const requiredSamples = Math.max(2, exitCfg.earlyExitMinBullishCandles || 3);
    if (samples.length < requiredSamples) return false;
    const window = samples.slice(-requiredSamples);
    const rising = window.every((sample, index) => index === 0 || sample.price > window[index - 1].price);
    const risePct = ((window[window.length - 1].price - window[0].price) / window[0].price) * 100;
    return rising && risePct >= (exitCfg.earlyExitMinRisePct || 0.5);
  }

  /**
   * Menghitung target TP (baik TP normal maupun BEP Defense darurat jika terisi cepat / penuh)
   */
  private calculatePositionTpPrices(pos: ActivePosition): { targetTpPrice: number; targetTp2Price: number; isBepActive: boolean; bepReason?: string } {
    const exitCfg = this.config.exit;
    const totalConfiguredLayers = this.config.grid.totalLayers || 6;
    const filledLayersCount = (pos.layers || []).filter((l) => l.status === 'FILLED').length;
    const tradeAgeSeconds = (Date.now() - pos.openedAt) / 1000;

    const bepDefenseActive = exitCfg.bepDefenseEnabled !== false; // Default aktif demi keselamatan modal
    // Ambang batas layer: jika tidak diset (atau 0), gunakan layer maksimal (totalConfiguredLayers)
    const maxLayersThreshold = exitCfg.bepMaxLayersTrigger && exitCfg.bepMaxLayersTrigger > 0
      ? exitCfg.bepMaxLayersTrigger
      : totalConfiguredLayers;

    // Batas waktu & minimal layer untuk deteksi Velocity Shock
    const fastFillSeconds = exitCfg.bepFastFillSeconds || 120;
    const fastFillMinLayers = exitCfg.bepFastFillMinLayers && exitCfg.bepFastFillMinLayers > 0
      ? exitCfg.bepFastFillMinLayers
      : Math.max(2, Math.ceil(totalConfiguredLayers * 0.65)); // Default adaptif: 65% dari total layer

    const bepBufferPct = exitCfg.bepBufferPct ?? 0.08;

    let isBep = false;
    let reason = '';

    if (bepDefenseActive && !pos.partialTpDone) {
      // Kondisi 1: Mencapai ambang batas layer penuh (misal 6/6 layer)
      if (filledLayersCount >= maxLayersThreshold) {
        isBep = true;
        reason = `Kapasitas Jaring Terpenuhi (${filledLayersCount}/${totalConfiguredLayers} Layer)`;
      }
      // Kondisi 2: Kecepatan Pengisian Ekstrem (Velocity Shock)
      else if (exitCfg.bepFastFillEnabled !== false && tradeAgeSeconds <= fastFillSeconds && filledLayersCount >= fastFillMinLayers) {
        isBep = true;
        reason = `Velocity Shock: ${filledLayersCount}/${totalConfiguredLayers} Layer tertelan kilat dlm ${Math.round(tradeAgeSeconds)}s (Batas: ${fastFillSeconds}s)`;
      }
    }

    if (isBep) {
      // JAMINAN PASTI NET PROFIT >= 0 (TIDAK BOLEH MINUS FEE):
      // Untuk posisi SHORT, harga exit BUY harus turun minimal sebesar biaya komisi round-trip Binance
      // (Maker fee 0.02% entry + 0.02% exit = 0.04% plus safety buffer = 0.08% s/d 0.10%).
      const effectiveBufferPct = Math.max(0.08, bepBufferPct || 0.10);
      const safeBufferPrice = pos.avgEntryPrice * (1 - effectiveBufferPct / 100);

      // Jika Binance menyediakan breakEvenPrice riil, pastikan tidak lebih tinggi dari safeBufferPrice
      let bepTarget = safeBufferPrice;
      if (pos.breakEvenPrice && pos.breakEvenPrice > 0 && pos.breakEvenPrice < pos.avgEntryPrice) {
        bepTarget = Math.min(safeBufferPrice, pos.breakEvenPrice);
      }

      return { targetTpPrice: bepTarget, targetTp2Price: bepTarget, isBepActive: true, bepReason: reason };
    }

    const normalTp1 = pos.avgEntryPrice * (1 - exitCfg.takeProfitPct / 100);
    const normalTp2 = pos.avgEntryPrice * (1 - (exitCfg.takeProfitPct * 2) / 100);
    return { targetTpPrice: normalTp1, targetTp2Price: normalTp2, isBepActive: false };
  }

  private recalculatePositionAverage(pos: ActivePosition) {
    const filledLayers = pos.layers.filter((l) => l.status === 'FILLED');
    let totalNotional = 0;
    let totalQty = 0;
    let totalMargin = 0;

    for (const l of filledLayers) {
      totalNotional += l.price * l.qty;
      totalQty += l.qty;
      totalMargin += l.marginUsdt;
    }

    if (totalQty > 0) {
      pos.totalQty = parseFloat(binanceFutures.formatQty(pos.symbol, totalQty));
      pos.avgEntryPrice = totalNotional / totalQty;
      pos.totalMarginUsed = totalMargin;

      const exitCfg = this.config.exit;
      const tpCalc = this.calculatePositionTpPrices(pos);
      pos.targetTpPrice = tpCalc.targetTpPrice;
      pos.targetTp2Price = tpCalc.targetTp2Price;

      if (tpCalc.isBepActive && !pos.isBepDefenseActive) {
        pos.isBepDefenseActive = true;
        pos.bepDefenseReason = tpCalc.bepReason;
        logger.log(
          'WARN',
          `🛡️ [BEP DEFENSE DIAKTIFKAN] ${pos.symbol}: ${tpCalc.bepReason}. Target TP dipindahkan ke BEP ($${pos.targetTpPrice.toFixed(6)}) demi mengamankan modal dari monster pump!`,
          pos.symbol
        );
      } else if (!tpCalc.isBepActive) {
        pos.isBepDefenseActive = false;
      }

      pos.hardSlPrice = pos.avgEntryPrice * (1 + exitCfg.hardStopLossPct / 100);

      logger.log(
        'INFO',
        `📊 [RECALCULATE AVG] ${pos.symbol}: Entry Rata-rata baru: $${pos.avgEntryPrice.toFixed(4)} | Volume: ${pos.totalQty} | TP: $${pos.targetTpPrice.toFixed(4)} ${pos.isBepDefenseActive ? '(MODE BEP DEFENSE)' : ''}`,
        pos.symbol
      );

      // Jika dalam mode LIVE, sinkronkan Take Profit Limit Order ke Binance
      if (this.config.tradingMode === 'LIVE') {
        this.syncLiveTakeProfitOrder(pos).catch(() => { });
      }
    }
  }

  /**
   * Menangani pengisian order Limit TP1 di Binance pada mode LIVE
   * Membatalkan seluruh jaring pending, menggeser SL ke BEP riil, dan memasang Limit TP2
   */
  private async handleLivePartialTpHit(pos: ActivePosition, livePos?: any) {
    if (pos.partialTpDone) return;

    const remainingQty = livePos ? Math.abs(livePos.positionAmt) : pos.totalQty * (1 - (this.config.exit.partialTpRatio || 0.5));
    if (remainingQty <= 0) {
      // Jika seluruh sisa posisi di Binance sudah 0, finalize trade dengan Take Profit
      await this.closePosition(pos, 'TAKE_PROFIT', pos.targetTp2Price || pos.targetTpPrice);
      return;
    }

    const closedQty = parseFloat(binanceFutures.formatQty(pos.symbol, pos.totalQty - remainingQty));
    if (closedQty <= 0) return;

    pos.partialTpDone = true;
    const partialPnl = Math.round((pos.avgEntryPrice - (pos.targetTpPrice || pos.avgEntryPrice)) * closedQty * 100) / 100;
    pos.totalQty = parseFloat(binanceFutures.formatQty(pos.symbol, remainingQty));
    pos.partialRealizedPnl = (pos.partialRealizedPnl || 0) + partialPnl;

    this.auditTradeLifecycle(pos.symbol, 'PARTIAL_CLOSE_CONFIRMED', {
      side: 'BUY',
      qty: closedQty,
      realizedPnl: partialPnl,
      remainingQty: pos.totalQty,
      status: 'CLOSED_PARTIAL',
    });

    // 1. Batalkan seluruh jaring pending grid di Binance
    await binanceFutures.cancelAllOrders(pos.symbol).catch(() => { });
    pos.tpOrderId = undefined;
    pos.tp2OrderId = undefined;
    if (pos.layers) {
      for (const l of pos.layers) {
        if (l.status === 'PENDING') {
          l.status = 'CANCELLED';
        }
      }
    }

    // 2. Geser Hard Stop Loss ke titik BEP RIIL BINANCE (sudah include seluruh biaya fee transaksi!)
    let bepPrice = 0;
    if (livePos?.breakEvenPrice && livePos.breakEvenPrice > 0) {
      bepPrice = livePos.breakEvenPrice;
      pos.breakEvenPrice = livePos.breakEvenPrice;
    } else {
      try {
        const p = await binanceFutures.getOpenPosition(pos.symbol);
        if (p?.breakEvenPrice && p.breakEvenPrice > 0) {
          bepPrice = p.breakEvenPrice;
          pos.breakEvenPrice = p.breakEvenPrice;
        }
      } catch { }
    }
    if (!bepPrice || bepPrice <= 0) {
      bepPrice = pos.avgEntryPrice * (1 - 0.0008);
    }
    pos.hardSlPrice = bepPrice;

    // 3. Target TP tahap 2 digeser lebih dalam (2x takeProfitPct di bawah average entry)
    pos.targetTp2Price = pos.avgEntryPrice * (1 - (this.config.exit.takeProfitPct * 2) / 100);
    pos.targetTpPrice = pos.targetTp2Price;

    // 4. Pasang order Limit BUY TP2 baru untuk sisa 50% di Binance
    if (pos.totalQty > 0) {
      await this.syncLiveTakeProfitOrder(pos);
    }

    logger.log(
      'SUCCESS',
      `🎯 [STAGE 1 TP1 TERISI DI BINANCE] ${pos.symbol}: Cuan Maker +$${partialPnl.toFixed(2)} aman! Grid pending dibatalkan, Hard SL digeser ke BEP (Include Fee): $${pos.hardSlPrice.toFixed(4)}. Sisa ${pos.totalQty} koin memburu TP2 @ $${pos.targetTp2Price.toFixed(4)}.`,
      pos.symbol
    );
    telegram.notifyPartialTp(
      pos.symbol,
      partialPnl,
      pos.totalQty,
      pos.avgEntryPrice,
      pos.targetTp2Price
    );
    this.broadcastStatus();
    db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });
  }

  /**
   * Smart Grid Queue: Menempatkan layer berikutnya dari antrean jika order limit SELL di Binance < QUEUE_DEPTH
   */
  private async deployNextGridLayerInQueue(pos: ActivePosition) {
    if (this.config.tradingMode !== 'LIVE' || !pos.layers) return;
    if (pos.status === 'CLOSING' || pos.status === 'CLOSED') return;

    const QUEUE_DEPTH = 2;
    // Hitung berapa layer SELL yang saat ini berstatus PENDING dan aktif memiliki orderId di Binance
    const activeBinanceLayers = pos.layers.filter(
      (l) => l.status === 'PENDING' && l.orderId && l.layerIndex > 0
    );

    if (activeBinanceLayers.length >= QUEUE_DEPTH) {
      return; // Sudah cukup 2 layer aktif di Binance
    }

    // Ambil layer PENDING berikutnya yang belum dikirim ke Binance (orderId masih kosong)
    const nextQueuedLayer = pos.layers.find(
      (l) => l.status === 'PENDING' && !l.orderId && l.layerIndex > 0
    );

    if (!nextQueuedLayer) {
      return; // Semua layer sudah terpasang atau terisi
    }

    logger.log(
      'INFO',
      `🚀 [SMART GRID QUEUE] ${pos.symbol}: Memajukan Layer #${nextQueuedLayer.layerIndex} dari antrean ke Binance Limit Order @ $${nextQueuedLayer.price.toFixed(6)} (Qty: ${nextQueuedLayer.qty})`,
      pos.symbol
    );

    try {
      const res = await binanceFutures.placeLimitOrder(
        pos.symbol,
        'SELL',
        nextQueuedLayer.qty,
        nextQueuedLayer.price,
        false
      );

      if (res?.orderId) {
        nextQueuedLayer.orderId = String(res.orderId);
        this.auditTradeLifecycle(pos.symbol, 'GRID_LAYER_PLACED', {
          layerIndex: nextQueuedLayer.layerIndex,
          side: 'SELL',
          price: nextQueuedLayer.price,
          qty: nextQueuedLayer.qty,
          orderId: nextQueuedLayer.orderId,
          status: 'ACTIVE_FROM_QUEUE',
        });
        logger.log(
          'SUCCESS',
          `✅ [GRID QUEUE AKTIF] ${pos.symbol}: Layer #${nextQueuedLayer.layerIndex} berhasil dipasang di Binance (Order ID: #${nextQueuedLayer.orderId})`,
          pos.symbol
        );
      } else {
        const errMsg = res?.msg || res?.message || JSON.stringify(res);
        logger.log(
          'WARN',
          `⚠️ [GRID QUEUE GAGAL] ${pos.symbol}: Gagal memasang Layer #${nextQueuedLayer.layerIndex}. Alasan: ${errMsg}`,
          pos.symbol
        );
      }
    } catch (e: any) {
      logger.log('ERROR', `❌ [GRID QUEUE ERROR] ${pos.symbol} Layer #${nextQueuedLayer.layerIndex}: ${e.message}`, pos.symbol);
    }
  }

  /**
   * Menangani event ORDER_TRADE_UPDATE seketika (<50ms) dari Private User Data Stream Binance
   * 1. Menghabisi semua order grid tersisa seketika saat Take Profit terisi (Mencegah bencana TAKEUSDT)
   * 2. Menutup posisi seketika dan mencatat profit riil
   * 3. Memperbarui ukuran Take Profit dan memajukan antrean Smart Grid Queue saat layer limit terisi
   */
  private async handleUserOrderTradeUpdate(order: any) {
    if (!order || !order.s) return;
    const symbol = order.s;
    const pos = this.activePositions.get(symbol);
    if (!pos) return;
    if (pos.status === 'CLOSING' || pos.status === 'CLOSED') return;

    const orderId = String(order.i);
    const side = order.S; // 'BUY' | 'SELL'
    const status = order.X; // 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELED' | 'EXPIRED' | 'NEW'
    const isReduceOnly = Boolean(order.R);
    const fillPrice = parseFloat(order.ap || order.L || '0');
    const filledQty = parseFloat(order.z || order.l || '0');
    const realizedProfit = parseFloat(order.rp || '0');

    // 1. ORDER BUY TERISI: TAKE PROFIT
    if (side === 'BUY' && (status === 'FILLED' || status === 'PARTIALLY_FILLED')) {
      const isTpMatch = (pos.tpOrderId && String(pos.tpOrderId) === orderId) ||
                        (pos.tp2OrderId && String(pos.tp2OrderId) === orderId) ||
                        isReduceOnly;

      if (isTpMatch) {
        if (status === 'FILLED') {
          // Kasus Partial TP (Tahap 1 selesai)
          if (this.config.exit.partialTpEnabled && !pos.partialTpDone && pos.tpOrderId && String(pos.tpOrderId) === orderId) {
            logger.log(
              'SUCCESS',
              `⚡ [USER STREAM] TP1 terisi instan untuk ${symbol} @ $${fillPrice}! Membatalkan antrean jaring & mengaktifkan BEP...`,
              symbol
            );
            await binanceFutures.cancelAllOrders(symbol).catch(() => {});
            const livePos = await binanceFutures.getOpenPosition(symbol).catch(() => null);
            if (livePos) {
              await this.handleLivePartialTpHit(pos, livePos);
            }
            return;
          }

          // Full Take Profit Hit!
          const exitReason = pos.isBepDefenseActive ? 'BEP_DEFENSE' : 'TAKE_PROFIT';
          logger.log(
            'SUCCESS',
            pos.isBepDefenseActive
              ? `🛡️ [BEP DEFENSE TERISI INSTAN] ${symbol}: Modal berhasil diselamatkan di BEP @ $${fillPrice}! Realized PnL: +$${realizedProfit.toFixed(4)}. Seketika membatalkan SELURUH antrean order di Binance!`
              : `🎯 [USER STREAM INSTANT TP] ${symbol} Take Profit FILLED @ $${fillPrice}! Realized PnL: +$${realizedProfit.toFixed(4)}. Seketika membatalkan SELURUH antrean order di Binance!`,
            symbol
          );

          // KRITIKAL: Batalkan seluruh order sisa (<30ms) agar layer tidak terisi jika ada spike balik
          await binanceFutures.cancelAllOrders(symbol).catch(() => {});

          // Tandai seluruh layer pending tersisa sebagai CANCELLED
          if (pos.layers) {
            for (const l of pos.layers) {
              if (l.status === 'PENDING') l.status = 'CANCELLED';
            }
          }

          // Tutup trade secara resmi dan catat realized profit
          await this.closePosition(pos, exitReason, fillPrice > 0 ? fillPrice : pos.targetTpPrice);
          return;
        }
      }
    }

    // 2. ORDER SELL TERISI: GRID LAYER TERISI
    if (side === 'SELL' && status === 'FILLED') {
      let layer = pos.layers.find((l) => l.orderId && String(l.orderId) === orderId);
      if (!layer) {
        layer = pos.layers.find((l) => l.status === 'PENDING' && fillPrice > 0 && Math.abs(l.price - fillPrice) / fillPrice < 0.005);
      }

      if (layer && layer.status === 'PENDING') {
        layer.status = 'FILLED';
        layer.filledAt = Date.now();
        if (!layer.orderId) layer.orderId = orderId;

        logger.log(
          'SNIPER',
          `🕸️ [USER STREAM LAYER FILLED] ${symbol} Layer #${layer.layerIndex} terisi instan @ $${fillPrice}! Total Qty bertambah...`,
          symbol
        );

        // Ambil posisi riil untuk sinkronisasi akurat volume dan break-even price
        const livePos = await binanceFutures.getOpenPosition(symbol).catch(() => null);
        if (livePos && Math.abs(livePos.positionAmt) > 0) {
          pos.totalQty = Math.abs(livePos.positionAmt);
          if (livePos.entryPrice > 0) {
            pos.avgEntryPrice = livePos.entryPrice;
          }
          if (livePos.breakEvenPrice && livePos.breakEvenPrice > 0) {
            pos.breakEvenPrice = livePos.breakEvenPrice;
          }
          const exitCfg = this.config.exit;
          const tpCalc = this.calculatePositionTpPrices(pos);
          pos.targetTpPrice = tpCalc.targetTpPrice;
          pos.targetTp2Price = tpCalc.targetTp2Price;

          if (tpCalc.isBepActive && !pos.isBepDefenseActive) {
            pos.isBepDefenseActive = true;
            pos.bepDefenseReason = tpCalc.bepReason;
            logger.log(
              'WARN',
              `🛡️ [BEP DEFENSE DIAKTIFKAN] ${pos.symbol}: ${tpCalc.bepReason}. Target TP dipindahkan ke BEP ($${pos.targetTpPrice.toFixed(6)}) demi mengamankan modal dari monster pump!`,
              pos.symbol
            );
          } else if (!tpCalc.isBepActive) {
            pos.isBepDefenseActive = false;
          }

          if (!pos.partialTpDone) {
            pos.hardSlPrice = pos.avgEntryPrice * (1 + exitCfg.hardStopLossPct / 100);
          }
          pos.totalMarginUsed = (pos.totalQty * pos.avgEntryPrice) / pos.leverage;

          this.updateTrailingSL(pos);

          // Reset status trailing runner saat layer averaging baru terisi
          pos.trailingTpActive = false;
          pos.lowestPrice = undefined;
          pos.peakPnlPct = 0;

          // Update order Limit TP di Binance dengan volume baru
          await this.syncLiveTakeProfitOrder(pos);

          // Pasang layer berikutnya dari Smart Grid Queue
          await this.deployNextGridLayerInQueue(pos);
        }
      }
    }

    // 3. ORDER SELL DIBATALKAN / EXPIRED
    if (side === 'SELL' && (status === 'CANCELED' || status === 'EXPIRED')) {
      const layer = pos.layers.find((l) => l.orderId && String(l.orderId) === orderId);
      if (layer && layer.status === 'PENDING') {
        layer.status = 'CANCELLED';
      }
    }
  }

  /**
   * Memasang atau memperbarui Order LIMIT BUY (Take Profit) langsung di buku pesanan Binance
   * Nol slippage & mendapatkan fee Maker (0.02%) yang jauh lebih hemat daripada market order
   */
  public async syncLiveTakeProfitOrder(pos: ActivePosition) {
    if (this.config.tradingMode !== 'LIVE' || !pos.targetTpPrice || pos.totalQty <= 0) return;
    if (this.syncingTpSymbols.has(pos.symbol)) return;
    this.syncingTpSymbols.add(pos.symbol);

    try {
      // 1. Batalkan SELURUH order BUY Take Profit lama yang ada di Binance untuk koin ini
      // Ini mencegah duplikasi order ganda dan error "ReduceOnly Order Failed" akibat sisa order di Binance
      try {
        const openOrders = await binanceFutures.getOpenOrders(pos.symbol);
        const existingBuyOrders = openOrders.filter((o: any) => o.side === 'BUY');
        for (const bo of existingBuyOrders) {
          await binanceFutures.cancelOrder(pos.symbol, bo.orderId).catch(() => {});
        }
      } catch { }

      pos.tpOrderId = undefined;
      pos.tp2OrderId = undefined;

      // Pastikan target TP valid untuk posisi SHORT (target TP harus di bawah harga entry rata-rata)
      if (pos.targetTpPrice >= pos.avgEntryPrice) {
        logger.log(
          'WARN',
          `⚠️ [TARGET TP TIDAK VALID] ${pos.symbol}: Target TP ($${pos.targetTpPrice.toFixed(6)}) >= Avg Entry ($${pos.avgEntryPrice.toFixed(6)}). Menunda order limit.`,
          pos.symbol
        );
        return;
      }

      const exitCfg = this.config.exit;

      // KASUS A: Partial TP Aktif dan Tahap 1 belum selesai -> Pasang DUAL LIMIT ORDER (TP1 50% & TP2 50%)
      if (exitCfg.partialTpEnabled && !pos.partialTpDone && !pos.isBepDefenseActive) {
        const ratio = exitCfg.partialTpRatio || 0.5;
        const plannedTp1Qty = pos.totalQty * ratio;
        const tp1Qty = parseFloat(binanceFutures.formatQty(pos.symbol, plannedTp1Qty));
        const tp2Qty = parseFloat(binanceFutures.formatQty(pos.symbol, pos.totalQty - tp1Qty));

        const tp1Price = pos.avgEntryPrice * (1 - exitCfg.takeProfitPct / 100);
        const tp2Price = pos.avgEntryPrice * (1 - (exitCfg.takeProfitPct * 2) / 100);
        pos.targetTpPrice = tp1Price;
        pos.targetTp2Price = tp2Price;

        const prec = binanceFutures.getPrecision(pos.symbol);
        const tp1Notional = tp1Qty * tp1Price;
        const tp2Notional = tp2Qty * tp2Price;
        const canSplit = tp1Qty > 0 && tp2Qty > 0 && tp1Notional >= prec.minNotional && tp2Notional >= prec.minNotional;

        if (canSplit) {
          const [tp1Res, tp2Res] = await Promise.all([
            binanceFutures.placeLimitOrder(pos.symbol, 'BUY', tp1Qty, tp1Price, true),
            binanceFutures.placeLimitOrder(pos.symbol, 'BUY', tp2Qty, tp2Price, true),
          ]);

          if (tp1Res?.orderId) {
            pos.tpOrderId = String(tp1Res.orderId);
            this.auditTradeLifecycle(pos.symbol, 'TP_LIMIT_PLACED', {
              side: 'BUY',
              targetTpPrice: tp1Price,
              qty: tp1Qty,
              orderId: pos.tpOrderId,
              status: 'ACTIVE_STAGE1',
            });
          }
          if (tp2Res?.orderId) {
            pos.tp2OrderId = String(tp2Res.orderId);
            this.auditTradeLifecycle(pos.symbol, 'TP_LIMIT_PLACED', {
              side: 'BUY',
              targetTpPrice: tp2Price,
              qty: tp2Qty,
              orderId: pos.tp2OrderId,
              status: 'ACTIVE_STAGE2',
            });
          }

          if (pos.tpOrderId && pos.tp2OrderId) {
            logger.log(
              'SUCCESS',
              `🎯 [DUAL LIMIT TP AKTIF] ${pos.symbol}: TP1 (50%) terpasang @ $${tp1Price.toFixed(6)} (Qty: ${tp1Qty}) & TP2 (50%) terpasang @ $${tp2Price.toFixed(6)} (Qty: ${tp2Qty}) [Maker 0.02%]`,
              pos.symbol
            );
            return;
          } else if (pos.tpOrderId || pos.tp2OrderId) {
            logger.log(
              'WARN',
              `⚠️ [DUAL TP SEBAGIAN] ${pos.symbol}: Satu order TP terpasang (TP1: ${pos.tpOrderId ? '#' + pos.tpOrderId : 'GAGAL'}, TP2: ${pos.tp2OrderId ? '#' + pos.tp2OrderId : 'GAGAL'}).`,
              pos.symbol
            );
            return;
          }
        } else {
          logger.log(
            'INFO',
            `ℹ️ [PARTIAL TP MIN-NOTIONAL] ${pos.symbol}: Volume/nosional pecahan ($${tp1Notional.toFixed(2)} / $${tp2Notional.toFixed(2)}) < minNotional Binance ($${prec.minNotional}). Memasang 100% Single Limit TP.`,
            pos.symbol
          );
        }
      }

      // KASUS B: Partial TP Aktif dan Tahap 1 sudah selesai -> Pasang Limit Order TP2 untuk sisa volume
      if (exitCfg.partialTpEnabled && pos.partialTpDone) {
        const tp2Price = pos.targetTp2Price || pos.avgEntryPrice * (1 - (exitCfg.takeProfitPct * 2) / 100);
        pos.targetTpPrice = tp2Price;
        const tpRes = await binanceFutures.placeLimitOrder(
          pos.symbol,
          'BUY',
          pos.totalQty,
          tp2Price,
          true
        );
        if (tpRes?.orderId) {
          pos.tp2OrderId = String(tpRes.orderId);
          this.auditTradeLifecycle(pos.symbol, 'TP_LIMIT_PLACED', {
            side: 'BUY',
            targetTpPrice: tp2Price,
            qty: pos.totalQty,
            orderId: pos.tp2OrderId,
            status: 'ACTIVE_STAGE2',
          });
          logger.log(
            'SUCCESS',
            `🎯 [STAGE 2 LIMIT TP AKTIF] ${pos.symbol}: Order Limit TP2 terpasang di Binance @ $${tp2Price.toFixed(6)} (Qty: ${pos.totalQty}, Order ID: #${pos.tp2OrderId})`,
            pos.symbol
          );
        }
        return;
      }

      // KASUS C: Single TP Biasa (100% Volume)
      const tpRes = await binanceFutures.placeLimitOrder(
        pos.symbol,
        'BUY',
        pos.totalQty,
        pos.targetTpPrice,
        true
      );

      if (tpRes?.orderId) {
        pos.tpOrderId = String(tpRes.orderId);
        this.auditTradeLifecycle(pos.symbol, 'TP_LIMIT_PLACED', {
          side: 'BUY',
          targetTpPrice: pos.targetTpPrice,
          qty: pos.totalQty,
          orderId: pos.tpOrderId,
          status: 'ACTIVE',
        });
        logger.log(
          'SUCCESS',
          pos.isBepDefenseActive
            ? `🛡️ [BEP DEFENSE LIMIT TP AKTIF] ${pos.symbol}: Order Limit Penyelamat Modal BEP terpasang di Binance @ $${pos.targetTpPrice.toFixed(6)} (Qty: ${pos.totalQty}, Order ID: #${pos.tpOrderId})`
            : `🎯 [LIMIT TP AKTIF] ${pos.symbol}: Order Limit Take Profit terpasang di Binance @ $${pos.targetTpPrice.toFixed(6)} (Qty: ${pos.totalQty}, Order ID: #${pos.tpOrderId})`,
          pos.symbol
        );
      } else {
        const errorDetail = tpRes?.msg || tpRes?.message || JSON.stringify(tpRes);
        logger.log(
          'ERROR',
          `❌ [LIMIT TP GAGAL] ${pos.symbol}: Gagal memasang order Take Profit di Binance. Alasan: ${errorDetail}`,
          pos.symbol
        );
      }
    } catch (err: any) {
      logger.log('ERROR', `❌ [LIMIT TP ERROR] ${pos.symbol}: ${err.message}`, pos.symbol);
      console.error(`Gagal syncLiveTakeProfitOrder untuk ${pos.symbol}:`, err.message);
    } finally {
      this.syncingTpSymbols.delete(pos.symbol);
    }
  }

  /**
   * Update trailing stop loss: tighten SL as grid fills to lock profit
   * Only tighten (lower), never relax (raise)
   */
  private updateTrailingSL(pos: ActivePosition) {
    if (!this.config.exit.trailingSlEnabled || !pos.layers) return;

    const exitCfg = this.config.exit;
    const leverage = pos.leverage || this.config.leverage || 5;

    // Calculate base SL from TP return (leverage-aware)
    const tpNominal = exitCfg.takeProfitPct / 100;
    const tpReturn = tpNominal * leverage;
    const maxSLReturn = tpReturn * (exitCfg.trailingSlMaxReturnRatio || 2.5);
    const baseSLNominal = maxSLReturn / leverage;

    // Find tier based on filled layers
    const filledCount = pos.layers.filter((l) => l.status === 'FILLED').length;
    let tierPercent = 1.0;

    if (exitCfg.trailingSlTiers && Array.isArray(exitCfg.trailingSlTiers)) {
      for (let i = exitCfg.trailingSlTiers.length - 1; i >= 0; i--) {
        const tier = exitCfg.trailingSlTiers[i];
        if (filledCount >= tier.filledLayerMin) {
          tierPercent = tier.percentOfBase || 1.0;
          break;
        }
      }
    }

    const newSlPercent = baseSLNominal * tierPercent;
    const newSlPrice = pos.avgEntryPrice * (1 + newSlPercent);

    // Only tighten SL (lower it), never relax
    if (newSlPrice < pos.hardSlPrice) {
      const oldSlPrice = pos.hardSlPrice;
      pos.hardSlPrice = newSlPrice;
      logger.log(
        'INFO',
        `📉 [TRAILING SL UPDATE] ${pos.symbol}: Tightened from $${oldSlPrice.toFixed(6)} → $${newSlPrice.toFixed(6)} (Filled: ${filledCount}/${pos.layers.length} layers, SL: ${(newSlPercent * 100).toFixed(2)}%, Ratio vs TP: ${(newSlPercent / tpNominal).toFixed(2)}x)`,
        pos.symbol
      );
      this.auditTradeLifecycle(pos.symbol, 'TRAILING_SL_UPDATED', {
        filledLayers: filledCount,
        totalLayers: pos.layers.length,
        oldSlPrice,
        newSlPrice,
        newSlPercent: (newSlPercent * 100).toFixed(2),
        slTpRatio: (newSlPercent / tpNominal).toFixed(2),
        status: 'TIGHTENED',
      });
    }
  }

  /**
   * Menutup posisi secara manual di harga pasar saat ini atas instruksi pengguna
   */
  public async manualClosePosition(symbol: string): Promise<boolean> {
    const pos = this.activePositions.get(symbol);
    if (!pos) return false;
    logger.log('WARN', `⚡ [TUTUP POSISI MANUAL] Menutup posisi ${symbol} atas instruksi pengguna.`);
    await this.closePosition(pos, 'MANUAL_CLOSE', pos.currentPrice || pos.avgEntryPrice);
    this.broadcastStatus();
    return true;
  }

  /**
   * Menutup posisi dan mencatat realized PnL
   */
  public async closePosition(
    pos: ActivePosition,
    reason: ClosedTrade['exitReason'],
    closePrice: number
  ) {
    if (this.closingSymbols.has(pos.symbol)) {
      logger.log('WARN', `⚠️ [DUPLIKAT DIHINDARI] Posisi ${pos.symbol} sudah dalam proses penutupan.`, pos.symbol);
      return;
    }
    if (pos.status === 'CLOSING' || pos.status === 'CLOSED') {
      logger.log('WARN', `⚠️ [DUPLIKAT DIHINDARI] Posisi ${pos.symbol} sudah dalam proses penutupan (status: ${pos.status}).`, pos.symbol);
      return;
    }

    this.closingSymbols.add(pos.symbol);
    pos.status = 'CLOSING';

    try {
      const durationSeconds = Math.round((Date.now() - pos.openedAt) / 1000);
      const pnl = (pos.avgEntryPrice - closePrice) * pos.totalQty;
      const finalRealizedPnl = Math.round((pnl + (pos.partialRealizedPnl || 0)) * 100) / 100;
      const pnlPct = Math.round(((pos.avgEntryPrice - closePrice) / pos.avgEntryPrice) * pos.leverage * 1000) / 10;

      let actualExitPrice = closePrice;
      let actualRealizedPnl = finalRealizedPnl;
      let actualPnlPct = pnlPct;
      let actualFee = 0;
      let closeResOrderId: string | undefined = undefined;

      if (this.config.tradingMode === 'LIVE') {
        // 1. Batalkan semua antrean order (TP & pending grid layers) terlebih dahulu
        await binanceFutures.cancelAllOrders(pos.symbol).catch(() => { });

        // 2. Ambil posisi riil di Binance setelah order dibatalkan untuk menghindari race condition
        let realPos: any = null;
        try {
          realPos = await binanceFutures.getOpenPosition(pos.symbol);
        } catch (e: any) {
          console.warn(`[closePosition] Gagal cek posisi riil ${pos.symbol}:`, e.message);
        }

        const isPositionAlreadyClosed = !realPos || Math.abs(realPos.positionAmt) === 0;
        const binanceAmt = realPos ? Math.abs(realPos.positionAmt) : 0;
        let closeQty = binanceAmt > 0 ? binanceAmt : pos.totalQty;

        // Proteksi Anti-Panic TP: Jika reason adalah TAKE_PROFIT pada mode LIVE tetapi posisi ternyata MASIH AKTIF di Binance,
        // DILARANG melempar Market Order terburu-buru yang memicu kerugian fee & slippage!
        // Kembalikan status SNIPING dan pasang ulang Limit TP Maker.
        if (reason === 'TAKE_PROFIT' && !isPositionAlreadyClosed && binanceAmt > 0) {
          logger.log(
            'WARN',
            `⚠️ [ANTI-PANIC TP] ${pos.symbol}: Permintaan Take Profit dibatalkan dari penutupan market karena posisi masih aktif (${binanceAmt} kontrak). Menyinkronkan Limit TP Maker kembali...`,
            pos.symbol
          );
          pos.status = 'SNIPING';
          this.closingSymbols.delete(pos.symbol);
          await this.syncLiveTakeProfitOrder(pos);
          return;
        }

        // Gembok Anti-Minus Trailing TP: Jika alasan adalah TRAILING_TP namun posisi masih aktif di Binance dan harga pasar riil sudah >= Modal (rugi untuk SHORT),
        // DILARANG melempar Market Order rugi! Batalkan penutupan market, kembalikan ke status SNIPING & pasang ulang Limit TP Maker.
        const currentMktPrice = pos.currentPrice || closePrice;
        const entryRef = (realPos?.entryPrice && realPos.entryPrice > 0) ? realPos.entryPrice : pos.avgEntryPrice;
        if (reason === 'TRAILING_TP' && !isPositionAlreadyClosed && binanceAmt > 0 && currentMktPrice >= entryRef) {
          logger.log(
            'WARN',
            `🛡️ [GEMBOK TRAILING TP] ${pos.symbol}: Eksekusi Trailing TP dibatalkan karena harga pasar ($${currentMktPrice.toFixed(6)}) sudah >= Modal ($${entryRef.toFixed(6)}). Menolak tutup rugi, Limit TP Maker dipasang kembali!`,
            pos.symbol
          );
          pos.status = 'SNIPING';
          pos.trailingTpActive = false;
          pos.lowestPrice = undefined;
          pos.peakPnlPct = 0;
          this.closingSymbols.delete(pos.symbol);
          await this.syncLiveTakeProfitOrder(pos);
          return;
        }

        // Anti-Orphan Sync: Jika ada layer baru yang terisi saat harga spike, sinkronkan totalQty memori ke riil Binance
        if (binanceAmt > 0 && Math.abs(binanceAmt - pos.totalQty) > 0.000001) {
          logger.log(
            'WARN',
            `🔄 [ANTI-ORPHAN SYNC] ${pos.symbol}: Sinkronisasi qty closing dari memori (${pos.totalQty}) ke riil Binance (${binanceAmt}) krn race-condition layer fill saat close/SL.`,
            pos.symbol
          );
          pos.totalQty = binanceAmt;
          if (realPos.entryPrice && realPos.entryPrice > 0) {
            pos.avgEntryPrice = realPos.entryPrice;
            pos.totalMarginUsed = (pos.totalQty * pos.avgEntryPrice) / pos.leverage;
          }
        }

        const isRealLong = realPos ? (realPos.positionSide === 'LONG' || (realPos.positionSide === 'BOTH' && realPos.positionAmt > 0)) : false;
        const actualClosingSide: 'BUY' | 'SELL' = isRealLong ? 'SELL' : 'BUY';

        this.auditTradeLifecycle(pos.symbol, 'FULL_CLOSE_REQUESTED', {
          side: actualClosingSide,
          qty: closeQty,
          reason,
          closePrice,
          status: 'SENT',
        });

        let fillExitPrice = 0;
        let execQty = 0;

        if (!isPositionAlreadyClosed && closeQty > 0) {
          this.auditOrderEvent(pos.symbol, 'CLOSE_POSITION_REQUESTED', {
            side: actualClosingSide,
            qty: closeQty,
            reason,
            closePrice,
            status: 'SENT',
          });
          const closeRes = await binanceFutures.closePositionMarket(pos.symbol, actualClosingSide, closeQty);
          if (closeRes?.orderId) {
            closeResOrderId = String(closeRes.orderId);
          }
          execQty = parseFloat(closeRes?.executedQty || '0');
          const cumQuote = parseFloat(closeRes?.cumQuote || '0');
          fillExitPrice = parseFloat(closeRes?.avgPrice || '0');
          if ((!fillExitPrice || fillExitPrice <= 0) && execQty > 0 && cumQuote > 0) {
            fillExitPrice = cumQuote / execQty;
          }

          if (fillExitPrice > 0) {
            actualExitPrice = fillExitPrice;
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 800));

        let confirmedClose = false;
        try {
          const recentTrades = await binanceFutures.getUserTrades(pos.symbol, 20);
          const minTime = pos.openedAt - 120000;
          const freshBuyTrades = recentTrades.filter((tr: any) => tr.side === 'BUY' && (!tr.time || tr.time >= minTime));

          if (pos.tpOrderId || pos.tp2OrderId) {
            const tpMatches = recentTrades.filter(
              (tr: any) =>
                (pos.tpOrderId && String(tr.orderId) === String(pos.tpOrderId)) ||
                (pos.tp2OrderId && String(tr.orderId) === String(pos.tp2OrderId))
            );
            if (tpMatches.length > 0) {
              confirmedClose = true;
            }
          }

          if (!confirmedClose && closeResOrderId) {
            const orderMatches = recentTrades.filter((tr: any) => String(tr.orderId) === String(closeResOrderId));
            if (orderMatches.length > 0) {
              confirmedClose = true;
            }
          }

          if (!confirmedClose && freshBuyTrades.length > 0) {
            confirmedClose = true;
          }

          let realPosAfterClose: any = null;
          try {
            realPosAfterClose = await binanceFutures.getOpenPosition(pos.symbol);
          } catch (e: any) {
            console.warn(`[closePosition] Gagal cek posisi riil pasca close ${pos.symbol}:`, e.message);
          }

          if (realPosAfterClose && Math.abs(realPosAfterClose.positionAmt) === 0) {
            confirmedClose = true;
          } else if (realPosAfterClose && Math.abs(realPosAfterClose.positionAmt) > 0) {
            const leftoverQty = Math.abs(realPosAfterClose.positionAmt);
            logger.log(
              'WARN',
              `🧹 [ORPHAN SWEEPER] ${pos.symbol}: Masih tersisa ${leftoverQty} kontrak di Binance setelah close. Menjalankan emergency sweep...`,
              pos.symbol
            );
            telegram.notifyEmergencyAlert(
              'Orphan Sweeper Terpicu 🧹',
              `Tersisa ${leftoverQty} kontrak pada ${pos.symbol} di Binance setelah close. Bot menjalankan emergency sweep market order.`,
              pos.symbol
            );
            try {
              const sweepSide: 'BUY' | 'SELL' = realPosAfterClose.positionAmt > 0 ? 'SELL' : 'BUY';
              await binanceFutures.closePositionMarket(pos.symbol, sweepSide, leftoverQty);
              await new Promise((resolve) => setTimeout(resolve, 600));
              realPosAfterClose = await binanceFutures.getOpenPosition(pos.symbol);
              if (!realPosAfterClose || Math.abs(realPosAfterClose.positionAmt) === 0) {
                confirmedClose = true;
              } else {
                confirmedClose = false;
              }
            } catch (sweepErr: any) {
              console.error(`[ORPHAN SWEEPER] Gagal sweep sisa posisi ${pos.symbol}:`, sweepErr.message);
              confirmedClose = false;
            }
          }

          if (!confirmedClose) {
            if (realPosAfterClose && Math.abs(realPosAfterClose.positionAmt) > 0) {
              pos.totalQty = Math.abs(realPosAfterClose.positionAmt);
            }
            logger.log(
              'WARN',
              `⚠️ [CLOSE NOT CONFIRMED] Posisi ${pos.symbol} belum terkonfirmasi tertutup di Binance. Local state tetap aktif agar tidak orphan.`,
              pos.symbol
            );
            telegram.notifyEmergencyAlert(
              'Posisi Belum Terkonfirmasi Tertutup di Binance ⚠️',
              `Order close untuk ${pos.symbol} belum terkonfirmasi di Binance. Local state tetap aktif agar tidak menjadi orphan. Bot akan mencoba rekonsiliasi otomatis.`,
              pos.symbol
            );
            this.auditOrderEvent(pos.symbol, 'CLOSE_SHORT_NOT_CONFIRMED', {
              reason,
              closePrice,
              status: 'PENDING',
            });
            pos.status = 'SNIPING';
            return;
          }

          this.auditOrderEvent(pos.symbol, 'CLOSE_SHORT_CONFIRMED', {
            reason,
            closePrice,
            actualExitPrice,
            status: 'CONFIRMED',
          });
          this.auditTradeLifecycle(pos.symbol, 'FULL_CLOSE_CONFIRMED', {
            side: 'BUY',
            reason,
            actualExitPrice,
            realizedPnl: actualRealizedPnl,
            status: 'CONFIRMED',
          });

          if (recentTrades.length > 0) {
            let closingTrades: any[] = [];
            if (pos.tpOrderId || pos.tp2OrderId) {
              closingTrades = recentTrades.filter(
                (tr: any) =>
                  (pos.tpOrderId && String(tr.orderId) === String(pos.tpOrderId)) ||
                  (pos.tp2OrderId && String(tr.orderId) === String(pos.tp2OrderId))
              );
            }
            if (closingTrades.length === 0 && closeResOrderId) {
              closingTrades = recentTrades.filter((tr: any) => String(tr.orderId) === String(closeResOrderId));
            }
            if (closingTrades.length === 0) {
              closingTrades = recentTrades.filter(
                (tr: any) => tr.side === 'BUY' && (!tr.time || tr.time >= minTime)
              );
            }

            if (closingTrades.length === 0 && (pos.tp2OrderId || pos.tpOrderId)) {
              try {
                const targetOid = pos.tp2OrderId || pos.tpOrderId;
                const tpOrder = await binanceFutures.getOrder(pos.symbol, targetOid!);
                if (tpOrder && parseFloat(tpOrder.avgPrice || '0') > 0) {
                  actualExitPrice = parseFloat(tpOrder.avgPrice);
                }
              } catch { }
            }

            if (closingTrades.length > 0) {
              let binancePnlSum = 0;
              let binanceFeeSum = 0;
              let totalTradedQty = 0;
              let totalTradedQuote = 0;

              // Ambil harga BNB jika ada komisi yang dibayar dengan BNB untuk konversi akurat ke USDT
              let bnbPrice = 0;
              const hasBnbFee = closingTrades.some((tr: any) => tr.commissionAsset === 'BNB') ||
                recentTrades.some((tr: any) => tr.side === 'SELL' && (!tr.time || tr.time >= minTime) && tr.commissionAsset === 'BNB');
              if (hasBnbFee) {
                bnbPrice = await binanceFutures.getBnbPrice();
              }

              for (const tr of closingTrades) {
                binancePnlSum += parseFloat(tr.realizedPnl || '0');
                const rawComm = parseFloat(tr.commission || '0');
                const feeInUsdt = tr.commissionAsset === 'BNB' ? rawComm * (bnbPrice || 600) : rawComm;
                binanceFeeSum += feeInUsdt;
                const tQty = parseFloat(tr.qty || '0');
                const tPrice = parseFloat(tr.price || '0');
                totalTradedQty += tQty;
                totalTradedQuote += tQty * tPrice;
              }

              const openingTrades = recentTrades.filter(
                (tr: any) => tr.side === 'SELL' && (!tr.time || tr.time >= minTime)
              );
              for (const otr of openingTrades) {
                const rawComm = parseFloat(otr.commission || '0');
                const feeInUsdt = otr.commissionAsset === 'BNB' ? rawComm * (bnbPrice || 600) : rawComm;
                binanceFeeSum += feeInUsdt;
              }

              if (totalTradedQty > 0) {
                actualExitPrice = totalTradedQuote / totalTradedQty;
              }

              actualFee = Math.round(binanceFeeSum * 1000) / 1000;
              const netBinancePnl = binancePnlSum - actualFee;
              actualRealizedPnl = Math.round(netBinancePnl * 100) / 100;
              const marginBase = pos.totalMarginUsed > 0 ? pos.totalMarginUsed : 1;
              actualPnlPct = Math.round((actualRealizedPnl / marginBase) * 1000) / 10;

              const isTpOrderMatch = pos.tpOrderId || pos.tp2OrderId
                ? closingTrades.some(
                    (tr: any) =>
                      (pos.tpOrderId && String(tr.orderId) === String(pos.tpOrderId)) ||
                      (pos.tp2OrderId && String(tr.orderId) === String(pos.tp2OrderId))
                  )
                : false;

              if (reason === 'TAKE_PROFIT' && isPositionAlreadyClosed && !isTpOrderMatch) {
                reason = 'MANUAL_CLOSE';
                logger.log('INFO', `⚡ [MANUAL CLOSE TERDETEKSI] ${pos.symbol}: Posisi ditutup secara manual di Binance.`, pos.symbol);
              } else if ((reason === 'TAKE_PROFIT' || reason === 'TRAILING_TP' || reason === 'BEP_DEFENSE') && actualRealizedPnl < 0) {
                const origReason = reason;
                reason = 'FEE_LOSS_EXIT';
                logger.log(
                  'WARN',
                  `💸 [FEE / SLIPPAGE > PROFIT] ${pos.symbol}: ${origReason === 'BEP_DEFENSE' ? 'BEP Defense' : origReason === 'TRAILING_TP' ? 'Trailing TP' : 'TP'} tereksekusi tapi PnL riil -$${Math.abs(actualRealizedPnl).toFixed(2)} (fee/slippage melebihi profit). Margin: $${pos.totalMarginUsed.toFixed(2)}`,
                  pos.symbol
                );
              }

              logger.log(
                actualRealizedPnl >= 0 ? 'SUCCESS' : 'WARN',
                `📊 [BINANCE PNL SYNC] ${pos.symbol}: Entry Riil: $${pos.avgEntryPrice.toFixed(6)} | Exit Riil: $${actualExitPrice.toFixed(6)} | Gross: $${binancePnlSum.toFixed(4)} | Fee: $${actualFee.toFixed(4)} USDT | Net PnL: ${actualRealizedPnl >= 0 ? '+' : ''}$${actualRealizedPnl.toFixed(2)} USDT`,
                pos.symbol
              );
            } else if (fillExitPrice > 0) {
              const grossPnl = (pos.avgEntryPrice - fillExitPrice) * (execQty > 0 ? execQty : pos.totalQty);
              const estFee = (pos.avgEntryPrice + fillExitPrice) * (execQty > 0 ? execQty : pos.totalQty) * 0.00045;
              actualFee = Math.round(estFee * 1000) / 1000;
              actualRealizedPnl = Math.round((grossPnl - actualFee + (pos.partialRealizedPnl || 0)) * 100) / 100;
              const marginBase = pos.totalMarginUsed > 0 ? pos.totalMarginUsed : 1;
              actualPnlPct = Math.round((actualRealizedPnl / marginBase) * 1000) / 10;
            } else {
              const grossPnl = pnl;
              const estFee = (pos.avgEntryPrice + closePrice) * pos.totalQty * 0.00045;
              actualFee = Math.round(estFee * 1000) / 1000;
              actualRealizedPnl = Math.round((grossPnl - actualFee + (pos.partialRealizedPnl || 0)) * 100) / 100;
              const marginBase = pos.totalMarginUsed > 0 ? pos.totalMarginUsed : 1;
              actualPnlPct = Math.round((actualRealizedPnl / marginBase) * 1000) / 10;
            }

            // Final sweep: Batalkan seluruh sisa order di Binance agar tidak ada order liar tertinggal
            await binanceFutures.cancelAllOrders(pos.symbol).catch(() => { });
          }
        } catch (e: any) {
          console.warn(`[Sync PnL] Menggunakan kalkulasi lokal: ${e.message}`);
        }
      } else {
        // Mode PAPER TRADING: Potong estimasi komisi riil Binance (round-trip ~0.07% notional)
        const entryFee = pos.avgEntryPrice * pos.totalQty * 0.00035;
        const exitFee = closePrice * pos.totalQty * (reason === 'TAKE_PROFIT' ? 0.0002 : 0.0005);
        actualFee = Math.round((entryFee + exitFee) * 1000) / 1000;
        actualRealizedPnl = Math.round((finalRealizedPnl - actualFee) * 100) / 100;
        const marginBase = pos.totalMarginUsed > 0 ? pos.totalMarginUsed : 1;
        actualPnlPct = Math.round((actualRealizedPnl / marginBase) * 1000) / 10;
        this.virtualBalance += actualRealizedPnl;
      }

      const filledLayersCount = (pos.layers || []).filter((l) => l.status === 'FILLED').length;
      const totalLayersCount = (pos.layers || []).length;

      const trade: ClosedTrade = {
        id: Math.random().toString(36).substring(2, 9),
        symbol: pos.symbol,
        side: 'SHORT',
        entryPrice: parseFloat(binanceFutures.formatPrice(pos.symbol, pos.avgEntryPrice)),
        exitPrice: parseFloat(binanceFutures.formatPrice(pos.symbol, actualExitPrice)),
        qty: pos.totalQty,
        marginUsed: pos.totalMarginUsed,
        realizedPnl: actualRealizedPnl,
        grossPnl: Math.round((actualRealizedPnl + actualFee) * 100) / 100,
        fee: actualFee,
        pnlPct: actualPnlPct,
        durationSeconds,
        exitReason: reason,
        isPaper: this.config.tradingMode === 'PAPER',
        closedAt: new Date().toLocaleTimeString('id-ID'),
        timestamp: Date.now(),
        layersFilled: `${filledLayersCount}/${totalLayersCount}`,
        layersDetail: (pos.layers || []).map((l) => ({
          layerIndex: l.layerIndex,
          price: l.price,
          qty: l.qty,
          marginUsdt: l.marginUsdt,
          status: l.status,
        })),
        paramsSnapshot: {
          marginPerLayerUsdt: this.config.grid.marginPerLayerUsdt,
          totalLayers: this.config.grid.totalLayers,
          layerSpacingPct: this.config.grid.layerSpacingPct,
          martingaleMultiplier: this.config.grid.martingaleMultiplier,
          maxTotalMarginPerCoin: this.config.grid.maxTotalMarginPerCoin,
          takeProfitPct: this.config.exit.takeProfitPct,
          hardStopLossPct: this.config.exit.hardStopLossPct,
          maxHoldMinutes: this.config.exit.maxHoldMinutes,
          spikeMinPercent: this.config.scanner.spikeMinPercent,
          leverage: this.config.leverage,
          marginType: this.config.marginType,
        },
      };

      this.closedTrades.unshift(trade);
      if (this.closedTrades.length > 100) this.closedTrades.pop();

      pos.status = 'CLOSED';
      this.activePositions.delete(pos.symbol);

      this.auditTradeLifecycle(pos.symbol, 'DB_TRADE_FINALIZED', {
        tradeId: trade.id,
        realizedPnl: trade.realizedPnl,
        exitReason: trade.exitReason,
        status: 'PERSISTED',
      });
      db.saveTrade(trade).then(() => this.syncTradesFromDb()).catch(() => { });
      db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });

      telegram.notifyTradeClosed(
        trade,
        this.config.tradingMode === 'PAPER' ? this.virtualBalance : undefined
      );

      const cooldownMinutes =
        trade.exitReason === 'EARLY_MOMENTUM_EXIT'
          ? this.config.exit.earlyExitCooldownMinutes || 60
          : trade.exitReason === 'HARD_STOP_LOSS'
            ? this.config.exit.hardStopCooldownMinutes || 180
            : trade.exitReason === 'BEP_DEFENSE'
              ? this.config.exit.bepCooldownMinutes || 15
              : this.config.scanner.cooldownMinutes || 10;
      this.scanner.setCooldown(pos.symbol, cooldownMinutes);
      logger.log(
        'INFO',
        `⏳ [COOLDOWN AKTIF] ${pos.symbol} diistirahatkan selama ${cooldownMinutes} menit (sampai ${new Date(Date.now() + cooldownMinutes * 60000).toLocaleTimeString('id-ID')}).`,
        pos.symbol
      );

      const isProfit = trade.realizedPnl >= 0;
      const reasonLabel =
        trade.exitReason === 'TAKE_PROFIT'
          ? '🎯 Take Profit (Pullback Wick)'
          : trade.exitReason === 'TRAILING_TP'
            ? '📈 Trailing Take Profit'
            : trade.exitReason === 'BEP_DEFENSE'
              ? '🛡️ BEP Defense (Penyelamatan Modal)'
            : trade.exitReason === 'HARD_STOP_LOSS'
              ? '🛑 Hard Stop Loss (Cut-Off)'
                  : trade.exitReason === 'EARLY_MOMENTUM_EXIT'
                    ? '⚠️ Early Momentum Exit'
              : trade.exitReason === 'FEE_LOSS_EXIT'
                ? '💸 TP Minus Fee (Biaya > Profit)'
                : trade.exitReason === 'TIME_LIMIT_EXIT'
                  ? '⏰ Batas Waktu Hold'
                  : 'Tutup Manual';

      logger.log(
        isProfit ? 'SUCCESS' : 'WARN',
        `🏁 [POSISI DITUTUP] ${pos.symbol} SHORT | Aksi: ${reasonLabel} | Entry: $${trade.entryPrice} ➜ Exit: $${trade.exitPrice} | PnL: ${trade.realizedPnl >= 0 ? '+' : ''}$${trade.realizedPnl} USDT (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct}%) | Durasi: ${durationSeconds} detik`,
        pos.symbol
      );

      this.broadcastStatus();
    } finally {
      this.closingSymbols.delete(pos.symbol);
      this.candle1mCache.delete(pos.symbol);
    }
  }

  /**
   * Cek apakah candle 1 menit saat ini berwarna MERAH (bearish / harga sedang turun).
   * Menggunakan caching cerdas berbasis openTime candle untuk menghemat kuota REST API.
   */
  private async isCurrent1mCandleBearish(symbol: string, currentPrice: number): Promise<boolean> {
    const now = Date.now();
    let cached = this.candle1mCache.get(symbol);

    // Refresh jika cache belum ada atau candle 1m sudah berganti menit (openTime + 60s <= now)
    if (!cached || now >= cached.openTime + 60_000 || now - cached.fetchedAt > 60_000) {
      try {
        const client = await binanceFutures.getHttpClient();
        const res = await client.get('/fapi/v1/klines', {
          params: { symbol, interval: '1m', limit: 2 },
          timeout: 1000,
        });
        if (Array.isArray(res.data) && res.data.length > 0) {
          const currentCandle = res.data[res.data.length - 1];
          const openTime = currentCandle[0];
          const open = parseFloat(currentCandle[1]);
          cached = { open, openTime, fetchedAt: now };
          this.candle1mCache.set(symbol, cached);
        }
      } catch (e: any) {
        logger.log('WARN', `⚠️ [CANDLE 1M CHECK] Gagal mengambil kline 1m ${symbol}: ${e.message}`, symbol);
      }
    }

    if (!cached || cached.open <= 0) {
      return false;
    }

    // Untuk posisi SHORT: Candle 1m MERAH jika harga saat ini lebih rendah dari harga Open candle berjalan
    return currentPrice < cached.open;
  }

  /**
   * Pengecekan batas waktu hold maksimal (Time-limit exit)
   * Dilengkapi fitur perpanjangan dinamis saat candle 1m sedang merah (bearish)
   */
  private async checkTimeLimitsAndTrailing() {
    const maxHoldMs = (this.config.exit.maxHoldMinutes || 10) * 60 * 1000;
    const now = Date.now();
    const extendEnabled = this.config.exit.extendHoldOnRedCandleEnabled ?? true;
    const extendSec = this.config.exit.extendHoldSeconds || 30;
    const maxExtensions = this.config.exit.maxHoldExtensions || 6;

    for (const pos of this.activePositions.values()) {
      if (pos.status !== 'SNIPING') continue;

      const totalAllowedMs = maxHoldMs + (pos.extendedHoldMs || 0);
      const holdDeadlineAt = pos.openedAt + totalAllowedMs;
      const holdRemainingMs = Math.max(0, holdDeadlineAt - now);
      pos.holdDeadlineAt = holdDeadlineAt;
      pos.holdRemainingSeconds = Math.ceil(holdRemainingMs / 1000);

      // Evaluasi perpanjangan jika sisa waktu <= extendSec (misal 30 detik) dan limit perpanjangan belum habis
      if (extendEnabled && pos.holdRemainingSeconds <= extendSec && (pos.extensionCount || 0) < maxExtensions) {
        // Guard rolling window: hanya evaluasi 1 kali per siklus perpanjangan
        const minGapMs = Math.max(10_000, (extendSec - 5) * 1000);
        if (!pos.lastExtensionAt || now - pos.lastExtensionAt >= minGapMs) {
          const isBearish = await this.isCurrent1mCandleBearish(pos.symbol, pos.currentPrice);
          pos.candle1mStatus = isBearish ? 'RED' : 'GREEN';

          if (isBearish) {
            pos.extendedHoldMs = (pos.extendedHoldMs || 0) + extendSec * 1000;
            pos.extensionCount = (pos.extensionCount || 0) + 1;
            pos.lastExtensionAt = now;

            const updatedTotalAllowed = maxHoldMs + pos.extendedHoldMs;
            pos.holdDeadlineAt = pos.openedAt + updatedTotalAllowed;
            pos.holdRemainingSeconds = Math.ceil(Math.max(0, pos.holdDeadlineAt - now) / 1000);

            logger.log(
              'INFO',
              `⏳ [HOLD EXTENDED] ${pos.symbol}: Candle 1m MERAH (Harga $${pos.currentPrice.toFixed(4)} sedang turun). Menambah waktu hold +${extendSec}s (Perpanjangan ke-${pos.extensionCount}/${maxExtensions}). Sisa waktu baru: ${pos.holdRemainingSeconds}s`,
              pos.symbol
            );
          }
        }
      }

      // Tentukan status holdAction untuk visualisasi dashboard
      if (pos.extensionCount && pos.extensionCount > 0) {
        pos.holdAction = pos.candle1mStatus === 'RED' ? 'WATCH' : (pos.currentPrice >= pos.avgEntryPrice ? 'CLOSE_NOW' : 'WATCH');
      } else {
        pos.holdAction = pos.currentPrice >= pos.avgEntryPrice ? 'CLOSE_NOW' : 'WATCH';
      }

      // Jika waktu benar-benar telah habis
      if (now - pos.openedAt >= totalAllowedMs) {
        const extraNote = pos.extensionCount ? ` (setelah ${pos.extensionCount}x perpanjangan)` : '';
        logger.log(
          'WARN',
          `⏰ [TIME LIMIT] ${pos.symbol} telah ditahan lebih dari ${this.config.exit.maxHoldMinutes} menit${extraNote}. Menutup posisi secara paksa...`,
          pos.symbol
        );
        this.closePosition(pos, 'TIME_LIMIT_EXIT', pos.currentPrice);
      }
    }
  }

  /**
   * Rekonsiliasi berkala posisi live dengan Binance matching engine
   */
  private async syncLivePositions() {
    if (this.config.tradingMode !== 'LIVE') return;

    try {
      const allLivePositions = await binanceFutures.getAllOpenPositions();

      // 1. Rekonsiliasi posisi aktif yang ada di memori bot
      for (const [symbol, pos] of this.activePositions.entries()) {
        try {
          const realPos = allLivePositions.find((p) => p.symbol === symbol);

          // Jika posisi sudah 0 / tidak ditemukan di Binance dan posisi bot sudah berjalan > 5 detik:
          // artinya posisi sudah tertutup otomatis di Binance (Limit Take Profit terisi oleh matching engine)
          if ((!realPos || Math.abs(realPos.positionAmt) === 0) && Date.now() - pos.openedAt > 5000 && pos.status === 'SNIPING') {
            let verifiedPos: any = realPos;
            if (!verifiedPos) {
              try {
                verifiedPos = await binanceFutures.getOpenPosition(symbol);
              } catch { }
            }
            if (!verifiedPos || Math.abs(verifiedPos.positionAmt) === 0) {
              let detectedReason: ClosedTrade['exitReason'] = 'TAKE_PROFIT';
              let detectedClosePrice = pos.targetTpPrice || pos.currentPrice;
              try {
                const trades = await binanceFutures.getUserTrades(symbol, 5);
                const latestBuy = trades.find((t: any) => t.side === 'BUY');
                if (latestBuy) {
                  const bPrice = parseFloat(latestBuy.price || '0');
                  const bPnl = parseFloat(latestBuy.realizedPnl || '0');
                  if (bPrice > 0) detectedClosePrice = bPrice;
                  if (bPnl < 0) {
                    detectedReason = 'HARD_STOP_LOSS';
                  } else if (pos.isBepDefenseActive) {
                    detectedReason = 'BEP_DEFENSE';
                  } else if (pos.tpOrderId && String(latestBuy.orderId) === String(pos.tpOrderId)) {
                    detectedReason = 'TAKE_PROFIT';
                  }
                }
              } catch {}
              logger.log('SUCCESS', `🎯 [REKONSILIASI LIVE] Posisi ${symbol} telah tertutup di Binance! Menyinkronkan eksekusi riil...`, symbol);
              await this.closePosition(pos, detectedReason, detectedClosePrice);
              continue;
            }
          }

          // Sinkronisasi kuantitas & avg entry price jika ada layer tambahan atau TP1 terisi di Binance
          if (realPos && Math.abs(realPos.positionAmt) > 0) {
            const isLiveLong = realPos.positionSide === 'LONG' || (realPos.positionSide === 'BOTH' && realPos.positionAmt > 0);
            if (isLiveLong && pos.side === 'SHORT') {
              logger.log(
                'ERROR',
                `🚨 [ANOMALI ARAH POSISI] ${symbol}: Di Binance terdeteksi posisi LONG (${realPos.positionAmt}), sedangkan bot memegang SHORT. Menolak sinkronisasi grid/TP agar tidak merusak posisi!`,
                symbol
              );
              continue;
            }

            const liveQty = Math.abs(realPos.positionAmt);
            if (Math.abs(pos.totalQty - liveQty) > 1e-6 || Math.abs(pos.avgEntryPrice - realPos.entryPrice) > 1e-6) {
              const oldQty = pos.totalQty;
              if (this.config.exit.partialTpEnabled && !pos.partialTpDone && liveQty < oldQty) {
                // TP1 terisi di Binance oleh matching engine (100% MAKER)!
                await this.handleLivePartialTpHit(pos, realPos);
              } else {
                pos.totalQty = liveQty;
                if (realPos.entryPrice > 0) {
                  pos.avgEntryPrice = realPos.entryPrice;
                  if (realPos.breakEvenPrice && realPos.breakEvenPrice > 0) {
                    pos.breakEvenPrice = realPos.breakEvenPrice;
                  }
                  const exitCfg = this.config.exit;
                  const tpCalc = this.calculatePositionTpPrices(pos);
                  pos.targetTpPrice = tpCalc.targetTpPrice;
                  pos.targetTp2Price = tpCalc.targetTp2Price;
                  if (tpCalc.isBepActive && !pos.isBepDefenseActive) {
                    pos.isBepDefenseActive = true;
                    pos.bepDefenseReason = tpCalc.bepReason;
                    logger.log(
                      'WARN',
                      `🛡️ [BEP DEFENSE DIAKTIFKAN] ${pos.symbol}: ${tpCalc.bepReason}. Target TP dipindahkan ke BEP ($${pos.targetTpPrice.toFixed(6)}) demi mengamankan modal dari monster pump!`,
                      pos.symbol
                    );
                  } else if (!tpCalc.isBepActive) {
                    pos.isBepDefenseActive = false;
                  }
                  if (!pos.partialTpDone) {
                    pos.hardSlPrice = pos.avgEntryPrice * (1 + exitCfg.hardStopLossPct / 100);
                  } else {
                    pos.hardSlPrice = pos.breakEvenPrice && pos.breakEvenPrice > 0 ? pos.breakEvenPrice : pos.avgEntryPrice * 0.9992;
                  }
                  pos.totalMarginUsed = (pos.totalQty * pos.avgEntryPrice) / pos.leverage;

                  // Tandai layer yang terisi secara riil di Binance
                  let accum = 0;
                  for (const layer of pos.layers) {
                    accum += layer.qty;
                    if (accum <= liveQty + 1e-4 && layer.status === 'PENDING') {
                      layer.status = 'FILLED';
                      layer.filledAt = Date.now();
                      logger.log(
                        'SNIPER',
                        `🕸️ [LAYER TERISI RIIL BINANCE] ${symbol} Layer #${layer.layerIndex} terisi di Binance! Total Qty: ${liveQty} @ Avg $${pos.avgEntryPrice.toFixed(6)}`,
                        symbol
                      );
                      // Update trailing SL when layer fills
                      this.updateTrailingSL(pos);
                    }
                  }

                  // Perbarui Limit Take Profit order di Binance jika kuantitas bertambah
                  if (liveQty > oldQty) {
                    pos.trailingTpActive = false;
                    pos.lowestPrice = undefined;
                    pos.peakPnlPct = 0;
                    await this.syncLiveTakeProfitOrder(pos);
                    await this.deployNextGridLayerInQueue(pos);
                  }
                }
              }
            }
          }

          // Pastikan posisi aktif SELALU memiliki order Limit Take Profit di Binance
          const isLiveLongPos = realPos && (realPos.positionSide === 'LONG' || (realPos.positionSide === 'BOTH' && realPos.positionAmt > 0));
          if (!isLiveLongPos && realPos && Math.abs(realPos.positionAmt) > 0 && pos.status === 'SNIPING' && !this.syncingTpSymbols.has(symbol)) {
            try {
              const openOrders = await binanceFutures.getOpenOrders(symbol);
              const hasTpOrder = openOrders.some((o: any) => o.side === 'BUY');
              if (!hasTpOrder) {
                const now = Date.now();
                if (!pos.lastTpAttempt || now - pos.lastTpAttempt >= 10000) {
                  pos.lastTpAttempt = now;
                  logger.log('WARN', `⚠️ [TP HILANG] ${symbol}: Tidak ada order Take Profit aktif di Binance. Memasang Limit TP baru...`, symbol);
                  await this.syncLiveTakeProfitOrder(pos);
                }
              }
            } catch { }
          }
        } catch (posErr: any) {
          console.warn(`[syncLivePositions] Gagal sinkron ${symbol}:`, posErr.message);
        }
      }

      // 2. ADOPSI POSISI YATIM (Orphan Positions):
      // Jika ada posisi aktif di Binance (seperti AMCUSDT atau IRENUSDT) yang belum ada di memori bot,
      // pulihkan kembali ke activePositions dan pasangkan Limit Take Profit agar tidak "Open Orders: 0"!
      for (const livePos of allLivePositions) {
        if (
          !this.activePositions.has(livePos.symbol) &&
          !this.deployingSymbols.has(livePos.symbol) &&
          Math.abs(livePos.positionAmt) > 0
        ) {
          const isLiveLong = livePos.positionSide === 'LONG' || (livePos.positionSide === 'BOTH' && livePos.positionAmt > 0);
          if (isLiveLong) {
            // Wick Sniper murni bot SHORT spike reversal. Jangan mengadopsi posisi LONG di Binance!
            continue;
          }

          logger.log(
            'WARN',
            `🔄 [RE-ADOPSI POSISI] Menemukan posisi aktif ${livePos.symbol} di Binance (Qty: ${Math.abs(livePos.positionAmt)}, Entry: $${livePos.entryPrice}). Memulihkan ke radar bot & memasang proteksi TP...`,
            livePos.symbol
          );

          const exitCfg = this.config.exit;
          const leverage = livePos.leverage || this.config.leverage || 10;
          const totalQty = Math.abs(livePos.positionAmt);
          const entryPrice = livePos.entryPrice;
          const targetTpPrice = entryPrice * (1 - exitCfg.takeProfitPct / 100);
          const hardSlPrice = entryPrice * (1 + exitCfg.hardStopLossPct / 100);

          const adoptedPos: ActivePosition = {
            id: `adopt_${livePos.symbol}_${Date.now()}`,
            symbol: livePos.symbol,
            side: 'SHORT',
            leverage,
            totalQty,
            avgEntryPrice: entryPrice,
            currentPrice: entryPrice,
            unrealizedPnl: livePos.unRealizedProfit || 0,
            pnlPct: 0,
            peakPnlPct: 0,
            totalMarginUsed: (totalQty * entryPrice) / leverage,
            layers: [
              {
                layerIndex: 0,
                price: entryPrice,
                qty: totalQty,
                marginUsdt: (totalQty * entryPrice) / leverage,
                status: 'FILLED',
                filledAt: Date.now(),
              },
            ],
            openedAt: Date.now(),
            targetTpPrice,
            hardSlPrice,
            status: 'SNIPING',
          };

          this.activePositions.set(livePos.symbol, adoptedPos);
          // Langsung pasangkan Limit Take Profit di Binance agar ada open order
          this.syncLiveTakeProfitOrder(adoptedPos).catch(() => { });
          this.broadcastStatus();
          db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });
        }
      }
    } catch (err: any) {
      console.error('Gagal syncLivePositions:', err.message);
    }
  }

  public getHistoricalTrades(limit: number = 50): ClosedTrade[] {
    return this.closedTrades.slice(0, limit);
  }

  public verifyPassword(password: string): boolean {
    const configured = this.config.security?.password || 'admin123';
    return String(password).trim() === configured;
  }

  public async changePassword(newPassword: string): Promise<boolean> {
    const cleaned = String(newPassword || '').trim();
    if (cleaned.length < 4) {
      throw new Error('Password baru minimal 4 karakter');
    }
    await this.saveConfig({
      security: {
        password: cleaned,
      },
    });
    logger.log('SUCCESS', '🔐 Password dashboard berhasil diperbarui.');
    return true;
  }

  private lastLoggedBalanceError: string = '';

  public async syncLiveBalance() {
    if (this.config.tradingMode !== 'LIVE') {
      return;
    }
    if (!this.config.apiKey || !this.config.apiSecret) {
      if (this.lastLoggedBalanceError !== 'NO_KEYS') {
        logger.log('WARN', '⚠️ [SINKRONISASI SALDO] API Key & Secret Binance belum diisi di Pengaturan.');
        this.lastLoggedBalanceError = 'NO_KEYS';
      }
      return;
    }
    try {
      binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
      const balances = await binanceFutures.getFuturesAccountBalance();
      if (balances.length > 0) {
        const usdt = balances.find((b) => b.asset === 'USDT') || balances.find((b) => b.asset === 'USDC');
        if (usdt) {
          const wasZero = this.realBalance === 0;
          this.realBalance = usdt.balance;
          this.liveAvailableBalance = usdt.availableBalance;
          this.broadcastStatus();
          this.lastLoggedBalanceError = '';
          if (wasZero && this.realBalance >= 0) {
            logger.log('SUCCESS', `💰 [SALDO BINANCE LIVE TERHUBUNG] Total Saldo: $${this.realBalance.toFixed(2)} USDT | Tersedia: $${this.liveAvailableBalance.toFixed(2)} USDT`);
          }
        }
      } else if (binanceFutures.lastBalanceError) {
        if (this.lastLoggedBalanceError !== binanceFutures.lastBalanceError) {
          logger.log('WARN', `⚠️ [SINKRONISASI SALDO GAGAL] Binance: ${binanceFutures.lastBalanceError}`);
          this.lastLoggedBalanceError = binanceFutures.lastBalanceError;
        }
      }
    } catch (e: any) {
      console.error('Gagal mengambil saldo riil Binance:', e.message);
    }
  }

  private getTodayWibDate(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
  }

  private getStartOfDayWibTimestamp(): number {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).formatToParts(now);
    const year = parseInt(parts.find((p) => p.type === 'year')!.value, 10);
    const month = parseInt(parts.find((p) => p.type === 'month')!.value, 10) - 1;
    const day = parseInt(parts.find((p) => p.type === 'day')!.value, 10);
    return Date.UTC(year, month, day) - 7 * 3600 * 1000;
  }

  private checkDailyReset() {
    const todayWib = this.getTodayWibDate();
    if (!this.lastResetDateWib) {
      this.lastResetDateWib = todayWib;
      return;
    }
    if (this.lastResetDateWib !== todayWib) {
      const oldDate = this.lastResetDateWib;
      this.lastResetDateWib = todayWib;
      this.spikesDetectedToday = 0;
      db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => {});
      logger.log('INFO', `🌅 [RESET HARIAN 00:00 WIB] Pergantian hari (${oldDate} ➔ ${todayWib} WIB). Metrik & lonjakan harian telah direset.`);
      this.broadcastStatus();
    }
  }

  public getClosedTrades(): ClosedTrade[] {
    return this.closedTrades;
  }

  public getRecentSpikes(): SpikeAlert[] {
    return this.scanner.getRecentSpikes();
  }

  public getStatus(): EngineStatus {
    this.checkDailyReset();
    const todayStartTs = this.getStartOfDayWibTimestamp();

    // Metrik Hari Ini (Sejak 00:00 WIB)
    const dailyTrades = this.closedTrades.filter((t) => t.timestamp >= todayStartTs);
    const dailyTradesCount = this.cachedDbStats ? this.cachedDbStats.dailyTrades : dailyTrades.length;
    const dailyWinsCount = this.cachedDbStats ? this.cachedDbStats.dailyWinsCount : dailyTrades.filter((t) => t.realizedPnl >= 0).length;
    const dailyLossesCount = this.cachedDbStats ? this.cachedDbStats.dailyLossesCount : (dailyTradesCount - dailyWinsCount);
    const dailyWinRate = this.cachedDbStats ? this.cachedDbStats.dailyWinRate : (dailyTradesCount > 0 ? Math.round((dailyWinsCount / dailyTradesCount) * 1000) / 10 : 0);
    const dailyPnl = this.cachedDbStats ? this.cachedDbStats.dailyPnl : Math.round(dailyTrades.reduce((acc, t) => acc + t.realizedPnl, 0) * 100) / 100;

    // Metrik All-Time (Riwayat Berjalan)
    const totalTrades = this.cachedDbStats ? this.cachedDbStats.totalTrades : this.closedTrades.length;
    const wins = this.cachedDbStats ? this.cachedDbStats.totalWins : this.closedTrades.filter((t) => t.realizedPnl >= 0).length;
    const winRate = this.cachedDbStats ? this.cachedDbStats.winRate : (totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0);
    const accumulatedPnl = this.cachedDbStats ? this.cachedDbStats.accumulatedPnl : Math.round(this.closedTrades.reduce((acc, t) => acc + t.realizedPnl, 0) * 100) / 100;

    if (this.config.tradingMode === 'LIVE' && this.realBalance === 0 && this.config.apiKey && this.config.apiSecret) {
      this.syncLiveBalance().then(() => this.broadcastStatus()).catch(() => { });
    }

    return {
      isRunning: this.isRunning,
      tradingMode: this.config.tradingMode,
      virtualBalance: Math.round(this.virtualBalance * 100) / 100,
      realBalance: this.config.tradingMode === 'LIVE' ? Math.round(this.realBalance * 100) / 100 : undefined,
      liveAvailableBalance: this.config.tradingMode === 'LIVE' ? Math.round(this.liveAvailableBalance * 100) / 100 : undefined,
      activePositionsCount: this.activePositions.size,
      spikesDetectedToday: this.spikesDetectedToday,
      totalTrades,
      winRate,
      accumulatedPnl,
      dailyPnl,
      dailyWinRate,
      dailyTradesCount,
      dailyWinsCount,
      dailyLossesCount,
      activePositions: Array.from(this.activePositions.values()),
      recentSpikes: this.scanner.getRecentSpikes(),
      recentTrades: this.closedTrades.slice(0, 20),
      cooldownCoins: this.scanner.getCooldowns(),
      monitoredCoinsCount: this.scanner.getTotalMonitoredSymbols(),
      ticksPerSecond: this.scanner.getTicksPerSecond(),
      marketDataAgeMs: this.scanner.getDataAgeMs(),
      leverage: this.config.leverage || 5,
      marginType: this.config.marginType || 'CROSSED',
      usedWeight1m: binanceFutures.lastUsedWeight,
      orderCount10s: binanceFutures.getOrderCount10s(),
      wsConnected: this.isRunning && (this.config.scanner?.dataSource === 'POLLING' || binanceFutures.isConnected()),
    };
  }

  public onStatus(callback: (status: EngineStatus) => void) {
    this.statusListeners.push(callback);
  }

  public onConfig(callback: (config: BotConfig) => void) {
    this.configListeners.push(callback);
  }

  private broadcastStatus() {
    const status = this.getStatus();
    for (const fn of this.statusListeners) {
      fn(status);
    }
  }

  private broadcastConfig() {
    for (const fn of this.configListeners) {
      fn(this.config);
    }
  }

  /**
   * Otomatis membaca ulang konfigurasi dari Database PostgreSQL jika terjadi perubahan "dari belakang"
   */
  public async syncConfigFromDb(): Promise<boolean> {
    if (!db.isConnected) {
      await db.init().catch(() => {});
      if (!db.isConnected) return false;
    }
    try {
      const dbCfg = await db.loadConfig();
      if (!dbCfg) return false;
      const raw = JSON.stringify(dbCfg);
      if (raw !== this.lastSyncedConfigJson) {
        const oldBalance = this.config.paperTrading?.initialVirtualBalance;
        this.lastSyncedConfigJson = raw;
        this.config = {
          ...this.config,
          ...dbCfg,
          exit: { ...this.config.exit, ...(dbCfg.exit || {}) },
          scanner: { ...this.config.scanner, ...(dbCfg.scanner || {}) },
          grid: { ...this.config.grid, ...(dbCfg.grid || {}) },
          risk: { ...this.config.risk, ...(dbCfg.risk || {}) },
          telegram: { ...this.config.telegram, ...(dbCfg.telegram || {}) },
          security: { ...this.config.security, ...(dbCfg.security || {}) },
        };
        try {
          fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
        } catch (e) {}
        this.scanner.updateConfig(this.config.scanner);
        if (this.config.telegram) {
          telegram.updateConfig(this.config.telegram);
        }
        if (this.isRunning) {
          binanceFutures.startTickerWebSocket(this.config.scanner.dataSource, this.config.scanner.pollingIntervalMs).catch(() => {});
        }
        if (this.config.apiKey && this.config.apiSecret) {
          binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
        }
        if (this.config.tradingMode === 'LIVE') {
          binanceFutures.startUserDataStream().catch(() => {});
          this.syncLiveBalance().catch(() => { });
        }
        if (
          this.config.paperTrading?.initialVirtualBalance !== undefined &&
          this.config.paperTrading.initialVirtualBalance !== oldBalance
        ) {
          this.virtualBalance = this.config.paperTrading.initialVirtualBalance;
          db.saveState(this.virtualBalance, Array.from(this.activePositions.values()), this.spikesDetectedToday).catch(() => { });
          logger.log('INFO', `💰 Saldo Paper Trading disesuaikan ke $${this.virtualBalance.toFixed(2)} USDT.`);
        }
        logger.log('INFO', '🔄 [DATABASE AUTO-SYNC] Konfigurasi bot otomatis diperbarui dari PostgreSQL!');
        this.broadcastConfig();
        this.broadcastStatus();
        return true;
      }

      // Cek apakah ada perubahan saldo manual di tabel wicksniper_state (hanya jika tidak ada posisi floating)
      if (this.activePositions.size === 0) {
        const dbState = await db.loadState();
        if (dbState && typeof dbState.virtualBalance === 'number') {
          if (Math.abs(dbState.virtualBalance - this.virtualBalance) > 0.01) {
            this.virtualBalance = dbState.virtualBalance;
            this.broadcastStatus();
          }
        }
      }
    } catch (e: any) {
      // ignore
    }
    return false;
  }

  public async syncTradesFromDb(): Promise<void> {
    if (!db.isConnected) return;
    try {
      const isPaper = this.config.tradingMode === 'PAPER';
      const [recentTrades, dbStats] = await Promise.all([
        db.loadRecentTrades(50, isPaper),
        db.getTradeStats(this.getStartOfDayWibTimestamp(), isPaper),
      ]);
      if (recentTrades && recentTrades.length >= 0) {
        this.closedTrades = recentTrades;
      }
      if (dbStats) {
        this.cachedDbStats = dbStats;
      }
    } catch (e: any) {
      // ignore
    }
  }

  public resetDemoWallet() {
    this.virtualBalance = this.config.paperTrading?.initialVirtualBalance || 245;
    this.closedTrades = [];
    this.cachedDbStats = null;
    this.activePositions.clear();
    db.clearAllTrades().catch(() => { });
    db.saveState(this.virtualBalance, [], 0).catch(() => { });
    logger.log('INFO', '🧹 Saldo dan riwayat trade demo berhasil di-reset.');
    this.broadcastStatus();
  }

  public async sendHeartbeatReport(): Promise<void> {
    if (!telegram.isConfigured()) return;
    const isLive = this.config.tradingMode === 'LIVE';
    const balanceStr = isLive
      ? `$${this.realBalance.toFixed(2)} USDT (Bebas: $${this.liveAvailableBalance.toFixed(2)})`
      : `$${this.virtualBalance.toFixed(2)} USDT`;
    const status = this.getStatus();
    await telegram.notifyHeartbeat({
      tradingMode: this.config.tradingMode,
      balanceStr,
      dailyPnl: status.dailyPnl ?? 0,
      dailyWins: status.dailyWinsCount || 0,
      dailyLosses: status.dailyLossesCount || 0,
      activePositionsCount: this.activePositions.size,
      monitoredCoins: this.scanner.getTotalMonitoredSymbols(),
      ticksPerSecond: this.scanner.getTicksPerSecond(),
      marketDataStale: (status.marketDataAgeMs ?? 0) >= 3000,
    });
  }
}
