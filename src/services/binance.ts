import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import WebSocket from 'ws';
import https from 'https';
import dns from 'dns';
import { logger } from './logger';

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
  private wsDomains: string[] = ['fstream.binance.com', 'fstream.binance.me', 'fstream.binance.je'];
  private wsUrl: string = `wss://${this.wsDomains[0]}/ws/!ticker@arr`;
  private currentDataSource: 'WEBSOCKET' | 'POLLING' = 'WEBSOCKET';
  private wsClient: WebSocket | null = null;
  private httpClient: AxiosInstance | null = null;
  private timeOffset: number = 0;
  private precisions: Map<string, SymbolPrecision> = new Map();
  private isWsConnected: boolean = false;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
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
      this.wsUrl = 'wss://stream.binancefuture.com/ws/!ticker@arr';
    } else {
      this.restBaseUrl = 'https://fapi.binance.com';
      this.wsDomainIndex = 0;
      this.wsUrl = `wss://${this.wsDomains[this.wsDomainIndex]}/ws/!ticker@arr`;
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
    if (this.dohCache.has(hostname)) {
      return this.dohCache.get(hostname)!;
    }
    try {
      const res = await axios.get(`https://cloudflare-dns.com/dns-query?name=${hostname}&type=A`, {
        headers: { accept: 'application/dns-json' },
        timeout: 4000,
      });
      const answers = res.data?.Answer || [];
      for (const a of answers) {
        if (a.type === 1 && a.data) {
          this.dohCache.set(hostname, a.data);
          return a.data;
        }
      }
    } catch {}
    const fallback = hostname.includes('testnet') ? '18.64.37.31' : '35.77.171.26';
    this.dohCache.set(hostname, fallback);
    return fallback;
  }

  private async getOrCreateDohAgent(): Promise<https.Agent> {
    if (this.dohAgent) return this.dohAgent;

    const fapiIp = await this.resolveHostViaDoH(this.isTestnet ? 'testnet.binancefuture.com' : 'fapi.binance.com');
    const fstreamIp = await this.resolveHostViaDoH(this.isTestnet ? 'stream.binancefuture.com' : 'fstream.binance.com');

    this.dohAgent = new https.Agent({
      keepAlive: true,
      lookup: (hostname, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const opt = typeof options === 'object' ? options : {};
        let ip = fapiIp;
        if (hostname.includes('stream') || hostname.includes('fstream')) {
          ip = fstreamIp;
        }
        if (hostname.includes('binance')) {
          if (opt && (opt as any).all) {
            cb(null, [{ address: ip, family: 4 }] as any);
          } else {
            cb(null, ip, 4);
          }
        } else {
          dns.lookup(hostname, options, cb);
        }
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
            console.log(`🔄 Mengirim ulang order penutupan dengan ukuran presisi: ${retryFormattedQty}`);
            const client = await this.getHttpClient();
            const retryParams: Record<string, any> = {
              symbol,
              side,
              type: 'MARKET',
              quantity: retryFormattedQty,
            };
            if (this.isDualSidePosition) {
              retryParams.positionSide = side === 'BUY' ? 'SHORT' : 'LONG';
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
    reduceOnly: boolean = false
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
        timeInForce: 'GTC',
        quantity: formattedQty,
        price: formattedPrice,
      };

      if (this.isDualSidePosition) {
        params.positionSide = side === 'BUY' ? 'SHORT' : 'LONG';
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
            timeInForce: 'GTC',
            quantity: this.formatQty(symbol, qty),
            price: this.formatPrice(symbol, price),
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
          console.error(`Gagal retry limit order ${symbol} [Code ${rCode}]:`, rMsg);
          return { error: true, code: rCode, msg: rMsg };
        }
      }

      // AUTO-RECOVERY 2: Error -2022 (ReduceOnly reject)
      if (errCode === -2022) {
        try {
          console.log(`🔄 [Auto-Recovery -2022] Mencoba tanpa reduceOnly untuk ${symbol}...`);
          const client = await this.getHttpClient();
          const retryParams: Record<string, any> = {
            symbol,
            side,
            type: 'LIMIT',
            timeInForce: 'GTC',
            quantity: this.formatQty(symbol, qty),
            price: this.formatPrice(symbol, price),
            positionSide: this.isDualSidePosition ? (side === 'BUY' ? 'SHORT' : 'LONG') : 'BOTH',
          };
          const retryData = this.signParams(retryParams);
          const retryRes = await client.post('/fapi/v1/order', retryData);
          return retryRes?.data || null;
        } catch (retryErr: any) {
          return { error: true, code: retryErr.response?.data?.code, msg: retryErr.response?.data?.msg || retryErr.message };
        }
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
    this.wsUrl = `wss://${newDomain}/ws/!ticker@arr`;
    logger.log('INFO', `🔄 [AUTO-ROTATION] Memutar URL WebSocket ke domain cadangan: ${newDomain}`);
  }

  /**
   * Menghubungkan ke All-Market Ticker WebSocket Stream (!ticker@arr)
   */
  public async startTickerWebSocket(dataSource?: 'WEBSOCKET' | 'POLLING') {
    if (dataSource) this.currentDataSource = dataSource;

    if (this.currentDataSource === 'POLLING') {
      logger.log('INFO', '✅ Mode POLLING diaktifkan. Menghentikan WebSocket dan beralih ke REST API 1000ms (1 detik).');
      this.isWsConnected = false;
      if (this.wsClient) {
        try {
          this.wsClient.terminate();
        } catch {}
        this.wsClient = null;
      }
      if (this.wsReconnectTimer) {
        clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = null;
      }
      this.startFastTickerStream(1000);
      return;
    }

    if (this.wsClient) {
      try {
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
        this.lastWsMessageAt = Date.now();
        console.log(`⚡ [WEBSOCKET CONNECTED] Terhubung ke Binance Futures All-Market Stream (${this.wsUrl})`);
        logger.log('INFO', '⚡ [MARKET DATA] Binance WebSocket terhubung.');
      });

      this.wsClient.on('message', (raw: WebSocket.Data) => {
        try {
          this.lastWsMessageAt = Date.now();
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
        const now = Date.now();
        if (code !== 1000 && now - this.lastWsCloseLog > 30000) {
          this.lastWsCloseLog = now;
          console.log(`⚠️ WebSocket terputus (Code: ${code}). Mencoba rekoneksi...`);
          logger.log('WARN', `⚠️ [MARKET DATA] WebSocket Binance terputus (Code: ${code}). Reconnect dijadwalkan.`);
        }
        // Fallback polling hanya jika WebSocket benar-benar terputus
        this.startFastTickerStream();
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.startTickerWebSocket(), 30000);
      });

      if (this.wsWatchdogTimer) clearInterval(this.wsWatchdogTimer);
      this.wsWatchdogTimer = setInterval(() => {
        if (this.isWsConnected && Date.now() - this.lastWsMessageAt > 5000) {
          console.warn('⚠️ WebSocket Binance diam >5 detik. Mengaktifkan fallback polling dan reconnect.');
          logger.log('WARN', '⚠️ [MARKET DATA] WebSocket diam >5 detik. Fallback polling 1 detik diaktifkan.');
          this.isWsConnected = false;
          this.startFastTickerStream();
          this.rotateWsDomain();
          this.wsClient?.terminate();
        }
      }, 2000);
    } catch (e: any) {
      console.error('Gagal inisialisasi WebSocket:', e.message);
      this.startFastTickerStream();
      if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = setTimeout(() => this.startTickerWebSocket(), 30000);
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

  public startFastTickerStream(intervalMs: number = 1000) {
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

    this.fastPollInterval = setInterval(async () => {
      const tickers = await this.fetchAllTickerPrices();
      if (tickers.length > 0) {
        for (const listener of this.tickerListeners) {
          listener(tickers);
        }
      }
    }, intervalMs);
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
      const userWsUrl = `wss://${streamBase}/ws/${this.listenKey}`;

      this.userWsClient = new WebSocket(userWsUrl, {
        agent,
        handshakeTimeout: 10000,
      } as any);

      this.userWsClient.on('open', () => {
        this.isUserWsConnected = true;
        logger.log('SUCCESS', '⚡ [USER DATA STREAM] Terhubung ke Binance Private Stream (Real-Time Order & Position Update Aktif).');
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
        console.warn(`[USER DATA STREAM CLOSED] Code: ${code}. Reconnecting in 5s...`);
        if (this.userWsReconnectTimer) clearTimeout(this.userWsReconnectTimer);
        this.userWsReconnectTimer = setTimeout(() => this.startUserDataStream(), 5000);
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

  public isUserStreamActive(): boolean {
    return this.isUserWsConnected;
  }
}

export const binanceFutures = new BinanceFuturesClient();
