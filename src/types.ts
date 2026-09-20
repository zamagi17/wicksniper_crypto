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
    maxHoldMinutes: number;
    partialTpEnabled?: boolean;
    partialTpRatio?: number; // default 0.5 (50%)
  };
  paperTrading: {
    initialVirtualBalance: number;
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
  targetTpPrice: number;
  hardSlPrice: number;
  status: 'SNIPING' | 'HOLDING' | 'CLOSING' | 'CLOSED';
  partialTpDone?: boolean;
  partialRealizedPnl?: number;
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
  pnlPct: number;
  durationSeconds: number;
  exitReason: 'TAKE_PROFIT' | 'TRAILING_TP' | 'HARD_STOP_LOSS' | 'TIME_LIMIT_EXIT' | 'MANUAL_CLOSE';
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
  activePositionsCount: number;
  spikesDetectedToday: number;
  totalTrades: number;
  winRate: number;
  accumulatedPnl: number;
  activePositions: ActivePosition[];
  recentSpikes: SpikeAlert[];
  recentTrades: ClosedTrade[];
  cooldownCoins: { symbol: string; until: number }[];
  monitoredCoinsCount?: number;
  ticksPerSecond?: number;
  leverage?: number;
  marginType?: 'CROSSED' | 'ISOLATED';
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'SNIPER';
  message: string;
  symbol?: string;
}
