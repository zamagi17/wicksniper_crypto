import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import WebSocket from 'ws';
import https from 'https';
import dns from 'dns';
import { logger } from './logger';
import { BtcTrendStatus } from '../types';

export interface SymbolPrecision {
  symbol: string;
  pricePrecision: number;
  quantityPrecision: number;
  tickSize: number;
  stepSize: number;
  minQty: number;
  minNotional: number;
}

export class BinanceFuturesClient {
  private apiKey: string = '';
  private apiSecret: string = '';
  private isTestnet: boolean = false;
  private restBaseUrl: string = 'https://fapi.binance.com';
  private wsDomainIndex: number = 0;
  private wsDomains: string[] = ['fstream.binance.com', 'stream.binancefuture.com', 'fstream.binance.me'];
  private wsUrl: string = `wss://${this.wsDomains[0]}/market/ws/!ticker@arr`;
  private currentDataSource: 'WEBSOCKET' | 'POLLING' = 'WEBSOCKET';
  private wsClient: WebSocket | null = null;
  private httpClient: AxiosInstance | null = null;
  private timeOffset: number = 0;
  private precisions: Map<string, SymbolPrecision> = new Map();
  private isWsConnected: boolean = false;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsReconnectAttempts: number = 0;
  private wsWatchdogTimer: NodeJS.Timeout | null = null;
  private lastWsMessageAt: number = 0;
  private lastWsCloseLog: number = 0;
  private tickerListeners: ((tickers: any[]) => void)[] = [];
  private positionCacheTime: number = 0;
  private positionCache: any[] = [];
  private readonly POSITION_CACHE_TTL = 2000; // 2 second cache
  public lastOrderError: string = '';
  public lastUsedWeight: number = 0;
  public lastOrderCount10s: number = 0;
  public lastOrderCount1m: number = 0;
  public lastOrderCountTs: number = 0;

  private userWsClient: WebSocket | null = null;
  private listenKey: string = '';
  private listenKeyKeepAliveTimer: NodeJS.Timeout | null = null;
  private isUserWsConnected: boolean = false;
  private userWsReconnectTimer: NodeJS.Timeout | null = null;
  private userWsReconnectAttempts: number = 0;
  private hasLoggedUserWsConnected: boolean = false;
  private orderTradeListeners: ((order: any) => void)[] = [];
  private accountUpdateListeners: ((account: any) => void)[] = [];

  public getOrderCount10s(): number {
    if (Date.now() - this.lastOrderCountTs > 10000) {
      this.lastOrderCount10s = 0;
      return 0;
    }
    return this.lastOrderCount10s;
  }

  constructor() {
    this.initHttpClient();
  }

  public configure(apiKey: string, apiSecret: string, isTestnet: boolean = false) {
    this.apiKey = (apiKey || '').trim();
    this.apiSecret = (apiSecret || '').trim();
    this.isTestnet = isTestnet;

    if (isTestnet) {
      this.restBaseUrl = 'https://testnet.binancefuture.com';
      this.wsUrl = 'wss://stream.binancefuture.com/market/ws/!ticker@arr';
    } else {
      this.restBaseUrl = 'https://fapi.binance.com';
      this.wsDomainIndex = 0;
      this.wsUrl = `wss://${this.wsDomains[this.wsDomainIndex]}/market/ws/!ticker@arr`;
    }

    if (this.httpClient) {
      this.httpClient.defaults.baseURL = this.restBaseUrl;
      this.httpClient.defaults.headers['X-MBX-APIKEY'] = this.apiKey;
    }

    this.initHttpClient();

    if (this.apiKey && this.apiSecret) {
      this.checkPositionMode().catch(() => {});
    }
  }

  public getTimeOffset(): number {
    return this.timeOffset;
  }

  private dohAgent: https.Agent | null = null;
  private dohCache: Map<string, string> = new Map();

  private async resolveHostViaDoH(hostname: string): Promise<string> {
    const cleanHost = hostname.replace(/\.$/, '');
    if (this.dohCache.has(cleanHost)) {
      return this.dohCache.get(cleanHost)!;
    }
    // Coba Cloudflare DoH
    try {
      const res = await axios.get(`https://cloudflare-dns.com/dns-query?name=${cleanHost}&type=A`, {
        headers: { accept: 'application/dns-json' },
        timeout: 4000,
      });
      const answers = res.data?.Answer || [];
      for (const a of answers) {
        if (a.type === 1 && a.data) {
          this.dohCache.set(cleanHost, a.data);
          return a.data;
        }
      }
    } catch {}
    // Fallback: Google DoH jika Cloudflare gagal
    try {
      const res = await axios.get(`https://dns.google/resolve?name=${cleanHost}&type=A`, {
        timeout: 4000,
      });
      const answers = res.data?.Answer || [];
      for (const a of answers) {
        if (a.type === 1 && a.data) {
          this.dohCache.set(cleanHost, a.data);
          return a.data;
        }
      }
    } catch {}
    return '';
  }

  private async getOrCreateDohAgent(): Promise<https.Agent> {
    if (this.dohAgent) return this.dohAgent;

    // Pre-warm DNS cache untuk domain futures utama
    await Promise.allSettled([
      this.resolveHostViaDoH(this.isTestnet ? 'testnet.binancefuture.com' : 'fapi.binance.com'),
      this.resolveHostViaDoH(this.isTestnet ? 'stream.binancefuture.com' : 'fstream.binance.com'),
      this.resolveHostViaDoH('stream.binancefuture.com'),
      this.resolveHostViaDoH('fstream.binance.me'),
      this.resolveHostViaDoH('www.binance.com'),
    ]);

    this.dohAgent = new https.Agent({
      keepAlive: true,
      lookup: async (hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const opt = typeof options === 'object' ? options : {};
        const cleanHost = hostname.replace(/\.$/, '');
        try {
          if (cleanHost.includes('binance')) {
            const ip = await this.resolveHostViaDoH(cleanHost);
            if (ip) {
              if (opt && (opt as any).all) {
                return cb(null, [{ address: ip, family: 4 }] as any);
              }
              return cb(null, ip, 4);
            }
          }
        } catch {}
        return dns.lookup(hostname, options, cb);
      },
    });

    return this.dohAgent;
  }

  private async initHttpClient() {
    const agent = await this.getOrCreateDohAgent();
    this.httpClient = axios.create({
      baseURL: this.restBaseUrl,
      timeout: 8000,
      httpsAgent: agent,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-MBX-APIKEY': this.apiKey,
        'User-Agent': 'WickSniper/1.0',
      },
    });

    this.httpClient.interceptors.response.use(
      (response) => {
        const weight = response.headers['x-mbx-used-weight-1m'];
        if (weight) {
          const parsed = parseInt(weight, 10);
          if (!isNaN(parsed)) {
            this.lastUsedWeight = parsed;
          }
        }
        const ord10s = response.headers['x-mbx-order-count-10s'];
        if (ord10s) {
          const parsed = parseInt(ord10s, 10);
          if (!isNaN(parsed)) {
            this.lastOrderCount10s = parsed;
            this.lastOrderCountTs = Date.now();
          }
        }
        const ord1m = response.headers['x-mbx-order-count-1m'];
        if (ord1m) {
          const parsed = parseInt(ord1m, 10);
          if (!isNaN(parsed)) {
            this.lastOrderCount1m = parsed;
          }
        }
        return response;
      },
      (error) => {
        if (error.response?.headers) {
          const weight = error.response.headers['x-mbx-used-weight-1m'];
          if (weight) {
            const parsed = parseInt(weight, 10);
            if (!isNaN(parsed)) {
              this.lastUsedWeight = parsed;
            }
          }
          const ord10s = error.response.headers['x-mbx-order-count-10s'];
          if (ord10s) {
            const parsed = parseInt(ord10s, 10);
            if (!isNaN(parsed)) {
              this.lastOrderCount10s = parsed;
            }
          }
        }
        return Promise.reject(error);
      }
    );
  }

  public async getHttpClient(): Promise<AxiosInstance> {
    if (!this.httpClient) {
      await this.initHttpClient();
    }
    return this.httpClient!;
  }

  public async syncTime(): Promise<number> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/time');
      const serverTime = res.data.serverTime;
      this.timeOffset = serverTime - Date.now();
      return this.timeOffset;
    } catch {
      return 0;
    }
  }

  public async fetchSymbolPrecision(symbol: string): Promise<SymbolPrecision> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get(`/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
      const symbols = res?.data?.symbols || [];
      const s = symbols.find((item: any) => item.symbol === symbol);
      if (s) {
        let tickSize = 0.0001;
        let stepSize = 1;
        let minQty = 1;
        let minNotional = 5;

        for (const f of s.filters || []) {
          if (f.filterType === 'PRICE_FILTER') {
            tickSize = parseFloat(f.tickSize) || tickSize;
          } else if (f.filterType === 'LOT_SIZE') {
            stepSize = parseFloat(f.stepSize) || stepSize;
            minQty = parseFloat(f.minQty) || minQty;
          } else if (f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') {
            minNotional = parseFloat(f.notional || f.minNotional) || minNotional;
          }
        }

        const precision: SymbolPrecision = {
          symbol: s.symbol,
          pricePrecision: typeof s.pricePrecision === 'number' ? s.pricePrecision : 4,
          quantityPrecision: typeof s.quantityPrecision === 'number' ? s.quantityPrecision : 0,
          tickSize,
          stepSize,
          minQty,
          minNotional,
        };
        this.precisions.set(s.symbol, precision);
        return precision;
      }
    } catch (e: any) {
      console.warn(`Gagal memuat presisi spesifik ${symbol}:`, e.message);
    }
    return this.getPrecision(symbol);
  }

  public async loadExchangeInfo(): Promise<Map<string, SymbolPrecision>> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/exchangeInfo');
      const symbols = res.data.symbols || [];

      for (const s of symbols) {
        if (s.status !== 'TRADING' || !s.symbol.endsWith('USDT')) {
          continue;
        }

        let tickSize = 0.0001;
        let stepSize = 1;
        let minQty = 1;
        let minNotional = 5;

        for (const f of s.filters || []) {
          if (f.filterType === 'PRICE_FILTER') {
            tickSize = parseFloat(f.tickSize) || tickSize;
          } else if (f.filterType === 'LOT_SIZE') {
            stepSize = parseFloat(f.stepSize) || stepSize;
            minQty = parseFloat(f.minQty) || minQty;
          } else if (f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') {
            minNotional = parseFloat(f.notional || f.minNotional) || minNotional;
          }
        }

        this.precisions.set(s.symbol, {
          symbol: s.symbol,
          pricePrecision: typeof s.pricePrecision === 'number' ? s.pricePrecision : 4,
          quantityPrecision: typeof s.quantityPrecision === 'number' ? s.quantityPrecision : 0,
          tickSize,
          stepSize,
          minQty,
          minNotional,
        });
      }

      return this.precisions;
    } catch (err: any) {
      console.error('Gagal memuat exchangeInfo Binance:', err.message);
      if (this.precisions.size === 0) {
        setTimeout(() => this.loadExchangeInfo(), 5000);
      }
      return this.precisions;
    }
  }

  private tradableSymbolsCache: { list: string[]; timestamp: number } | null = null;

  public async getTradableSymbols(forceRefresh = false): Promise<string[]> {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    if (
      !forceRefresh &&
      this.tradableSymbolsCache &&
      Date.now() - this.tradableSymbolsCache.timestamp < ONE_DAY_MS &&
      this.tradableSymbolsCache.list.length > 0
    ) {
      return this.tradableSymbolsCache.list;
    }

    if (this.precisions.size === 0 || forceRefresh) {
      await this.loadExchangeInfo();
    }

    const list = Array.from(this.precisions.keys()).sort();
    if (list.length > 0) {
      this.tradableSymbolsCache = { list, timestamp: Date.now() };
    }
    return list;
  }

  public getPrecision(symbol: string): SymbolPrecision {
    const existing = this.precisions.get(symbol);
    if (existing) return existing;

    // Jika belum ada di cache, picu pengambilan async presisi spesifik ke Binance
    this.fetchSymbolPrecision(symbol).catch(() => {});

    return {
      symbol,
      pricePrecision: 4,
      quantityPrecision: 1,
      tickSize: 0.0001,
      stepSize: 0.1,
      minQty: 0.1,
      minNotional: 5,
    };
  }

  public formatPrice(symbol: string, price: number): string {
    if (price <= 0) return '0';
    const prec = this.getPrecision(symbol);
    const tickSize = prec.tickSize > 0 ? prec.tickSize : 0.0001;

    let decimals = 4;
    const tickStr = tickSize.toString();
    if (tickStr.includes('e-')) {
      decimals = parseInt(tickStr.split('e-')[1], 10);
    } else if (tickStr.includes('.')) {
      decimals = tickStr.split('.')[1].replace(/0+$/, '').length;
    } else {
      decimals = 0;
    }
    if (typeof prec.pricePrecision === 'number' && prec.pricePrecision > decimals) {
      decimals = prec.pricePrecision;
    }

    const factor = Math.round(1 / tickSize);
    let rounded: number;
    if (factor >= 1 && Math.abs(1 / factor - tickSize) < 1e-9) {
      rounded = Math.floor(price * factor + 1e-8) / factor;
    } else {
      rounded = Math.floor(price / tickSize + 1e-8) * tickSize;
    }

    return rounded.toFixed(decimals);
  }

  public formatQty(symbol: string, qty: number): string {
    if (qty <= 0) return '0';
    const prec = this.getPrecision(symbol);
    const stepSize = prec.stepSize > 0 ? prec.stepSize : 0.1;

    let decimals = 0;
    const stepStr = stepSize.toString();
    if (stepStr.includes('e-')) {
      decimals = parseInt(stepStr.split('e-')[1], 10);
    } else if (stepStr.includes('.')) {
      decimals = stepStr.split('.')[1].replace(/0+$/, '').length;
    }
    if (typeof prec.quantityPrecision === 'number' && prec.quantityPrecision > decimals) {
      decimals = prec.quantityPrecision;
    }

    const factor = Math.round(1 / stepSize);
    let rounded: number;
    if (factor >= 1 && Math.abs(1 / factor - stepSize) < 1e-9) {
      rounded = Math.floor(qty * factor + 1e-8) / factor;
    } else {
      rounded = Math.floor(qty / stepSize + 1e-8) * stepSize;
    }

    return Math.max(prec.minQty, rounded).toFixed(decimals);
  }

  private signParams(params: Record<string, any>): string {
    const timestamp = Date.now() + this.timeOffset;
    const query = new URLSearchParams({ recvWindow: '10000', ...params, timestamp: String(timestamp) }).toString();
    const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  private isDualSidePosition: boolean = false;

  public getIsDualSidePosition(): boolean {
    return this.isDualSidePosition;
  }

  /**
   * Mengecek apakah akun Binance diatur dalam mode Hedge (Dual Position) atau One-Way Mode
   */
  public async checkPositionMode(): Promise<boolean> {
    if (!this.apiKey || !this.apiSecret) return false;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({});
      const res = await client.get(`/fapi/v1/positionSide/dual?${data}`);
      this.isDualSidePosition = !!res.data?.dualSidePosition;
      return this.isDualSidePosition;
    } catch {
      return false;
    }
  }

  public lastBalanceError: string = '';

  /**
   * Mengambil saldo dompet Binance Futures (USDT)
   */
  public async getFuturesAccountBalance(): Promise<{ asset: string; balance: number; availableBalance: number }[]> {
    if (!this.apiKey || !this.apiSecret) {
      this.lastBalanceError = 'API Key dan API Secret Binance belum diisi.';
      return [];
    }
    try {
      if (this.timeOffset === 0) {
        await this.syncTime();
      }
      const client = await this.getHttpClient();
      const data = this.signParams({});
      const res = await client.get(`/fapi/v2/balance?${data}`);
      if (Array.isArray(res?.data)) {
        this.lastBalanceError = '';
        return res.data.map((item: any) => ({
          asset: item.asset,
          balance: parseFloat(item.balance || '0'),
          availableBalance: parseFloat(item.availableBalance || item.withdrawAvailable || '0'),
        }));
      }
      return [];
    } catch (err: any) {
      const errMsg = err.response?.data?.msg || err.message;
      this.lastBalanceError = errMsg;
      console.error('Gagal mengambil saldo futures:', errMsg);
      return [];
    }
  }

  /**
   * Mengambil posisi aktual koin tertentu langsung dari Binance matching engine
   */
  public async getOpenPosition(symbol: string): Promise<{
    symbol: string;
    positionAmt: number;
    entryPrice: number;
    breakEvenPrice?: number;
    unRealizedProfit: number;
    leverage: number;
    positionSide?: string;
  } | null> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol });
      const res = await client.get(`/fapi/v2/positionRisk?${data}`);
      if (Array.isArray(res?.data)) {
        // Auto-deteksi mode akun jika ada posisi SHORT atau LONG
        if (res.data.some((p: any) => p.positionSide === 'SHORT' || p.positionSide === 'LONG')) {
          this.isDualSidePosition = true;
        }

        // Prioritas 1: Cari posisi yang MEMILIKI ukuran aktif (positionAmt != 0)
        let item = res.data.find(
          (p: any) => p.symbol === symbol && Math.abs(parseFloat(p.positionAmt || '0')) > 1e-8
        );

        // Prioritas 2: Jika posisi 0, cari posisi SHORT (untuk Hedge Mode)
        if (!item) {
          item = res.data.find(
            (p: any) => p.symbol === symbol && p.positionSide === 'SHORT'
          );
        }

        // Prioritas 3: Cari posisi BOTH (untuk One-Way Mode)
        if (!item) {
          item = res.data.find(
            (p: any) => p.symbol === symbol && p.positionSide === 'BOTH'
          );
        }

        // Prioritas 4: Fallback ke item pertama yang cocok dengan simbol
        if (!item) {
          item = res.data.find((p: any) => p.symbol === symbol);
        }

        if (item) {
          return {
            symbol: item.symbol,
            positionAmt: parseFloat(item.positionAmt || '0'),
            entryPrice: parseFloat(item.entryPrice || '0'),
            breakEvenPrice: parseFloat(item.breakEvenPrice || '0'),
            unRealizedProfit: parseFloat(item.unRealizedProfit || '0'),
            leverage: parseInt(item.leverage || '5'),
            positionSide: item.positionSide,
          };
        }
      }
      return null;
    } catch (err: any) {
      console.error(`Gagal mengecek posisi ${symbol} di Binance:`, err.response?.data || err.message);
      return null;
    }
  }

  /**
   * Mengambil semua posisi yang AKTIF (positionAmt != 0) langsung dari Binance Futures
   */
  public async getAllOpenPositions(): Promise<{
    symbol: string;
    positionAmt: number;
    entryPrice: number;
    breakEvenPrice?: number;
    unRealizedProfit: number;
    leverage: number;
    positionSide: string;
  }[]> {
    if (!this.apiKey || !this.apiSecret) return [];
    
    // Check cache (2 second TTL)
    const now = Date.now();
    if (now - this.positionCacheTime < this.POSITION_CACHE_TTL) {
      return this.positionCache;
    }
    
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({});
      const res = await client.get(`/fapi/v2/positionRisk?${data}`);
      if (Array.isArray(res?.data)) {
        if (res.data.some((p: any) => p.positionSide === 'SHORT' || p.positionSide === 'LONG')) {
          this.isDualSidePosition = true;
        }
        const result = res.data
          .filter((p: any) => Math.abs(parseFloat(p.positionAmt || '0')) > 1e-8)
          .map((item: any) => ({
            symbol: item.symbol,
            positionAmt: parseFloat(item.positionAmt || '0'),
            entryPrice: parseFloat(item.entryPrice || '0'),
            breakEvenPrice: parseFloat(item.breakEvenPrice || '0'),
            unRealizedProfit: parseFloat(item.unRealizedProfit || '0'),
            leverage: parseInt(item.leverage || '5'),
            positionSide: item.positionSide || 'BOTH',
          }));
        // Cache the result
        this.positionCache = result;
        this.positionCacheTime = now;
        return result;
      }
      return [];
    } catch (err: any) {
      console.error('Gagal mengambil semua posisi aktif Binance:', err.message);
      return [];
    }
  }

  /**
   * Uji coba koneksi API Key, server time, latensi, dan saldo USDT sebelum Live Trading
   */
  public async testConnection(): Promise<{
    success: boolean;
    latencyMs: number;
    balanceUsdt: number;
    availableUsdt: number;
    dualSidePosition: boolean;
    message?: string;
    error?: string;
  }> {
    if (!this.apiKey || !this.apiSecret) {
      return {
        success: false,
        latencyMs: 0,
        balanceUsdt: 0,
        availableUsdt: 0,
        dualSidePosition: false,
        error: 'API Key dan API Secret Binance belum diisi.',
      };
    }

    try {
      const startTime = Date.now();
      await this.syncTime();
      const latencyMs = Date.now() - startTime;

      await this.checkPositionMode();

      const balances = await this.getFuturesAccountBalance();
      const usdt = balances.find((b) => b.asset === 'USDT');
      const balanceUsdt = usdt?.balance || 0;
      const availableUsdt = usdt?.availableBalance || 0;

      return {
        success: true,
        latencyMs,
        balanceUsdt,
        availableUsdt,
        dualSidePosition: this.isDualSidePosition,
        message: `Koneksi berhasil! Latensi: ${latencyMs}ms | Saldo Futures Tersedia: $${availableUsdt.toFixed(2)} USDT | Mode: ${this.isDualSidePosition ? 'Hedge Mode' : 'One-Way Mode'}`,
      };
    } catch (err: any) {
      let binanceMsg = err.response?.data?.msg || err.message;
      if (err.response?.status === 401 && (binanceMsg.includes('Invalid API-key, IP') || binanceMsg.includes('IP') || binanceMsg.includes('API-key'))) {
        binanceMsg = 'IP Tidak Terdaftar di Whitelist Binance (Atau API Key Salah). Pastikan IP Server Oracle Anda sudah didaftarkan pada API Key Binance Anda.';
      }
      return {
        success: false,
        latencyMs: 0,
        balanceUsdt: 0,
        availableUsdt: 0,
        dualSidePosition: false,
        error: `Gagal terhubung ke Binance: ${binanceMsg}`,
      };
    }
  }

  private configuredSymbols: Set<string> = new Set();

  public async setLeverage(symbol: string, leverage: number): Promise<number> {
    if (!this.apiKey || !this.apiSecret) return leverage;
    const key = `${symbol}_${leverage}`;
    if (this.configuredSymbols.has(key)) return leverage;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol, leverage });
      const res = await client.post('/fapi/v1/leverage', data);
      this.configuredSymbols.add(key);
      if (res?.data?.leverage) {
        const actual = parseInt(res.data.leverage, 10);
        return actual > 0 ? actual : leverage;
      }
      return leverage;
    } catch (err: any) {
      const errMsg = err.response?.data?.msg || err.message;
      console.warn(`[setLeverage] ${symbol} set leverage ${leverage}x info: ${errMsg}`);
      try {
        const pos = await this.getOpenPosition(symbol);
        if (pos?.leverage && pos.leverage > 0) {
          return pos.leverage;
        }
      } catch { }
      return leverage;
    }
  }

  public async setMarginType(symbol: string, marginType: 'CROSSED' | 'ISOLATED'): Promise<void> {
    if (!this.apiKey || !this.apiSecret) return;
    const key = `${symbol}_${marginType}`;
    if (this.configuredSymbols.has(key)) return;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol, marginType });
      await client.post('/fapi/v1/marginType', data);
      this.configuredSymbols.add(key);
    } catch {}
  }

  /**
   * Menembakkan order berjenjang (High-Frequency Batch) otomatis dipecah maks 5 order per request
   */
  public async sendBatchOrders(batchOrdersList: any[]): Promise<any[]> {
    if (!this.apiKey || !this.apiSecret || !batchOrdersList.length) return [];
    const allResults: any[] = [];
    const CHUNK_SIZE = 5;

    // Pastikan setiap limit order memiliki positionSide yang sesuai konfigurasi akun
    const preparedOrders = batchOrdersList.map((ord) => {
      const copy = { ...ord };
      if (!copy.positionSide) {
        copy.positionSide = this.isDualSidePosition ? 'SHORT' : 'BOTH';
      }
      return copy;
    });

    for (let i = 0; i < preparedOrders.length; i += CHUNK_SIZE) {
      const chunk = preparedOrders.slice(i, i + CHUNK_SIZE);
      try {
        const client = await this.getHttpClient();
        const data = this.signParams({
          batchOrders: JSON.stringify(chunk),
        });
        const res = await client.post('/fapi/v1/batchOrders', data);
        if (Array.isArray(res?.data)) {
          allResults.push(...res.data);
        }
      } catch (err: any) {
        const errData = err.response?.data;
        const errMsg = errData?.msg || errData?.message || err.message;
        const errCode = errData?.code;
        this.lastOrderError = errMsg;
        console.error(`Gagal mengeksekusi batchOrders (chunk ${Math.floor(i / CHUNK_SIZE) + 1}):`, errData || err.message);
        for (let c = 0; c < chunk.length; c++) {
          allResults.push({ code: errCode || -1, msg: errMsg, isError: true });
        }
      }
    }
    return allResults;
  }

  /**
   * Membuka posisi baru seketika dengan Market Order (Mendukung One-Way & Hedge Mode)
   */
  public async openMarketOrder(symbol: string, side: 'BUY' | 'SELL', qty: number): Promise<any> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const client = await this.getHttpClient();
      const formattedQty = this.formatQty(symbol, qty);
      const params: Record<string, any> = {
        symbol,
        side,
        type: 'MARKET',
        quantity: formattedQty,
      };

      if (this.isDualSidePosition) {
        params.positionSide = side === 'SELL' ? 'SHORT' : 'LONG';
      } else {
        params.positionSide = 'BOTH';
      }

      const data = this.signParams(params);
      const res = await client.post('/fapi/v1/order', data);
      return res?.data;
    } catch (err: any) {
      const errData = err.response?.data;
      const errMsg = errData?.msg || errData?.message || err.message;
      this.lastOrderError = errMsg;
      console.error(`Gagal membuka posisi market ${symbol}:`, errData || err.message);
      return null;
    }
  }

  /**
   * Menutup posisi seketika dengan Market Order
   * Dilengkapi auto-recovery & fallback jika kuantitas floating desimal tidak pas (Error -2022)
   */
  public async closePositionMarket(symbol: string, side: 'BUY' | 'SELL', qty: number): Promise<any> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const client = await this.getHttpClient();
      const formattedQty = this.formatQty(symbol, qty);
      const params: Record<string, any> = {
        symbol,
        side,
        type: 'MARKET',
        quantity: formattedQty,
      };

      if (this.isDualSidePosition) {
        // Pada Hedge Mode, penutupan SHORT dikirim side: BUY & positionSide: SHORT (reduceOnly tidak diizinkan oleh Binance di Hedge Mode)
        params.positionSide = side === 'BUY' ? 'SHORT' : 'LONG';
      } else {
        params.positionSide = 'BOTH';
        params.reduceOnly = 'true';
      }

      const data = this.signParams(params);
      const res = await client.post('/fapi/v1/order', data);
      return res?.data;
    } catch (err: any) {
      const errCode = err.response?.data?.code;
      const errMsg = err.response?.data?.msg || err.message;
      console.error(`Gagal menutup posisi market ${symbol} (Code ${errCode}):`, errMsg);

      // Proteksi Go-Live: Jika error -2022 (ReduceOnly reject / Qty mismatch), periksa posisi aktual di Binance dan kirim ulang
      if (errCode === -2022 || (errMsg && errMsg.includes('ReduceOnly'))) {
        try {
          console.log(`⚠️ Menyelidiki posisi aktual ${symbol} di Binance untuk rekonsiliasi penutupan...`);
          const realPos = await this.getOpenPosition(symbol);
          if (realPos && Math.abs(realPos.positionAmt) > 0) {
            const exactQty = Math.abs(realPos.positionAmt);
            const retryFormattedQty = this.formatQty(symbol, exactQty);
            // SISI PENUTUPAN HARUS SESUAI ARAH RIIL DI BINANCE!
            // Jika positionAmt < 0 (SHORT) -> tutup dengan BUY
            // Jika positionAmt > 0 (LONG) -> tutup dengan SELL
            const correctSide: 'BUY' | 'SELL' = realPos.positionAmt < 0 ? 'BUY' : 'SELL';
            console.log(`🔄 Mengirim ulang order penutupan dengan ukuran presisi: ${retryFormattedQty} (Side: ${correctSide})`);
            const client = await this.getHttpClient();
            const retryParams: Record<string, any> = {
              symbol,
              side: correctSide,
              type: 'MARKET',
              quantity: retryFormattedQty,
            };
            if (this.isDualSidePosition) {
              retryParams.positionSide = correctSide === 'BUY' ? 'SHORT' : 'LONG';
            } else {
              retryParams.positionSide = 'BOTH';
              retryParams.reduceOnly = 'true';
            }
            const retryData = this.signParams(retryParams);
            const retryRes = await client.post('/fapi/v1/order', retryData);
            return retryRes?.data;
          } else {
            console.log(`✅ Posisi ${symbol} ternyata sudah tertutup di Binance.`);
            return { symbol, status: 'FILLED', msg: 'Already closed' };
          }
        } catch (retryErr: any) {
          console.error(`Gagal retry penutupan posisi ${symbol}:`, retryErr.response?.data || retryErr.message);
        }
      }
      return null;
    }
  }

  /**
   * Mengambil riwayat trade pengguna terkini untuk koin tertentu untuk mendapatkan harga eksekusi riil, fee, dan realized PnL Binance
   */
  public async getUserTrades(symbol: string, limit: number = 20, startTime?: number): Promise<any[]> {
    if (!this.apiKey || !this.apiSecret) return [];
    try {
      const client = await this.getHttpClient();
      const params: Record<string, any> = { symbol, limit: String(limit) };
      if (startTime && startTime > 0) {
        params.startTime = String(Math.floor(startTime));
      }
      const data = this.signParams(params);
      const res = await client.get(`/fapi/v1/userTrades?${data}`);
      return Array.isArray(res?.data) ? res.data : [];
    } catch (err: any) {
      console.error(`Gagal mengambil userTrades ${symbol}:`, err.response?.data || err.message);
      return [];
    }
  }

  private bnbPriceCache: { price: number; timestamp: number } = { price: 600, timestamp: 0 };

  /**
   * Mengambil harga pasar BNBUSDT terkini untuk konversi akurat jika fee dipotong dalam BNB
   */
  public async getBnbPrice(): Promise<number> {
    const now = Date.now();
    if (now - this.bnbPriceCache.timestamp < 60_000 && this.bnbPriceCache.price > 0) {
      return this.bnbPriceCache.price;
    }
    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/ticker/price', { params: { symbol: 'BNBUSDT' } });
      const p = parseFloat(res?.data?.price || '0');
      if (p > 0) {
        this.bnbPriceCache = { price: p, timestamp: now };
        return p;
      }
    } catch {}
    return this.bnbPriceCache.price > 0 ? this.bnbPriceCache.price : 600;
  }

  /**
   * Mengambil data spread Bid/Ask terkini langsung dari Binance matching engine
   */
  public async getOrderbookSpread(symbol: string): Promise<{ bidPrice: number; askPrice: number; spreadPct: number } | null> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get(`/fapi/v1/ticker/bookTicker?symbol=${symbol}`);
      const bid = parseFloat(res?.data?.bidPrice || '0');
      const ask = parseFloat(res?.data?.askPrice || '0');
      if (bid > 0 && ask > 0) {
        const spreadPct = ((ask - bid) / bid) * 100;
        return { bidPrice: bid, askPrice: ask, spreadPct };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Mengambil riwayat transaksi pasar publik terkini (Recent Trades / Tape)
   * Berguna untuk mengecek jeda/gap waktu antar trade dan mendeteksi koin sepi / illiquid.
   */
  public async getRecentTrades(
    symbol: string,
    limit: number = 20
  ): Promise<Array<{ id: number; price: number; qty: number; time: number }> | null> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get(`/fapi/v1/trades`, {
        params: { symbol, limit },
        timeout: 2000,
      });
      if (Array.isArray(res?.data)) {
        return res.data.map((t: any) => ({
          id: t.id,
          price: parseFloat(t.price),
          qty: parseFloat(t.qty),
          time: Number(t.time),
        }));
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Mengambil detail order Binance berdasarkan orderId untuk memeriksa harga eksekusi (avgPrice)
   */
  public async getOrder(symbol: string, orderId: string | number): Promise<any> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol, orderId: String(orderId) });
      const res = await client.get(`/fapi/v1/order?${data}`);
      return res?.data || null;
    } catch (err: any) {
      return null;
    }
  }

  /**
   * Memasang Order Limit (misalnya untuk Take Profit limit order atau entry limit)
   */
  public async placeLimitOrder(
    symbol: string,
    side: 'BUY' | 'SELL',
    qty: number,
    price: number,
    reduceOnly: boolean = false,
    positionSide?: 'LONG' | 'SHORT' | 'BOTH',
    timeInForce: 'GTC' | 'GTX' | 'IOC' = 'GTC'
  ): Promise<any> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const client = await this.getHttpClient();
      const formattedQty = this.formatQty(symbol, qty);
      const formattedPrice = this.formatPrice(symbol, price);
      const params: Record<string, any> = {
        symbol,
        side,
        type: 'LIMIT',
        timeInForce,
        quantity: formattedQty,
        price: formattedPrice,
      };

      if (positionSide) {
        params.positionSide = positionSide;
        if (!this.isDualSidePosition && reduceOnly) {
          params.reduceOnly = 'true';
        }
      } else if (this.isDualSidePosition) {
        // Pada Hedge Mode: jika reduceOnly, BUY menutup SHORT, SELL menutup LONG.
        // Jika bukan reduceOnly (grid/entry), BUY membuka/menambah LONG, SELL membuka/menambah SHORT.
        params.positionSide = reduceOnly
          ? (side === 'BUY' ? 'SHORT' : 'LONG')
          : (side === 'BUY' ? 'LONG' : 'SHORT');
      } else {
        params.positionSide = 'BOTH';
        if (reduceOnly) {
          params.reduceOnly = 'true';
        }
      }

      const data = this.signParams(params);
      const res = await client.post('/fapi/v1/order', data);
      return res?.data || null;
    } catch (err: any) {
      const errCode = err.response?.data?.code;
      const errMsg = err.response?.data?.msg || err.message;
      console.error(`Gagal memasang limit order ${symbol} (${side} @ ${price}) [Code ${errCode}]:`, errMsg);

      // AUTO-RECOVERY 1: Error -4061 (Order's position side does not match user's setting)
      // Balikkan isDualSidePosition dan pasang ulang order dengan positionSide yang tepat!
      if (errCode === -4061) {
        try {
          this.isDualSidePosition = !this.isDualSidePosition;
          console.log(`🔄 [Auto-Recovery -4061] Mengalihkan isDualSidePosition ke ${this.isDualSidePosition} dan mencoba pasang ulang limit order ${symbol}...`);
          const client = await this.getHttpClient();
          const retryParams: Record<string, any> = {
            symbol,
            side,
            type: 'LIMIT',
            timeInForce,
            quantity: this.formatQty(symbol, qty),
            price: this.formatPrice(symbol, price),
          };
          if (this.isDualSidePosition) {
            retryParams.positionSide = reduceOnly
              ? (side === 'BUY' ? 'SHORT' : 'LONG')
              : (side === 'BUY' ? 'LONG' : 'SHORT');
          } else {
            retryParams.positionSide = 'BOTH';
            if (reduceOnly) retryParams.reduceOnly = 'true';
          }
          const retryData = this.signParams(retryParams);
          const retryRes = await client.post('/fapi/v1/order', retryData);
          return retryRes?.data || null;
        } catch (retryErr: any) {
          const rCode = retryErr.response?.data?.code;
          const rMsg = retryErr.response?.data?.msg || retryErr.message;
          console.error(`Gagal retry limit order ${symbol} [Code ${rCode}]:`, rMsg);
          return { error: true, code: rCode, msg: rMsg };
        }
      }

      // AUTO-RECOVERY 2: Error -2022 (ReduceOnly reject)
      // Proteksi Ketat: JANGAN PERNAH mencoba ulang order tanpa reduceOnly!
      // Menghapus reduceOnly pada order BUY akan membuka posisi LONG liar di One-Way Mode jika harga tersentuh.
      if (errCode === -2022) {
        console.warn(`⚠️ [Order Ditolak -2022] ${symbol} (${side} @ ${price}) ditolak Binance: ${errMsg}. Order reduceOnly dibatalkan demi keselamatan agar tidak membuka posisi berlawanan.`);
        return { error: true, code: -2022, msg: errMsg };
      }

      // AUTO-RECOVERY 3: Error -4014 atau -1111 (Price not increased by tick size / filter failure)
      if (errCode === -4014 || errCode === -1111 || String(errMsg).toLowerCase().includes('tick size')) {
        try {
          console.log(`🔄 [Auto-Recovery -4014] Memuat presisi live dari Binance untuk ${symbol} dan menyesuaikan tick size...`);
          await this.fetchSymbolPrecision(symbol);
          const client = await this.getHttpClient();
          const retryFormattedQty = this.formatQty(symbol, qty);
          const retryFormattedPrice = this.formatPrice(symbol, price);
          const retryParams: Record<string, any> = {
            symbol,
            side,
            type: 'LIMIT',
            timeInForce: 'GTC',
            quantity: retryFormattedQty,
            price: retryFormattedPrice,
          };
          if (this.isDualSidePosition) {
            retryParams.positionSide = side === 'BUY' ? 'SHORT' : 'LONG';
          } else {
            retryParams.positionSide = 'BOTH';
            if (reduceOnly) retryParams.reduceOnly = 'true';
          }
          const retryData = this.signParams(retryParams);
          const retryRes = await client.post('/fapi/v1/order', retryData);
          return retryRes?.data || null;
        } catch (retryErr: any) {
          const rCode = retryErr.response?.data?.code;
          const rMsg = retryErr.response?.data?.msg || retryErr.message;
          console.error(`Gagal retry auto-recovery -4014 untuk ${symbol} [Code ${rCode}]:`, rMsg);
          return { error: true, code: rCode, msg: rMsg };
        }
      }

      return { error: true, code: errCode, msg: errMsg };
    }
  }

  /**
   * Mengambil daftar order aktif/terbuka (Open Orders) dari Binance matching engine
   */
  public async getOpenOrders(symbol?: string): Promise<any[]> {
    if (!this.apiKey || !this.apiSecret) return [];
    try {
      const client = await this.getHttpClient();
      const params: Record<string, any> = {};
      if (symbol) params.symbol = symbol;
      const data = this.signParams(params);
      const res = await client.get(`/fapi/v1/openOrders?${data}`);
      return Array.isArray(res?.data) ? res.data : [];
    } catch (err: any) {
      console.error(`Gagal mengambil openOrders ${symbol || 'all'}:`, err.response?.data || err.message);
      return [];
    }
  }

  /**
   * Membatalkan order tertentu berdasarkan orderId
   */
  public async cancelOrder(symbol: string, orderId: string | number): Promise<boolean> {
    if (!this.apiKey || !this.apiSecret) return false;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol, orderId: String(orderId) });
      await client.delete(`/fapi/v1/order?${data}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Membatalkan semua order aktif koin tertentu
   */
  public async cancelAllOrders(symbol: string): Promise<void> {
    if (!this.apiKey || !this.apiSecret) return;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol });
      await client.delete(`/fapi/v1/allOpenOrders?${data}`);
    } catch {}
  }

  /**
   * Auto-Rotate WebSocket Domain to bypass Cloudflare shadowbans
   */
  private rotateWsDomain() {
    if (this.isTestnet) return;
    this.wsDomainIndex = (this.wsDomainIndex + 1) % this.wsDomains.length;
    const newDomain = this.wsDomains[this.wsDomainIndex];
    this.wsUrl = `wss://${newDomain}/market/ws/!ticker@arr`;
    logger.log('INFO', `🔄 [AUTO-ROTATION] Memutar URL WebSocket ke domain cadangan: ${newDomain}`);
  }

  private currentPollingIntervalMs: number = 1000;

  /**
   * Menghubungkan ke All-Market Ticker WebSocket Stream (!ticker@arr)
   */
  public async startTickerWebSocket(dataSource?: 'WEBSOCKET' | 'POLLING', pollingIntervalMs?: number) {
    if (dataSource) this.currentDataSource = dataSource;
    if (pollingIntervalMs && pollingIntervalMs >= 200) {
      this.currentPollingIntervalMs = pollingIntervalMs;
    }

    if (this.currentDataSource === 'POLLING') {
      logger.log(
        'INFO',
        `✅ Mode POLLING diaktifkan. Menghentikan WebSocket dan beralih ke REST API ${this.currentPollingIntervalMs}ms (${(this.currentPollingIntervalMs / 1000).toFixed(1)} detik).`
      );
      this.isWsConnected = false;
      if (this.wsClient) {
        try {
          this.wsClient.removeAllListeners();
          this.wsClient.terminate();
        } catch {}
        this.wsClient = null;
      }
      if (this.wsReconnectTimer) {
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = null;
      }
      this.startFastTickerStream(this.currentPollingIntervalMs);
      return;
    }

    // Jika WebSocket saat ini SUDAH terhubung dan aktif, jangan putus!
    if (this.currentDataSource === 'WEBSOCKET' && this.isWsConnected && this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
      if (this.wsReconnectTimer) {
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = null;
      }
      return;
    }

    if (this.wsClient) {
      try {
        this.wsClient.removeAllListeners();
        this.wsClient.terminate();
      } catch {}
      this.wsClient = null;
    }

    try {
      const agent = await this.getOrCreateDohAgent();
      this.wsClient = new WebSocket(this.wsUrl, {
        agent,
        handshakeTimeout: 10000,
      } as any);

      this.wsClient.on('open', () => {
        this.isWsConnected = true;
        this.wsReconnectAttempts = 0;
        this.lastWsMessageAt = Date.now();
        if (this.wsReconnectTimer) {
          clearTimeout(this.wsReconnectTimer);
          this.wsReconnectTimer = null;
        }
        console.log(`⚡ [WEBSOCKET CONNECTED] Terhubung ke Binance Futures All-Market Stream (${this.wsUrl})`);
        logger.log('INFO', '⚡ [MARKET DATA] Binance WebSocket terhubung.');
      });

      this.wsClient.on('message', (raw: WebSocket.Data) => {
        try {
          this.lastWsMessageAt = Date.now();
          if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
          }
          const data = JSON.parse(raw.toString());
          if (Array.isArray(data)) {
            if (data.length > 0 && this.fastPollInterval) {
              clearInterval(this.fastPollInterval);
              this.fastPollInterval = null;
              logger.log('INFO', '✅ [MARKET DATA] Payload ticker valid diterima. Fallback polling dihentikan.');
            }
            for (const listener of this.tickerListeners) {
              listener(data);
            }
          }
        } catch {}
      });

      this.wsClient.on('ping', () => {
        this.lastWsMessageAt = Date.now();
        try {
          this.wsClient?.pong();
        } catch {}
      });

      this.wsClient.on('error', (err) => {
        console.error('WebSocket Error:', err.message);
        logger.log('ERROR', `❌ [MARKET DATA] WebSocket Binance error: ${err.message}`);
      });

      this.wsClient.on('close', (code: number) => {
        this.isWsConnected = false;
        if (this.wsWatchdogTimer) {
          clearInterval(this.wsWatchdogTimer);
          this.wsWatchdogTimer = null;
        }
        if (this.currentDataSource === 'POLLING') return;

        this.wsReconnectAttempts++;
        if (this.wsReconnectAttempts >= 2) {
          this.rotateWsDomain();
          this.wsReconnectAttempts = 0;
        }

        const now = Date.now();
        if (code !== 1000 && now - this.lastWsCloseLog > 10000) {
          this.lastWsCloseLog = now;
          console.log(`⚠️ WebSocket terputus (Code: ${code}). Mencoba rekoneksi...`);
          logger.log('WARN', `⚠️ [MARKET DATA] WebSocket Binance terputus (Code: ${code}). Reconnect dijadwalkan.`);
        }
        // Fallback polling hanya jika WebSocket benar-benar terputus
        this.startFastTickerStream(this.currentPollingIntervalMs);
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => {
          this.wsReconnectTimer = null;
          this.startTickerWebSocket();
        }, 5000);
      });

      if (this.wsWatchdogTimer) clearInterval(this.wsWatchdogTimer);
      this.wsWatchdogTimer = setInterval(() => {
        if (this.currentDataSource !== 'WEBSOCKET') return;
        if (this.isWsConnected && Date.now() - this.lastWsMessageAt > 15000) {
          console.warn('⚠️ WebSocket Binance diam >15 detik. Mengaktifkan fallback polling dan reconnect.');
          logger.log('WARN', `⚠️ [MARKET DATA] WebSocket diam >15 detik. Fallback polling ${this.currentPollingIntervalMs}ms diaktifkan.`);
          this.isWsConnected = false;
          this.startFastTickerStream(this.currentPollingIntervalMs);
          this.rotateWsDomain();
          try {
            this.wsClient?.removeAllListeners();
            this.wsClient?.terminate();
          } catch {}
          this.wsClient = null;
          this.startTickerWebSocket();
        }
      }, 5000);
    } catch (e: any) {
      console.error('Gagal inisialisasi WebSocket:', e.message);
      this.startFastTickerStream(this.currentPollingIntervalMs);
      if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = setTimeout(() => {
        this.wsReconnectTimer = null;
        this.startTickerWebSocket();
      }, 5000);
    }
  }

  private fastPollInterval: NodeJS.Timeout | null = null;

  public async fetchAllTickerPrices(): Promise<any[]> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/ticker/price');
      if (Array.isArray(res.data)) {
        return res.data.map((item: any) => ({
          s: item.symbol,
          c: item.price,
          p: item.price,
        }));
      }
    } catch (err: any) {
      if (err.response) {
        const status = err.response.status;
        if (status === 429) {
          logger.log('WARN', `⚠️ [MARKET DATA] Terkena HTTP 429 Rate Limit (Used Weight: ${this.lastUsedWeight}/2400). Menahan request sementara...`);
        } else if (status === 418) {
          logger.log('ERROR', `❌ [MARKET DATA] IP Terkena Banned Sementara oleh API REST Binance (HTTP 418). Used Weight: ${this.lastUsedWeight}/2400.`);
        }
      }
    }
    return [];
  }

  /**
   * Fetch 24h ticker statistics including volume (for auto-blacklist refresh)
   * Endpoint: /fapi/v1/ticker/24hr
   */
  public async fetch24hTickers(): Promise<any[]> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/ticker/24hr');
      if (Array.isArray(res.data)) {
        return res.data.map((item: any) => ({
          s: item.symbol,
          c: item.lastPrice,
          p: item.lastPrice,
          q: item.quoteVolume, // 24h volume in USDT
        }));
      }
    } catch (err: any) {
      if (err.response) {
        const status = err.response.status;
        if (status === 429) {
          logger.log('WARN', `⚠️ [24H TICKER] Terkena HTTP 429 Rate Limit (Used Weight: ${this.lastUsedWeight}/2400).`);
        } else if (status === 418) {
          logger.log('ERROR', `❌ [24H TICKER] IP Terkena Banned (HTTP 418). Used Weight: ${this.lastUsedWeight}/2400.`);
        }
      }
    }
    return [];
  }

  public startFastTickerStream(intervalMs?: number) {
    const effectiveInterval = intervalMs || this.currentPollingIntervalMs || 1000;
    this.currentPollingIntervalMs = effectiveInterval;

    // Jika WebSocket sudah aktif dan mode bukan POLLING, jangan jalankan REST polling
    if (this.isWsConnected && this.currentDataSource !== 'POLLING') {
      if (this.fastPollInterval) {
        clearInterval(this.fastPollInterval);
        this.fastPollInterval = null;
      }
      return;
    }

    if (this.fastPollInterval) {
      clearInterval(this.fastPollInterval);
    }

    this.fetchAllTickerPrices().then((tickers) => {
      if (tickers.length > 0) {
        for (const listener of this.tickerListeners) {
          listener(tickers);
        }
      }
    }).catch(() => {});

    let isPolling = false;
    this.fastPollInterval = setInterval(async () => {
      if (isPolling) return;
      isPolling = true;
      try {
        const tickers = await this.fetchAllTickerPrices();
        if (tickers.length > 0) {
          for (const listener of this.tickerListeners) {
            listener(tickers);
          }
        }
      } finally {
        isPolling = false;
      }
    }, effectiveInterval);
  }

  public onTickers(callback: (tickers: any[]) => void) {
    this.tickerListeners.push(callback);
  }

  public isConnected(): boolean {
    return this.isWsConnected;
  }

  public async createListenKey(): Promise<string | null> {
    if (!this.apiKey) return null;
    try {
      const client = await this.getHttpClient();
      const res = await client.post('/fapi/v1/listenKey');
      if (res.data?.listenKey) {
        this.listenKey = res.data.listenKey;
        return this.listenKey;
      }
    } catch (err: any) {
      console.error('Gagal membuat listenKey Binance:', err.response?.data || err.message);
    }
    return null;
  }

  public async keepAliveListenKey(): Promise<boolean> {
    if (!this.apiKey || !this.listenKey) return false;
    try {
      const client = await this.getHttpClient();
      await client.put('/fapi/v1/listenKey');
      return true;
    } catch (err: any) {
      console.warn('Gagal keep-alive listenKey:', err.response?.data || err.message);
      return false;
    }
  }

  public async closeListenKey(): Promise<void> {
    if (!this.apiKey || !this.listenKey) return;
    try {
      const client = await this.getHttpClient();
      await client.delete('/fapi/v1/listenKey');
    } catch {}
  }

  public async startUserDataStream(): Promise<void> {
    if (!this.apiKey || !this.apiSecret) return;

    // Jika sudah aktif dan terhubung, tidak perlu reconnect berulang
    if (this.isUserWsConnected && this.userWsClient && this.userWsClient.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.userWsClient) {
      try {
        this.userWsClient.terminate();
      } catch {}
      this.userWsClient = null;
    }

    const key = await this.createListenKey();
    if (!key) {
      logger.log('WARN', '⚠️ [USER DATA STREAM] Gagal mendapatkan listenKey. Mencoba lagi dalam 15 detik...');
      if (this.userWsReconnectTimer) clearTimeout(this.userWsReconnectTimer);
      this.userWsReconnectTimer = setTimeout(() => this.startUserDataStream(), 15000);
      return;
    }

    if (this.listenKeyKeepAliveTimer) clearInterval(this.listenKeyKeepAliveTimer);
    this.listenKeyKeepAliveTimer = setInterval(async () => {
      const ok = await this.keepAliveListenKey();
      if (!ok) {
        this.startUserDataStream();
      }
    }, 30 * 60 * 1000);

    try {
      const agent = await this.getOrCreateDohAgent();
      const streamBase = this.isTestnet ? 'stream.binancefuture.com' : 'fstream.binance.com';
      // Menggunakan endpoint /private/ws/ resmi Binance Futures 2026
      const userWsUrl = `wss://${streamBase}/private/ws/${this.listenKey}`;

      this.userWsClient = new WebSocket(userWsUrl, {
        agent,
        handshakeTimeout: 10000,
      } as any);

      this.userWsClient.on('open', () => {
        this.isUserWsConnected = true;
        this.userWsReconnectAttempts = 0;
        if (!this.hasLoggedUserWsConnected) {
          this.hasLoggedUserWsConnected = true;
          logger.log('SUCCESS', '⚡ [USER DATA STREAM] Terhubung ke Binance Private Stream (Real-Time Order & Position Update Aktif).');
        }
      });

      this.userWsClient.on('message', (raw: WebSocket.Data) => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.e === 'ORDER_TRADE_UPDATE') {
            for (const fn of this.orderTradeListeners) {
              fn(data.o);
            }
          } else if (data.e === 'ACCOUNT_UPDATE') {
            for (const fn of this.accountUpdateListeners) {
              fn(data.a);
            }
          }
        } catch (err: any) {
          console.error('Error parse UserDataStream message:', err.message);
        }
      });

      this.userWsClient.on('close', (code) => {
        this.isUserWsConnected = false;
        this.userWsReconnectAttempts++;
        // Exponential backoff: 5s, 10s, 20s, 30s, max 60s
        const delayMs = Math.min(60000, Math.pow(2, Math.min(this.userWsReconnectAttempts - 1, 4)) * 5000);
        console.warn(`[USER DATA STREAM CLOSED] Code: ${code}. Attempt ${this.userWsReconnectAttempts}. Reconnecting in ${delayMs / 1000}s...`);

        if (this.userWsReconnectAttempts === 3) {
          logger.log(
            'WARN',
            `⚠️ [USER DATA STREAM] WebSocket privat terputus (Code: ${code}). Bot otomatis memakai sinkronisasi REST API untuk posisi & order.`
          );
          this.hasLoggedUserWsConnected = false;
        }

        if (this.userWsReconnectTimer) clearTimeout(this.userWsReconnectTimer);
        this.userWsReconnectTimer = setTimeout(() => this.startUserDataStream(), delayMs);
      });

      this.userWsClient.on('error', (err) => {
        console.error('[USER DATA STREAM ERROR]:', err.message);
        this.userWsClient?.terminate();
      });
    } catch (e: any) {
      console.error('Gagal inisialisasi UserDataStream:', e.message);
      if (this.userWsReconnectTimer) clearTimeout(this.userWsReconnectTimer);
      this.userWsReconnectTimer = setTimeout(() => this.startUserDataStream(), 10000);
    }
  }

  public onOrderTradeUpdate(callback: (order: any) => void) {
    this.orderTradeListeners.push(callback);
  }

  public onAccountUpdate(callback: (account: any) => void) {
    this.accountUpdateListeners.push(callback);
  }

  private smartMoneyCache: Map<string, { timestamp: number; data: any }> = new Map();

  public async getSmartMoneyMetrics(symbol: string, period: string = '5m'): Promise<{
    symbol: string;
    whaleLongRatio: number;
    whaleShortRatio: number;
    whaleLongShortRatio: number;
    smartTraderLongRatio: number;
    smartTraderShortRatio: number;
    smartTraderLongShortRatio: number;
    smartTraderLongAvgEntry?: number;
    smartTraderShortAvgEntry?: number;
    retailLongRatio: number;
    retailShortRatio: number;
    whaleLongAvgEntry?: number;
    whaleShortAvgEntry?: number;
    longWhalePositionsUsdt?: number;
    shortWhalePositionsUsdt?: number;
    longWhales?: number;
    shortWhales?: number;
    longProfitWhales?: number;
    shortProfitWhales?: number;
    longWhaleWinratePct?: number;
    shortWhaleWinratePct?: number;
    timestamp: number;
  } | null> {
    const cacheKey = `${symbol}_${period}`;
    const cached = this.smartMoneyCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < 30000) {
      return cached.data;
    }

    try {
      const client = await this.getHttpClient();
      const dohAgent = await this.getOrCreateDohAgent();

      const [posRes, topAccRes, globalRes, bapiStatsRes, bapiListRes, bapiOverviewRes] = await Promise.all([
        client.get('/futures/data/topLongShortPositionRatio', {
          params: { symbol, period, limit: 1 },
          timeout: 4000,
        }).catch(() => null),
        client.get('/futures/data/topLongShortAccountRatio', {
          params: { symbol, period, limit: 1 },
          timeout: 4000,
        }).catch(() => null),
        client.get('/futures/data/globalLongShortAccountRatio', {
          params: { symbol, period, limit: 1 },
          timeout: 4000,
        }).catch(() => null),
        axios.get(`https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/details/stats?symbol=${symbol}&timeRange=ALL`, {
          httpsAgent: dohAgent,
          timeout: 4000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'clienttype': 'web',
          },
        }).catch(() => null),
        axios.get(`https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/details/list?symbol=${symbol}&page=1&rows=5&timeRange=ALL&sortingField=POSITION&sortingOrder=DESC`, {
          httpsAgent: dohAgent,
          timeout: 4000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'clienttype': 'web',
          },
        }).catch(() => null),
        axios.get(`https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview?symbol=${symbol}`, {
          httpsAgent: dohAgent,
          timeout: 4000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'clienttype': 'web',
          },
        }).catch(() => null),
      ]);

      const posData = posRes?.data?.[0];
      let whaleLongRatio = parseFloat(posData?.longAccount || '0');
      let whaleShortRatio = parseFloat(posData?.shortAccount || '0');
      let whaleLongShortRatio = parseFloat(posData?.longShortRatio || '1');

      let smartTraderLongRatio = 0.5;
      let smartTraderShortRatio = 0.5;
      let smartTraderLongShortRatio = 1.0;
      const topAccData = topAccRes?.data?.[0];
      if (topAccData) {
        smartTraderLongRatio = parseFloat(topAccData.longAccount || '0.5');
        smartTraderShortRatio = parseFloat(topAccData.shortAccount || '0.5');
        smartTraderLongShortRatio = parseFloat(topAccData.longShortRatio || '1.0');
      }

      let whaleLongAvgEntry: number | undefined;
      let whaleShortAvgEntry: number | undefined;
      let smartTraderLongAvgEntry: number | undefined;
      let smartTraderShortAvgEntry: number | undefined;
      let longWhalePositionsUsdt: number | undefined;
      let shortWhalePositionsUsdt: number | undefined;
      let longWhales: number | undefined;
      let shortWhales: number | undefined;
      let longProfitWhales: number | undefined;
      let shortProfitWhales: number | undefined;
      let longWhaleWinratePct: number | undefined;
      let shortWhaleWinratePct: number | undefined;

      const bapiStats = bapiStatsRes?.data?.data;
      if (bapiStats) {
        longWhalePositionsUsdt = parseFloat(bapiStats.longWhalePositions || '0');
        shortWhalePositionsUsdt = parseFloat(bapiStats.shortWhalePositions || '0');
        longWhales = parseInt(bapiStats.longWhales || '0', 10);
        shortWhales = parseInt(bapiStats.shortWhales || '0', 10);

        const totalWhalePos = longWhalePositionsUsdt + shortWhalePositionsUsdt;
        if (totalWhalePos > 0) {
          whaleLongRatio = longWhalePositionsUsdt / totalWhalePos;
          whaleShortRatio = shortWhalePositionsUsdt / totalWhalePos;
          whaleLongShortRatio = shortWhalePositionsUsdt > 0 ? longWhalePositionsUsdt / shortWhalePositionsUsdt : 99;
        }
      }

      const bapiList = bapiListRes?.data?.data;
      if (Array.isArray(bapiList) && bapiList.length > 0) {
        const buyItem = bapiList.find((x: any) => x.side === 'BUY' && x.userType === 2) || bapiList.find((x: any) => x.side === 'BUY');
        const sellItem = bapiList.find((x: any) => x.side === 'SELL' && x.userType === 2) || bapiList.find((x: any) => x.side === 'SELL');
        if (buyItem?.avgEntryPrice) {
          whaleLongAvgEntry = parseFloat(buyItem.avgEntryPrice);
        }
        if (sellItem?.avgEntryPrice) {
          whaleShortAvgEntry = parseFloat(sellItem.avgEntryPrice);
        }
        const smartBuyItem = bapiList.find((x: any) => x.side === 'BUY' && x.userType === 1);
        const smartSellItem = bapiList.find((x: any) => x.side === 'SELL' && x.userType === 1);
        if (smartBuyItem?.avgEntryPrice) {
          smartTraderLongAvgEntry = parseFloat(smartBuyItem.avgEntryPrice);
        }
        if (smartSellItem?.avgEntryPrice) {
          smartTraderShortAvgEntry = parseFloat(smartSellItem.avgEntryPrice);
        }
      }

      const bapiOverview = bapiOverviewRes?.data?.data;
      if (bapiOverview) {
        if (bapiOverview.longWhalesAvgEntryPrice && !whaleLongAvgEntry) {
          const p = parseFloat(bapiOverview.longWhalesAvgEntryPrice);
          if (p > 0) whaleLongAvgEntry = p;
        }
        if (bapiOverview.shortWhalesAvgEntryPrice && !whaleShortAvgEntry) {
          const p = parseFloat(bapiOverview.shortWhalesAvgEntryPrice);
          if (p > 0) whaleShortAvgEntry = p;
        }
        if (bapiOverview.longWhales !== undefined) {
          longWhales = parseInt(bapiOverview.longWhales, 10);
        }
        if (bapiOverview.shortWhales !== undefined) {
          shortWhales = parseInt(bapiOverview.shortWhales, 10);
        }
        if (bapiOverview.longProfitWhales !== undefined) {
          longProfitWhales = parseInt(bapiOverview.longProfitWhales, 10);
        }
        if (bapiOverview.shortProfitWhales !== undefined) {
          shortProfitWhales = parseInt(bapiOverview.shortProfitWhales, 10);
        }
        if (longWhales && longWhales > 0 && longProfitWhales !== undefined) {
          longWhaleWinratePct = (longProfitWhales / longWhales) * 100;
        }
        if (shortWhales && shortWhales > 0 && shortProfitWhales !== undefined) {
          shortWhaleWinratePct = (shortProfitWhales / shortWhales) * 100;
        }
      }

      if (!posData && !bapiStats && !bapiOverview && !topAccData) return null;

      let retailLongRatio = 0.5;
      let retailShortRatio = 0.5;
      if (globalRes?.data?.[0]) {
        retailLongRatio = parseFloat(globalRes.data[0].longAccount || '0.5');
        retailShortRatio = parseFloat(globalRes.data[0].shortAccount || '0.5');
      }

      const result = {
        symbol,
        whaleLongRatio,
        whaleShortRatio,
        whaleLongShortRatio,
        smartTraderLongRatio,
        smartTraderShortRatio,
        smartTraderLongShortRatio,
        smartTraderLongAvgEntry,
        smartTraderShortAvgEntry,
        retailLongRatio,
        retailShortRatio,
        whaleLongAvgEntry,
        whaleShortAvgEntry,
        longWhalePositionsUsdt,
        shortWhalePositionsUsdt,
        longWhales,
        shortWhales,
        longProfitWhales,
        shortProfitWhales,
        longWhaleWinratePct,
        shortWhaleWinratePct,
        timestamp: posData?.timestamp || now,
      };

      this.smartMoneyCache.set(cacheKey, { timestamp: now, data: result });
      return result;
    } catch {
      return null;
    }
  }

  private rsiCache: Map<string, { timestamp: number; rsi: number }> = new Map();

  public async getSymbolRsi(symbol: string, interval: string = '15m'): Promise<number | undefined> {
    const cacheKey = `${symbol}_${interval}`;
    const cached = this.rsiCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < 30_000) {
      return cached.rsi;
    }

    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/klines', {
        params: { symbol, interval, limit: 25 },
        timeout: 4000,
      });
      if (res && Array.isArray(res.data) && res.data.length >= 15) {
        const closes = res.data.map((k: any) => parseFloat(k[4]));
        const period = 14;
        let gains = 0;
        let losses = 0;
        for (let i = 1; i <= period; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff >= 0) gains += diff;
          else losses += Math.abs(diff);
        }
        let avgGain = gains / period;
        let avgLoss = losses / period;
        for (let i = period + 1; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          const gain = diff > 0 ? diff : 0;
          const loss = diff < 0 ? Math.abs(diff) : 0;
          avgGain = (avgGain * (period - 1) + gain) / period;
          avgLoss = (avgLoss * (period - 1) + loss) / period;
        }
        let rsi = 50;
        if (avgLoss === 0 && avgGain === 0) rsi = 50;
        else if (avgLoss === 0) rsi = 100;
        else if (avgGain === 0) rsi = 0;
        else {
          const rs = avgGain / avgLoss;
          rsi = Math.round((100 - 100 / (1 + rs)) * 10) / 10;
        }
        this.rsiCache.set(cacheKey, { timestamp: now, rsi });
        return rsi;
      }
    } catch {}
    return undefined;
  }

  private atrCache: Map<string, { timestamp: number; atr: number; atrPct: number; currentPrice: number }> = new Map();

  public async getSymbolAtr(
    symbol: string,
    interval: string = '15m',
    period: number = 14
  ): Promise<{ atr: number; atrPct: number; currentPrice: number } | undefined> {
    const cacheKey = `${symbol}_${interval}_${period}`;
    const cached = this.atrCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < 30_000) {
      return { atr: cached.atr, atrPct: cached.atrPct, currentPrice: cached.currentPrice };
    }

    try {
      const client = await this.getHttpClient();
      const limit = Math.max(30, period + 25);
      const res = await client.get('/fapi/v1/klines', {
        params: { symbol, interval, limit },
        timeout: 4000,
      });

      if (res && Array.isArray(res.data) && res.data.length >= period + 1) {
        const trValues: number[] = [];
        for (let i = 1; i < res.data.length; i++) {
          const prev = res.data[i - 1];
          const curr = res.data[i];
          const high = parseFloat(curr[2]);
          const low = parseFloat(curr[3]);
          const prevClose = parseFloat(prev[4]);
          const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
          );
          trValues.push(tr);
        }

        if (trValues.length >= period) {
          let atr = trValues.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
          for (let i = period; i < trValues.length; i++) {
            atr = (atr * (period - 1) + trValues[i]) / period;
          }

          const currentPrice = parseFloat(res.data[res.data.length - 1][4]);
          if (currentPrice > 0) {
            const atrPct = (atr / currentPrice) * 100;
            const result = { atr, atrPct, currentPrice };
            this.atrCache.set(cacheKey, { timestamp: now, atr, atrPct, currentPrice });
            return result;
          }
        }
      }
    } catch {}
    return undefined;
  }

  private emaCache: Map<string, { timestamp: number; ema: number }> = new Map();

  public async getSymbolEma(
    symbol: string,
    interval: string = '15m',
    period: number = 50
  ): Promise<number | undefined> {
    const cacheKey = `${symbol}_${interval}_${period}`;
    const cached = this.emaCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < 30_000) {
      return cached.ema;
    }

    try {
      const client = await this.getHttpClient();
      const limit = Math.max(period + 30, 80);
      const res = await client.get('/fapi/v1/klines', {
        params: { symbol, interval, limit },
        timeout: 4000,
      });

      if (res && Array.isArray(res.data) && res.data.length >= period) {
        const closes = res.data.map((k: any) => parseFloat(k[4]));
        const multiplier = 2 / (period + 1);
        let ema = closes[0];
        for (let i = 1; i < closes.length; i++) {
          ema = (closes[i] - ema) * multiplier + ema;
        }
        this.emaCache.set(cacheKey, { timestamp: now, ema });
        return ema;
      }
    } catch {}
    return undefined;
  }

  private btcTrendCache: Map<string, { timestamp: number; data: BtcTrendStatus }> = new Map();
  private lastBtcTrendStatus: BtcTrendStatus | null = null;
  private lastDirectionalTrend: 'BULLISH' | 'BEARISH' | null = null;

  public getLastBtcTrendStatus(): BtcTrendStatus | null {
    return this.lastBtcTrendStatus;
  }

  public async getBtcTrendStatus(
    interval: string = '1h',
    period: number = 50,
    dropThresholdPct: number = 1.0,
    deadbandPct: number = 0.25,
    inheritSidewaysTrend: boolean = true
  ): Promise<BtcTrendStatus | null> {
    const deadband = Math.max(0, deadbandPct);
    const cacheKey = `${interval}_${period}_${dropThresholdPct}_${deadband}_${inheritSidewaysTrend}`;
    const cached = this.btcTrendCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.timestamp < 20_000) {
      return cached.data;
    }

    try {
      const client = await this.getHttpClient();
      const limit = Math.max(period + 30, 80);
      const res = await client.get('/fapi/v1/klines', {
        params: { symbol: 'BTCUSDT', interval, limit },
        timeout: 4000,
      });

      if (res && Array.isArray(res.data) && res.data.length >= period) {
        const klines = res.data;
        const closes = klines.map((k: any) => parseFloat(k[4]));
        const currentCandle = klines[klines.length - 1];
        const openPrice = parseFloat(currentCandle[1]);
        const currentPrice = parseFloat(currentCandle[4]);

        const multiplier = 2 / (period + 1);
        const emaSeries: number[] = new Array(closes.length);
        emaSeries[0] = closes[0];
        for (let i = 1; i < closes.length; i++) {
          emaSeries[i] = (closes[i] - emaSeries[i - 1]) * multiplier + emaSeries[i - 1];
        }
        const ema = emaSeries[emaSeries.length - 1];

        const candleChangePct = ((currentPrice - openPrice) / openPrice) * 100;
        const prevCandle = klines.length >= 2 ? klines[klines.length - 2] : null;
        const prevClose = prevCandle ? parseFloat(prevCandle[4]) : openPrice;
        const changeFromPrevClose = ((currentPrice - prevClose) / prevClose) * 100;

        const thresh = Math.abs(dropThresholdPct);
        const isFlashDump = candleChangePct <= -thresh || changeFromPrevClose <= -thresh;
        const isFlashSurge = candleChangePct >= thresh || changeFromPrevClose >= thresh;

        const diffUsdt = currentPrice - ema;
        const diffPct = ema > 0 ? (diffUsdt / ema) * 100 : 0;

        // Evaluasi Tren Macro dengan Deadband / Hysteresis Buffer:
        // - BULLISH: diffPct > +deadband (harga tegas di atas batas toleransi)
        // - BEARISH: diffPct < -deadband (harga tegas di bawah batas toleransi)
        // - SIDEWAYS: -deadband <= diffPct <= +deadband (harga berada di zona penyangga EMA, pasar berkonsolidasi)
        let trend: 'BULLISH' | 'BEARISH' | 'SIDEWAYS' = 'SIDEWAYS';
        if (diffPct > deadband) {
          trend = 'BULLISH';
          this.lastDirectionalTrend = 'BULLISH';
        } else if (diffPct < -deadband) {
          trend = 'BEARISH';
          this.lastDirectionalTrend = 'BEARISH';
        } else {
          trend = 'SIDEWAYS';
        }

        // Tentukan priorTrend secara deterministik dari riwayat klines (mencari candle terakhir di luar deadband):
        let priorTrend: 'BULLISH' | 'BEARISH' | 'NONE' = 'NONE';
        for (let i = closes.length - 2; i >= 0; i--) {
          const pastClose = closes[i];
          const pastEma = emaSeries[i];
          if (pastEma > 0) {
            const pastDiffPct = ((pastClose - pastEma) / pastEma) * 100;
            if (pastDiffPct > deadband) {
              priorTrend = 'BULLISH';
              break;
            } else if (pastDiffPct < -deadband) {
              priorTrend = 'BEARISH';
              break;
            }
          }
        }

        // Fallback ke cache memory jika seluruh lookback berada di dalam deadband
        if (priorTrend === 'NONE' && this.lastDirectionalTrend) {
          priorTrend = this.lastDirectionalTrend;
        } else if (priorTrend !== 'NONE' && !this.lastDirectionalTrend) {
          this.lastDirectionalTrend = priorTrend;
        }

        // Kebijakan Eksekusi (Anti-Whipsaw, Anti Trap & Intra-Deadband EMA Check):
        // 1. BULLISH  -> canLong = !isFlashDump, canShort = false
        // 2. BEARISH  -> canLong = false, canShort = !isFlashSurge
        // 3. SIDEWAYS (Regime Hysteresis / Trend Inertia & Intra-Deadband EMA Guard):
        //    - Long hanya diizinkan jika tren sideways membolehkan LONG dan harga masih bernilai positif di atas EMA (diffPct >= 0).
        //      Jika harga minus / di bawah EMA (diffPct < 0), dilarang LONG karena berisiko breakdown masuk ke bearish.
        //    - Short hanya diizinkan jika tren sideways membolehkan SHORT dan harga masih bernilai negatif di bawah EMA (diffPct <= 0).
        //      Jika harga positif / di atas EMA (diffPct > 0), dilarang SHORT karena berisiko breakout masuk ke bullish.
        let canLong = false;
        let canShort = false;

        if (trend === 'BULLISH') {
          canLong = !isFlashDump;
          canShort = false;
        } else if (trend === 'BEARISH') {
          canLong = false;
          canShort = !isFlashSurge;
        } else {
          const isAboveEma = diffPct >= 0;
          const isBelowEma = diffPct <= 0;

          if (inheritSidewaysTrend && priorTrend === 'BEARISH') {
            canLong = false;
            canShort = !isFlashSurge && isBelowEma;
          } else if (inheritSidewaysTrend && priorTrend === 'BULLISH') {
            canLong = !isFlashDump && isAboveEma;
            canShort = false;
          } else {
            canLong = !isFlashDump && isAboveEma;
            canShort = !isFlashSurge && isBelowEma;
          }
        }

        const priorLabel = trend === 'SIDEWAYS' && priorTrend !== 'NONE' ? ` [Prior: ${priorTrend}]` : '';
        let reason = `BTC $${currentPrice.toFixed(0)} (${trend}${priorLabel} vs EMA${period} $${ema.toFixed(0)}, Δ: ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(2)}%) | 1-Candle Δ: ${candleChangePct >= 0 ? '+' : ''}${candleChangePct.toFixed(2)}%`;
        if (isFlashDump) reason += ' | ⚠️ FLASH DUMP';
        if (isFlashSurge) reason += ' | 🚀 FLASH SURGE';
        if (trend === 'SIDEWAYS') {
          if (inheritSidewaysTrend && priorTrend === 'BULLISH' && !canLong && !isFlashDump) {
            reason += ' | ⛔ Di bawah EMA (Long Ditahan)';
          } else if (inheritSidewaysTrend && priorTrend === 'BEARISH' && !canShort && !isFlashSurge) {
            reason += ' | ⛔ Di atas EMA (Short Ditahan)';
          } else if (!inheritSidewaysTrend && !canLong && !canShort) {
            reason += ' | ⛔ Di luar zona aman EMA (Posisi Ditahan)';
          }
        }

        const result: BtcTrendStatus = {
          btcPrice: currentPrice,
          ema,
          trend,
          priorTrend,
          changePct: candleChangePct,
          isFlashDump,
          isFlashSurge,
          canLong,
          canShort,
          reason,
          timeframe: interval,
          period,
          diffUsdt,
          diffPct,
          deadbandPct: deadband,
          inheritSidewaysTrend,
          updatedAt: now,
        };

        this.lastBtcTrendStatus = result;
        this.btcTrendCache.set(cacheKey, { timestamp: now, data: result });
        return result;
      }
    } catch {
      if (cached) {
        return cached.data;
      }
    }
    return null;
  }

  private fundingRateCache: Map<string, { timestamp: number; ratePct: number }> = new Map();

  public async getFundingRate(symbol: string): Promise<number | undefined> {
    const cached = this.fundingRateCache.get(symbol);
    const now = Date.now();
    if (cached && now - cached.timestamp < 30_000) {
      return cached.ratePct;
    }

    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/premiumIndex', {
        params: { symbol },
        timeout: 3000,
      });
      if (res?.data?.lastFundingRate) {
        const fr = parseFloat(res.data.lastFundingRate);
        if (!isNaN(fr)) {
          const ratePct = fr * 100;
          this.fundingRateCache.set(symbol, { timestamp: now, ratePct });
          return ratePct;
        }
      }
    } catch {}
    return undefined;
  }

  public async getTicker24hr(symbol: string): Promise<any | null> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/ticker/24hr', {
        params: { symbol },
        timeout: 4000,
      });
      return res?.data || null;
    } catch {
      return null;
    }
  }

  public isUserStreamActive(): boolean {
    return this.isUserWsConnected;
  }
}

export const binanceFutures = new BinanceFuturesClient();
