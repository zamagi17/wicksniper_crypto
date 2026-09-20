let socket = null;
let currentStatus = null;
let currentConfig = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  fetchInitialData();
});

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;
  socket = new WebSocket(wsUrl);

  const indicator = document.getElementById('ws-indicator');
  const statusText = document.getElementById('ws-status-text');

  socket.onopen = () => {
    indicator.className = 'status-pill online';
    statusText.innerText = 'TERHUBUNG';
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'STATUS') {
        renderStatus(msg.data);
      } else if (msg.type === 'CONFIG') {
        currentConfig = msg.data;
        if (currentStatus) renderStatus(currentStatus);
      } else if (msg.type === 'LOG') {
        appendLog(msg.data);
        if (msg.data.level === 'SNIPER') {
          playSpikeAlertSound();
        } else if (msg.data.level === 'SUCCESS' && msg.data.message.includes('POSISI DITUTUP')) {
          playProfitSound();
        }
      } else if (msg.type === 'LOGS') {
        renderLogs(msg.data);
      }
    } catch (e) {
      console.error('Error parsing WebSocket message:', e);
    }
  };

  socket.onclose = () => {
    indicator.className = 'status-pill offline';
    statusText.innerText = 'TERPUTUS';
    setTimeout(connectWebSocket, 3000);
  };
}

// Web Audio Synthesizer (Zero External Assets, 100% Reliable & Offline)
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

function playSpikeAlertSound() {
  try {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1400, ctx.currentTime + 0.18);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch {}
}

function playProfitSound() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    [587.33, 880].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, now + idx * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.01, now + idx * 0.12 + 0.35);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.35);
    });
  } catch {}
}

async function fetchInitialData() {
  // Coba muat cache lokal terlebih dahulu untuk kecepatan render
  try {
    const cachedCfg = localStorage.getItem('wicksniper_config');
    if (cachedCfg) {
      currentConfig = JSON.parse(cachedCfg);
      populateSettingsForm(currentConfig);
    }
  } catch (e) {}

  try {
    const [resStatus, resConfig, resLogs] = await Promise.all([
      fetch('/api/status?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
      fetch('/api/logs?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
    ]);
    currentConfig = resConfig;
    try {
      localStorage.setItem('wicksniper_config', JSON.stringify(resConfig));
    } catch (e) {}
    if (!settingsFormInitialized && !localStorage.getItem('wicksniper_settings_draft')) {
      populateSettingsForm(resConfig);
      settingsFormInitialized = true;
    }
    renderStatus(resStatus);
    renderLogs(resLogs);
  } catch (err) {
    console.error('Gagal mengambil data awal:', err);
  }
}

function renderStatus(status) {
  currentStatus = status;

  // 1. Tombol Jalankan / Hentikan
  const btnIcon = document.getElementById('btn-engine-icon');
  const btnText = document.getElementById('btn-engine-text');
  const btnToggle = document.getElementById('btn-toggle-engine');

  if (status.isRunning) {
    btnToggle.className = 'btn btn-danger';
    btnIcon.innerText = '⏹';
    btnText.innerText = 'Hentikan Bot';
  } else {
    btnToggle.className = 'btn btn-primary';
    btnIcon.innerText = '▶';
    btnText.innerText = 'Jalankan Bot';
  }

  // 2. Mode Badge
  const modeBadge = document.getElementById('mode-badge');
  if (status.tradingMode === 'LIVE') {
    modeBadge.className = 'badge-mode live';
    modeBadge.innerText = '🟢 LIVE FUTURES';
    document.getElementById('metric-balance-type').innerText = 'Saldo Live Binance';
  } else {
    modeBadge.className = 'badge-mode paper';
    modeBadge.innerText = '🧪 PAPER TRADING';
    document.getElementById('metric-balance-type').innerText = 'Mode Virtual Paper';
  }

  // 3. KPI Cards
  document.getElementById('metric-balance').innerText = `$${status.virtualBalance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

  const pnlEl = document.getElementById('metric-pnl');
  const isPosPnl = status.accumulatedPnl >= 0;
  pnlEl.innerText = `${isPosPnl ? '+' : ''}$${status.accumulatedPnl.toFixed(2)}`;
  pnlEl.className = `kpi-value ${isPosPnl ? 'text-green' : 'text-red'}`;
  document.getElementById('metric-pnl-sub').innerText = `${status.totalTrades} Trade Selesai`;

  document.getElementById('metric-winrate').innerText = `${status.winRate.toFixed(1)}%`;
  const wins = Math.round((status.winRate / 100) * status.totalTrades);
  const losses = status.totalTrades - wins;
  document.getElementById('metric-winrate-sub').innerText = `${wins} Menang / ${losses} Kalah`;

  document.getElementById('metric-spikes').innerText = status.spikesDetectedToday;
  const totalActiveMargin = (status.activePositions || []).reduce((sum, p) => sum + (p.totalMarginUsed || 0), 0);
  document.getElementById('metric-positions-count').innerText = `${status.activePositionsCount} / ${currentConfig?.grid?.maxConcurrentCoins || 2} Koin Aktif ${status.activePositionsCount > 0 ? `($${totalActiveMargin.toFixed(2)})` : ''}`;
  document.getElementById('metric-leverage').innerText = `${status.leverage || 5}x ${status.marginType === 'ISOLATED' ? 'Iso' : 'Cross'}`;
  document.getElementById('radar-pulse-tag').innerText = `Memindai ${status.monitoredCoinsCount || 0} Koin (${status.ticksPerSecond || 0} tick/s)`;
  document.getElementById('active-count-tag').innerText = `${status.activePositionsCount} Posisi`;
  
  const activeMarginEl = document.getElementById('active-margin-tag');
  if (activeMarginEl) {
    if (status.activePositionsCount > 0) {
      activeMarginEl.style.display = 'inline-block';
      activeMarginEl.innerText = `Margin Aktif: $${totalActiveMargin.toFixed(2)} USDT`;
    } else {
      activeMarginEl.style.display = 'none';
    }
  }

  document.getElementById('closed-count-tag').innerText = `${status.totalTrades} Trade`;

  // 4. Render Active Positions
  renderActivePositions(status.activePositions || []);

  // 5. Render Spikes Radar
  renderSpikesTable(status.recentSpikes || []);

  // 6. Render Closed Trades
  renderClosedTradesTable(status.recentTrades || []);
}

function renderActivePositions(positions) {
  const container = document.getElementById('active-positions-container');
  if (!positions || positions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🕸️</div>
        <p>Belum ada posisi aktif.</p>
        <small>Bot sedang memindai 300+ koin futures untuk mendeteksi lonjakan harga (spike)...</small>
      </div>
    `;
    return;
  }

  container.innerHTML = positions
    .map((pos) => {
      const isProfit = (pos.unrealizedPnl || 0) >= 0;
      const pnlColor = isProfit ? 'text-green' : 'text-red';
      const pnlSign = isProfit ? '+' : '';

      const layersHtml = (pos.layers || [])
        .map((l) => `<span class="layer-badge ${l.status.toLowerCase()}">L#${l.layerIndex}: $${l.price.toFixed(4)} (${l.status} • $${l.marginUsdt.toFixed(2)})</span>`)
        .join('');

      return `
        <div class="position-card">
          <div class="pos-header">
            <div class="pos-symbol">
              ${pos.symbol}
              <span class="badge-side short">SHORT ${pos.leverage}x</span>
              <span class="badge-margin-tag">💰 Margin: $${(pos.totalMarginUsed || 0).toFixed(2)} / $${currentConfig?.grid?.maxTotalMarginPerCoin || 35} USDT</span>
            </div>
            <div class="pos-pnl">
              <div class="pos-pnl-val ${pnlColor}">${pnlSign}$${(pos.unrealizedPnl || 0).toFixed(2)}</div>
              <div class="pos-pnl-pct ${pnlColor}">${pnlSign}${(pos.pnlPct || 0).toFixed(1)}%</div>
            </div>
          </div>

          <div class="pos-metrics">
            <div class="pos-metric-item">
              <small>Entry Rata-rata</small>
              <span>$${pos.avgEntryPrice.toFixed(4)}</span>
            </div>
            <div class="pos-metric-item">
              <small>Harga Saat Ini</small>
              <span>$${pos.currentPrice.toFixed(4)}</span>
            </div>
            <div class="pos-metric-item">
              <small>Margin Terpakai</small>
              <span class="text-cyan"><b>$${(pos.totalMarginUsed || 0).toFixed(2)} USDT</b> <small class="text-muted">(${pos.totalQty} koin)</small></span>
            </div>
            <div class="pos-metric-item">
              <small>Target TP (-${currentConfig?.exit?.takeProfitPct || 1.2}%)</small>
              <span class="text-green">$${pos.targetTpPrice.toFixed(4)}</span>
            </div>
            <div class="pos-metric-item">
              <small>Hard SL (+${currentConfig?.exit?.hardStopLossPct || 4.5}%)</small>
              <span class="text-red">$${pos.hardSlPrice.toFixed(4)}</span>
            </div>
          </div>

          <div class="grid-layers-bar">
            ${layersHtml}
          </div>
        </div>
      `;
    })
    .join('');
}

function renderSpikesTable(spikes) {
  const tbody = document.getElementById('spike-table-body');
  if (!spikes || spikes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Belum ada lonjakan harga yang melewati ambang batas.</td></tr>`;
    return;
  }

  tbody.innerHTML = spikes
    .slice(0, 10)
    .map((s) => {
      const timeStr = new Date(s.timestamp).toLocaleTimeString('id-ID');
      const statusBadge =
        s.status === 'EXECUTING'
          ? `<span class="badge-hft" style="background:rgba(0,230,118,0.2);color:#00e676;border-color:#00e676">SNIPED 🎯</span>`
          : s.status === 'SKIPPED'
          ? `<span class="badge-hft" style="background:rgba(255,179,0,0.2);color:#ffb300;border-color:#ffb300">DILEWATI</span>`
          : `<span class="badge-hft">TERDETEKSI</span>`;

      return `
        <tr>
          <td>${timeStr}</td>
          <td><b>${s.symbol}</b></td>
          <td>$${s.startPrice.toFixed(4)}</td>
          <td>$${s.currentPrice.toFixed(4)}</td>
          <td class="text-green"><b>+${s.surgePct.toFixed(2)}%</b></td>
          <td>${statusBadge}</td>
        </tr>
      `;
    })
    .join('');
}

let recentClosedTrades = [];
let selectedTradeForDetail = null;

function renderClosedTradesTable(trades) {
  recentClosedTrades = trades || [];
  const tbody = document.getElementById('closed-trades-body');
  if (!trades || trades.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">Belum ada trade yang ditutup.</td></tr>`;
    return;
  }

  tbody.innerHTML = trades
    .slice(0, 25)
    .map((t) => {
      const isWin = t.realizedPnl >= 0;
      const pnlColor = isWin ? 'text-green' : 'text-red';
      const sign = isWin ? '+' : '';
      const layerBadge = t.layersFilled
        ? `<span class="tag-counter" style="font-size: 9.5px; padding: 1px 5px; margin-left: 4px;" title="Layer yang terserap">L#${t.layersFilled}</span>`
        : '';

      return `
        <tr class="clickable-trade-row" onclick="openTradeDetailModal('${t.id}')" title="Klik untuk melihat rincian trade & perbandingan parameter">
          <td>${t.closedAt}</td>
          <td><b>${t.symbol}</b> <span class="badge-side short">SHORT</span> ${layerBadge}</td>
          <td><span class="text-cyan font-mono"><b>$${(t.marginUsed || 0).toFixed(2)}</b></span></td>
          <td>$${t.entryPrice} ➜ $${t.exitPrice}</td>
          <td><b>${t.durationSeconds}s</b></td>
          <td class="${pnlColor}"><b>${sign}$${t.realizedPnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%)</b></td>
          <td>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
              <small>${t.exitReason}</small>
              <button type="button" class="btn btn-xs" onclick="event.stopPropagation(); openTradeDetailModal('${t.id}')" style="font-size: 10px; padding: 2px 7px;">🔍 Detail</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function openTradeDetailModal(tradeId) {
  const t = recentClosedTrades.find((x) => x.id === tradeId);
  if (!t) return;
  selectedTradeForDetail = t;

  const isWin = t.realizedPnl >= 0;
  const pnlColor = isWin ? 'text-green' : 'text-red';
  const sign = isWin ? '+' : '';

  // Header Title & Badge
  document.getElementById('td-title').innerText = `🔍 Detail Trade: ${t.symbol} SHORT (${t.isPaper ? 'Paper' : 'Live'})`;
  const badge = document.getElementById('td-pnl-badge');
  badge.className = `badge-mode ${isWin ? 'live' : 'paper'}`;
  badge.innerText = `${sign}$${t.realizedPnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%)`;

  // Fallback snapshot jika trade lama belum memiliki snapshot
  const snap = t.paramsSnapshot || {
    marginPerLayerUsdt: 3,
    totalLayers: 6,
    layerSpacingPct: 1.0,
    martingaleMultiplier: 1.15,
    maxTotalMarginPerCoin: 80,
    takeProfitPct: 1.2,
    hardStopLossPct: 4.5,
    maxHoldMinutes: 10,
    spikeMinPercent: 3.2,
    leverage: 5,
    marginType: 'CROSSED',
  };

  const curr = currentConfig || {};
  const currGrid = curr.grid || {};
  const currExit = curr.exit || {};
  const currScanner = curr.scanner || {};

  // Helper render baris perbandingan
  const renderCompareRow = (name, valSnap, valCurr, unit = '') => {
    const isSame = String(valSnap) === String(valCurr);
    const statusBadge = isSame
      ? `<span class="badge-same">Sama</span>`
      : `<span class="badge-diff">Berbeda</span>`;
    const valCurrStyle = isSame ? '' : 'color: var(--color-cyan); font-weight: 700;';
    return `
      <tr>
        <td class="param-name">${name}</td>
        <td><b>${valSnap !== undefined ? valSnap : '-'}${unit}</b></td>
        <td style="${valCurrStyle}">${valCurr !== undefined ? valCurr : '-'}${unit}</td>
        <td>${statusBadge}</td>
      </tr>
    `;
  };

  // Layers breakdown
  let layersHtml = '';
  if (t.layersDetail && t.layersDetail.length > 0) {
    layersHtml = `
      <div class="td-section-title">🧱 Rincian Layer Jaring Terisi (${t.layersFilled || 'Grid'})</div>
      <div class="td-layers-wrap">
        ${t.layersDetail
          .map(
            (l) => `
          <div class="td-layer-row ${l.status === 'FILLED' ? 'filled' : ''}">
            <span><b>Layer #${l.layerIndex}</b>: $${l.price.toFixed(4)}</span>
            <span>Margin: $${l.marginUsdt.toFixed(2)} USDT</span>
            <span class="${l.status === 'FILLED' ? 'text-green' : 'text-muted'}"><b>[${l.status}]</b></span>
          </div>
        `
          )
          .join('')}
      </div>
    `;
  }

  const body = document.getElementById('td-body');
  body.innerHTML = `
    <!-- KPI SUMMARY -->
    <div class="td-kpi-grid">
      <div class="td-kpi-card">
        <div class="td-kpi-label">Realized PnL</div>
        <div class="td-kpi-val ${pnlColor}">${sign}$${t.realizedPnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%)</div>
      </div>
      <div class="td-kpi-card">
        <div class="td-kpi-label">Entry ➜ Exit</div>
        <div class="td-kpi-val" style="font-size: 12.5px;">$${t.entryPrice} ➜ $${t.exitPrice}</div>
      </div>
      <div class="td-kpi-card">
        <div class="td-kpi-label">Total Margin Terpakai</div>
        <div class="td-kpi-val text-cyan">$${(t.marginUsed || 0).toFixed(2)} USDT</div>
      </div>
      <div class="td-kpi-card">
        <div class="td-kpi-label">Durasi & Waktu</div>
        <div class="td-kpi-val">${t.durationSeconds} detik <small style="font-size: 10px; color: var(--text-muted); font-weight: normal;">(${t.closedAt})</small></div>
      </div>
      <div class="td-kpi-card">
        <div class="td-kpi-label">Alasan Selesai</div>
        <div class="td-kpi-val text-gold" style="font-size: 12px;">${t.exitReason}</div>
      </div>
      <div class="td-kpi-card">
        <div class="td-kpi-label">Layer Terisi</div>
        <div class="td-kpi-val text-purple">${t.layersFilled || '-'}</div>
      </div>
    </div>

    <!-- PARAMETER COMPARISON TABLE -->
    <div class="td-section-title">⚖️ Perbandingan Parameter (Trade Ini vs Aktif Sekarang)</div>
    <div style="overflow-x: auto;">
      <table class="param-compare-table">
        <thead>
          <tr>
            <th>Parameter Bot</th>
            <th>Saat Trade Ini Berjalan</th>
            <th>Konfigurasi Aktif Sekarang</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${renderCompareRow('Modal Per Layer', snap.marginPerLayerUsdt ?? 3, currGrid.marginPerLayerUsdt ?? 3, ' USDT')}
          ${renderCompareRow('Jumlah Layer', snap.totalLayers ?? 6, currGrid.totalLayers ?? 6, ' Lapis')}
          ${renderCompareRow('Jarak Antar Jaring (Spacing)', snap.layerSpacingPct ?? 1.0, currGrid.layerSpacingPct ?? 1.0, '%')}
          ${renderCompareRow('Pengali Martingale', snap.martingaleMultiplier ?? 1.15, currGrid.martingaleMultiplier ?? 1.15, 'x')}
          ${renderCompareRow('Target Take Profit', snap.takeProfitPct ?? 1.2, currExit.takeProfitPct ?? 1.2, '%')}
          ${renderCompareRow('Hard Stop Loss', snap.hardStopLossPct ?? 4.5, currExit.hardStopLossPct ?? 4.5, '%')}
          ${renderCompareRow('Maks Hold Time', snap.maxHoldMinutes ?? 10, currExit.maxHoldMinutes ?? 10, ' Menit')}
          ${renderCompareRow('Minimal Spike', snap.spikeMinPercent ?? 3.2, currScanner.spikeMinPercent ?? 3.2, '%')}
          ${renderCompareRow('Leverage', snap.leverage ?? 5, curr.leverage ?? 5, 'x')}
          ${renderCompareRow('Maks Margin Per Koin', snap.maxTotalMarginPerCoin ?? 80, currGrid.maxTotalMarginPerCoin ?? 80, ' USDT')}
        </tbody>
      </table>
    </div>

    ${layersHtml}
  `;

  document.getElementById('trade-detail-modal').classList.add('open');
}

function closeTradeDetailModal() {
  document.getElementById('trade-detail-modal').classList.remove('open');
}

function applySnapshotParamsToConfig() {
  if (!selectedTradeForDetail) return;
  const snap = selectedTradeForDetail.paramsSnapshot || {
    marginPerLayerUsdt: 3,
    totalLayers: 6,
    layerSpacingPct: 1.0,
    martingaleMultiplier: 1.15,
    maxTotalMarginPerCoin: 80,
    takeProfitPct: 1.2,
    hardStopLossPct: 4.5,
    maxHoldMinutes: 10,
    spikeMinPercent: 3.2,
    leverage: 5,
    marginType: 'CROSSED',
  };

  // Isi ke form modal pengaturan
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  };

  setVal('cfg-margin-layer', snap.marginPerLayerUsdt);
  setVal('cfg-total-layers', snap.totalLayers);
  setVal('cfg-layer-spacing', snap.layerSpacingPct);
  setVal('cfg-martingale', snap.martingaleMultiplier);
  setVal('cfg-max-margin', snap.maxTotalMarginPerCoin);
  setVal('cfg-tp-pct', snap.takeProfitPct);
  setVal('cfg-sl-pct', snap.hardStopLossPct);
  setVal('cfg-max-hold', snap.maxHoldMinutes);
  setVal('cfg-spike-pct', snap.spikeMinPercent);
  setVal('cfg-leverage', snap.leverage);
  setVal('cfg-margin-type', snap.marginType);

  isFormModifiedByUser = true;
  try {
    localStorage.setItem('wicksniper_settings_draft', JSON.stringify(getSettingsFormData()));
  } catch (e) {}

  closeTradeDetailModal();
  openSettingsModal();
  alert('✅ Parameter dari trade ini berhasil dimuat ke formulir pengaturan! Silakan periksa lalu klik "Simpan Perubahan" jika ingin menggunakannya.');
}

function renderLogs(logs) {
  const terminal = document.getElementById('terminal-logs');
  terminal.innerHTML = '';
  logs.forEach((l) => appendLog(l));
}

function appendLog(log) {
  const terminal = document.getElementById('terminal-logs');
  const div = document.createElement('div');
  div.className = `log-entry ${log.level.toLowerCase()}`;
  div.innerText = `[${log.timestamp}] [${log.level}] ${log.message}`;
  terminal.insertBefore(div, terminal.firstChild);

  // Batasi 100 baris DOM
  if (terminal.children.length > 100) {
    terminal.removeChild(terminal.lastChild);
  }
}

function clearLocalLogs() {
  document.getElementById('terminal-logs').innerHTML = '';
}

async function toggleEngine() {
  if (!currentStatus) return;
  const endpoint = currentStatus.isRunning ? '/api/stop' : '/api/start';
  try {
    const res = await fetch(endpoint, { method: 'POST' }).then((r) => r.json());
    if (res.status) {
      renderStatus(res.status);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function resetDemo() {
  if (!confirm('Yakin ingin mereset saldo demo dan riwayat trade?')) return;
  try {
    const res = await fetch('/api/reset-demo', { method: 'POST' }).then((r) => r.json());
    if (res.status) {
      renderStatus(res.status);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

// ==========================================
// MODAL SETTINGS (PERSISTENT & FLOATING FOOTER)
// ==========================================
let settingsFormInitialized = false;
let isFormModifiedByUser = false;

function populateSettingsForm(cfg) {
  if (!cfg) return;
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  };

  setVal('cfg-mode', cfg.tradingMode || 'PAPER');
  setVal('cfg-virtual-balance', cfg.paperTrading?.initialVirtualBalance ?? currentStatus?.virtualBalance ?? 245);
  setVal('cfg-leverage', cfg.leverage || 5);
  setVal('cfg-margin-type', cfg.marginType || 'CROSSED');
  setVal('cfg-spike-pct', cfg.scanner?.spikeMinPercent || 3.2);
  setVal('cfg-tp-pct', cfg.exit?.takeProfitPct || 1.2);
  setVal('cfg-sl-pct', cfg.exit?.hardStopLossPct || 4.5);
  setVal('cfg-max-hold', cfg.exit?.maxHoldMinutes || 10);
  setVal('cfg-margin-layer', cfg.grid?.marginPerLayerUsdt || 3);
  setVal('cfg-max-margin', cfg.grid?.maxTotalMarginPerCoin || 80);
  setVal('cfg-total-layers', cfg.grid?.totalLayers || 6);
  setVal('cfg-layer-spacing', cfg.grid?.layerSpacingPct || 1.0);
  setVal('cfg-max-coins', cfg.grid?.maxConcurrentCoins || 2);
  setVal('cfg-martingale', cfg.grid?.martingaleMultiplier || 1.15);
  setVal('cfg-api-key', cfg.apiKey || '');
  setVal('cfg-api-secret', cfg.apiSecret || '');
}

function getSettingsFormData() {
  const getVal = (id, def) => {
    const el = document.getElementById(id);
    return el ? el.value : def;
  };

  return {
    tradingMode: getVal('cfg-mode', 'PAPER'),
    leverage: parseInt(getVal('cfg-leverage', '5')) || 5,
    marginType: getVal('cfg-margin-type', 'CROSSED'),
    paperTrading: {
      initialVirtualBalance: parseFloat(getVal('cfg-virtual-balance', '245')) || 245,
    },
    scanner: {
      ...(currentConfig?.scanner || {}),
      spikeMinPercent: parseFloat(getVal('cfg-spike-pct', '3.2')) || 3.2,
    },
    exit: {
      ...(currentConfig?.exit || {}),
      takeProfitPct: parseFloat(getVal('cfg-tp-pct', '1.2')) || 1.2,
      hardStopLossPct: parseFloat(getVal('cfg-sl-pct', '4.5')) || 4.5,
      maxHoldMinutes: parseInt(getVal('cfg-max-hold', '10')) || 10,
    },
    grid: {
      ...(currentConfig?.grid || {}),
      marginPerLayerUsdt: parseFloat(getVal('cfg-margin-layer', '3')) || 3,
      maxTotalMarginPerCoin: parseFloat(getVal('cfg-max-margin', '80')) || 80,
      totalLayers: parseInt(getVal('cfg-total-layers', '6')) || 6,
      layerSpacingPct: parseFloat(getVal('cfg-layer-spacing', '1.0')) || 1.0,
      maxConcurrentCoins: parseInt(getVal('cfg-max-coins', '2')) || 2,
      martingaleMultiplier: parseFloat(getVal('cfg-martingale', '1.15')) || 1.15,
    },
    apiKey: (getVal('cfg-api-key', '') || '').trim(),
    apiSecret: (getVal('cfg-api-secret', '') || '').trim(),
  };
}

async function reloadConfigFromServer() {
  try {
    const fresh = await fetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
    if (fresh) {
      currentConfig = fresh;
      try {
        localStorage.setItem('wicksniper_config', JSON.stringify(fresh));
        localStorage.removeItem('wicksniper_settings_draft');
      } catch (e) {}
      populateSettingsForm(fresh);
      isFormModifiedByUser = false;
      const btn = document.querySelector('.btn-refresh-cfg');
      if (btn) {
        const oldText = btn.innerText;
        btn.innerText = '✅ Tersinkron!';
        setTimeout(() => (btn.innerText = oldText), 1500);
      }
    }
  } catch (err) {
    alert(`Gagal mengambil konfigurasi dari server: ${err.message}`);
  }
}

async function openSettingsModal() {
  // Jika form belum diisi, ambil dari draft lokal atau dari server
  if (!settingsFormInitialized) {
    const draft = localStorage.getItem('wicksniper_settings_draft');
    if (draft) {
      try {
        const parsedDraft = JSON.parse(draft);
        populateSettingsForm(parsedDraft);
        isFormModifiedByUser = true;
      } catch (e) {}
    } else {
      if (!currentConfig) {
        try {
          const fresh = await fetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
          if (fresh) {
            currentConfig = fresh;
            localStorage.setItem('wicksniper_config', JSON.stringify(fresh));
          }
        } catch {}
      }
      populateSettingsForm(currentConfig);
    }
    settingsFormInitialized = true;
  }

  // Buka modal TANPA menghapus editan pengguna
  document.getElementById('settings-modal').classList.add('open');
}

function closeSettingsModal() {
  // Hanya sembunyikan modal - JANGAN pernah mereset input form agar draf tidak hilang
  document.getElementById('settings-modal').classList.remove('open');
}

async function saveSettings() {
  const updated = getSettingsFormData();

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    }).then((r) => r.json());

    if (res.success) {
      currentConfig = res.config;
      try {
        localStorage.setItem('wicksniper_config', JSON.stringify(res.config));
        localStorage.removeItem('wicksniper_settings_draft');
      } catch (e) {}
      isFormModifiedByUser = false;
      populateSettingsForm(res.config);
      closeSettingsModal();
      alert('✅ Pengaturan berhasil disimpan!');
    } else {
      alert(`Gagal menyimpan: ${res.message || 'Unknown error'}`);
    }
  } catch (err) {
    alert(`Gagal menyimpan: ${err.message}`);
  }
}

// ==========================================
// BACKTEST LAB CONTROLLER
// ==========================================
function formatDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${y}-${m}-${d}T${h}:${min}`;
}

let _backtestModalInitialized = false;

function openBacktestModal() {
  // Hanya set tanggal default jika belum terisi
  const startEl = document.getElementById('bt-start-date');
  const endEl = document.getElementById('bt-end-date');
  if (!startEl.value || !endEl.value) {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    startEl.value = formatDateTimeLocal(threeDaysAgo);
    endEl.value = formatDateTimeLocal(now);
  }

  // Hanya inisialisasi dari config SEKALI saja (saat pertama kali dibuka)
  // Supaya perubahan user tidak ter-reset tiap buka modal
  if (!_backtestModalInitialized && currentConfig) {
    if (currentConfig.leverage) document.getElementById('bt-leverage').value = currentConfig.leverage;
    if (currentConfig.scanner?.spikeMinPercent) document.getElementById('bt-spike').value = currentConfig.scanner.spikeMinPercent;
    if (currentConfig.exit?.takeProfitPct) document.getElementById('bt-tp').value = currentConfig.exit.takeProfitPct;
    if (currentConfig.exit?.hardStopLossPct) document.getElementById('bt-sl').value = currentConfig.exit.hardStopLossPct;
    if (currentConfig.grid?.marginPerLayerUsdt) document.getElementById('bt-margin').value = currentConfig.grid.marginPerLayerUsdt;
    if (currentConfig.grid?.layerSpacingPct) document.getElementById('bt-spacing').value = currentConfig.grid.layerSpacingPct;
    if (currentConfig.grid?.totalLayers) document.getElementById('bt-total-layers').value = currentConfig.grid.totalLayers;
    if (currentConfig.grid?.maxTotalMarginPerCoin) document.getElementById('bt-max-margin').value = currentConfig.grid.maxTotalMarginPerCoin;
    if (currentConfig.grid?.martingaleMultiplier) document.getElementById('bt-martingale').value = currentConfig.grid.martingaleMultiplier;
    if (currentConfig.exit?.maxHoldMinutes) document.getElementById('bt-max-hold').value = currentConfig.exit.maxHoldMinutes;
    if (currentConfig.scanner?.cooldownMinutes) document.getElementById('bt-cooldown').value = currentConfig.scanner.cooldownMinutes;
    _backtestModalInitialized = true;
  }

  document.getElementById('backtest-modal').style.display = 'flex';
}

function resetBacktestParams() {
  // Reset parameter backtest ke nilai config bot saat ini
  _backtestModalInitialized = false;
  openBacktestModal();
  if (currentConfig) {
    // Force re-init
    if (currentConfig.leverage) document.getElementById('bt-leverage').value = currentConfig.leverage;
    if (currentConfig.scanner?.spikeMinPercent) document.getElementById('bt-spike').value = currentConfig.scanner.spikeMinPercent;
    if (currentConfig.exit?.takeProfitPct) document.getElementById('bt-tp').value = currentConfig.exit.takeProfitPct;
    if (currentConfig.exit?.hardStopLossPct) document.getElementById('bt-sl').value = currentConfig.exit.hardStopLossPct;
    if (currentConfig.grid?.marginPerLayerUsdt) document.getElementById('bt-margin').value = currentConfig.grid.marginPerLayerUsdt;
    if (currentConfig.grid?.layerSpacingPct) document.getElementById('bt-spacing').value = currentConfig.grid.layerSpacingPct;
    if (currentConfig.grid?.totalLayers) document.getElementById('bt-total-layers').value = currentConfig.grid.totalLayers;
    if (currentConfig.grid?.maxTotalMarginPerCoin) document.getElementById('bt-max-margin').value = currentConfig.grid.maxTotalMarginPerCoin;
    if (currentConfig.grid?.martingaleMultiplier) document.getElementById('bt-martingale').value = currentConfig.grid.martingaleMultiplier;
    if (currentConfig.exit?.maxHoldMinutes) document.getElementById('bt-max-hold').value = currentConfig.exit.maxHoldMinutes;
    if (currentConfig.scanner?.cooldownMinutes) document.getElementById('bt-cooldown').value = currentConfig.scanner.cooldownMinutes;
  }
}

function closeBacktestModal() {
  document.getElementById('backtest-modal').style.display = 'none';
}

function setBtPreset(days) {
  document.querySelectorAll('.btn-preset').forEach((b) => b.classList.remove('active'));
  if (window.event && window.event.target) {
    window.event.target.classList.add('active');
  }
  const now = new Date();
  const past = new Date(now.getTime() - days * 24 * 3600 * 1000);
  document.getElementById('bt-start-date').value = formatDateTimeLocal(past);
  document.getElementById('bt-end-date').value = formatDateTimeLocal(now);
}

async function executeBacktest() {
  const symbolsInput = document.getElementById('bt-symbols').value;
  const symbols = symbolsInput.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const startDate = document.getElementById('bt-start-date').value;
  const endDate = document.getElementById('bt-end-date').value;

  if (symbols.length === 0) {
    alert('Masukkan minimal 1 simbol koin futures!');
    return;
  }
  if (!startDate || !endDate) {
    alert('Tentukan tanggal mulai dan tanggal selesai!');
    return;
  }

  const payload = {
    symbols,
    startTime: new Date(startDate).getTime(),
    endTime: new Date(endDate).getTime(),
    leverage: parseFloat(document.getElementById('bt-leverage').value) || 5,
    spikeMinPercent: parseFloat(document.getElementById('bt-spike').value) || 3.2,
    takeProfitPct: parseFloat(document.getElementById('bt-tp').value) || 1.2,
    hardStopLossPct: parseFloat(document.getElementById('bt-sl').value) || 4.5,
    marginPerLayerUsdt: parseFloat(document.getElementById('bt-margin').value) || 3,
    layerSpacingPct: parseFloat(document.getElementById('bt-spacing').value) || 1.0,
    totalLayers: parseInt(document.getElementById('bt-total-layers').value) || 6,
    maxTotalMarginPerCoin: parseFloat(document.getElementById('bt-max-margin').value) || 80,
    martingaleMultiplier: parseFloat(document.getElementById('bt-martingale').value) || 1.15,
    maxHoldMinutes: parseInt(document.getElementById('bt-max-hold').value) || 10,
    cooldownMinutes: parseInt(document.getElementById('bt-cooldown').value) || 10,
    initialBalance: parseFloat(document.getElementById('bt-init-balance').value) || 245,
    partialTpEnabled: false,
  };

  // Debug log untuk memastikan params terkirim dengan benar
  console.log('🧪 Backtest payload:', JSON.stringify(payload, null, 2));

  const btn = document.getElementById('btn-run-backtest');
  const btnIcon = document.getElementById('bt-btn-icon');
  const btnText = document.getElementById('bt-btn-text');
  const loading = document.getElementById('bt-loading');
  const resultsContainer = document.getElementById('bt-results-container');

  btn.disabled = true;
  btnIcon.innerText = '⏳';
  btnText.innerText = 'Menguji...';
  loading.style.display = 'block';
  resultsContainer.style.display = 'none';

  try {
    const res = await fetch('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json());

    if (!res.success) {
      throw new Error(res.message || 'Gagal menjalankan backtest.');
    }

    const r = res.result;
    document.getElementById('bt-res-winrate').innerText = `${r.winRate.toFixed(1)}%`;
    document.getElementById('bt-res-winrate-sub').innerText = `${r.winningTrades} Menang / ${r.losingTrades} Kalah`;

    const isPos = r.netProfitUsdt >= 0;
    const sign = isPos ? '+' : '';
    const pnlEl = document.getElementById('bt-res-pnl');
    pnlEl.innerText = `${sign}$${r.netProfitUsdt.toFixed(2)}`;
    pnlEl.className = `kpi-value ${isPos ? 'text-green' : 'text-red'}`;
    document.getElementById('bt-res-pnl-sub').innerText = `${sign}${r.netProfitPct.toFixed(1)}% dari modal $${r.initialBalance}`;

    document.getElementById('bt-res-trades').innerText = r.totalTrades;
    document.getElementById('bt-res-candles').innerText = `${r.totalCandlesAnalyzed.toLocaleString()} Lilin 1m`;

    document.getElementById('bt-res-pf').innerText = r.profitFactor;
    document.getElementById('bt-res-mdd').innerText = `Max Drawdown: -$${r.maxDrawdownUsdt.toFixed(2)} (-${r.maxDrawdownPct.toFixed(1)}%)`;
    document.getElementById('bt-trade-count-tag').innerText = `${r.totalTrades} Trade`;

    const tbody = document.getElementById('bt-trades-table-body');
    if (r.trades.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted" style="padding: 20px;">Tidak ada lonjakan yang memenuhi ambang pemicu spike pada periode ini.</td></tr>`;
    } else {
      tbody.innerHTML = r.trades
        .map((t) => {
          const isWin = t.realizedPnl >= 0;
          const tColor = isWin ? 'text-green' : 'text-red';
          const tSign = isWin ? '+' : '';
          return `
            <tr>
              <td>${t.entryTime}</td>
              <td><b>${t.symbol}</b> <span class="badge-side short">SHORT</span></td>
              <td><span class="text-cyan font-mono"><b>$${t.marginUsed.toFixed(2)}</b></span></td>
              <td>$${t.entryPrice} ➜ $${t.exitPrice}</td>
              <td><b>${t.durationMinutes}m</b></td>
              <td class="${tColor}"><b>${tSign}$${t.realizedPnl.toFixed(2)} (${tSign}${t.pnlPct.toFixed(1)}%)</b></td>
              <td><small>${t.exitReason}</small></td>
            </tr>
          `;
        })
        .join('');
    }

    resultsContainer.style.display = 'block';
  } catch (err) {
    alert(`Error Backtest: ${err.message}`);
  } finally {
    btn.disabled = false;
    btnIcon.innerText = '🚀';
    btnText.innerText = 'Mulai Backtest Historis';
    loading.style.display = 'none';
  }
}

// ==========================================
// DRAFT AUTO-SAVE & PWA SERVICE WORKER
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.addEventListener('input', () => {
      isFormModifiedByUser = true;
      try {
        localStorage.setItem('wicksniper_settings_draft', JSON.stringify(getSettingsFormData()));
      } catch (e) {}
    });
    modal.addEventListener('change', () => {
      isFormModifiedByUser = true;
      try {
        localStorage.setItem('wicksniper_settings_draft', JSON.stringify(getSettingsFormData()));
      } catch (e) {}
    });
  }
});

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        console.log('✅ PWA Service Worker registered:', reg.scope);
      })
      .catch((err) => {
        console.warn('⚠️ PWA Service Worker registration skipped/failed:', err.message);
      });
  });
}
