import fs from 'fs';
import path from 'path';
import { binanceFutures } from './binance';

export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  tradesCount: number;
}

export class HistoricalDataFetcher {
  private cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir || path.resolve(__dirname, '../../data_cache');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Mengambil data klines dari Binance Futures atau dari cache lokal
   */
  public async getKlines(
    symbol: string,
    interval: string = '1m',
    startTime: number,
    endTime: number,
    useCache: boolean = true
  ): Promise<Candle[]> {
    symbol = symbol.toUpperCase().trim();
    const cacheFileName = `${symbol}_${interval}_${Math.floor(startTime / 60000)}_${Math.floor(endTime / 60000)}.json`;
    const cacheFilePath = path.join(this.cacheDir, cacheFileName);

    if (useCache && fs.existsSync(cacheFilePath)) {
      try {
        const raw = fs.readFileSync(cacheFilePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      } catch { }
    } else if (!useCache && fs.existsSync(cacheFilePath)) {
      // Jika bypass cache aktif, hapus file cache lama agar data lama tidak lagi tersisa
      try {
        fs.unlinkSync(cacheFilePath);
      } catch { }
    }

    const client = await binanceFutures.getHttpClient();
    const allCandles: Candle[] = [];
    let currentStart = startTime;
    const limit = 1500; // Maksimal batas per request Binance Futures

    let fetchErrorOccurred = false;

    while (currentStart < endTime) {
      try {
        const res = await client.get('/fapi/v1/klines', {
          params: {
            symbol,
            interval,
            startTime: currentStart,
            endTime,
            limit,
          },
        });

        const data = res.data;
        if (!Array.isArray(data) || data.length === 0) {
          break;
        }

        for (const item of data) {
          allCandles.push({
            openTime: item[0],
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
            volume: parseFloat(item[5]),
            closeTime: item[6],
            tradesCount: parseInt(item[8] || '0', 10),
          });
        }

        const lastCandle = data[data.length - 1];
        const lastCloseTime = lastCandle[6];

        if (data.length < limit || lastCloseTime >= endTime) {
          break;
        }

        currentStart = lastCloseTime + 1;
        // Jeda 100ms agar aman dari rate limit
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (err: any) {
        fetchErrorOccurred = true;
        console.error(`[DataFetcher] Error fetching ${symbol}: ${err.message}`);
        break;
      }
    }

    // Urutkan berdasarkan waktu dan buang duplikat jika ada
    const uniqueCandles = Array.from(
      new Map(allCandles.map((c) => [c.openTime, c])).values()
    ).sort((a, b) => a.openTime - b.openTime);

    // Simpan cache terbaru jika proses pengambilan dari Binance berhasil tanpa error
    if (!fetchErrorOccurred && uniqueCandles.length > 0) {
      try {
        fs.writeFileSync(cacheFilePath, JSON.stringify(uniqueCandles), 'utf-8');
      } catch (err: any) {
        console.warn(`[DataFetcher] Gagal menyimpan cache: ${err.message}`);
      }
    }

    return uniqueCandles;
  }

  /**
   * Menghapus seluruh cache klines lokal dari disk
   */
  public clearAllCache(): number {
    try {
      if (fs.existsSync(this.cacheDir)) {
        const files = fs.readdirSync(this.cacheDir);
        let count = 0;
        for (const file of files) {
          if (file.endsWith('.json')) {
            try {
              fs.unlinkSync(path.join(this.cacheDir, file));
              count++;
            } catch { }
          }
        }
        return count;
      }
    } catch (err: any) {
      console.warn(`[DataFetcher] Gagal menghapus cache: ${err.message}`);
    }
    return 0;
  }
}

export const dataFetcher = new HistoricalDataFetcher();
