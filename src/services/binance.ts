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

    if (this.httpClient) {
      this.httpClient.defaults.baseURL = this.restBaseUrl;
      this.httpClient.defaults.headers['X-MBX-APIKEY'] = this.apiKey;
    }

    this.initHttpClient();

    if (this.apiKey && this.apiSecret) {
      this.checkPositionMode().catch(() => {});
    }
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
          } else if (f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL') {
            minNotional = parseFloat(f.notional || f.minNotional) || minNotional;
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
      if (this.precisions.size === 0) {
        setTimeout(() => this.loadExchangeInfo(), 5000);
      }
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
    if (price <= 0) return '0';
    const prec = this.getPrecision(symbol);
    let tickSize = prec.tickSize;
    if (price < tickSize && price > 0) {
      const exp = Math.floor(Math.log10(price));
      tickSize = Math.pow(10, exp - 1);
    }
    const decimals = Math.max(0, Math.round(-Math.log10(tickSize)));
    const rounded = Math.floor(price / tickSize + 1e-8) * tickSize;
    return rounded.toFixed(decimals);
  }

  public formatQty(symbol: string, qty: number): string {
    if (qty <= 0) return '0';
    const prec = this.getPrecision(symbol);
    const decimals = Math.max(0, Math.round(-Math.log10(prec.stepSize)));
    const rounded = Math.floor(qty / prec.stepSize + 1e-8) * prec.stepSize;
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

  /**
   * Mengambil saldo dompet Binance Futures (USDT)
   */
  public async getFuturesAccountBalance(): Promise<{ asset: string; balance: number; availableBalance: number }[]> {
    if (!this.apiKey || !this.apiSecret) return [];
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({});
      const res = await client.get(`/fapi/v2/balance?${data}`);
      if (Array.isArray(res?.data)) {
        return res.data.map((item: any) => ({
          asset: item.asset,
          balance: parseFloat(item.balance || '0'),
          availableBalance: parseFloat(item.availableBalance || item.withdrawAvailable || '0'),
        }));
      }
      return [];
    } catch (err: any) {
      console.error('Gagal mengambil saldo futures:', err.response?.data || err.message);
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
    unRealizedProfit: number;
    leverage: number;
  } | null> {
    if (!this.apiKey || !this.apiSecret) return null;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol });
      const res = await client.get(`/fapi/v2/positionRisk?${data}`);
      if (Array.isArray(res?.data)) {
        const item = res.data.find((p: any) => p.symbol === symbol);
        if (item) {
          return {
            symbol: item.symbol,
            positionAmt: parseFloat(item.positionAmt || '0'),
            entryPrice: parseFloat(item.entryPrice || '0'),
            unRealizedProfit: parseFloat(item.unRealizedProfit || '0'),
            leverage: parseInt(item.leverage || '5'),
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
      const binanceMsg = err.response?.data?.msg || err.message;
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

  public async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.apiKey || !this.apiSecret) return;
    const key = `${symbol}_${leverage}`;
    if (this.configuredSymbols.has(key)) return;
    try {
      const client = await this.getHttpClient();
      const data = this.signParams({ symbol, leverage });
      await client.post('/fapi/v1/leverage', data);
      this.configuredSymbols.add(key);
    } catch {}
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
        console.error(`Gagal mengeksekusi batchOrders (chunk ${Math.floor(i / CHUNK_SIZE) + 1}):`, err.response?.data || err.message);
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
      console.error(`Gagal membuka posisi market ${symbol}:`, err.response?.data || err.message);
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
