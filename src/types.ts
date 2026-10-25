export interface BotConfig {
  tradingMode: 'PAPER' | 'LIVE';
  apiKey: string;
  apiSecret: string;
  isTestnet: boolean;
  leverage: number;
  marginType: 'CROSSED' | 'ISOLATED';
  scanner: {
    enabled: boolean;
    spikeLookbackSeconds: number;
    spikeMinPercent: number;
    volumeSpikeMultiplier: number;
    minPriceUsdt: number;
    maxPriceUsdt: number;
    max24hChangePct?: number; // Batas maksimal kenaikan 24 jam untuk menghindari monster pump (misal: 40.0)
    excludeSymbols: string[];
    cooldownMinutes: number;
    whitelistEnabled?: boolean;
    whitelistSymbols?: string[];
    dataSource?: 'WEBSOCKET' | 'POLLING';
    pollingIntervalMs?: number;
    skipBottomRejectionEnabled?: boolean;
    bottomRejectionMinRangePct?: number;
    bottomRejectionWickRatio?: number;
    upperWickPullbackEnabled?: boolean;
    upperWickPullbackMinPct?: number;
    upperWickPullbackMaxWaitSeconds?: number;
    upperWickCooldownMinutes?: number;
    min24hVolumeUsdt?: number;
    max24hVolumeUsdt?: number;
    blacklistTemporaryHours?: number;
    autoBlacklist?: boolean;
    maxSpreadPct?: number;
    tradeGapFilterEnabled?: boolean;
    maxTradeGapSeconds?: number;
    tradeGapCooldownMinutes?: number;
    minRsi1m?: number;
    minRsiCooldownMinutes?: number;
    minVolRatio?: number;
    minVolRatioCooldownMinutes?: number;
    maxVolRatio?: number;
    maxVolRatioCooldownMinutes?: number;
    emaTrendFilterEnabled?: boolean;
    emaTrendFastPeriod?: number;
    emaTrendSlowPeriod?: number;
    tradeQualityScoringEnabled?: boolean;
    tradeQualityThreshold?: number;
  };
  grid: {
    maxConcurrentCoins: number;
    totalLayers: number;
    layerSpacingPct: number;
    marginPerLayerUsdt: number;
    martingaleMultiplier: number;
    maxTotalMarginPerCoin: number;
  };
  exit: {
    takeProfitPct: number;
    takeProfit2Pct?: number;
    trailingTpEnabled: boolean;
    trailingCallbackPct: number;
    hardStopLossPct: number;
    atrDynamicSlTpEnabled?: boolean;
    atrPeriod?: number;
    atrSlMultiplier?: number;
    atrTpMultiplier?: number;
    atrDeferHardStopBeforeLastLayer?: boolean;
    atrMinLayersToProtect?: number;
    trailingSlEnabled?: boolean;
    trailingSlMaxReturnRatio?: number;
    trailingSlTiers?: Array<{ filledLayerMin: number; percentOfBase: number }>;
    maxHoldMinutes: number;
    earlyExitMomentumEnabled?: boolean;
    earlyExitMinBullishCandles?: number;
    earlyExitMinRisePct?: number;
    earlyExitCooldownMinutes?: number;
    earlyExitMinLayersPct?: number;
    earlyExitMinLossSlPct?: number;
    hardStopCooldownMinutes?: number;
    partialTpEnabled?: boolean;
    partialTpRatio?: number; // default 0.5 (50%)
    bepDefenseEnabled?: boolean;
    bepFinalLayerEnabled?: boolean;
    bepMaxLayersTrigger?: number;
    bepFastFillEnabled?: boolean;
    bepFastFillSeconds?: number;
    bepFastFillMinLayers?: number;
    bepBufferPct?: number;
    bepCooldownMinutes?: number;
    extendHoldOnRedCandleEnabled?: boolean;
    extendHoldSeconds?: number;
    maxHoldExtensions?: number;
  };
  paperTrading: {
    initialVirtualBalance: number;
  };
  risk?: {
    maxDailyLossUsdt?: number;
    minSafetyBalanceUsdt?: number;
  };
  telegram?: {
    enabled?: boolean;
    botToken?: string;
    chatId?: string;
    notifyOnNewOrder?: boolean;
    notifyOnLayerFill?: boolean;
    notifyOnClose?: boolean;
    notifyOnEmergency?: boolean;
    notifyOnAutoBlacklist?: boolean;
    notifyOnReversal?: boolean;
    heartbeatIntervalHours?: number;
  };
  triggerStrategy?: 'WICK_SNIPER' | 'SMART_MONEY' | 'HYBRID';
  smartMoney?: SmartMoneyConfig;
  momentumLong?: MomentumLongConfig;
  autoTuner?: AutoTunerConfig;
  security?: {
    password?: string;
  };
  server: {
    port: number;
  };
}

export interface SmartMoneyConfig {
  enabled: boolean;
  mode: 'STANDALONE' | 'FILTER_ONLY';
  direction: 'BOTH' | 'SHORT_ONLY' | 'LONG_ONLY';
  period: '5m' | '15m' | '1h';
  thresholdShortRatio: number; // e.g. 0.60 (Whale short >= 60%)
  thresholdLongRatio: number;  // e.g. 0.60 (Whale long >= 60%)
  retailTrapFilter: boolean;   // Konfirmasi retail di sisi berlawanan
  rsiFilterEnabled?: boolean;  // Filter RSI Anti-Pucuk/Lembah
  minRsiShort?: number;        // Batas minimal RSI untuk Short (e.g. 48)
  maxRsiShort?: number;        // Batas maksimal RSI untuk Short (e.g. 65 - Anti-Parabolic Pump/Squeeze)
  maxRsiLong?: number;         // Batas maksimal RSI untuk Long (e.g. 62)
  fundingRateFilterEnabled?: boolean; // Filter Funding Rate (Anti-Negative Funding Squeeze)
  minFundingRatePct?: number;         // Ambang batas minimal funding rate untuk Short (%, default -0.02%)
  maxFundingRatePct?: number;         // Ambang batas maksimal funding rate untuk Long (%, default +0.10%)
  whaleDistanceFilterEnabled?: boolean; // Filter Jarak Modal Paus (Anti-FOMO)
  maxWhaleDistancePct?: number;         // Maksimal toleransi jarak harga dari modal paus (%, default 1.5%)
  whaleHealthFilterEnabled?: boolean;   // Filter Kesehatan Paus: Hanya ikuti paus yang sehat/meraih laba (Anti-Nyangkut)
  minWhaleWinratePct?: number;          // Minimal % paus meraih laba (%, default 50%)
  maxWhaleAdverseLossPct?: number;      // Maksimal batas harga menembus modal paus ke arah rugi (%, default 0.8%)
  pullbackConfirmationEnabled?: boolean; // Menunggu pantulan/diskon sebelum eksekusi
  pullbackMinPct: number;      // Pullback minimal sebelum eksekusi (%)
  pullbackMaxWaitSeconds: number; // Batas tunggu konfirmasi pullback (detik)
  entryLayers: number;         // 1 = Single Sniper, 2-3 = Light DCA
  layerSpacingPct: number;     // Jarak antar layer jika entryLayers > 1
  marginUsdt?: number;         // Modal margin per posisi (USDT)
  leverage?: number;           // Leverage
  takeProfitPct?: number;      // Take Profit (%)
  trailingTpEnabled?: boolean; // Trailing Take Profit
  trailingCallbackPct?: number;// Trailing callback (%)
  stopLossPct?: number;        // Hard Stop Loss (%)
  structuralSlEnabled?: boolean; // Dynamic Stop Loss di atas/bawah modal paus
  structuralSlBufferPct?: number; // Buffer toleransi SL terhadap modal paus (%, default 0.3%)
  cooldownMinutes: number;     // Cooldown antar trade simbol yang sama
  maxConcurrentPositions?: number; // Maksimal koin/posisi aktif bersamaan untuk Smart Money
  scanIntervalSeconds?: number;// Interval pengecekan rasio pasar
  maxHoldHours?: number;       // Batas waktu hold posisi sebelum timeout paksa exit demi hindari funding fee drain (default: 8 jam, 0 = nonaktif)
  atrFilterEnabled?: boolean;  // Filter ATR Volatilitas (Anti-Koin Tidur/Sideways & Anti-Ekstrem)
  atrTimeframe?: '15m' | '1h'; // Timeframe kalkulasi ATR (default: '15m')
  atrPeriod?: number;          // Periode standar ATR (default: 14)
  minAtrPct?: number;          // Minimal % ATR terhadap harga (default: 0.8%)
  maxAtrPct?: number;          // Maksimal % ATR terhadap harga (default: 3.0%)
  atrDynamicSlTpEnabled?: boolean; // TP/SL Dinamis berbasis ATR
  atrSlMultiplier?: number;    // Pengali ATR untuk SL (default: 1.2x)
  maxStopLossPct?: number;     // Batas atas maksimal Stop Loss (%) agar tidak melebar berlebihan saat volatilitas tinggi (default: 2.5%)
  atrTpMultiplier?: number;    // Pengali ATR untuk TP (default: 1.8x)
  autoBepEnabled?: boolean;    // Auto pindah SL ke BEP (impas) saat posisi mencapai target profit awal
  atrBepTriggerMultiplier?: number; // Pengali ATR untuk memicu Auto-BEP (default: 1.0x)
  autoBepBufferPct?: number;   // Buffer profit di atas/bawah entry saat Auto-BEP aktif (%, default: 0.3%)
  signalDriver?: 'SMART_TRADER' | 'WHALE' | 'DUAL_CONFLUENCE'; // Pengemudi utama sinyal (default: 'SMART_TRADER')
  minWhaleRatio?: number;      // Ambang minimal rasio Paus saat mode SMART_TRADER (%, default: 30%)
  smartTraderFilterEnabled?: boolean; // Filter konfluensi: Wajib searah dengan Smart Trader (Top Accounts)
  smartTraderMinRatio?: number;      // Ambang minimal rasio Smart Trader (%, default: 50%)
  entryOrderType?: 'LIMIT' | 'MARKET'; // Tipe order entry: LIMIT (Maker 0.02% murah) vs MARKET (Taker 0.05%)
  limitWaitSeconds?: number;   // Batas waktu tunggu fill order limit sebelum dibatalkan (default: 15 detik)
  emaFilterEnabled?: boolean;  // Filter Konfirmasi Tren EMA (e.g. EMA 50 15m)
  emaTimeframe?: '5m' | '15m' | '1h'; // Timeframe EMA (default: '15m')
  emaPeriod?: number;          // Periode EMA (default: 50)
  btcTrendFilterEnabled?: boolean; // Filter Arah Tren Macro BTC (Anti-Dump & Anti-Pump Market Wide)
  btcTrendTimeframe?: '15m' | '1h' | '4h'; // Timeframe tren BTC (default: '1h')
  btcTrendEmaPeriod?: number;  // Periode EMA BTC (default: 50)
  btcDropThresholdPct?: number; // Ambang flash dump/surge BTC (%) (default: 1.0%)
}

export interface BtcTrendStatus {
  btcPrice: number;
  ema: number;
  trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
  changePct: number;
  isFlashDump: boolean;
  isFlashSurge: boolean;
  canLong: boolean;
  canShort: boolean;
  reason: string;
  timeframe?: string;
  period?: number;
  diffUsdt?: number;
  diffPct?: number;
  updatedAt?: number;
}

export interface SmartMoneySignal {
  id: string;
  symbol: string;
  side: 'SHORT' | 'LONG';
  signalDriver?: 'SMART_TRADER' | 'WHALE' | 'DUAL_CONFLUENCE';
  currentPrice: number;
  triggerPrice: number;
  whaleLongRatio: number;
  whaleShortRatio: number;
  whaleLongShortRatio: number;
  retailLongRatio: number;
  retailShortRatio: number;
  whaleAvgEntry?: number;
  whaleDistancePct?: number;
  whalePositionsUsdt?: number;
  whaleWinratePct?: number;
  whaleProfitWhales?: number;
  whaleTotalWhales?: number;
  smartTraderLongRatio?: number;
  smartTraderShortRatio?: number;
  smartTraderLongAvgEntry?: number;
  smartTraderShortAvgEntry?: number;
  smartTraderAligned?: boolean;
  atr?: number;
  atrPct?: number;
  btcTrendStatus?: {
    btcPrice: number;
    ema: number;
    trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    changePct?: number;
  };
  rsi15m?: number;
  fundingRatePct?: number;
  timestamp: number;
  status: 'PENDING' | 'EXECUTING' | 'SKIPPED' | 'COOLING_DOWN';
  reason?: string;
}

export interface MomentumLongConfig {
  enabled: boolean;
  minSurgePct?: number;
  minVolRatio?: number;
  maxRsiFilterEnabled?: boolean;
  maxRsi1m?: number;
  maxFundingRatePct?: number;
  marginUsdt?: number;
  leverage?: number;
  takeProfitPct?: number;
  trailingTpEnabled?: boolean;
  trailingActivationPct?: number;
  trailingCallbackPct?: number;
  stopLossPct?: number;
  maxHoldMinutes?: number;
  cooldownMinutes?: number;
}

export interface TickerSnapshot {
  symbol: string;
  price: number;
  time: number;
}

export interface SpikeSimResult {
  hypotheticalEntryPrice: number;
  targetTpPrice: number;
  hardSlPrice: number;
  side: 'SHORT' | 'LONG';
  highestPrice: number;
  lowestPrice: number;
  highestDiffPct: number;
  lowestDiffPct: number;
  outcome: 'SAVED_SL' | 'MISSED_TP' | 'TIMEOUT' | 'TRACKING';
  simulatedPnlPct: number;
  durationMinutes: number;
  isComplete: boolean;
  updatedAt: number;
}

export interface SpikeAlert {
  id: string;
  symbol: string;
  startPrice: number;
  currentPrice: number;
  surgePct: number;
  lookbackSeconds: number;
  timestamp: number;
  status: 'PENDING' | 'EXECUTING' | 'SKIPPED' | 'COOLING_DOWN';
  skipReason?: string;
  paramsSnapshot?: Record<string, any>;
  simResult?: SpikeSimResult;
}

export interface MarketSnapshot {
  rsi1m?: number;
  vol1mUsdt?: number;
  avgVol1mUsdt?: number;
  volRatio?: number;
  vol24hUsdt?: number;
  priceChange24hPct?: number;
  surgePct?: number;
  lookbackSeconds?: number;
  fundingRatePct?: number;
  openInterestUsdt?: number;
  high24h?: number;
  low24h?: number;
  capturedAt?: number;
}

export interface GridLayer {
  layerIndex: number;
  orderId?: string;
  price: number;
  qty: number;
  marginUsdt: number;
  volumeUsdt?: number;
  vol24hUsdt?: number;
  marketVolume1mUsdt?: number;
  rsi?: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED';
  filledAt?: number;
}

export interface ActivePosition {
  id: string;
  symbol: string;
  side: 'SHORT' | 'LONG';
  strategyType?: 'WICK_SNIPER' | 'MOMENTUM_LONG' | 'SMART_MONEY';
  leverage: number;
  totalQty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  pnlPct: number;
  peakPnlPct: number;
  maxAdversePnlPct?: number;
  totalMarginUsed: number;
  layers: GridLayer[];
  openedAt: number;
  holdDeadlineAt?: number;
  holdRemainingSeconds?: number;
  holdAction?: 'WATCH' | 'CLOSE_NOW';
  extendedHoldMs?: number;
  extensionCount?: number;
  lastExtensionAt?: number;
  candle1mStatus?: 'RED' | 'GREEN' | 'UNKNOWN';
  targetTpPrice: number;
  targetTp2Price?: number;
  hardSlPrice: number;
  breakEvenPrice?: number;
  status: 'SNIPING' | 'HOLDING' | 'CLOSING' | 'CLOSED';
  partialTpDone?: boolean;
  partialRealizedPnl?: number;
  partialExitPrice?: number;
  isBepDefenseActive?: boolean;
  bepDefenseReason?: string;
  trailingTpActive?: boolean;
  lowestPrice?: number;
  highestPrice?: number;
  tpOrderId?: string;
  tp2OrderId?: string;
  lastTpOrderId?: string;
  lastTpAttempt?: number;
  paramsSnapshot?: Record<string, any>;
  marketSnapshot?: MarketSnapshot;
  slDescription?: string;
  smartMoneyFlowStatus?: SmartMoneyFlowStatus;
  atr?: number;
  atrPct?: number;
  bepTriggerPrice?: number;
  isAutoBepDone?: boolean;
  entryReason?: string;
  lastReversalNotifiedSide?: 'LONG' | 'SHORT';
  btcTrendStatus?: {
    btcPrice: number;
    ema: number;
    trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    changePct?: number;
  };
  fundingRatePct?: number;
  rsi15m?: number;
}

export interface SmartMoneyFlowStatus {
  whaleLongRatio: number;
  whaleShortRatio: number;
  whaleLongShortRatio: number;
  retailLongRatio?: number;
  retailShortRatio?: number;
  whaleAvgEntry?: number;
  whaleDistancePct?: number;
  longWhalePositionsUsdt?: number;
  shortWhalePositionsUsdt?: number;
  whaleWinratePct?: number;
  whaleProfitWhales?: number;
  whaleTotalWhales?: number;
  smartTraderLongRatio?: number;
  smartTraderShortRatio?: number;
  smartTraderLongAvgEntry?: number;
  smartTraderShortAvgEntry?: number;
  smartTraderAligned?: boolean;
  aligned: boolean;
  reversalDetected: boolean;
  label: string;
  detail?: string;
  updatedAt: number;
}

export interface PostExitSnapshot {
  highestPrice: number;
  lowestPrice: number;
  highestDiffPct: number;
  lowestDiffPct: number;
  minutesTracked: number;
  isComplete: boolean;
  updatedAt: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: 'SHORT' | 'LONG';
  strategyType?: 'WICK_SNIPER' | 'MOMENTUM_LONG' | 'SMART_MONEY';
  entryPrice: number;
  exitPrice: number;
  qty: number;
  marginUsed: number;
  realizedPnl: number;
  grossPnl?: number;
  fee?: number;
  pnlPct: number;
  durationSeconds: number;
  exitReason: 'TAKE_PROFIT' | 'TRAILING_TP' | 'HARD_STOP_LOSS' | 'FEE_LOSS_EXIT' | 'TIME_LIMIT_EXIT' | 'EARLY_MOMENTUM_EXIT' | 'BEP_DEFENSE' | 'MANUAL_CLOSE';
  isPaper: boolean;
  closedAt: string;
  timestamp: number;
  layersFilled?: string;
  layersDetail?: {
    layerIndex: number;
    price: number;
    qty: number;
    marginUsdt: number;
    volumeUsdt?: number;
    vol24hUsdt?: number;
    marketVolume1mUsdt?: number;
    rsi?: number;
    status: string;
    filledAt?: number;
  }[];
  targetTpPrice?: number;
  targetTp2Price?: number;
  hardSlPrice?: number;
  partialTpDone?: boolean;
  paramsSnapshot?: Record<string, any>;
  marketSnapshot?: MarketSnapshot;
  maePct?: number;
  peakPnlPct?: number;
  postExit30m?: PostExitSnapshot;
  smartMoneyFlowStatus?: SmartMoneyFlowStatus;
  slDescription?: string;
  entryReason?: string;
  btcTrendStatus?: {
    btcPrice: number;
    ema: number;
    trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS';
    changePct?: number;
  };
  fundingRatePct?: number;
  rsi15m?: number;
}

export interface EngineStatus {
  isRunning: boolean;
  tradingMode: 'PAPER' | 'LIVE';
  virtualBalance: number;
  realBalance?: number;
  liveAvailableBalance?: number;
  activePositionsCount: number;
  spikesDetectedToday: number;
  totalSpikes?: number;
  totalTrades: number;
  winRate: number;
  accumulatedPnl: number;
  dailyPnl?: number;
  dailyWinRate?: number;
  dailyTradesCount?: number;
  dailyWinsCount?: number;
  dailyLossesCount?: number;
  activePositions: ActivePosition[];
  recentSpikes: SpikeAlert[];
  recentTrades: ClosedTrade[];
  cooldownCoins: { symbol: string; until: number }[];
  monitoredCoinsCount?: number;
  ticksPerSecond?: number;
  marketDataAgeMs?: number;
  leverage?: number;
  marginType?: 'CROSSED' | 'ISOLATED';
  usedWeight1m?: number;
  orderCount10s?: number;
  wsConnected?: boolean;
  btcTrendStatus?: BtcTrendStatus;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  time?: number;
  level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'SNIPER';
  message: string;
  symbol?: string;
}

export interface AutoTunerConfig {
  enabled: boolean;
  mode: 'SEMI_AUTO' | 'FULL_AUTO';
  minSampleSize?: number; // default: 15
  evalPeriodDays?: number; // default: 7
  autoApplyIntervalHours?: number; // default: 24
  circuitBreakerLosses?: number; // default: 3
  stepSizePct?: number; // default: 10 (max 10% perubahan per parameter)
  targetParams?: {
    spikeMinPercent?: boolean;
    takeProfitPct?: boolean;
    layerSpacingPct?: boolean;
    trailingCallbackPct?: boolean;
    minRsi1m?: boolean;
    maxVolRatio?: boolean;
    maxHoldMinutes?: boolean;
  };
}

export interface TuningProposal {
  id: string;
  createdAt: number;
  status: 'PROPOSED' | 'APPLIED' | 'REJECTED' | 'ROLLED_BACK';
  currentParams: Record<string, number>;
  proposedParams: Record<string, number>;
  deltas: Record<string, number>;
  rationale: string[];
  metrics: {
    totalTradesAnalyzed: number;
    winRateBefore: number;
    avgPnlPctBefore: number;
    profitFactorBefore: number;
    winnersCount: number;
    losersCount: number;
    hardStopExitsCount: number;
    timeLimitExitsCount: number;
  };
  appliedAt?: number;
}

export interface TuningHistoryRecord {
  id: string;
  proposal: TuningProposal;
  previousConfigSnapshot: Record<string, any>;
  status: 'PROPOSED' | 'APPLIED' | 'REJECTED' | 'ROLLED_BACK';
  appliedAt?: number;
  createdAt: number;
}

