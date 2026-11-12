# 📘 Dokumentasi Resmi: Wick Sniper & Top Gainer Exhaustion Engine

Dokumentasi lengkap ini menjelaskan cara kerja sistem, logika pemicu (*entry triggers*), manajemen risiko jaring (*grid sizing*), serta benteng pengaman (*exit & protection*) pada bot **Wick Sniper Crypto**.

---

## 📑 Daftar Isi
1. [Arsitektur & Dua Pintu Pemicu Entry](#1-arsitektur--dua-pintu-pemicu-entry)
2. [Sistem Jaring Limit Grid & Formula Sizing](#2-sistem-jaring-limit-grid--formula-sizing)
3. [Benteng Pengaman & Manajemen Keluar (5 Lapis Exit)](#3-benteng-pengaman--manajemen-keluar-5-lapis-exit)
4. [Kamus Parameter Dashboard (Panduan Lengkap)](#4-kamus-parameter-dashboard-panduan-lengkap)
5. [Contoh Kasus & Perhitungan Riil](#5-contoh-kasus--perhitungan-riil)
6. [Tanya Jawab (FAQ) & Panduan Operasional](#6-tanya-jawab-faq--panduan-operasional)

---

## 1. Arsitektur & Dua Pintu Pemicu Entry

Bot terhubung langsung ke WebSocket Binance Futures (`!ticker@arr`) dan menerima data harga setiap milidetik. Saat mendeteksi peluang, bot mengevaluasi **dua pintu pemicu SHORT**:

```
                              [Binance Futures Ticker Stream]
                                             │
                       ┌─────────────────────┴─────────────────────┐
                       ▼                                           ▼
             [PINTU 1: GAYA LEADER]                       [PINTU 2: SPIKE BIASA]
         Top Gainer Exhaustion Sniper                    Spike Reversal Scalper
                       │                                           │
         • Kenaikan 24j ≥ 30%                        • Lonjakan cepat ≥ 2% (20 detik)
         • Volume 24j ≥ $30.000.000                  • Volume 24j ≥ $15.000.000
         • Deviasi MA(7) 2m ≥ +6.0%                  • Kenaikan 24j ≤ 35%
         • Volume Candle 2m ≥ 2x MA(Vol)             • Filter Tape Gap & Spread lolos
                       │                                           │
                       └─────────────────────┬─────────────────────┘
                                             ▼
                                  [EKSEKUSI GRID SHORT]
                     1. Market Order Layer 0 (Entry Pertama)
                     2. Limit Grid Orders (Layer 1 s/d N)
                     3. Limit Take Profit (1.6% Maker Order)
```

### A. Pintu 1: Top Gainer Exhaustion Sniper (Replikasi Copy Trading Leader)
* **Tujuan**: Menangkap puncak kelelahan (*blow-off top wick*) koin Top Gainer yang sudah naik tinggi, lalu menyerap sisa lonjakan dengan jaring limit sebelum harga terkoreksi tajam.
* **Syarat Wajib Terpenuhi Sekaligus**:
  1. **Top Gainer Filter**: Kenaikan 24 jam koin $\ge +30\%$.
  2. **Likuiditas Tinggi**: Volume perputaran 24 jam $\ge \$30.000.000\text{ USDT}$.
  3. **Rentang Candle**: Rentang candle 2 menit $\ge 5.0\%$.
  4. **Puncak Overextended (Deviasi MA)**: Harga tertinggi candle 2 menit melesat $\ge +6.0\%$ di atas garis Moving Average 7 periode (MA7).
  5. **Ledakan Volume Klimaks**: Volume candle 2 menit saat ini $\ge 2.0\times$ rata-rata volume MA(7).

### B. Pintu 2: Spike Reversal Scalper (Bawaan Wick Sniper)
* **Tujuan**: Menangkap jarum sumbu spontan (*flash spike*) pada koin likuid mana pun.
* **Syarat**:
  1. Harga melonjak $\ge +2.0\%$ dalam jendela waktu 20 detik.
  2. Volume 24 jam $\ge \$15.000.000\text{ USDT}$.
  3. Kenaikan 24 jam belum ekstrem ($< 35\%$) agar tidak terseret tren monster pump.

---

## 2. Sistem Jaring Limit Grid & Formula Sizing

Saat sinyal pemicu aktif, bot mengeksekusi jaring SHORT bertingkat ke atas:

### Model Sizing Aritmatika (+25% Per Layer - Gaya Leader)
Ukuran margin di setiap layer bertambah secara linear sebesar persentase tertentu dari Modal Dasar:

$$\text{Margin Layer } i = \text{Modal Per Layer} \times \left(1 + \frac{i \times \text{Kenaikan Aritmatika \%}}{100}\right)$$

#### Contoh Perhitungan (Modal Dasar = $5, Kenaikan = +25%):
* **Layer 0 (Market)**: $\$5.00$
* **Layer 1 (+1.3%)**: $\$5.00 \times 1.25 = \mathbf{\$6.25}$
* **Layer 2 (+2.6%)**: $\$5.00 \times 1.50 = \mathbf{\$7.50}$
* **Layer 3 (+3.9%)**: $\$5.00 \times 1.75 = \mathbf{\$8.75}$
* **Layer 4 (+5.2%)**: $\$5.00 \times 2.00 = \mathbf{\$10.00}$
* **Layer 5 (+6.5%)**: $\$5.00 \times 2.25 = \mathbf{\$11.25}$
* **Layer 6 (+7.8%)**: $\$5.00 \times 2.50 = \mathbf{\$12.50}$

### ⚠️ Aturan Plafon Margin (Penting!)
Di dashboard terdapat parameter **`Maksimal Margin Per Koin (USDT)`**:
* Akumulasi Layer 0 s/d Layer 5 = **$48.75 USDT**.
* Jika Layer 6 dipasang ($12.50 USDT), total margin menjadi **$61.25 USDT**.
* **Jika `Maksimal Margin Per Koin` diset ke $55 USDT**: Bot **otomatis berhenti di Layer 5** (hanya 6 layer yang dipasang) untuk mencegah over-leverage!
* **Jika ingin genap 7 layer**: Naikkan `Maksimal Margin Per Koin` menjadi **$65 USDT**, atau turunkan `Modal Per Layer` ke **$4.0 USDT**.

---

## 3. Benteng Pengaman & Manajemen Keluar (5 Lapis Exit)

Bot tidak mengandalkan satu pengaman saja, melainkan memiliki 5 lapis benteng otomatis:

```
[Koin Melonjak Liar]
         │
         ▼
[Lapis 1: BEP Defense] ──► Jika kena Layer 5 / 4 layer cepat (<120s),
         │                 TP diturunkan ke BEP (+0.2% fee). Koin mantul sedikit langsung keluar impas.
         ▼
[Lapis 2: Early Exit]  ──► Jika harga naik 5 candle berturut & floating loss ≥ 50% Hard SL,
         │                 bot CUT LOSS separuh jalan (tidak menunggu SL penuh).
         ▼
[Lapis 3: Hard SL]     ──► Batas mati 3.5% dari Average Entry Price.
         │                 Maksimal kerugian riil hanya ~$1.9 - $2.5 USDT (0.4% portofolio)!
         ▼
[Lapis 4: Max Hold]    ──► 45 menit tidak kunjung pullback? Bot auto-close pasar (anti-nyangkut).
         │
         ▼
[Lapis 5: Circuit Breaker] ──► Akumulasi rugi harian capai $150? Bot stop trading total hari itu.
```

1. **Take Profit (1.6%)**: Dipasang langsung sebagai Limit Order (Maker) di Binance. Begitu harga retrace ke bawah 1.6%, posisi tertutup otomatis dengan profit.
2. **BEP Defense (Breakeven)**: Jika koin terlalu kuat dan mengisi 5 layer, bot tahu momentumnya abnormal. Target TP langsung diturunkan ke titik impas (Average Price - 0.2% fee). Koin turun sedikit saja langsung keluar selamat tanpa rugi.
3. **Early Exit Momentum**: Jika koin terus mencetak candle hijau beruntun dan floating loss menyentuh separuh batas Hard SL, bot memotong rugi lebih dini demi efisiensi modal.
4. **Hard Stop Loss (3.5%)**: Dihitung dari harga rata-rata (*Average Entry Price*). Karena leverage rendah (3x) dan margin terkontrol (\$55), kerugian maksimal terburuk hanyalah **\$1.93 USDT**. Saldo akun (\$500) sangat aman.
5. **Time Stop (Max Hold 45 Menit)**: Mencegah modal terkunci berjam-jam pada koin yang masuk fase konsolidasi menyamping.

---

## 4. Kamus Parameter Dashboard (Panduan Lengkap)

### A. Tab: Wick Sniper (Spike)

| Parameter | Default | Keterangan & Dampak |
| :--- | :--- | :--- |
| **Top Gainer Exhaustion Sniper** | `Centang (Aktif)` | Mengaktifkan Pintu 1 (Strategi replikasi leader Binance Copy Trading). |
| **Min Kenaikan 24 Jam (%)** | `30` | Hanya memindai koin yang dalam 24 jam terakhir sudah terbang $\ge +30\%$. |
| **Min Volume 24 Jam (USDT)** | `30000000` | Turnover likuiditas koin minimal (\$30M) agar order jaring mudah tereksekusi tanpa slippage. |
| **Timeframe Candle** | `2 Menit (2m)` | Timeframe candle untuk mengukur deviasi dan volume klimaks. |
| **Periode MA** | `7` | Garis rata-rata pergerakan harga dasar (MA7) penentu level deviasi pucuk. |
| **Min Deviasi di Atas MA (%)** | `6.0` | Jarak puncak jarum terhadap garis MA7. Minimal +6.0% di atas garis MA baru dianggap pucuk kelelahan. |
| **Min Rentang Candle (%)** | `5.0` | Jarak `(High - Low) / Low` pada candle 2m minimal 5% (tanda volatilitas ekstrem). |
| **Min Ledakan Vol (x MA Vol)** | `2.0` | Volume candle pemicu minimal $2\times$ lipat dari rata-rata volume MA(7). |
| **Minimal Spike Lonjakan (%)** | `2` | Ambang pemicu Pintu 2 (Spike Reversal Biasa). *Tips: Jika ingin 100% murni gaya leader, naikkan ke 8-10% agar pintu 2 hening.* |
| **Target Take Profit (%) / TP 1** | `1.6` | Target keuntungan dari harga rata-rata posisi. |
| **Modal Per Layer (USDT)** | `5` | Margin yang dipakai untuk membuka Layer 0 awal. |
| **Maksimal Margin Per Koin (USDT)** | `55` | Batas plafon total modal gabungan seluruh layer untuk 1 koin. |
| **Jumlah Layer Jaring** | `7` | Target jumlah baris limit order yang disiapkan di atas harga pasar. |
| **Jarak Antar Jaring (%)** | `1.3` | Jarak persentase kenaikan harga di antara masing-masing limit order. |
| **Tipe Sizing Grid** | `Aritmatika (+X%)` | Mode penambahan lot. Aritmatika = lot bertambah linear teratur (Gaya Leader). |
| **Kenaikan Aritmatika Per Layer (%)** | `25` | Persentase penambahan modal per level layer (+25% per tangga). |
| **Plafon Margin Per Layer (USDT)** | `55` | Batas modal maksimal yang boleh dialokasikan pada satu baris layer tunggal. |
| **Pasang Seluruh Jaring Sekaligus** | `Centang (Aktif)` | Menebar seluruh limit order ke orderbook Binance secara instan (Gaya Leader). |

### B. Tab: Risk & Saldo

| Parameter | Default | Keterangan & Dampak |
| :--- | :--- | :--- |
| **Maksimal Koin Bersamaan** | `2` | Bot hanya membuka maksimal 2 koin aktif dalam satu waktu. |
| **Leverage** | `3x` | Daya ungkit margin. Menggunakan 3x Cross Margin membuat akun imun likuidasi. |
| **Hard Stop Loss (%)** | `3.5` | Batas rugi maksimal dari harga rata-rata posisi. |
| **BEP Defense Aktif** | `Centang (Aktif)` | Otomatis menurunkan TP ke titik impas jika terseret ke layer dalam. |
| **Trigger Layer BEP Defense** | `5` | Jika Layer 5 terisi, sistem pertahanan BEP langsung menyala. |
| **Batas Waktu Tahan Posisi (Menit)** | `45` | Posisi ditutup otomatis setelah 45 menit jika belum mencapai TP. |
| **Maksimal Rugi Harian (USDT)** | `150` | Circuit breaker: bot berhenti total jika kerugian harian menyentuh batas ini. |

---

## 5. Contoh Kasus & Perhitungan Riil

### Kasus: Trade IDOLUSDT (Data Riil Bot)
```
Entry Price  : 0.039161
Exit Price   : 0.038526 (Drop -1.62% ke target TP 1.6%)
Margin Used  : $5.00 USDT
Leverage     : 3x Cross
PnL Bersih   : +$0.23 USDT (+4.6% dari margin)
Durasi       : 181 detik (3 menit)
Alasan Exit  : TAKE_PROFIT
```
* **Kenapa masuk?** IDOLUSDT melonjak +2.07% dalam 20 detik (memicu Radar Spike 2%).
* **Jaring yang disiapkan**: 6 layer berjarak 1.3% ke atas dengan modal bertingkat ($5, $6.24, $7.48, $8.75, $10, $11.25).
* **Perilaku pasar**: Hanya Layer 0 yang terisi, harga langsung pullback turun menyentuh target TP 1.6%, dan posisi sukses ditutup dalam 3 menit.

---

## 6. Tanya Jawab (FAQ) & Panduan Operasional

### Q1: Bot diam berjam-jam, apakah normal?
**Sangat normal.** Bot ini adalah *Sniper*, bukan bot grid sembarangan. Bot hanya bereaksi saat ada koin yang benar-benar mengalami deviasi ekstrem di pucuk atau spike kilat. Leader Binance pun rata-rata hanya masuk 1–4 kali sehari.

### Q2: Mengapa koin yang naik baru 16% bisa ditembak bot?
Karena parameter **Minimal Spike Lonjakan (%)** diset `2%`. Koin dengan kenaikan 24j berapa pun (asalkan di bawah 35%), jika tiba-tiba melonjak 2% dalam 20 detik, akan ditembak oleh Pintu 2.  
* **Jika Anda hanya ingin 100% gaya leader (hanya Top Gainer pucuk):** Naikkan angka `Minimal Spike Lonjakan (%)` ke `8%` atau `10%`. Dengan begitu, Pintu 2 akan hening dan bot murni hanya menembak koin Top Gainer yang naik $\ge 30\%$.

### Q3: Mengapa jaring hanya terpasang 6 layer, bukan 7 layer?
Karena akumulasi modal Layer 0 s/d Layer 5 sudah mencapai **$48.72 USDT**. Jika Layer 6 dipasang ($12.50 USDT), totalnya menjadi $61.22 USDT, melampaui `Maksimal Margin Per Koin` ($55 USDT).  
* **Solusi agar genap 7 layer:** Ubah `Maksimal Margin Per Koin` menjadi **$65 USDT**.

### Q4: Apakah akun saya bisa terkena Likuidasi?
**Secara matematis tidak.** Dengan modal $500, posisi per koin hanya $55 pada Leverage 3x Cross Margin. Koin harus terbang naik lebih dari **+300%** tanpa henti untuk melikuidasi akun. Ditambah lagi, Hard SL di 3.5% akan memotong posisi jauh sebelum risiko margin terjadi (maksimal rugi hanya ~$2 USDT).

### Q5: Bagaimana Radar "Penyelamatan Modal" bekerja?
Radar Simulasi Bayangan (*Shadow Trading*) memantau seluruh koin yang ditolak filter menggunakan **Simulasi Jaring Multi-Layer Dinamis**:
* Jika harga koin naik menembus layer demi layer, bot bayangan menyerap lonjakan tersebut dan menghitung ulang harga rata-rata (*Average Entry Price*).
* Koin hanya dikategorikan **"Selamat dari Stop Loss (Saved SL)"** jika kenaikan harga menembus **seluruh 7 layer jaring** dan melewati Hard Stop Loss akhir.
* Jika koin berbalik arah di layer mana pun (misal Layer 1, 2, atau 3) dan menyentuh TP, maka dicatat sebagai **"Peluang Terlewat (Missed TP)"** lengkap dengan estimasi profit riilnya.

