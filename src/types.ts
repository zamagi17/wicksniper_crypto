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
    maxSpreadPct?: number;
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
    trailingTpEnabled: boolean;
    trailingCallbackPct: number;
    hardStopLossPct: number;
    trailingSlEnabled?: boolean;
    trailingSlMaxReturnRatio?: number;
    trailingSlTiers?: Array<{ filledLayerMin: number; percentOfBase: number }>;
    maxHoldMinutes: number;
    earlyExitMomentumEnabled?: boolean;
    earlyExitMinBullishCandles?: number;
    earlyExitMinRisePct?: number;
    earlyExitCooldownMinutes?: number;
    hardStopCooldownMinutes?: number;
    partialTpEnabled?: boolean;
    partialTpRatio?: number; // default 0.5 (50%)
    bepDefenseEnabled?: boolean;
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
    heartbeatIntervalHours?: number;
  };
  security?: {
    password?: string;
  };
  server: {
    port: number;
  };
}

export interface TickerSnapshot {
  symbol: string;
  price: number;
  time: number;
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
}

export interface GridLayer {
  layerIndex: number;
  orderId?: string;
  price: number;
  qty: number;
  marginUsdt: number;
  status: 'PENDING' | 'FILLED' | 'CANCELLED';
  filledAt?: number;
}

export interface ActivePosition {
  id: string;
  symbol: string;
  side: 'SHORT';
  leverage: number;
  totalQty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  pnlPct: number;
  peakPnlPct: number;
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
  isBepDefenseActive?: boolean;
  bepDefenseReason?: string;
  trailingTpActive?: boolean;
  lowestPrice?: number;
  tpOrderId?: string;
  tp2OrderId?: string;
  lastTpAttempt?: number;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: 'SHORT';
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
    status: string;
  }[];
  paramsSnapshot?: {
    marginPerLayerUsdt: number;
    totalLayers: number;
    layerSpacingPct: number;
    martingaleMultiplier: number;
    maxTotalMarginPerCoin: number;
    takeProfitPct: number;
    hardStopLossPct: number;
    maxHoldMinutes: number;
    spikeMinPercent: number;
    leverage: number;
    marginType: string;
  };
}

export interface EngineStatus {
  isRunning: boolean;
  tradingMode: 'PAPER' | 'LIVE';
  virtualBalance: number;
  realBalance?: number;
  liveAvailableBalance?: number;
  activePositionsCount: number;
  spikesDetectedToday: number;
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
  level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'SNIPER';
  message: string;
  symbol?: string;
}
