import fs from 'fs';
import path from 'path';
import { ActivePosition, BotConfig, ClosedTrade, EngineStatus, GridLayer, SpikeAlert } from '../types';
import { binanceFutures } from './binance';
import { SpikeScanner } from './scanner';
import { logger } from './logger';
import { db } from './db';
import { telegram } from './telegram';

export class WickSniperEngine {
  private config: BotConfig;
  private configPath: string;
  private isRunning: boolean = false;
  private scanner: SpikeScanner;
  private virtualBalance: number = 1000;
  private activePositions: Map<string, ActivePosition> = new Map();
  private priceMomentum: Map<string, { price: number; time: number }[]> = new Map();
  private closingSymbols: Set<string> = new Set();
  private syncingTpSymbols: Set<string> = new Set();
  private orderAudit: Map<string, { lastEvent: string; lastTs: number; status: string }> = new Map();
  private closedTrades: ClosedTrade[] = [];
  private spikesDetectedToday: number = 0;
  private statusListeners: ((status: EngineStatus) => void)[] = [];
  private configListeners: ((config: BotConfig) => void)[] = [];
  private lastSyncedConfigJson: string = '';
  private tickInterval: NodeJS.Timeout | null = null;
  private realBalance: number = 0;
  private liveAvailableBalance: number = 0;
  private lastWeightWarnAt: number = 0;

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
      binanceFutures.startTickerWebSocket(this.config.scanner.dataSource).catch(() => {});
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
    this.lastSyncedConfigJson = JSON.stringify(this.config);
    await db.saveConfig(this.config).catch(() => { });
    if (this.config.tradingMode === 'LIVE') {
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
      const dbTrades = await db.loadRecentTrades(50);
      if (dbTrades.length > 0) {
        this.closedTrades = dbTrades;
      }
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
    await binanceFutures.startTickerWebSocket(this.config.scanner.dataSource);
    this.scanner.start();

    if (this.config.tradingMode === 'LIVE') {
      await binanceFutures.checkPositionMode();
      await this.syncLivePositions();
      await this.syncLiveBalance();
    }

    // Heartbeat ticker, time-limit check tiap 1 detik, sync live position tiap 3s, & sinkronisasi DB tiap 5 detik
    let tickCount = 0;
    if (!this.tickInterval) {
      this.tickInterval = setInterval(async () => {
        this.checkTimeLimitsAndTrailing();
        this.broadcastStatus();
        tickCount++;
        // Relaksasi interval sync posisi dan balance ke 5 detik (dari 3 detik) untuk menghemat kuota REST
        if (tickCount % 5 === 0 && this.config.tradingMode === 'LIVE') {
          await this.syncLivePositions();
          await this.syncLiveBalance();
        }
        if (tickCount % 5 === 0) {
          await this.syncConfigFromDb();
        }

        // Tampilkan log pemakaian Kuota API (Weight) setiap 15 detik jika ada aktivitas REST
        if (tickCount % 15 === 0) {
          const weight = binanceFutures.lastUsedWeight;
          if (weight > 0) {
            const ord10s = binanceFutures.getOrderCount10s();
            const pct = Math.round((weight / 2400) * 100);
            const level = pct >= 80 ? 'WARN' : 'INFO';
            logger.log(
              level,
              `📊 [API WEIGHT] Binance REST Quota: ${weight}/2400 (${pct}%) | Orders 10s: ${ord10s}/300`
            );
          }
        }

        // Peringatan otomatis jika kuota mendekati batas kritis (>= 1900 weight / ~80%)
        const currentWeight = binanceFutures.lastUsedWeight;
        if (currentWeight >= 1900 && (!this.lastWeightWarnAt || Date.now() - this.lastWeightWarnAt > 20000)) {
          this.lastWeightWarnAt = Date.now();
          logger.log(
            'WARN',
            `⚠️ [RATE LIMIT ALERT] Pemakaian kuota API Binance mencapai ${currentWeight}/2400 (${Math.round((currentWeight / 2400) * 100)}%)! Kurangi frekuensi request agar tidak terkena HTTP 429.`
          );
        }
        // Jika bot dihentikan dan semua posisi sudah tertutup, bersihkan interval
        if (!this.isRunning && this.activePositions.size === 0 && this.tickInterval) {
          clearInterval(this.tickInterval);
          this.tickInterval = null;
        }
      }, 1000);
    }
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

    // Cek kuota posisi aktif (di memori bot DAN di Binance aktual untuk mode LIVE)
    let currentActiveCount = this.activePositions.size;
    if (this.config.tradingMode === 'LIVE') {
      try {
        const livePositions = await binanceFutures.getAllOpenPositions();
        currentActiveCount = Math.max(currentActiveCount, livePositions.length);
      } catch { }
    }

    if (currentActiveCount >= this.config.grid.maxConcurrentCoins) {
      alert.status = 'SKIPPED';
      alert.skipReason = `Maksimal posisi aktif (${this.config.grid.maxConcurrentCoins}) tercapai`;
      logger.log('WARN', `⚡ Spike terdeteksi pada ${symbol} (+${alert.surgePct}%), namun dilewati: Kuota koin penuh (${currentActiveCount}/${this.config.grid.maxConcurrentCoins}).`);
      db.saveSpike(alert).catch(() => { });
      return;
    }

    // Cek apakah koin ini sudah memiliki posisi aktif di memori atau di Binance riil
    if (this.activePositions.has(symbol)) {
      alert.status = 'SKIPPED';
      alert.skipReason = `Sudah ada posisi aktif pada ${symbol}`;
      db.saveSpike(alert).catch(() => { });
      return;
    }

    if (this.config.tradingMode === 'LIVE') {
      try {
        const livePos = await binanceFutures.getOpenPosition(symbol);
        if (livePos && Math.abs(livePos.positionAmt) > 0) {
          alert.status = 'SKIPPED';
          alert.skipReason = `Posisi aktif sudah ada di Binance pada ${symbol} (Qty: ${Math.abs(livePos.positionAmt)})`;
          logger.log('WARN', `⚠️ [SKIP ORDER BARU] ${symbol} sudah punya posisi aktif di Binance. Bot menahan order baru agar tidak avg down/duplicate.`);
          db.saveSpike(alert).catch(() => { });
          return;
        }
      } catch (e: any) {
        logger.log('WARN', `⚠️ [CHECK LIVE POSISI] Gagal mengecek posisi aktif Binance ${symbol}: ${e.message}`);
      }
    }

    alert.status = 'EXECUTING';
    logger.log('SNIPER', `🚨 [SPONGE SPIKE DETECTED] ${symbol} melonjak +${alert.surgePct}% dalam ${alert.lookbackSeconds}s! Menembakkan Jaring SHORT bertingkat...`, symbol);
    db.saveSpike(alert).catch(() => { });

    await this.deployGridLadder(symbol, alert.currentPrice, alert.surgePct, alert.lookbackSeconds);
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
      // tunggu sejenak (120ms) lalu query posisi riil dari positionRisk atau userTrades
      if (!realEntryPrice || realEntryPrice <= 0) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          const realPos = await binanceFutures.getOpenPosition(symbol);
          if (realPos && Math.abs(realPos.positionAmt) > 0 && realPos.entryPrice > 0) {
            realEntryPrice = realPos.entryPrice;
            executedQty = Math.abs(realPos.positionAmt);
          } else {
            const recentTrades = await binanceFutures.getUserTrades(symbol, 3);
            const entryTrade = recentTrades.find(
              (t: any) => t.side === 'SELL' && (!res0.orderId || String(t.orderId) === String(res0.orderId))
            );
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

      // Siapkan payload batch order limit layer 1 ke atas
      const batchPayload = layers.slice(1).map((l) => ({
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
        for (const layer of layers.slice(1)) {
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

          for (let i = 0; i < batchRes.length && (i + 1) < layers.length; i++) {
            const item = batchRes[i];
            if (item?.orderId) {
              layers[i + 1].orderId = String(item.orderId);
              placedCount++;
            } else {
              failedCount++;
              layers[i + 1].status = 'CANCELLED';
              const code = item?.code || item?.error?.code;
              const msg = item?.msg || item?.error?.msg || (typeof item === 'string' ? item : '');
              if (!failureReason && (code || msg)) {
                failureReason = code ? `[${code}] ${msg}` : msg;
              }
            }
          }

          const totalRequested = layers.length - 1;
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
            totalLayers: layers.length - 1,
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
      // Proteksi anti-whipsaw / order propagation: beri waktu minimal 3 detik sejak order dibuka
      // dan pastikan harga pasar benar-benar di bawah avgEntryPrice (profit riil)
      const tradeAgeMs = Date.now() - pos.openedAt;
      if (currentPrice <= pos.targetTpPrice && currentPrice < pos.avgEntryPrice && tradeAgeMs >= 3000) {
        if (this.config.exit.partialTpEnabled && !pos.partialTpDone && pos.totalQty > 0) {
          if (this.config.tradingMode === 'LIVE') {
            try {
              const livePos = await binanceFutures.getOpenPosition(pos.symbol);
              if (!livePos || Math.abs(livePos.positionAmt) === 0) {
                // Seluruh posisi sudah tertutup (misal flash dump tembus TP1 & TP2 sekaligus)
                this.closePosition(pos, 'TAKE_PROFIT', pos.targetTpPrice);
                continue;
              }
              const currentLiveQty = Math.abs(livePos.positionAmt);
              if (currentLiveQty < pos.totalQty) {
                // TP1 sudah terisi sebagian di Binance sebagai MAKER!
                await this.handleLivePartialTpHit(pos, livePos);
                continue;
              }
              // Jika order limit TP1 & TP2 masih antre di Binance, biarkan Binance mengeksekusi sebagai MAKER!
              continue;
            } catch { }
          } else {
            // Mode PAPER TRADING:
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
        }

        // Jika Trailing TP aktif, aktifkan mode trailing agar profit bisa berlari lebih dalam
        if (this.config.exit.trailingTpEnabled) {
          pos.trailingTpActive = true;
          if (this.config.tradingMode === 'LIVE') {
            if (pos.tpOrderId) binanceFutures.cancelOrder(pos.symbol, pos.tpOrderId).catch(() => {});
            if (pos.tp2OrderId) binanceFutures.cancelOrder(pos.symbol, pos.tp2OrderId).catch(() => {});
            pos.tpOrderId = undefined;
            pos.tp2OrderId = undefined;
          }
          continue;
        }

        // Jika dalam mode LIVE dan memiliki Limit TP order yang terpasang di Binance:
        if (this.config.tradingMode === 'LIVE' && (pos.tpOrderId || pos.tp2OrderId)) {
          // Periksa apakah posisi di Binance sudah tertutup otomatis oleh Limit TP matching engine
          const openPos = await binanceFutures.getOpenPosition(pos.symbol);
          if (!openPos || Math.abs(openPos.positionAmt) === 0) {
            // Sudah terisi oleh Limit Order Binance di targetTpPrice tanpa slippage!
            this.closePosition(pos, 'TAKE_PROFIT', pos.targetTp2Price || pos.targetTpPrice);
            continue;
          }
          if (this.config.exit.partialTpEnabled && !pos.partialTpDone) {
            const currentLiveQty = Math.abs(openPos.positionAmt);
            if (currentLiveQty < pos.totalQty) {
              await this.handleLivePartialTpHit(pos, openPos);
              continue;
            }
          }
          // Jika posisi masih terbuka di Binance, biarkan Limit TP order dieksekusi oleh Binance matching engine
          // sebagai MAKER (bebas slippage & fee jauh lebih murah 0.02%).
          // JANGAN batalkan dan lempar Market Order terburu-buru yang memicu slippage dan rugi fee!
          continue;
        }

        this.closePosition(pos, 'TAKE_PROFIT', currentPrice);
        continue;
      }

      // C. TRAILING TAKE PROFIT
      // Proteksi volatilitas: minimal 5 detik sejak order dibuka, pnlPct minimal 1.0% (menutupi fee roundtrip),
      // dan harga pasar harus benar-benar di bawah avgEntryPrice (profit riil untuk SHORT)
      const trailingAgeMs = Date.now() - pos.openedAt;
      if (
        this.config.exit.trailingTpEnabled &&
        trailingAgeMs >= 5000 &&
        pos.peakPnlPct >= this.config.exit.takeProfitPct * pos.leverage
      ) {
        const dropFromPeak = pos.peakPnlPct - pos.pnlPct;
        const callbackThreshold = (this.config.exit.trailingCallbackPct || 0.4) * pos.leverage;
        if (dropFromPeak >= callbackThreshold && pos.pnlPct >= 1.0 && currentPrice < pos.avgEntryPrice) {
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
      pos.targetTpPrice = pos.avgEntryPrice * (1 - exitCfg.takeProfitPct / 100);
      pos.targetTp2Price = pos.avgEntryPrice * (1 - (exitCfg.takeProfitPct * 2) / 100);
      pos.hardSlPrice = pos.avgEntryPrice * (1 + exitCfg.hardStopLossPct / 100);

      logger.log(
        'INFO',
        `📊 [RECALCULATE AVG] ${pos.symbol}: Entry Rata-rata baru: $${pos.avgEntryPrice.toFixed(4)} | Volume: ${pos.totalQty} | TP1 Baru: $${pos.targetTpPrice.toFixed(4)}`,
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
      if (exitCfg.partialTpEnabled && !pos.partialTpDone) {
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
          `🎯 [LIMIT TP AKTIF] ${pos.symbol}: Order Limit Take Profit terpasang di Binance @ $${pos.targetTpPrice.toFixed(6)} (Qty: ${pos.totalQty}, Order ID: #${pos.tpOrderId})`,
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

        this.auditTradeLifecycle(pos.symbol, 'FULL_CLOSE_REQUESTED', {
          side: 'BUY',
          qty: closeQty,
          reason,
          closePrice,
          status: 'SENT',
        });

        let fillExitPrice = 0;
        let execQty = 0;

        if (!isPositionAlreadyClosed && closeQty > 0) {
          this.auditOrderEvent(pos.symbol, 'CLOSE_SHORT_REQUESTED', {
            side: 'BUY',
            qty: closeQty,
            reason,
            closePrice,
            status: 'SENT',
          });
          const closeRes = await binanceFutures.closePositionMarket(pos.symbol, 'BUY', closeQty);
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
          const minTime = pos.openedAt - 10000;
          const recentTrades = await binanceFutures.getUserTrades(pos.symbol, 20, minTime);
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
            try {
              await binanceFutures.closePositionMarket(pos.symbol, 'BUY', leftoverQty);
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

              for (const tr of closingTrades) {
                binancePnlSum += parseFloat(tr.realizedPnl || '0');
                binanceFeeSum += parseFloat(tr.commission || '0');
                const tQty = parseFloat(tr.qty || '0');
                const tPrice = parseFloat(tr.price || '0');
                totalTradedQty += tQty;
                totalTradedQuote += tQty * tPrice;
              }

              const openingTrades = recentTrades.filter(
                (tr: any) => tr.side === 'SELL' && (!tr.time || tr.time >= minTime)
              );
              for (const otr of openingTrades) {
                binanceFeeSum += parseFloat(otr.commission || '0');
              }

              if (totalTradedQty > 0) {
                actualExitPrice = totalTradedQuote / totalTradedQty;
              }

              const netBinancePnl = binancePnlSum - binanceFeeSum;
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
              } else if (reason === 'TAKE_PROFIT' && actualRealizedPnl < 0) {
                reason = 'FEE_LOSS_EXIT';
                logger.log(
                  'WARN',
                  `💸 [FEE > PROFIT] ${pos.symbol}: TP tereksekusi tapi PnL riil -$${Math.abs(actualRealizedPnl).toFixed(2)} (fee melebihi profit). Margin: $${pos.totalMarginUsed.toFixed(2)}`,
                  pos.symbol
                );
              }

              logger.log(
                actualRealizedPnl >= 0 ? 'SUCCESS' : 'WARN',
                `📊 [BINANCE PNL SYNC] ${pos.symbol}: Entry Riil: $${pos.avgEntryPrice.toFixed(6)} | Exit Riil: $${actualExitPrice.toFixed(6)} | Gross: $${binancePnlSum.toFixed(4)} | Fee: $${binanceFeeSum.toFixed(4)} | Net PnL: ${actualRealizedPnl >= 0 ? '+' : ''}$${actualRealizedPnl.toFixed(2)} USDT`,
                pos.symbol
              );
            } else if (fillExitPrice > 0) {
              const grossPnl = (pos.avgEntryPrice - fillExitPrice) * (execQty > 0 ? execQty : pos.totalQty);
              const estFee = (pos.avgEntryPrice + fillExitPrice) * (execQty > 0 ? execQty : pos.totalQty) * 0.0005;
              actualRealizedPnl = Math.round((grossPnl - estFee + (pos.partialRealizedPnl || 0)) * 100) / 100;
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
        this.virtualBalance += Math.round(pnl * 100) / 100;
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
      db.saveTrade(trade).catch(() => { });
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
            : this.config.scanner.cooldownMinutes || 10;
      this.scanner.setCooldown(pos.symbol, cooldownMinutes);

      const isProfit = trade.realizedPnl >= 0;
      const reasonLabel =
        trade.exitReason === 'TAKE_PROFIT'
          ? '🎯 Take Profit (Pullback Wick)'
          : trade.exitReason === 'TRAILING_TP'
            ? '📈 Trailing Take Profit'
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
    }
  }

  /**
   * Pengecekan batas waktu hold maksimal (Time-limit exit)
   */
  private checkTimeLimitsAndTrailing() {
    const maxHoldMs = (this.config.exit.maxHoldMinutes || 10) * 60 * 1000;
    const now = Date.now();

    for (const pos of this.activePositions.values()) {
      const holdDeadlineAt = pos.openedAt + maxHoldMs;
      const holdRemainingMs = Math.max(0, holdDeadlineAt - now);
      pos.holdDeadlineAt = holdDeadlineAt;
      pos.holdRemainingSeconds = Math.ceil(holdRemainingMs / 1000);
      pos.holdAction = pos.currentPrice >= pos.avgEntryPrice ? 'CLOSE_NOW' : 'WATCH';

      if (now - pos.openedAt >= maxHoldMs && pos.status === 'SNIPING') {
        logger.log('WARN', `⏰ [TIME LIMIT] ${pos.symbol} telah ditahan lebih dari ${this.config.exit.maxHoldMinutes} menit. Menutup posisi secara paksa...`, pos.symbol);
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
            logger.log('SUCCESS', `🎯 [REKONSILIASI LIVE] Posisi ${symbol} telah tertutup di Binance! Menyinkronkan eksekusi riil...`, symbol);
            await this.closePosition(pos, 'TAKE_PROFIT', pos.targetTpPrice || pos.currentPrice);
            continue;
          }

          // Sinkronisasi kuantitas & avg entry price jika ada layer tambahan atau TP1 terisi di Binance
          if (realPos && Math.abs(realPos.positionAmt) > 0) {
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
                  pos.targetTpPrice = pos.avgEntryPrice * (1 - exitCfg.takeProfitPct / 100);
                  pos.targetTp2Price = pos.avgEntryPrice * (1 - (exitCfg.takeProfitPct * 2) / 100);
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
                    await this.syncLiveTakeProfitOrder(pos);
                  }
                }
              }
            }
          }

          // Pastikan posisi aktif SELALU memiliki order Limit Take Profit di Binance
          if (realPos && Math.abs(realPos.positionAmt) > 0 && pos.status === 'SNIPING' && !this.syncingTpSymbols.has(symbol)) {
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
        if (!this.activePositions.has(livePos.symbol) && Math.abs(livePos.positionAmt) > 0) {
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

  public getStatus(): EngineStatus {
    const totalTrades = this.closedTrades.length;
    const wins = this.closedTrades.filter((t) => t.realizedPnl >= 0).length;
    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 1000) / 10 : 0;
    const accumulatedPnl = Math.round(this.closedTrades.reduce((acc, t) => acc + t.realizedPnl, 0) * 100) / 100;

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
    if (!db.isConnected) return false;
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
          telegram: { ...this.config.telegram, ...(dbCfg.telegram || {}) },
          security: { ...this.config.security, ...(dbCfg.security || {}) },
        };
        this.scanner.updateConfig(this.config.scanner);
        if (this.config.telegram) {
          telegram.updateConfig(this.config.telegram);
        }
        if (this.isRunning) {
          binanceFutures.startTickerWebSocket(this.config.scanner.dataSource).catch(() => {});
        }
        if (this.config.apiKey && this.config.apiSecret) {
          binanceFutures.configure(this.config.apiKey, this.config.apiSecret, this.config.isTestnet);
        }
        if (this.config.tradingMode === 'LIVE') {
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

  public resetDemoWallet() {
    this.virtualBalance = this.config.paperTrading?.initialVirtualBalance || 245;
    this.closedTrades = [];
    this.activePositions.clear();
    db.clearAllTrades().catch(() => { });
    db.saveState(this.virtualBalance, [], 0).catch(() => { });
    logger.log('INFO', '🧹 Saldo dan riwayat trade demo berhasil di-reset.');
    this.broadcastStatus();
  }
}
