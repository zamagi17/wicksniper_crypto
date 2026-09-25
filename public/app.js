let socket = null;
let currentStatus = null;
let currentConfig = null;

// ==========================================
// AUTHENTICATION & SECURITY CONTROLLER
// ==========================================
function getAuthToken() {
  try {
    return localStorage.getItem('wicksniper_auth_token');
  } catch {
    return null;
  }
}

function setAuthToken(token) {
  try {
    localStorage.setItem('wicksniper_auth_token', token);
  } catch {}
}

function clearAuthToken() {
  try {
    localStorage.removeItem('wicksniper_auth_token');
  } catch {}
}

async function authFetch(url, options = {}) {
  const token = getAuthToken();
  const headers = { ...(options.headers || {}) };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && !url.includes('/api/auth/')) {
    showLoginOverlay('Sesi telah berakhir atau tidak valid. Silakan masukkan password kembali.');
  }
  return res;
}

function showLoginOverlay(errMsg = '') {
  const overlay = document.getElementById('login-overlay');
  const errBox = document.getElementById('login-error-msg');
  const input = document.getElementById('login-password-input');
  if (overlay) overlay.classList.remove('hidden');
  if (errBox) {
    if (errMsg) {
      errBox.innerText = errMsg;
      errBox.style.display = 'block';
    } else {
      errBox.style.display = 'none';
    }
  }
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 150);
  }
}

function hideLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  const errBox = document.getElementById('login-error-msg');
  if (overlay) overlay.classList.add('hidden');
  if (errBox) errBox.style.display = 'none';
}

function toggleLoginPasswordVisibility() {
  const input = document.getElementById('login-password-input');
  const btn = document.getElementById('login-eye-btn');
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    if (btn) btn.innerText = '🙈';
  } else {
    input.type = 'password';
    if (btn) btn.innerText = '👁️';
  }
}
window.toggleLoginPasswordVisibility = toggleLoginPasswordVisibility;

async function handleLoginSubmit(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('login-password-input');
  const btn = document.getElementById('btn-submit-login');
  const btnText = btn?.querySelector('.btn-login-text');
  const btnSpinner = btn?.querySelector('.btn-login-spinner');
  const errBox = document.getElementById('login-error-msg');

  const password = (input?.value || '').trim();
  if (!password) {
    if (errBox) {
      errBox.innerText = 'Harap masukkan password dashboard.';
      errBox.style.display = 'block';
    }
    input?.focus();
    return;
  }

  if (btn) btn.disabled = true;
  if (btnText) btnText.style.display = 'none';
  if (btnSpinner) btnSpinner.style.display = 'inline-flex';
  if (errBox) errBox.style.display = 'none';

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }).then((r) => r.json());

    if (res.success && res.token) {
      setAuthToken(res.token);
      hideLoginOverlay();
      connectWebSocket();
      fetchInitialData();
    } else {
      if (errBox) {
        errBox.innerText = res.message || 'Password salah!';
        errBox.style.display = 'block';
      }
      if (input) {
        input.select();
        input.focus();
      }
    }
  } catch (err) {
    if (errBox) {
      errBox.innerText = `Gagal terhubung ke server: ${err.message}`;
      errBox.style.display = 'block';
    }
  } finally {
    if (btn) btn.disabled = false;
    if (btnText) btnText.style.display = 'inline-flex';
    if (btnSpinner) btnSpinner.style.display = 'none';
  }
}
window.handleLoginSubmit = handleLoginSubmit;

async function logoutSession() {
  if (!confirm('Kunci terminal dashboard sekarang?')) return;
  try {
    await authFetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  clearAuthToken();
  showLoginOverlay();
}
window.logoutSession = logoutSession;

async function handlePasswordChange() {
  const currentPassword = (document.getElementById('cfg-current-password')?.value || '').trim();
  const newPassword = (document.getElementById('cfg-new-password')?.value || '').trim();
  const confirmPassword = (document.getElementById('cfg-confirm-password')?.value || '').trim();
  const statusEl = document.getElementById('password-change-status');
  const btn = document.getElementById('btn-change-password');

  const showStatus = (text, isSuccess) => {
    if (!statusEl) return;
    statusEl.style.display = 'block';
    statusEl.style.background = isSuccess ? 'rgba(0, 255, 170, 0.12)' : 'rgba(255, 68, 68, 0.12)';
    statusEl.style.border = isSuccess ? '1px solid rgba(0, 255, 170, 0.35)' : '1px solid rgba(255, 68, 68, 0.35)';
    statusEl.style.color = isSuccess ? 'var(--color-green)' : 'var(--color-red)';
    statusEl.innerText = text;
  };

  if (!currentPassword) {
    showStatus('⚠️ Harap masukkan password saat ini.', false);
    return;
  }
  if (!newPassword || newPassword.length < 4) {
    showStatus('⚠️ Password baru minimal 4 karakter.', false);
    return;
  }
  if (newPassword !== confirmPassword) {
    showStatus('⚠️ Konfirmasi password baru tidak cocok!', false);
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Menyimpan Password...';
  }

  try {
    const res = await authFetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    }).then((r) => r.json());

    if (res.success) {
      showStatus('✅ ' + (res.message || 'Password berhasil diubah!'), true);
      const curIn = document.getElementById('cfg-current-password');
      const newIn = document.getElementById('cfg-new-password');
      const confIn = document.getElementById('cfg-confirm-password');
      if (curIn) curIn.value = '';
      if (newIn) newIn.value = '';
      if (confIn) confIn.value = '';
    } else {
      showStatus('❌ ' + (res.message || 'Gagal mengubah password'), false);
    }
  } catch (err) {
    showStatus(`❌ Error: ${err.message}`, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🔑 Simpan & Perbarui Password Dashboard';
    }
  }
}
window.handlePasswordChange = handlePasswordChange;

// Initialize with authentication verification
document.addEventListener('DOMContentLoaded', async () => {
  const token = getAuthToken();
  if (!token) {
    showLoginOverlay();
  } else {
    try {
      const checkRes = await fetch('/api/auth/check', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (checkRes.ok) {
        hideLoginOverlay();
        connectWebSocket();
        fetchInitialData();
      } else {
        clearAuthToken();
        showLoginOverlay('Sesi kedaluwarsa. Silakan masukkan password kembali.');
      }
    } catch {
      // offline fallback
      connectWebSocket();
      fetchInitialData();
    }
  }

  // CapsLock detector
  const pwInput = document.getElementById('login-password-input');
  const capsAlert = document.getElementById('login-caps-warning');
  if (pwInput && capsAlert) {
    const checkCaps = (e) => {
      if (e.getModifierState && e.getModifierState('CapsLock')) {
        capsAlert.style.display = 'block';
      } else {
        capsAlert.style.display = 'none';
      }
    };
    pwInput.addEventListener('keydown', checkCaps);
    pwInput.addEventListener('keyup', checkCaps);
  }
});

function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (socket) {
    try { socket.close(); } catch (e) {}
    socket = null;
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;
  socket = new WebSocket(wsUrl);

  const indicator = document.getElementById('ws-indicator');
  const statusText = document.getElementById('ws-status-text');

  socket.onopen = () => {
    indicator.className = 'status-pill online';
    statusText.innerText = 'TERHUBUNG';
    const drawerWsStatus = document.getElementById('drawer-ws-status');
    if (drawerWsStatus) {
      drawerWsStatus.innerHTML = '<span class="text-green">ONLINE 🟢</span>';
    }
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'STATUS') {
        renderStatus(msg.data);
      } else if (msg.type === 'CONFIG') {
        currentConfig = msg.data;
        try {
          localStorage.setItem('wicksniper_config', JSON.stringify(msg.data));
        } catch (e) {}
        if (currentStatus) renderStatus(currentStatus);

        // Perbarui formulir pengaturan jika modal sedang tertutup atau belum diubah manual oleh pengguna
        const modal = document.getElementById('settings-modal');
        const isModalOpen = modal && modal.classList.contains('open');
        if (!isModalOpen || !isFormModifiedByUser) {
          populateSettingsForm(msg.data);
          isFormModifiedByUser = false;
        }

        // Sinkronkan juga input backtest lab jika sedang tidak diedit aktif oleh user
        const btModal = document.getElementById('backtest-modal');
        const isBtModalOpen = btModal && btModal.style.display === 'flex';
        if (!isBtModalOpen || !_backtestFormModifiedByUser) {
          applyConfigToBacktestInputs(msg.data);
          _backtestFormModifiedByUser = false;
        }
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
    const drawerWsStatus = document.getElementById('drawer-ws-status');
    if (drawerWsStatus) {
      drawerWsStatus.innerHTML = '<span class="text-red">OFFLINE 🔴</span>';
    }
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
    // Bersihkan draft tersisa dari versi sebelumnya agar tidak menimpa setting real dari DB
    localStorage.removeItem('wicksniper_settings_draft');
    const cachedCfg = localStorage.getItem('wicksniper_config');
    if (cachedCfg) {
      currentConfig = JSON.parse(cachedCfg);
      populateSettingsForm(currentConfig);
    }
  } catch (e) {}

  try {
    const [resStatus, resConfig, resLogs] = await Promise.all([
      authFetch('/api/status?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
      authFetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
      authFetch('/api/logs?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json()),
    ]);
    if (resConfig && !resConfig.message && resConfig.exit) {
      currentConfig = resConfig;
      try {
        localStorage.setItem('wicksniper_config', JSON.stringify(resConfig));
      } catch (e) {}
      populateSettingsForm(resConfig);
      settingsFormInitialized = true;
      isFormModifiedByUser = false;
      applyConfigToBacktestInputs(resConfig);
      _backtestFormModifiedByUser = false;
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
    if (typeof status.realBalance === 'number') {
      const availBal = typeof status.liveAvailableBalance === 'number' ? status.liveAvailableBalance : status.realBalance;
      document.getElementById('metric-balance').innerText = `$${status.realBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      document.getElementById('metric-balance-type').innerText = `Saldo Dompet Binance (Tersedia: $${availBal.toFixed(2)})`;
    } else {
      document.getElementById('metric-balance').innerText = `Memuat...`;
      document.getElementById('metric-balance-type').innerText = `Sinkronisasi Saldo Binance...`;
    }
  } else {
    modeBadge.className = 'badge-mode paper';
    modeBadge.innerText = '🧪 PAPER TRADING';
    document.getElementById('metric-balance-type').innerText = 'Mode Virtual Paper';
    document.getElementById('metric-balance').innerText = `$${status.virtualBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  const resetDemoBtn = document.getElementById('btn-reset-demo');
  if (resetDemoBtn) {
    resetDemoBtn.style.display = status.tradingMode === 'LIVE' ? 'none' : 'inline-flex';
  }

  const drawerResetBtn = document.getElementById('btn-drawer-reset-demo');
  if (drawerResetBtn) {
    drawerResetBtn.style.display = status.tradingMode === 'LIVE' ? 'none' : 'flex';
  }

  const mobileModeChip = document.getElementById('mobile-mode-chip');
  if (mobileModeChip) {
    mobileModeChip.className = status.tradingMode === 'LIVE' ? 'badge-mode live' : 'badge-mode paper';
    mobileModeChip.innerText = status.tradingMode === 'LIVE' ? '🟢 LIVE TRADING' : '🧪 PAPER TRADING';
  }

  const drawerWsStatus = document.getElementById('drawer-ws-status');
  if (drawerWsStatus) {
    if (!status.isRunning) {
      drawerWsStatus.innerHTML = '<span class="text-yellow">PAUSED 🟡</span>';
    } else if (status.wsConnected !== false) {
      drawerWsStatus.innerHTML = '<span class="text-green">ONLINE 🟢</span>';
    } else {
      drawerWsStatus.innerHTML = '<span class="text-red">OFFLINE 🔴</span>';
    }
  }

  const dPnl = status.dailyPnl !== undefined ? status.dailyPnl : status.accumulatedPnl;
  const isPosPnl = dPnl >= 0;
  const pnlEl = document.getElementById('metric-pnl');
  pnlEl.innerText = `${isPosPnl ? '+' : ''}$${dPnl.toFixed(2)}`;
  pnlEl.className = `kpi-value ${isPosPnl ? 'text-green' : 'text-red'}`;
  const allTimeSign = status.accumulatedPnl >= 0 ? '+' : '';
  document.getElementById('metric-pnl-sub').innerText = `Hari Ini • Total: ${allTimeSign}$${status.accumulatedPnl.toFixed(2)} (${status.totalTrades} Trade)`;

  const dailyWinRate = status.dailyWinRate !== undefined ? status.dailyWinRate : status.winRate;
  document.getElementById('metric-winrate').innerText = `${dailyWinRate.toFixed(1)}%`;
  const dWins = status.dailyWinsCount !== undefined ? status.dailyWinsCount : Math.round((status.winRate / 100) * status.totalTrades);
  const dLosses = status.dailyLossesCount !== undefined ? status.dailyLossesCount : (status.totalTrades - dWins);
  document.getElementById('metric-winrate-sub').innerText = `Hari Ini: ${dWins}W / ${dLosses}L • Total: ${status.winRate.toFixed(1)}%`;

  document.getElementById('metric-spikes').innerText = status.spikesDetectedToday;
  const totalActiveMargin = (status.activePositions || []).reduce((sum, p) => sum + (p.totalMarginUsed || 0), 0);
  document.getElementById('metric-positions-count').innerText = `${status.activePositionsCount} / ${currentConfig?.grid?.maxConcurrentCoins || 2} Koin Aktif ${status.activePositionsCount > 0 ? `($${totalActiveMargin.toFixed(2)})` : ''}`;
  document.getElementById('metric-leverage').innerText = `${status.leverage || 5}x ${status.marginType === 'ISOLATED' ? 'Iso' : 'Cross'}`;
  const marketDataAgeMs = Number(status.marketDataAgeMs ?? -1);
  const marketDataStale = marketDataAgeMs >= 3000 || marketDataAgeMs < 0;
  const marketDataLabel = marketDataStale ? '⚠️ Data stale' : `${status.ticksPerSecond || 0} tick/s`;
  document.getElementById('radar-pulse-tag').innerText = `Memindai ${status.monitoredCoinsCount || 0} Koin (${marketDataLabel})`;
  document.getElementById('active-count-tag').innerText = `${status.activePositionsCount} Posisi`;

  // Update Mobile Navigation Badges
  const tabPosBadge = document.getElementById('tab-pos-badge');
  if (tabPosBadge) {
    if (status.activePositionsCount > 0) {
      tabPosBadge.style.display = 'inline-flex';
      tabPosBadge.innerText = status.activePositionsCount;
    } else {
      tabPosBadge.style.display = 'none';
    }
  }

  const tabTradesBadge = document.getElementById('tab-trades-badge');
  if (tabTradesBadge) {
    if (status.totalTrades > 0) {
      tabTradesBadge.style.display = 'inline-flex';
      tabTradesBadge.innerText = status.totalTrades > 99 ? '99+' : status.totalTrades;
    } else {
      tabTradesBadge.style.display = 'none';
    }
  }
  
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

  // Render Cooldown Strip
  const cooldownStrip = document.getElementById('cooldown-strip');
  const cooldownTags = document.getElementById('cooldown-list-tags');
  if (cooldownStrip && cooldownTags) {
    const list = status.cooldownCoins || [];
    const now = Date.now();
    const activeCooldowns = list.filter(c => c.until > now);
    if (activeCooldowns.length > 0) {
      cooldownStrip.style.display = 'flex';
      cooldownTags.innerHTML = activeCooldowns.map(c => {
        const remainingSec = Math.max(0, Math.round((c.until - now) / 1000));
        const mins = Math.floor(remainingSec / 60);
        const secs = remainingSec % 60;
        const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return `<span style="padding: 2px 8px; background: rgba(255, 170, 0, 0.18); border: 1px solid rgba(255, 170, 0, 0.35); border-radius: 4px; font-weight: 700; color: #ffb84d;">${c.symbol} (${timeStr})</span>`;
      }).join('');
    } else {
      cooldownStrip.style.display = 'none';
    }
  }

  // 4. Render Active Positions
  renderActivePositions(status.activePositions || []);

  // 5. Render Spikes Radar
  if (radarState.page === 1 && !radarState.symbol && radarState.status === 'ALL') {
    radarState.total = status.recentSpikes?.length || 0;
    renderSpikesTable(status.recentSpikes || []);
    updateRadarPaginationUI();
  }

  // 6. Render Closed Trades
  if (tradesState.page === 1 && !tradesState.symbol && tradesState.outcome === 'ALL' && tradesState.mode === 'ALL') {
    tradesState.total = status.totalTrades;
    tradesState.totalPages = Math.ceil(status.totalTrades / tradesState.limit) || 1;
    renderClosedTradesTable(status.recentTrades || []);
    updateTradesPaginationUI();
  }
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
      const remainingSeconds = Math.max(0, Number(pos.holdRemainingSeconds ?? 0));
      const remainingMinutes = Math.floor(remainingSeconds / 60);
      const remainingSecs = remainingSeconds % 60;
      const holdCountdown = `${String(remainingMinutes).padStart(2, '0')}:${String(remainingSecs).padStart(2, '0')}`;
      let holdAction = pos.holdAction === 'CLOSE_NOW' ? '⚠️ Jangan perpanjang' : '👀 Masih bisa dipantau';
      if (pos.extensionCount && pos.extensionCount > 0) {
        const extSec = currentConfig?.exit?.extendHoldSeconds || 30;
        const maxExt = currentConfig?.exit?.maxHoldExtensions || 6;
        holdAction = `🔄 Diperpanjang +${extSec * pos.extensionCount}s (${pos.extensionCount}/${maxExt})`;
      } else if (currentConfig?.exit?.extendHoldOnRedCandleEnabled && remainingSeconds <= (currentConfig?.exit?.extendHoldSeconds || 30)) {
        holdAction = pos.candle1mStatus === 'RED' ? '📉 Candle 1m Merah (Siap perpanjang)' : '⏳ Pantau 30s terakhir';
      }
      const holdClass = pos.extensionCount && pos.extensionCount > 0
        ? 'text-green'
        : pos.holdAction === 'CLOSE_NOW' ? 'text-red' : remainingSeconds <= 300 ? 'text-yellow' : 'text-cyan';

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
            <div style="display: flex; align-items: center; gap: 10px;">
              <div class="pos-pnl">
                <div class="pos-pnl-val ${pnlColor}">${pnlSign}$${(pos.unrealizedPnl || 0).toFixed(2)}</div>
                <div class="pos-pnl-pct ${pnlColor}">${pnlSign}${(pos.pnlPct || 0).toFixed(1)}%</div>
              </div>
              <button class="btn btn-sm btn-danger" onclick="manualClosePosition('${pos.symbol}')" title="Tutup posisi ini seketika di harga pasar">
                ⚡ Tutup
              </button>
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
            <div class="pos-metric-item">
              <small>Sisa Waktu Hold</small>
              <span class="${holdClass}"><b>${holdCountdown}</b> <small>${holdAction}</small></span>
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

// --- PAGINATION & FILTER STATE FOR RADAR & TRADES ---
let tradesState = {
  page: 1,
  limit: 20,
  totalPages: 1,
  total: 0,
  symbol: '',
  outcome: 'ALL',
  mode: 'ALL',
};

let radarState = {
  page: 1,
  limit: 15,
  totalPages: 1,
  total: 0,
  symbol: '',
  status: 'ALL',
};

let recentClosedTrades = [];
let selectedTradeForDetail = null;

async function fetchPaginatedTrades(page = 1) {
  tradesState.page = page;
  const symbol = (document.getElementById('trades-filter-symbol')?.value || '').trim();
  const outcome = document.getElementById('trades-filter-outcome')?.value || 'ALL';
  const mode = document.getElementById('trades-filter-mode')?.value || 'ALL';
  tradesState.symbol = symbol;
  tradesState.outcome = outcome;
  tradesState.mode = mode;

  try {
    const params = new URLSearchParams({
      page: String(tradesState.page),
      limit: String(tradesState.limit),
    });
    if (symbol) params.append('symbol', symbol);
    if (outcome !== 'ALL') params.append('outcome', outcome);
    if (mode !== 'ALL') params.append('mode', mode);

    const res = await fetch(`/api/trades?${params.toString()}`);
    const data = await res.json();
    if (data.success) {
      tradesState.totalPages = data.totalPages || 1;
      tradesState.total = data.total || 0;
      renderClosedTradesTable(data.trades);
      updateTradesPaginationUI();
    }
  } catch (e) {
    console.warn('Gagal memuat riwayat trade:', e);
  }
}

function updateTradesPaginationUI() {
  const infoEl = document.getElementById('trades-pagination-info');
  const prevBtn = document.getElementById('trades-prev-btn');
  const nextBtn = document.getElementById('trades-next-btn');
  const countTag = document.getElementById('closed-count-tag');

  if (infoEl) infoEl.innerText = `Halaman ${tradesState.page} dari ${tradesState.totalPages} (Total: ${tradesState.total} Trade)`;
  if (countTag) countTag.innerText = `${tradesState.total} Trade`;
  if (prevBtn) prevBtn.disabled = tradesState.page <= 1;
  if (nextBtn) nextBtn.disabled = tradesState.page >= tradesState.totalPages;
}

function changeTradesPage(delta) {
  const newPage = tradesState.page + delta;
  if (newPage >= 1 && newPage <= tradesState.totalPages) {
    fetchPaginatedTrades(newPage);
  }
}

let tradesFilterTimer = null;
function handleTradesFilterChange() {
  clearTimeout(tradesFilterTimer);
  tradesFilterTimer = setTimeout(() => {
    fetchPaginatedTrades(1);
  }, 250);
}

function resetTradesFilter() {
  const symEl = document.getElementById('trades-filter-symbol');
  const outEl = document.getElementById('trades-filter-outcome');
  const modEl = document.getElementById('trades-filter-mode');
  if (symEl) symEl.value = '';
  if (outEl) outEl.value = 'ALL';
  if (modEl) modEl.value = 'ALL';
  fetchPaginatedTrades(1);
}

async function fetchPaginatedSpikes(page = 1) {
  radarState.page = page;
  const symbol = (document.getElementById('radar-filter-symbol')?.value || '').trim();
  const status = document.getElementById('radar-filter-status')?.value || 'ALL';
  radarState.symbol = symbol;
  radarState.status = status;

  try {
    const params = new URLSearchParams({
      page: String(radarState.page),
      limit: String(radarState.limit),
    });
    if (symbol) params.append('symbol', symbol);
    if (status !== 'ALL') params.append('status', status);

    const res = await fetch(`/api/spikes?${params.toString()}`);
    const data = await res.json();
    if (data.success) {
      radarState.totalPages = data.totalPages || 1;
      radarState.total = data.total || 0;
      renderSpikesTable(data.spikes);
      updateRadarPaginationUI();
    }
  } catch (e) {
    console.warn('Gagal memuat radar spikes:', e);
  }
}

function updateRadarPaginationUI() {
  const infoEl = document.getElementById('radar-pagination-info');
  const prevBtn = document.getElementById('radar-prev-btn');
  const nextBtn = document.getElementById('radar-next-btn');

  if (infoEl) infoEl.innerText = `Halaman ${radarState.page} dari ${radarState.totalPages} (Total: ${radarState.total} Spike)`;
  if (prevBtn) prevBtn.disabled = radarState.page <= 1;
  if (nextBtn) nextBtn.disabled = radarState.page >= radarState.totalPages;
}

function changeRadarPage(delta) {
  const newPage = radarState.page + delta;
  if (newPage >= 1 && newPage <= radarState.totalPages) {
    fetchPaginatedSpikes(newPage);
  }
}

let radarFilterTimer = null;
function handleRadarFilterChange() {
  clearTimeout(radarFilterTimer);
  radarFilterTimer = setTimeout(() => {
    fetchPaginatedSpikes(1);
  }, 250);
}

function resetRadarFilter() {
  const symEl = document.getElementById('radar-filter-symbol');
  const statEl = document.getElementById('radar-filter-status');
  if (symEl) symEl.value = '';
  if (statEl) statEl.value = 'ALL';
  fetchPaginatedSpikes(1);
}

function renderSpikesTable(spikes) {
  const tbody = document.getElementById('spike-table-body');
  if (!spikes || spikes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">Belum ada lonjakan harga yang melewati ambang batas.</td></tr>`;
    return;
  }

  tbody.innerHTML = spikes
    .map((s) => {
      const timeStr = new Date(s.timestamp).toLocaleTimeString('id-ID');
      const statusBadge =
        s.status === 'EXECUTING'
          ? `<span class="badge-hft" style="background:rgba(0,230,118,0.2);color:#00e676;border-color:#00e676">SNIPED 🎯</span>`
          : s.status === 'SKIPPED'
          ? `<span class="badge-hft" style="background:rgba(255,179,0,0.2);color:#ffb300;border-color:#ffb300" title="${s.skipReason || 'Dilewati filter'}">DILEWATI</span>`
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

      const feeIndicator = (t.fee && t.fee > 0)
        ? `<br><span style="font-size: 10px; color: var(--color-text-muted);" title="Gross PnL: ${t.grossPnl !== undefined ? (t.grossPnl >= 0 ? '+' : '') + '$' + t.grossPnl.toFixed(2) : '-'} | Fee: -$${t.fee.toFixed(3)}">Fee: -$${t.fee.toFixed(3)}</span>`
        : '';

      return `
        <tr class="clickable-trade-row" onclick="openTradeDetailModal('${t.id}')" title="Klik untuk melihat rincian trade & perbandingan parameter">
          <td>${t.closedAt}</td>
          <td><b>${t.symbol}</b> <span class="badge-side short">SHORT</span> ${layerBadge}</td>
          <td><span class="text-cyan font-mono"><b>$${(t.marginUsed || 0).toFixed(2)}</b></span></td>
          <td>$${t.entryPrice} ➜ $${t.exitPrice}</td>
          <td><b>${t.durationSeconds}s</b></td>
          <td class="${pnlColor}"><b>${sign}$${t.realizedPnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%)</b>${feeIndicator}</td>
          <td>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
              <small class="${t.exitReason === 'HARD_STOP_LOSS' ? 'text-red' : t.exitReason === 'FEE_LOSS_EXIT' ? 'text-gold' : 'text-green'}"><b>${
                t.exitReason === 'TAKE_PROFIT' ? '🎯 TP' :
                t.exitReason === 'TRAILING_TP' ? '📈 Trailing TP' :
                t.exitReason === 'HARD_STOP_LOSS' ? '🛑 Hard SL' :
                t.exitReason === 'FEE_LOSS_EXIT' ? '💸 TP Minus Fee' :
                t.exitReason === 'TIME_LIMIT_EXIT' ? '⏰ Batas Waktu' :
                t.exitReason === 'EARLY_MOMENTUM_EXIT' ? '⚠️ Early Momentum' :
                t.exitReason === 'MANUAL_CLOSE' ? '⚡ Manual' :
                (t.exitReason || '-')
              }</b></small>
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
        <div class="td-kpi-label">Net Realized PnL</div>
        <div class="td-kpi-val ${pnlColor}">${sign}$${t.realizedPnl.toFixed(2)} (${sign}${t.pnlPct.toFixed(1)}%)</div>
      </div>
      ${(t.fee && t.fee > 0) ? `
      <div class="td-kpi-card">
        <div class="td-kpi-label">Fee Binance (Riil)</div>
        <div class="td-kpi-val text-red">-$${t.fee.toFixed(4)} USDT</div>
      </div>
      <div class="td-kpi-card">
        <div class="td-kpi-label">Gross PnL (Sebelum Fee)</div>
        <div class="td-kpi-val ${t.grossPnl !== undefined && t.grossPnl >= 0 ? 'text-green' : 'text-red'}">
          ${t.grossPnl !== undefined ? (t.grossPnl >= 0 ? '+' : '') + '$' + t.grossPnl.toFixed(2) : '-'} USDT
        </div>
      </div>
      ` : ''}
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
        <div class="td-kpi-val" style="font-size: 12px; color: ${
          t.exitReason === 'TAKE_PROFIT' || t.exitReason === 'TRAILING_TP' ? 'var(--green)' :
          t.exitReason === 'HARD_STOP_LOSS' ? 'var(--red, #ff4d4d)' :
          t.exitReason === 'FEE_LOSS_EXIT' ? 'var(--gold, #f0b90b)' :
          'var(--text-muted)'
        }">${
          t.exitReason === 'TAKE_PROFIT' ? '🎯 Take Profit' :
          t.exitReason === 'TRAILING_TP' ? '📈 Trailing TP' :
          t.exitReason === 'HARD_STOP_LOSS' ? '🛑 Hard Stop Loss' :
          t.exitReason === 'FEE_LOSS_EXIT' ? '💸 TP Minus Fee' :
          t.exitReason === 'TIME_LIMIT_EXIT' ? '⏰ Batas Waktu' :
          t.exitReason === 'EARLY_MOMENTUM_EXIT' ? '⚠️ Early Momentum' :
          t.exitReason === 'MANUAL_CLOSE' ? '⚡ Tutup Manual' :
          t.exitReason
        }</div>
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

  closeTradeDetailModal();
  openSettingsModal(true); // skip reload agar snapshot yang baru diterapkan tidak tertimpa
  alert('✅ Parameter dari trade ini berhasil dimuat ke formulir pengaturan! Silakan periksa lalu klik "Simpan Perubahan" jika ingin menggunakannya.');
}

function renderLogs(logs) {
  const terminal = document.getElementById('terminal-logs');
  terminal.innerHTML = '';
  logs.forEach((l) => appendLog(l));
}

function formatLogMessage(message) {
  if (!message) return '';

  const labelMap = {
    OPEN_SHORT_REQUESTED: 'OPEN SHORT',
    OPEN_SHORT_CONFIRMED: 'OPEN SHORT CONFIRMED',
    GRID_LAYER_PLACED: 'GRID LAYER',
    TP_LIMIT_PLACED: 'TP LIMIT',
    PARTIAL_CLOSE_REQUESTED: 'PARTIAL CLOSE',
    PARTIAL_CLOSE_CONFIRMED: 'PARTIAL CLOSE CONFIRMED',
    FULL_CLOSE_REQUESTED: 'FULL CLOSE',
    FULL_CLOSE_CONFIRMED: 'FULL CLOSE CONFIRMED',
    DB_TRADE_FINALIZED: 'DB FINALIZED',
    CLOSE_SHORT_REQUESTED: 'CLOSE SHORT',
    CLOSE_SHORT_CONFIRMED: 'CLOSE SHORT CONFIRMED',
    CLOSE_SHORT_NOT_CONFIRMED: 'CLOSE SHORT PENDING',
  };

  const normalized = String(message).replace(/\[ORDER AUDIT\] ([^|]+) \| ([A-Z_]+) \| (.*)/, (_, symbol, event, rest) => {
    const label = labelMap[event] || event.replace(/_/g, ' ');
    return `[AUDIT] ${symbol} • ${label}${rest ? ` • ${rest.replace(/\s*\|\s*/g, ' • ')}` : ''}`;
  });

  return normalized;
}

function appendLog(log) {
  if (!log) return;
  const terminal = document.getElementById('terminal-logs');
  if (!terminal) return;

  // Cegah duplikasi entri log yang sama di DOM UI
  if (log.id && document.getElementById(`log-${log.id}`)) {
    return;
  }

  const div = document.createElement('div');
  if (log.id) {
    div.id = `log-${log.id}`;
  }
  div.className = `log-entry ${log.level.toLowerCase()}`;
  div.innerText = `[${log.timestamp}] [${log.level}] ${formatLogMessage(log.message)}`;
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
    const res = await authFetch(endpoint, { method: 'POST' }).then((r) => r.json());
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
    const res = await authFetch('/api/reset-demo', { method: 'POST' }).then((r) => r.json());
    if (res.status) {
      renderStatus(res.status);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function manualClosePosition(symbol) {
  if (!confirm(`Yakin ingin menutup posisi SHORT ${symbol} sekarang di harga pasar?`)) return;
  try {
    const res = await authFetch('/api/close-position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    }).then((r) => r.json());

    if (res.success) {
      if (res.status) renderStatus(res.status);
    } else {
      alert(`Gagal menutup posisi: ${res.message || 'Unknown error'}`);
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
  setVal('cfg-spike-pct', cfg.scanner?.spikeMinPercent || 2.0);
  setVal('cfg-tp-pct', cfg.exit?.takeProfitPct || 1.2);
  setVal('cfg-sl-pct', cfg.exit?.hardStopLossPct || 4.5);
  setVal('cfg-max-hold', cfg.exit?.maxHoldMinutes || 60);

  // Perpanjangan Waktu Hold saat Candle 1m Merah
  const erhCheckbox = document.getElementById('cfg-extend-hold-red-enabled');
  if (erhCheckbox) {
    erhCheckbox.checked = cfg.exit?.extendHoldOnRedCandleEnabled !== false;
    toggleExtendHoldRedInput();
  }
  setVal('cfg-extend-hold-seconds', cfg.exit?.extendHoldSeconds || 30);
  setVal('cfg-extend-hold-max-extensions', cfg.exit?.maxHoldExtensions || 6);
  const brCheckbox = document.getElementById('cfg-bottom-rejection-enabled');
  if (brCheckbox) {
    brCheckbox.checked = !!cfg.scanner?.skipBottomRejectionEnabled;
    toggleBottomRejectionInput();
  }
  setVal('cfg-bottom-rejection-range', cfg.scanner?.bottomRejectionMinRangePct || 1.5);
  setVal('cfg-bottom-rejection-ratio', cfg.scanner?.bottomRejectionWickRatio || 2.0);
  const uwpCheckbox = document.getElementById('cfg-upper-wick-pullback-enabled');
  if (uwpCheckbox) {
    uwpCheckbox.checked = !!cfg.scanner?.upperWickPullbackEnabled;
    toggleUpperWickInput();
  }
  setVal('cfg-upper-wick-pullback-min', cfg.scanner?.upperWickPullbackMinPct ?? 0.3);
  setVal('cfg-upper-wick-pullback-wait', cfg.scanner?.upperWickPullbackMaxWaitSeconds ?? 5);
  const eemCheckbox = document.getElementById('cfg-early-exit-momentum-enabled');
  if (eemCheckbox) eemCheckbox.checked = !!cfg.exit?.earlyExitMomentumEnabled;
  setVal('cfg-early-exit-candles', cfg.exit?.earlyExitMinBullishCandles || 3);
  setVal('cfg-early-exit-rise', cfg.exit?.earlyExitMinRisePct || 0.5);
  setVal('cfg-early-exit-cooldown', cfg.exit?.earlyExitCooldownMinutes || 60);
  setVal('cfg-hard-sl-cooldown', cfg.exit?.hardStopCooldownMinutes || 180);

  // Partial Take Profit
  const ptCheckbox = document.getElementById('cfg-partial-tp-enabled');
  if (ptCheckbox) {
    ptCheckbox.checked = !!cfg.exit?.partialTpEnabled;
    togglePartialTpInput();
  }
  setVal('cfg-partial-tp-ratio', cfg.exit?.partialTpRatio ? Math.round(cfg.exit.partialTpRatio * 100) : 50);

  // Trailing Stop Loss
  const tsCheckbox = document.getElementById('cfg-trailing-sl-enabled');
  if (tsCheckbox) {
    tsCheckbox.checked = !!cfg.exit?.trailingSlEnabled;
    toggleTrailingSL();
  }

  // Trailing Take Profit (Trailing Callback)
  const ttpCheckbox = document.getElementById('cfg-trailing-tp-enabled');
  if (ttpCheckbox) {
    ttpCheckbox.checked = !!cfg.exit?.trailingTpEnabled;
    toggleTrailingTpInput();
  }
  setVal('cfg-trailing-tp-callback', cfg.exit?.trailingCallbackPct || 0.4);

  setVal('cfg-margin-layer', cfg.grid?.marginPerLayerUsdt || 3);
  setVal('cfg-max-margin', cfg.grid?.maxTotalMarginPerCoin || 50);
  setVal('cfg-total-layers', cfg.grid?.totalLayers || 25);
  setVal('cfg-layer-spacing', cfg.grid?.layerSpacingPct || 1.2);
  setVal('cfg-max-coins', cfg.grid?.maxConcurrentCoins || 2);
  setVal('cfg-martingale', cfg.grid?.martingaleMultiplier || 1.1);
  setVal('cfg-cooldown', cfg.scanner?.cooldownMinutes || 20);
  setVal('cfg-data-source', cfg.scanner?.dataSource || 'WEBSOCKET');
  setVal('cfg-polling-interval', String(cfg.scanner?.pollingIntervalMs || 1000));
  toggleDataSourceGroup();
  setVal('cfg-api-key', cfg.apiKey || '');
  setVal('cfg-api-secret', cfg.apiSecret || '');

  // Telegram Notifications
  const tg = cfg.telegram || {};
  const tgCheckbox = document.getElementById('cfg-tg-enabled');
  if (tgCheckbox) {
    tgCheckbox.checked = !!tg.enabled;
    toggleTelegramInputs();
  }
  setVal('cfg-tg-token', tg.botToken || '');
  setVal('cfg-tg-chatid', tg.chatId || '');
  const setChecked = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = val !== undefined ? !!val : true;
  };
  setChecked('cfg-tg-on-new', tg.notifyOnNewOrder);
  setChecked('cfg-tg-on-layer', tg.notifyOnLayerFill);
  setChecked('cfg-tg-on-close', tg.notifyOnClose);

  // Whitelist
  const wlCheckbox = document.getElementById('cfg-whitelist-enabled');
  if (wlCheckbox) {
    wlCheckbox.checked = !!cfg.scanner?.whitelistEnabled;
    toggleWhitelistInput();
  }
  setVal('cfg-whitelist-symbols', (cfg.scanner?.whitelistSymbols || []).join(', '));
  setVal('cfg-exclude-symbols', (cfg.scanner?.excludeSymbols ?? ['USDCUSDT', 'FDUSDUSDT', 'BTCUSDT', 'ETHUSDT']).join(', '));
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
      spikeMinPercent: parseFloat(getVal('cfg-spike-pct', '2.0')) || 2.0,
      skipBottomRejectionEnabled: !!document.getElementById('cfg-bottom-rejection-enabled')?.checked,
      bottomRejectionMinRangePct: parseFloat(getVal('cfg-bottom-rejection-range', '1.5')) || 1.5,
      bottomRejectionWickRatio: parseFloat(getVal('cfg-bottom-rejection-ratio', '2.0')) || 2.0,
      upperWickPullbackEnabled: !!document.getElementById('cfg-upper-wick-pullback-enabled')?.checked,
      upperWickPullbackMinPct: parseFloat(getVal('cfg-upper-wick-pullback-min', '0.3')) || 0.3,
      upperWickPullbackMaxWaitSeconds: parseInt(getVal('cfg-upper-wick-pullback-wait', '5'), 10) || 5,
      cooldownMinutes: parseInt(getVal('cfg-cooldown', '20')) || 20,
      whitelistEnabled: !!document.getElementById('cfg-whitelist-enabled')?.checked,
      whitelistSymbols: (getVal('cfg-whitelist-symbols', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
      excludeSymbols: (getVal('cfg-exclude-symbols', '') || '')
        .split(',')
        .map(s => s.trim().toUpperCase())
        .filter(Boolean),
      dataSource: getVal('cfg-data-source', 'WEBSOCKET'),
      pollingIntervalMs: parseInt(getVal('cfg-polling-interval', '1000'), 10) || 1000,
    },
    exit: {
      ...(currentConfig?.exit || {}),
      takeProfitPct: parseFloat(getVal('cfg-tp-pct', '1.2')) || 1.2,
      hardStopLossPct: parseFloat(getVal('cfg-sl-pct', '4.5')) || 4.5,
      maxHoldMinutes: parseInt(getVal('cfg-max-hold', '60')) || 60,
      earlyExitMomentumEnabled: !!document.getElementById('cfg-early-exit-momentum-enabled')?.checked,
      earlyExitMinBullishCandles: parseInt(getVal('cfg-early-exit-candles', '3')) || 3,
      earlyExitMinRisePct: parseFloat(getVal('cfg-early-exit-rise', '0.5')) || 0.5,
      earlyExitCooldownMinutes: parseInt(getVal('cfg-early-exit-cooldown', '60')) || 60,
      hardStopCooldownMinutes: parseInt(getVal('cfg-hard-sl-cooldown', '180')) || 180,
      partialTpEnabled: !!document.getElementById('cfg-partial-tp-enabled')?.checked,
      partialTpRatio: (parseFloat(getVal('cfg-partial-tp-ratio', '50')) || 50) / 100,
      trailingSlEnabled: !!document.getElementById('cfg-trailing-sl-enabled')?.checked,
      trailingTpEnabled: !!document.getElementById('cfg-trailing-tp-enabled')?.checked,
      trailingCallbackPct: parseFloat(getVal('cfg-trailing-tp-callback', '0.4')) || 0.4,
      extendHoldOnRedCandleEnabled: !!document.getElementById('cfg-extend-hold-red-enabled')?.checked,
      extendHoldSeconds: parseInt(getVal('cfg-extend-hold-seconds', '30'), 10) || 30,
      maxHoldExtensions: parseInt(getVal('cfg-extend-hold-max-extensions', '6'), 10) || 6,
    },
    grid: {
      ...(currentConfig?.grid || {}),
      marginPerLayerUsdt: parseFloat(getVal('cfg-margin-layer', '3')) || 3,
      maxTotalMarginPerCoin: parseFloat(getVal('cfg-max-margin', '50')) || 50,
      totalLayers: parseInt(getVal('cfg-total-layers', '25')) || 25,
      layerSpacingPct: parseFloat(getVal('cfg-layer-spacing', '1.2')) || 1.2,
      maxConcurrentCoins: parseInt(getVal('cfg-max-coins', '2')) || 2,
      martingaleMultiplier: parseFloat(getVal('cfg-martingale', '1.1')) || 1.1,
    },
    apiKey: (getVal('cfg-api-key', '') || '').trim(),
    apiSecret: (getVal('cfg-api-secret', '') || '').trim(),
    telegram: {
      enabled: !!document.getElementById('cfg-tg-enabled')?.checked,
      botToken: (getVal('cfg-tg-token', '') || '').trim(),
      chatId: (getVal('cfg-tg-chatid', '') || '').trim(),
      notifyOnNewOrder: !!document.getElementById('cfg-tg-on-new')?.checked,
      notifyOnLayerFill: !!document.getElementById('cfg-tg-on-layer')?.checked,
      notifyOnClose: !!document.getElementById('cfg-tg-on-close')?.checked,
    },
  };
}

async function reloadConfigFromServer() {
  try {
    const fresh = await authFetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
    if (fresh && fresh.exit) {
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

async function openSettingsModal(skipReload = false) {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.add('open');

  if (skipReload) return;

  // Selalu sinkronkan dengan database/server setiap kali modal pengaturan dibuka
  try {
    const fresh = await authFetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
    if (fresh && fresh.exit) {
      currentConfig = fresh;
      try {
        localStorage.setItem('wicksniper_config', JSON.stringify(fresh));
        localStorage.removeItem('wicksniper_settings_draft');
      } catch (e) {}
      populateSettingsForm(fresh);
      isFormModifiedByUser = false;
      settingsFormInitialized = true;
    }
  } catch (err) {
    console.warn('Gagal memuat config terbaru saat membuka pengaturan:', err);
    if (currentConfig) {
      populateSettingsForm(currentConfig);
    }
  }
}

function closeSettingsModal() {
  document.getElementById('settings-modal')?.classList.remove('open');
  isFormModifiedByUser = false;
}

async function saveSettings() {
  const updated = getSettingsFormData();

  try {
    const res = await authFetch('/api/config', {
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

async function testBinanceConnection() {
  const apiKey = (document.getElementById('cfg-api-key')?.value || '').trim();
  const apiSecret = (document.getElementById('cfg-api-secret')?.value || '').trim();
  const btn = document.getElementById('btn-test-binance');
  const resultBox = document.getElementById('binance-test-result');

  if (!apiKey || !apiSecret) {
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.style.background = 'rgba(255, 68, 68, 0.1)';
      resultBox.style.border = '1px solid rgba(255, 68, 68, 0.3)';
      resultBox.style.color = 'var(--color-red)';
      resultBox.innerHTML = '⚠️ Harap isi Binance API Key dan API Secret terlebih dahulu.';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Menguji Koneksi...';
  }
  if (resultBox) {
    resultBox.style.display = 'block';
    resultBox.style.background = 'rgba(0, 240, 255, 0.08)';
    resultBox.style.border = '1px solid rgba(0, 240, 255, 0.3)';
    resultBox.style.color = 'var(--color-cyan)';
    resultBox.innerHTML = '🔄 Menghubungkan ke Binance Futures REST API & sinkronisasi waktu...';
  }

  try {
    const res = await authFetch('/api/check-binance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, apiSecret }),
    }).then((r) => r.json());

    if (resultBox) {
      if (res.success) {
        resultBox.style.background = 'rgba(0, 255, 136, 0.1)';
        resultBox.style.border = '1px solid rgba(0, 255, 136, 0.4)';
        resultBox.style.color = 'var(--color-green)';
        resultBox.innerHTML = `
          <div style="font-weight: 700; margin-bottom: 4px;">✅ TERHUBUNG KE BINANCE FUTURES!</div>
          <div>⚡ <b>Latensi:</b> ${res.latencyMs}ms</div>
          <div>💰 <b>Saldo Futures Tersedia:</b> $${res.availableUsdt.toFixed(2)} USDT</div>
          <div>🛡️ <b>Mode Posisi Akun:</b> ${res.dualSidePosition ? 'Hedge Mode (Dual Position)' : 'One-Way Mode (Normal)'}</div>
          <div style="font-size: 11px; margin-top: 6px; color: var(--text-muted);">
            ${res.availableUsdt < 20 ? '⚠️ Saldo USDT minim. Disarankan memiliki saldo minimal $50 - $245 USDT.' : '✅ Saldo siap untuk trading live.'}
          </div>
        `;
      } else {
        resultBox.style.background = 'rgba(255, 68, 68, 0.1)';
        resultBox.style.border = '1px solid rgba(255, 68, 68, 0.4)';
        resultBox.style.color = 'var(--color-red)';
        resultBox.innerHTML = `
          <div style="font-weight: 700; margin-bottom: 4px;">❌ KONEKSI GAGAL</div>
          <div>${res.error || 'Periksa API Key, Secret, atau koneksi jaringan Anda.'}</div>
          <div style="font-size: 11px; margin-top: 4px; color: var(--text-muted);">
            Pastikan opsi <b>"Enable Reading"</b> dan <b>"Enable Futures"</b> telah dicentang di manajemen API Binance Anda.
          </div>
        `;
      }
    }
  } catch (err) {
    if (resultBox) {
      resultBox.style.background = 'rgba(255, 68, 68, 0.1)';
      resultBox.style.border = '1px solid rgba(255, 68, 68, 0.4)';
      resultBox.style.color = 'var(--color-red)';
      resultBox.innerHTML = `❌ Error pengujian: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '🔍 Uji Koneksi & Saldo Binance Futures';
    }
  }
}

// ==========================================
// ==========================================
// WHITELIST TOGGLE
// ==========================================
function toggleWhitelistInput() {
  const checkbox = document.getElementById('cfg-whitelist-enabled');
  const inputGroup = document.getElementById('whitelist-input-group');
  if (inputGroup) {
    inputGroup.style.pointerEvents = 'auto';
    inputGroup.style.opacity = checkbox && checkbox.checked ? '1' : '0.8';
  }
}
window.toggleWhitelistInput = toggleWhitelistInput;

// ==========================================
// PARTIAL TAKE PROFIT TOGGLE
// ==========================================
function togglePartialTpInput() {
  const checkbox = document.getElementById('cfg-partial-tp-enabled');
  const group = document.getElementById('partial-tp-ratio-group');
  if (group) {
    group.style.pointerEvents = 'auto';
    group.style.opacity = checkbox && checkbox.checked ? '1' : '0.8';
  }
}
window.togglePartialTpInput = togglePartialTpInput;

// ==========================================
// TRAILING STOP LOSS TOGGLE
// ==========================================
function toggleTrailingSL() {
  const checkbox = document.getElementById('cfg-trailing-sl-enabled');
  const group = document.getElementById('trailing-sl-info-group');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'block' : 'none';
  }
}
window.toggleTrailingSL = toggleTrailingSL;

function toggleBottomRejectionInput() {
  const checkbox = document.getElementById('cfg-bottom-rejection-enabled');
  const group = document.getElementById('cfg-bottom-rejection-params');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'flex' : 'none';
  }
}
window.toggleBottomRejectionInput = toggleBottomRejectionInput;

function toggleUpperWickInput() {
  const checkbox = document.getElementById('cfg-upper-wick-pullback-enabled');
  const group = document.getElementById('cfg-upper-wick-pullback-params');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'flex' : 'none';
  }
}
window.toggleUpperWickInput = toggleUpperWickInput;

function toggleExtendHoldRedInput() {
  const checkbox = document.getElementById('cfg-extend-hold-red-enabled');
  const group = document.getElementById('cfg-extend-hold-params');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'flex' : 'none';
  }
}
window.toggleExtendHoldRedInput = toggleExtendHoldRedInput;

function toggleTrailingTpInput() {
  const checkbox = document.getElementById('cfg-trailing-tp-enabled');
  const group = document.getElementById('trailing-tp-callback-group');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'block' : 'none';
  }
}
window.toggleTrailingTpInput = toggleTrailingTpInput;

function toggleDataSourceGroup() {
  const select = document.getElementById('cfg-data-source');
  const group = document.getElementById('polling-interval-group');
  if (group) {
    group.style.display = select && select.value === 'POLLING' ? 'block' : 'none';
  }
}
window.toggleDataSourceGroup = toggleDataSourceGroup;

// ==========================================
// TELEGRAM NOTIFICATIONS CONTROLLER
// ==========================================
function toggleTelegramInputs() {
  const checkbox = document.getElementById('cfg-tg-enabled');
  const group = document.getElementById('telegram-input-group');
  if (group) {
    group.style.pointerEvents = 'auto';
    group.style.opacity = checkbox && checkbox.checked ? '1' : '0.85';
  }
}
window.toggleTelegramInputs = toggleTelegramInputs;

async function testTelegramConnection() {
  const botToken = (document.getElementById('cfg-tg-token')?.value || '').trim();
  const chatId = (document.getElementById('cfg-tg-chatid')?.value || '').trim();
  const btn = document.getElementById('btn-test-telegram');
  const resultBox = document.getElementById('telegram-test-result');

  if (!botToken || !chatId) {
    if (resultBox) {
      resultBox.style.display = 'block';
      resultBox.style.background = 'rgba(255, 68, 68, 0.1)';
      resultBox.style.border = '1px solid rgba(255, 68, 68, 0.3)';
      resultBox.style.color = 'var(--color-red)';
      resultBox.innerHTML = '⚠️ Harap isi Telegram Bot Token dan Chat ID terlebih dahulu.';
    }
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Mengirim Pesan Tes...';
  }
  if (resultBox) {
    resultBox.style.display = 'block';
    resultBox.style.background = 'rgba(0, 240, 255, 0.08)';
    resultBox.style.border = '1px solid rgba(0, 240, 255, 0.3)';
    resultBox.style.color = 'var(--color-cyan)';
    resultBox.innerHTML = '🔄 Menghubungkan ke Telegram Bot API & mengirim pesan uji coba...';
  }

  try {
    const res = await authFetch('/api/check-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botToken, chatId }),
    }).then((r) => r.json());

    if (resultBox) {
      if (res.success) {
        resultBox.style.background = 'rgba(0, 255, 136, 0.1)';
        resultBox.style.border = '1px solid rgba(0, 255, 136, 0.4)';
        resultBox.style.color = 'var(--color-green)';
        resultBox.innerHTML = `
          <div style="font-weight: 700; margin-bottom: 4px;">✅ PESAN TELEGRAM BERHASIL TERKIRIM!</div>
          <div>🤖 <b>Bot Terhubung:</b> @${res.botName}</div>
          <div style="font-size: 11px; margin-top: 4px; color: var(--text-muted);">
            Silakan periksa aplikasi Telegram Anda. Pesan uji coba telah masuk ke Chat ID yang Anda tuju!
          </div>
        `;
      } else {
        resultBox.style.background = 'rgba(255, 68, 68, 0.1)';
        resultBox.style.border = '1px solid rgba(255, 68, 68, 0.4)';
        resultBox.style.color = 'var(--color-red)';
        resultBox.innerHTML = `
          <div style="font-weight: 700; margin-bottom: 4px;">❌ GAGAL MENGIRIM KE TELEGRAM</div>
          <div>${res.error || 'Token bot tidak valid atau Chat ID belum memulai percakapan (/start) dengan bot.'}</div>
          <div style="font-size: 11px; margin-top: 4px; color: var(--text-muted);">
            <b>Tips:</b> Pastikan Anda sudah membuka chat dengan bot Anda di Telegram dan menekan tombol <b>/start</b> terlebih dahulu.
          </div>
        `;
      }
    }
  } catch (err) {
    if (resultBox) {
      resultBox.style.background = 'rgba(255, 68, 68, 0.1)';
      resultBox.style.border = '1px solid rgba(255, 68, 68, 0.4)';
      resultBox.style.color = 'var(--color-red)';
      resultBox.innerHTML = `❌ Error pengujian: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerText = '📱 Kirim Pesan Uji Coba Telegram';
    }
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
let _backtestFormModifiedByUser = false;

function applyConfigToBacktestInputs(cfg) {
  if (!cfg) return;

  // Default target koin disamakan dengan isi yang ada di config koin whitelist
  const whitelist = (cfg.scanner?.whitelistSymbols || []).filter(Boolean);
  const symbolsInput = document.getElementById('bt-symbols');
  if (symbolsInput) {
    if (whitelist.length > 0) {
      symbolsInput.value = whitelist.join(', ');
    } else {
      symbolsInput.value = 'AKEUSDT, CROSSUSDT, BTWUSDT';
    }
  }

  if (cfg.leverage !== undefined) document.getElementById('bt-leverage').value = cfg.leverage;
  if (cfg.scanner?.spikeMinPercent !== undefined) document.getElementById('bt-spike').value = cfg.scanner.spikeMinPercent;
  if (cfg.exit?.takeProfitPct !== undefined) document.getElementById('bt-tp').value = cfg.exit.takeProfitPct;
  if (cfg.exit?.hardStopLossPct !== undefined) document.getElementById('bt-sl').value = cfg.exit.hardStopLossPct;

  const bttsCheckbox = document.getElementById('bt-trailing-sl-enabled');
  if (bttsCheckbox) bttsCheckbox.checked = !!cfg.exit?.trailingSlEnabled;

  const bteemCheckbox = document.getElementById('bt-early-exit-momentum-enabled');
  if (bteemCheckbox) bteemCheckbox.checked = !!cfg.exit?.earlyExitMomentumEnabled;
  if (cfg.exit?.earlyExitMinBullishCandles !== undefined) document.getElementById('bt-early-exit-candles').value = cfg.exit.earlyExitMinBullishCandles;
  if (cfg.exit?.earlyExitMinRisePct !== undefined) document.getElementById('bt-early-exit-rise').value = cfg.exit.earlyExitMinRisePct;
  if (cfg.exit?.earlyExitCooldownMinutes !== undefined) document.getElementById('bt-early-exit-cooldown').value = cfg.exit.earlyExitCooldownMinutes;
  if (cfg.exit?.hardStopCooldownMinutes !== undefined) document.getElementById('bt-hard-sl-cooldown').value = cfg.exit.hardStopCooldownMinutes;

  const btptCheckbox = document.getElementById('bt-partial-tp-enabled');
  if (btptCheckbox) btptCheckbox.checked = !!cfg.exit?.partialTpEnabled;
  const btptRatio = document.getElementById('bt-partial-tp-ratio');
  if (btptRatio && cfg.exit?.partialTpRatio !== undefined) {
    btptRatio.value = Math.round(cfg.exit.partialTpRatio * 100);
  }
  toggleBtPartialTp();

  const btttpCheckbox = document.getElementById('bt-trailing-tp-enabled');
  if (btttpCheckbox) btttpCheckbox.checked = !!cfg.exit?.trailingTpEnabled;
  const btttpCallback = document.getElementById('bt-trailing-tp-callback');
  if (btttpCallback && cfg.exit?.trailingCallbackPct !== undefined) {
    btttpCallback.value = cfg.exit.trailingCallbackPct;
  }
  toggleBtTrailingTp();

  if (cfg.grid?.marginPerLayerUsdt !== undefined) document.getElementById('bt-margin').value = cfg.grid.marginPerLayerUsdt;
  if (cfg.grid?.layerSpacingPct !== undefined) document.getElementById('bt-spacing').value = cfg.grid.layerSpacingPct;
  if (cfg.grid?.totalLayers !== undefined) document.getElementById('bt-total-layers').value = cfg.grid.totalLayers;
  if (cfg.grid?.maxTotalMarginPerCoin !== undefined) document.getElementById('bt-max-margin').value = cfg.grid.maxTotalMarginPerCoin;
  if (cfg.grid?.martingaleMultiplier !== undefined) document.getElementById('bt-martingale').value = cfg.grid.martingaleMultiplier;
  if (cfg.exit?.maxHoldMinutes !== undefined) document.getElementById('bt-max-hold').value = cfg.exit.maxHoldMinutes;
  if (cfg.scanner?.cooldownMinutes !== undefined) document.getElementById('bt-cooldown').value = cfg.scanner.cooldownMinutes;

  const btbrCheckbox = document.getElementById('bt-bottom-rejection-enabled');
  if (btbrCheckbox) btbrCheckbox.checked = !!cfg.scanner?.skipBottomRejectionEnabled;
  const btbrRange = document.getElementById('bt-bottom-rejection-range');
  if (btbrRange && cfg.scanner?.bottomRejectionMinRangePct !== undefined) {
    btbrRange.value = cfg.scanner.bottomRejectionMinRangePct;
  }
  const btbrRatio = document.getElementById('bt-bottom-rejection-ratio');
  if (btbrRatio && cfg.scanner?.bottomRejectionWickRatio !== undefined) {
    btbrRatio.value = cfg.scanner.bottomRejectionWickRatio;
  }
  toggleBtBottomRejection();

  const btuwpCheckbox = document.getElementById('bt-upper-wick-pullback-enabled');
  if (btuwpCheckbox) btuwpCheckbox.checked = !!cfg.scanner?.upperWickPullbackEnabled;
  const btuwpMin = document.getElementById('bt-upper-wick-pullback-min');
  if (btuwpMin && cfg.scanner?.upperWickPullbackMinPct !== undefined) {
    btuwpMin.value = cfg.scanner.upperWickPullbackMinPct;
  }
  toggleBtUpperWick();
}

async function openBacktestModal() {
  // Set tanggal default jika belum terisi
  const startEl = document.getElementById('bt-start-date');
  const endEl = document.getElementById('bt-end-date');
  if (!startEl.value || !endEl.value) {
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
    startEl.value = formatDateTimeLocal(threeDaysAgo);
    endEl.value = formatDateTimeLocal(now);
  }

  // Muat config segar jika form belum pernah diedit manual atau belum diinisialisasi
  if (!_backtestModalInitialized || !_backtestFormModifiedByUser) {
    try {
      const fresh = await authFetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
      if (fresh && fresh.exit) {
        currentConfig = fresh;
        try {
          localStorage.setItem('wicksniper_config', JSON.stringify(fresh));
        } catch (e) {}
      }
    } catch (e) {}

    applyConfigToBacktestInputs(currentConfig);
    _backtestModalInitialized = true;
    _backtestFormModifiedByUser = false;
  }

  document.getElementById('backtest-modal').style.display = 'flex';
}

async function resetBacktestParams() {
  // Reset parameter backtest ke nilai config bot saat ini (selalu ambil data fresh)
  try {
    const fresh = await authFetch('/api/config?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
    if (fresh && fresh.exit) {
      currentConfig = fresh;
      try {
        localStorage.setItem('wicksniper_config', JSON.stringify(fresh));
      } catch (e) {}
    }
  } catch (err) {
    console.warn('Gagal memuat config saat reset backtest:', err);
  }

  applyConfigToBacktestInputs(currentConfig);
  _backtestFormModifiedByUser = false;

  // Reset rentang waktu default ke 3 hari terakhir sampai sekarang
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 3600 * 1000);
  document.getElementById('bt-start-date').value = formatDateTimeLocal(threeDaysAgo);
  document.getElementById('bt-end-date').value = formatDateTimeLocal(now);
  document.querySelectorAll('.btn-preset').forEach((b) => b.classList.remove('active'));
  const preset3d = document.querySelectorAll('.btn-preset')[1];
  if (preset3d) preset3d.classList.add('active');
}

function toggleBtBottomRejection() {
  const isChecked = document.getElementById('bt-bottom-rejection-enabled')?.checked;
  const container = document.getElementById('bt-bottom-rejection-container');
  if (container) {
    container.style.display = isChecked ? 'inline-flex' : 'none';
  }
}
window.toggleBtBottomRejection = toggleBtBottomRejection;

function toggleBtUpperWick() {
  const isChecked = document.getElementById('bt-upper-wick-pullback-enabled')?.checked;
  const container = document.getElementById('bt-upper-wick-container');
  if (container) {
    container.style.display = isChecked ? 'inline-flex' : 'none';
  }
}
window.toggleBtUpperWick = toggleBtUpperWick;

async function clearBacktestCache() {
  if (!confirm('Hapus semua file cache klines yang tersimpan di disk lokal?')) return;
  try {
    const res = await authFetch('/api/backtest/clear-cache', { method: 'POST' }).then((r) => r.json());
    if (res.success) {
      alert(`✅ Cache klines berhasil dibersihkan! (${res.deletedCount || 0} file dihapus)`);
    } else {
      alert(`⚠️ Gagal membersihkan cache: ${res.message}`);
    }
  } catch (err) {
    alert(`❌ Error membersihkan cache: ${err.message}`);
  }
}
window.clearBacktestCache = clearBacktestCache;

function toggleBtPartialTp() {
  const isChecked = document.getElementById('bt-partial-tp-enabled')?.checked;
  const container = document.getElementById('bt-partial-tp-ratio-container');
  if (container) {
    container.style.display = isChecked ? 'inline-flex' : 'none';
  }
}
window.toggleBtPartialTp = toggleBtPartialTp;

function toggleBtTrailingTp() {
  const isChecked = document.getElementById('bt-trailing-tp-enabled')?.checked;
  const container = document.getElementById('bt-trailing-tp-callback-container');
  if (container) {
    container.style.display = isChecked ? 'inline-flex' : 'none';
  }
}
window.toggleBtTrailingTp = toggleBtTrailingTp;

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

  const getNum = (id, fallback) => {
    const val = parseFloat(document.getElementById(id)?.value);
    return isNaN(val) ? fallback : val;
  };
  const getInt = (id, fallback) => {
    const val = parseInt(document.getElementById(id)?.value, 10);
    return isNaN(val) ? fallback : val;
  };

  const payload = {
    symbols,
    startTime: new Date(startDate).getTime(),
    endTime: new Date(endDate).getTime(),
    bypassCache: !!document.getElementById('bt-bypass-cache')?.checked,
    leverage: getNum('bt-leverage', 5),
    spikeMinPercent: getNum('bt-spike', 2.0),
    takeProfitPct: getNum('bt-tp', 1.2),
    hardStopLossPct: getNum('bt-sl', 4.5),
    trailingSlEnabled: !!document.getElementById('bt-trailing-sl-enabled')?.checked,
    earlyExitMomentumEnabled: !!document.getElementById('bt-early-exit-momentum-enabled')?.checked,
    earlyExitMinBullishCandles: getInt('bt-early-exit-candles', 3),
    earlyExitMinRisePct: getNum('bt-early-exit-rise', 0.5),
    earlyExitCooldownMinutes: getInt('bt-early-exit-cooldown', 60),
    hardStopCooldownMinutes: getInt('bt-hard-sl-cooldown', 180),
    partialTpEnabled: !!document.getElementById('bt-partial-tp-enabled')?.checked,
    partialTpRatio: getNum('bt-partial-tp-ratio', 50) / 100,
    trailingTpEnabled: !!document.getElementById('bt-trailing-tp-enabled')?.checked,
    trailingCallbackPct: getNum('bt-trailing-tp-callback', 0.4),
    skipBottomRejectionEnabled: !!document.getElementById('bt-bottom-rejection-enabled')?.checked,
    bottomRejectionMinRangePct: getNum('bt-bottom-rejection-range', 1.5),
    bottomRejectionWickRatio: getNum('bt-bottom-rejection-ratio', 2.0),
    upperWickPullbackEnabled: !!document.getElementById('bt-upper-wick-pullback-enabled')?.checked,
    upperWickPullbackMinPct: getNum('bt-upper-wick-pullback-min', 0.3),
    marginPerLayerUsdt: getNum('bt-margin', 3),
    layerSpacingPct: getNum('bt-spacing', 1.2),
    totalLayers: getInt('bt-total-layers', 25),
    maxTotalMarginPerCoin: getNum('bt-max-margin', 50),
    martingaleMultiplier: getNum('bt-martingale', 1.1),
    maxHoldMinutes: getInt('bt-max-hold', 60),
    cooldownMinutes: getInt('bt-cooldown', 20),
    initialBalance: getNum('bt-init-balance', 245),
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
    const res = await authFetch('/api/backtest?_t=' + Date.now(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
      },
      cache: 'no-store',
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
    const feeSub = (r.totalFeesUsdt && r.totalFeesUsdt > 0) ? ` • 💸 Fee: -$${r.totalFeesUsdt.toFixed(2)} USDT` : '';
    document.getElementById('bt-res-pnl-sub').innerText = `${sign}${r.netProfitPct.toFixed(1)}% dari modal $${r.initialBalance}${feeSub}`;

    document.getElementById('bt-res-trades').innerText = r.totalTrades;
    let candleSub = `${r.totalCandlesAnalyzed.toLocaleString()} Lilin 1m`;
    if (r.partialTpTrades > 0) {
      candleSub += ` • 🎯 ${r.partialTpTrades} Partial TP`;
    }
    if (r.bottomRejectionSkips > 0) {
      candleSub += ` • 🛡️ ${r.bottomRejectionSkips} Sweep Ditolak`;
    }
    if (r.upperWickSkips > 0) {
      candleSub += ` • 🎯 ${r.upperWickSkips} Monster Pump Ditolak`;
    }
    document.getElementById('bt-res-candles').innerText = candleSub;

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
          const partialBadge = t.partialTpTaken
            ? `<span class="badge" style="background: rgba(0, 240, 255, 0.15); color: var(--color-cyan); font-size: 10px; padding: 1px 5px; border-radius: 3px; margin-left: 4px; border: 1px solid rgba(0, 240, 255, 0.3);" title="Stage 1 Partial TP terealisasi & SL dipindah ke BEP">🎯 Partial TP</span>`
            : '';
          let exitReasonLabel = t.exitReason;
          if (t.exitReason === 'TAKE_PROFIT') exitReasonLabel = '🎯 Take Profit';
          else if (t.exitReason === 'TRAILING_TP') exitReasonLabel = t.partialTpTaken ? '🎯 Stage 2 TP / BEP' : '📈 Trailing TP';
          else if (t.exitReason === 'HARD_STOP_LOSS') exitReasonLabel = '🛑 Hard SL';
          else if (t.exitReason === 'TIME_LIMIT_EXIT') exitReasonLabel = '⏰ Batas Waktu';
          else if (t.exitReason === 'EARLY_MOMENTUM_EXIT') exitReasonLabel = '⚠️ Early Momentum';
          else if (t.exitReason === 'FEE_LOSS_EXIT') exitReasonLabel = '💸 TP Minus Fee';

          const btFeeTag = (t.fee && t.fee > 0)
            ? `<br><span style="font-size: 10px; color: var(--color-text-muted);" title="Gross PnL: ${t.grossPnl !== undefined ? (t.grossPnl >= 0 ? '+' : '') + '$' + t.grossPnl.toFixed(2) : '-'} | Fee: -$${t.fee.toFixed(3)}">Fee: -$${t.fee.toFixed(3)}</span>`
            : '';

          return `
            <tr>
              <td>${t.entryTime}</td>
              <td><b>${t.symbol}</b> <span class="badge-side short">SHORT</span>${partialBadge}</td>
              <td><span class="text-cyan font-mono"><b>$${t.marginUsed.toFixed(2)}</b></span></td>
              <td>$${t.entryPrice} ➜ $${t.exitPrice}</td>
              <td><b>${t.durationMinutes}m</b></td>
              <td class="${tColor}"><b>${tSign}$${t.realizedPnl.toFixed(2)} (${tSign}${t.pnlPct.toFixed(1)}%)</b>${btFeeTag}</td>
              <td><small>${exitReasonLabel}</small></td>
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
    });
    modal.addEventListener('change', () => {
      isFormModifiedByUser = true;
    });
  }

  const btModal = document.getElementById('backtest-modal');
  if (btModal) {
    btModal.addEventListener('input', () => {
      _backtestFormModifiedByUser = true;
    });
    btModal.addEventListener('change', () => {
      _backtestFormModifiedByUser = true;
    });
  }

  document.getElementById('cfg-tg-enabled')?.addEventListener('change', toggleTelegramInputs);
  document.getElementById('cfg-partial-tp-enabled')?.addEventListener('change', togglePartialTpInput);
  document.getElementById('cfg-trailing-sl-enabled')?.addEventListener('change', toggleTrailingSL);
  document.getElementById('cfg-whitelist-enabled')?.addEventListener('change', toggleWhitelistInput);
  document.getElementById('cfg-data-source')?.addEventListener('change', toggleDataSourceGroup);
});

// Deteksi saat tab aktif kembali (saat buka layar HP/iPad atau kembali dari tab lain)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    }
    authFetch('/api/config?_t=' + Date.now(), { cache: 'no-store' })
      .then((r) => r.json())
      .then((fresh) => {
        if (fresh && fresh.exit) {
          currentConfig = fresh;
          try {
            localStorage.setItem('wicksniper_config', JSON.stringify(fresh));
          } catch (e) {}
          const modal = document.getElementById('settings-modal');
          const isModalOpen = modal && modal.classList.contains('open');
          if (!isModalOpen || !isFormModifiedByUser) {
            populateSettingsForm(fresh);
            isFormModifiedByUser = false;
          }

          const btModal = document.getElementById('backtest-modal');
          const isBtModalOpen = btModal && btModal.style.display === 'flex';
          if (!isBtModalOpen || !_backtestFormModifiedByUser) {
            applyConfigToBacktestInputs(fresh);
            _backtestFormModifiedByUser = false;
          }
        }
      })
      .catch(() => {});
  }
});

// PWA Service Worker Registration & Cache Busting
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js?v=2.3.2')
      .then((reg) => {
        reg.update();
      })
      .catch((err) => {
        console.warn('⚠️ PWA Service Worker registration skipped:', err.message);
      });
  });
}

// ============================================================================
// MOBILE NAVIGATION & ACTION DRAWER (PWA READY)
// ============================================================================
function switchMobileTab(tabKey) {
  const container = document.getElementById('dashboard-columns');
  if (container) {
    container.setAttribute('data-active-tab', tabKey);
  }

  const tabs = document.querySelectorAll('.seg-tab');
  tabs.forEach((tab) => {
    if (tab.getAttribute('data-tab') === tabKey) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  try {
    localStorage.setItem('wicksniper_mobile_tab', tabKey);
  } catch (e) {}
}

function toggleMobileDrawer() {
  const drawer = document.getElementById('mobile-drawer');
  if (drawer) {
    drawer.classList.toggle('open');
  }
}

function closeMobileDrawer() {
  const drawer = document.getElementById('mobile-drawer');
  if (drawer) {
    drawer.classList.remove('open');
  }
}

function handleDrawerOverlayClick(event) {
  if (event.target && event.target.id === 'mobile-drawer') {
    closeMobileDrawer();
  }
}

// Restore saved mobile tab on start
try {
  const savedTab = localStorage.getItem('wicksniper_mobile_tab');
  if (savedTab) {
    switchMobileTab(savedTab);
  }
} catch (e) {}

// ESC key closes drawer
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMobileDrawer();
  }
});

