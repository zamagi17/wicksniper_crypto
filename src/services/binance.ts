import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import WebSocket from 'ws';
import https from 'https';
import dns from 'dns';

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
  private wsUrl: string = 'wss://fstream.binance.com/ws/!ticker@arr';
  private restBaseUrl: string = 'https://fapi.binance.com';
  private wsClient: WebSocket | null = null;
  private httpClient: AxiosInstance | null = null;
  private timeOffset: number = 0;
  private precisions: Map<string, SymbolPrecision> = new Map();
  private isWsConnected: boolean = false;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private tickerListeners: ((tickers: any[]) => void)[] = [];

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
      this.wsUrl = 'wss://fstream.binance.com/ws/!ticker@arr';
    }

    this.initHttpClient();
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

  public async loadExchangeInfo(): Promise<Map<string, SymbolPrecision>> {
    try {
      const client = await this.getHttpClient();
      const res = await client.get('/fapi/v1/exchangeInfo');
      const symbols = res.data.symbols || [];

      for (const s of symbols) {
        if (s.contractType !== 'PERPETUAL' || s.status !== 'TRADING' || !s.symbol.endsWith('USDT')) {
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
          } else if (f.filterType === 'MIN_NOTIONAL') {
            minNotional = parseFloat(f.notional) || minNotional;
          }
        }

        this.precisions.set(s.symbol, {
          symbol: s.symbol,
          pricePrecision: s.pricePrecision || 4,
          quantityPrecision: s.quantityPrecision || 0,
          tickSize,
          stepSize,
          minQty,
          minNotional,
        });
      }

      return this.precisions;
    } catch (err: any) {
      console.error('Gagal memuat exchangeInfo Binance:', err.message);
      return this.precisions;
    }
  }

  public getPrecision(symbol: string): SymbolPrecision {
    return this.precisions.get(symbol) || {
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
    const prec = this.getPrecision(symbol);
    const decimals = Math.max(0, Math.round(-Math.log10(prec.tickSize)));
    return (Math.floor(price / prec.tickSize) * prec.tickSize).toFixed(decimals);
  }

  public formatQty(symbol: string, qty: number): string {
    const prec = this.getPrecision(symbol);
    const decimals = Math.max(0, Math.round(-Math.log10(prec.stepSize)));
    const rounded = Math.floor(qty / prec.stepSize) * prec.stepSize;
    return Math.max(prec.minQty, rounded).toFixed(decimals);
  }

  private signParams(params: Record<string, any>): string {
    const timestamp = Date.now() + this.timeOffset;
    const query = new URLSearchParams({ ...params, timestamp: String(timestamp) }).toString();
    const signature = crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
    return `${query}&signature=${signature}`;
  }

  public async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.apiKey || !this.apiSecret) return;
    try {
      const data = this.signParams({ symbol, leverage });
      await this.httpClient?.post('/fapi/v1/leverage', data);
    } catch {}
  }

  public async setMarginType(symbol: string, marginType: 'CROSSED' | 'ISOLATED'): Promise<void> {
    if (!this.apiKey || !this.apiSecret) return;
    try {
      const data = this.signParams({ symbol, marginType });
      await this.httpClient?.post('/fapi/v1/marginType', data);
    } catch {}
  }

  /**
   * Menembakkan order berjenjang (High-Frequency Batch) otomatis dipecah maks 5 order per request
   */
  public async sendBatchOrders(batchOrdersList: any[]): Promise<any[]> {
    if (!this.apiKey || !this.apiSecret || !batchOrdersList.length) return [];
    const allResults: any[] = [];
    const CHUNK_SIZE = 5;

    for (let i = 0; i < batchOrdersList.length; i += CHUNK_SIZE) {
      const chunk = batchOrdersList.slice(i, i + CHUNK_SIZE);
      try {
        const data = this.signParams({
          batchOrders: JSON.stringify(chunk),
        });
        const res = await this.httpClient?.post('/fapi/v1/batchOrders', data);
        if (Array.isArray(res?.data)) {
          allResults.push(...res.data);
        }
      } catch (err: any) {
        console.error(`Gagal mengeksekusi batchOrders (chunk ${Math.floor(i / CHUNK_SIZE) + 1}):`, err.response?.data || err.message);
      }
    }
    return allResults;
  }

  /**
   * Membuka posisi baru seketika dengan Market Order (Tanpa reduceOnly)
   */
  public async openMarketOrder(symbol: string, side: 'BUY' | 'SELL', qty: number): Promise<any> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const formattedQty = this.formatQty(symbol, qty);
      const data = this.signParams({
        symbol,
        side,
        type: 'MARKET',
        quantity: formattedQty,
      });
      const res = await this.httpClient?.post('/fapi/v1/order', data);
      return res?.data;
    } catch (err: any) {
      console.error(`Gagal membuka posisi market ${symbol}:`, err.response?.data || err.message);
      return null;
    }
  }

  /**
   * Menutup posisi seketika dengan Market Order (Dengan reduceOnly)
   */
  public async closePositionMarket(symbol: string, side: 'BUY' | 'SELL', qty: number): Promise<any> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const formattedQty = this.formatQty(symbol, qty);
      const data = this.signParams({
        symbol,
        side,
        type: 'MARKET',
        quantity: formattedQty,
        reduceOnly: 'true',
      });
      const res = await this.httpClient?.post('/fapi/v1/order', data);
      return res?.data;
    } catch (err: any) {
      console.error(`Gagal menutup posisi market ${symbol}:`, err.response?.data || err.message);
      return null;
    }
  }

  /**
   * Membatalkan semua order aktif koin tertentu
   */
  public async cancelAllOrders(symbol: string): Promise<void> {
    if (!this.apiKey || !this.apiSecret) return;
    try {
      const data = this.signParams({ symbol });
      await this.httpClient?.delete(`/fapi/v1/allOpenOrders?${data}`);
    } catch {}
  }

  /**
   * Menghubungkan ke All-Market Ticker WebSocket Stream (!ticker@arr)
   */
  public async startTickerWebSocket() {
    if (this.wsClient) {
      try {
        this.wsClient.terminate();
      } catch {}
      this.wsClient = null;
    }

    try {
      const agent = await this.getOrCreateDohAgent();
      this.wsClient = new WebSocket(this.wsUrl, { agent });

      this.wsClient.on('open', () => {
        this.isWsConnected = true;
        console.log(`⚡ [WEBSOCKET CONNECTED] Terhubung ke Binance Futures All-Market Stream (${this.wsUrl}) via DoH`);
      });

      this.wsClient.on('message', (raw: WebSocket.Data) => {
        try {
          const data = JSON.parse(raw.toString());
          if (Array.isArray(data)) {
            for (const listener of this.tickerListeners) {
              listener(data);
            }
          }
        } catch {}
      });

      this.wsClient.on('error', (err) => {
        console.error('WebSocket Error:', err.message);
      });

      this.wsClient.on('close', () => {
        this.isWsConnected = false;
        console.log('⚠️ WebSocket terputus. Mencoba rekoneksi dalam 3 detik...');
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => this.startTickerWebSocket(), 3000);
      });
    } catch (e: any) {
      console.error('Gagal inisialisasi WebSocket:', e.message);
      if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = setTimeout(() => this.startTickerWebSocket(), 5000);
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
    } catch {}
    return [];
  }

  public startFastTickerStream() {
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
    }, 1000);
  }

  public onTickers(callback: (tickers: any[]) => void) {
    this.tickerListeners.push(callback);
  }

  public isConnected(): boolean {
    return this.isWsConnected;
  }
}

export const binanceFutures = new BinanceFuturesClient();
