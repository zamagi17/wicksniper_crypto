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
    heartbeatIntervalHours?: number;
  };
  momentumLong?: MomentumLongConfig;
  security?: {
    password?: string;
  };
  server: {
    port: number;
  };
}

export interface MomentumLongConfig {
  enabled: boolean;
  minSurgePct?: number;
  minVolRatio?: number;
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
  strategyType?: 'WICK_SNIPER' | 'MOMENTUM_LONG';
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
  strategyType?: 'WICK_SNIPER' | 'MOMENTUM_LONG';
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
}

export interface LogEntry {
  id: string;
  timestamp: string;
  time?: number;
  level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'SNIPER';
  message: string;
  symbol?: string;
}
