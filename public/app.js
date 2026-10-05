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

// BLACKLIST UI HANDLERS
window.openBlacklistModal = async function () {
  const modal = document.getElementById('blacklist-modal');
  if (modal) modal.classList.add('open');
  await refreshBlacklistList();
};

window.closeBlacklistModal = function () {
  const modal = document.getElementById('blacklist-modal');
  if (modal) modal.classList.remove('open');
};

async function refreshBlacklistList(btnEl) {
  const btn = (btnEl instanceof HTMLElement ? btnEl : null) || document.getElementById('btn-refresh-blacklist');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ Memuat...';
  }
  const container = document.getElementById('blacklist-list-container');
  try {
    const res = await authFetch('/api/blacklist?_t=' + Date.now(), { cache: 'no-store' }).then((r) => r.json());
    let list = res;
    if (res && Array.isArray(res.list)) list = res.list;
    if (!Array.isArray(list)) {
      if (container) container.innerHTML = '<div style="padding:12px; color:var(--text-danger);">Gagal memuat daftar blacklist.</div>';
      return;
    }
    if (container) {
      container.innerHTML = '';
      if (list.length === 0) {
        container.innerHTML = '<div style="padding:12px; color:var(--text-muted);">Tidak ada entri blacklist sementara.</div>';
        return;
      }
      list.forEach((entry) => {
        const el = document.createElement('div');
        el.style.display = 'flex';
        el.style.justifyContent = 'space-between';
        el.style.alignItems = 'center';
        el.style.padding = '8px 10px';
        el.style.borderBottom = '1px dashed rgba(255,255,255,0.03)';

        const left = document.createElement('div');
        left.style.display = 'flex';
        left.style.flexDirection = 'column';
        left.innerHTML = `<strong>${entry.symbol}</strong><small style="color:var(--text-muted);">${entry.reason || ''} ${entry.expiresAt ? ' • Expires: ' + new Date(entry.expiresAt).toLocaleString() : ''}</small>`;

        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.gap = '8px';

        const btnRemove = document.createElement('button');
        btnRemove.className = 'btn btn-danger';
        btnRemove.innerText = 'Remove';
        btnRemove.onclick = async () => {
          if (!confirm(`Remove ${entry.symbol} from blacklist?`)) return;
          try {
            const resp = await authFetch('/api/blacklist/remove', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ symbol: entry.symbol }),
            });
            const j = await resp.json();
            if (!j || !j.success) {
              alert('Gagal menghapus: ' + (j?.message || 'Unknown error'));
              return;
            }
            await refreshBlacklistList();
          } catch (err) {
            alert('Gagal menghapus: ' + err.message);
          }
        };

        right.appendChild(btnRemove);
        el.appendChild(left);
        el.appendChild(right);
        container.appendChild(el);
      });
    }
  } catch (err) {
    if (container) container.innerHTML = `<div style="padding:12px; color:var(--text-danger);">Gagal memuat: ${err.message}</div>`;
  } finally {
    if (btn) {
      btn.innerText = '✅ Terupdate!';
      setTimeout(() => {
        btn.innerText = '🔄 Refresh';
        btn.disabled = false;
      }, 1000);
    }
  }
}

async function blacklistClear() {
  if (!confirm('Clear semua entri blacklist sementara?')) return;
  try {
    await authFetch('/api/blacklist/clear', { method: 'POST' }).then((r) => r.json());
    await refreshBlacklistList();
  } catch (err) {
    alert('Gagal clear: ' + err.message);
  }
}

window.refreshBlacklistList = refreshBlacklistList;

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
    fetchPaginatedSpikes(1);
    fetchPaginatedTrades(1);
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

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatCryptoPrice(val) {
  if (val === null || val === undefined || val === '') return '-';
  const num = Number(val);
  if (isNaN(num)) return String(val);
  if (num === 0) return '0.00';

  const abs = Math.abs(num);
  let decimals = 2;
  if (abs < 0.00001) decimals = 8;
  else if (abs < 0.001) decimals = 7;
  else if (abs < 0.1) decimals = 6;
  else if (abs < 1) decimals = 5;
  else if (abs < 10) decimals = 4;
  else if (abs < 100) decimals = 3;
  else decimals = 2;

  return num.toFixed(decimals);
}

function formatShortUsdt(num) {
  if (!num || isNaN(num)) return '0';
  const n = Number(num);
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toFixed(0);
}

function formatDateTime(val, splitLines = false) {
  if (!val) return '-';
  let ts = val;
  if (typeof val === 'string' && !isNaN(Number(val))) {
    ts = Number(val);
  }
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(val);

  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());

  if (splitLines) {
    return `<div class="datetime-cell"><span class="datetime-date">${day}/${month}/${year}</span><span class="datetime-time text-muted">${hours}:${minutes}:${seconds}</span></div>`;
  }
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function formatDurationHms(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds || 0)));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h} jam ${m} menit ${s} detik`;
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
    const totalSpikes = typeof status.totalSpikes === 'number' && status.totalSpikes > 0
      ? status.totalSpikes
      : (status.recentSpikes?.length || 0);
    radarState.total = totalSpikes;
    radarState.totalPages = Math.ceil(totalSpikes / radarState.limit) || 1;
    renderSpikesTable((status.recentSpikes || []).slice(0, radarState.limit));
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
      const holdCountdown = formatDurationHms(remainingSeconds);
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

      const isDualTp = currentConfig?.exit?.partialTpEnabled;
      const tp1RatioPct = Math.round((currentConfig?.exit?.partialTpRatio || 0.7) * 100);
      const tp2RatioPct = 100 - tp1RatioPct;

      let tpStatusBadge = '';
      let tpBannerHtml = '';
      let slMetricLabel = `Hard SL (+${currentConfig?.exit?.hardStopLossPct || 4.5}%)`;
      let slMetricHtml = `<span class="text-red">$${formatCryptoPrice(pos.hardSlPrice)}</span>`;
      let tpMetricLabel = `Target TP (-${currentConfig?.exit?.takeProfitPct || 1.2}%)`;
      let tpMetricHtml = `<span class="text-green">$${formatCryptoPrice(pos.targetTpPrice)}</span>`;

      if (pos.partialTpDone) {
        tpStatusBadge = `<span class="badge-tp-stage-done" style="background: rgba(48, 209, 88, 0.15); border: 1px solid rgba(48, 209, 88, 0.4); color: #30d158; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px;">✅ TP 1 HIT (+${tp1RatioPct}%) • 🛡️ AUTO BEP AKTIF</span>`;
        tpBannerHtml = `
          <div style="background: linear-gradient(90deg, rgba(48, 209, 88, 0.12), rgba(0, 240, 255, 0.08)); border: 1px dashed rgba(48, 209, 88, 0.35); border-radius: 6px; padding: 7px 12px; margin: 10px 0 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 11.5px;">
            <span style="color: #30d158; font-weight: 600;">
              🎯 <b>TP 1 SUDAH TERISI:</b> Cuan Maker <b>+$${(pos.partialRealizedPnl || 0).toFixed(2)} USDT</b> aman di dompet!
            </span>
            <span style="color: #00f0ff; font-weight: 600;">
              🛡️ Sisa <b>${pos.totalQty} koin (${tp2RatioPct}%)</b> memburu TP 2 dengan <b>Auto BEP @ $${formatCryptoPrice(pos.hardSlPrice)}</b>
            </span>
          </div>
        `;
        slMetricLabel = `🛡️ Stop Loss (Auto BEP)`;
        slMetricHtml = `<span style="color: #00f0ff; font-weight: 600;">$${formatCryptoPrice(pos.hardSlPrice)} <small style="color: #30d158;">(Zero Risk)</small></span>`;
        tpMetricLabel = `🎯 Target TP 2 (Sisa ${tp2RatioPct}%)`;
        tpMetricHtml = `<span class="text-green"><b>$${formatCryptoPrice(pos.targetTpPrice)}</b></span>`;
      } else if (isDualTp) {
        tpStatusBadge = `<span class="badge-tp-stage-dual" style="background: rgba(0, 240, 255, 0.1); border: 1px solid rgba(0, 240, 255, 0.3); color: #00f0ff; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px;">🎯 Dual TP: ${tp1RatioPct}% / ${tp2RatioPct}%</span>`;
        tpMetricLabel = `🎯 Target TP 1 (${tp1RatioPct}%)`;
        const tp2DisplayPrice = pos.targetTp2Price ? formatCryptoPrice(pos.targetTp2Price) : formatCryptoPrice(pos.avgEntryPrice * (1 - (currentConfig?.exit?.takeProfit2Pct || (currentConfig?.exit?.takeProfitPct || 1.2) * 2) / 100));
        tpMetricHtml = `<span class="text-green"><b>$${formatCryptoPrice(pos.targetTpPrice)}</b> <small style="color: #00f0ff;">(TP2: $${tp2DisplayPrice})</small></span>`;
      }

      const layersHtml = (pos.layers || [])
        .map((l) => {
          let timeTag = '';
          if (l.filledAt) {
            const dt = new Date(l.filledAt);
            timeTag = ` • ⏱️${dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`;
          }
          const volUsdt = l.volumeUsdt !== undefined ? Number(l.volumeUsdt) : ((Number(l.price || 0) * Number(l.qty || 0)) || (Number(l.marginUsdt || 0) * Number(pos.leverage || 5)));
          const vol24hTag = l.vol24hUsdt ? ` • 🌐Vol24h: $${formatShortUsdt(l.vol24hUsdt)}` : '';
          const rsiTag = l.rsi !== undefined ? ` • 📊RSI ${Number(l.rsi).toFixed(1)}` : '';
          return `<span class="layer-badge ${l.status.toLowerCase()}">L#${l.layerIndex}: $${formatCryptoPrice(l.price)} (${l.status}${timeTag} • $${Number(l.marginUsdt || 0).toFixed(2)} Mgn • $${volUsdt.toFixed(1)} Vol${vol24hTag}${rsiTag})</span>`;
        })
        .join('');

      return `
        <div class="position-card">
          <div class="pos-header">
            <div class="pos-symbol">
              ${pos.symbol}
              <span class="badge-side ${pos.side === 'LONG' ? 'long' : 'short'}">${pos.side || 'SHORT'} ${pos.leverage}x</span>
              ${pos.marketSnapshot?.vol24hUsdt ? `<span class="badge-vol24h" style="font-size: 10px;" title="Volume 24 Jam (Turnover USDT)">🌐 Vol 24h: <b>$${formatShortUsdt(pos.marketSnapshot.vol24hUsdt)}</b></span>` : ''}
              ${pos.marketSnapshot?.rsi1m !== undefined ? `<span class="badge-rsi ${pos.marketSnapshot.rsi1m >= 80 ? 'rsi-hot' : pos.marketSnapshot.rsi1m >= 70 ? 'rsi-warm' : ''}" style="font-size: 10px;" title="RSI 1m saat Entry">📊 RSI ${Number(pos.marketSnapshot.rsi1m).toFixed(1)}</span>` : ''}
              ${tpStatusBadge}
              <span class="badge-margin-tag">💰 Margin: $${(pos.totalMarginUsed || 0).toFixed(2)} / $${currentConfig?.grid?.maxTotalMarginPerCoin || 35} USDT</span>
            </div>
            <div style="display: flex; align-items: center; gap: 10px;">
              <div class="pos-pnl">
                <div class="pos-pnl-val ${pnlColor}">${pnlSign}$${(pos.unrealizedPnl || 0).toFixed(2)}</div>
                <div class="pos-pnl-pct ${pnlColor}">${pnlSign}${(pos.pnlPct || 0).toFixed(1)}%</div>
                ${pos.partialTpDone && (pos.partialRealizedPnl || 0) > 0 ? `<div style="font-size: 10px; color: #30d158; text-align: right; font-weight: 600;">+ Cuan TP1: +$${(pos.partialRealizedPnl || 0).toFixed(2)}</div>` : ''}
              </div>
              <button class="btn btn-sm btn-danger" onclick="manualClosePosition('${pos.symbol}')" title="Tutup posisi ini seketika di harga pasar">
                ⚡ Tutup
              </button>
            </div>
          </div>

          ${tpBannerHtml}

          <div class="pos-metrics">
            <div class="pos-metric-item">
              <small>Entry Rata-rata</small>
              <span>$${formatCryptoPrice(pos.avgEntryPrice)}</span>
            </div>
            <div class="pos-metric-item">
              <small>Harga Saat Ini</small>
              <span>$${formatCryptoPrice(pos.currentPrice)}</span>
            </div>
            <div class="pos-metric-item">
              <small>Margin Terpakai</small>
              <span class="text-cyan"><b>$${(pos.totalMarginUsed || 0).toFixed(2)} USDT</b> <small class="text-muted">(${pos.totalQty} koin)</small></span>
            </div>
            <div class="pos-metric-item">
              <small>${tpMetricLabel}</small>
              ${tpMetricHtml}
            </div>
            <div class="pos-metric-item">
              <small>${slMetricLabel}</small>
              ${slMetricHtml}
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
      if (data.simStats) {
        updateRadarSimSummaryUI(data.simStats);
      }
      updateRadarPaginationUI();
    }
  } catch (e) {
    console.warn('Gagal memuat radar spikes:', e);
  }
}

function updateRadarSimSummaryUI(stats) {
  const savedEl = document.getElementById('sim-saved-sl');
  const missedEl = document.getElementById('sim-missed-tp');
  const rateEl = document.getElementById('sim-defense-rate');
  const activeEl = document.getElementById('sim-active-count');

  const saved = Number(stats?.savedSlCount || 0);
  const missed = Number(stats?.missedTpCount || 0);
  const active = Number(stats?.trackingCount || 0);
  const totalEvaluated = saved + missed;
  const rate = totalEvaluated > 0 ? ((saved / totalEvaluated) * 100).toFixed(1) : '0';

  if (savedEl) savedEl.innerText = `${saved} Koin`;
  if (missedEl) missedEl.innerText = `${missed} Koin`;
  if (rateEl) rateEl.innerText = `${rate}%`;
  if (activeEl) activeEl.innerText = `${active} Koin`;
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

let currentLoadedSpikes = [];

function renderSpikesTable(spikes) {
  currentLoadedSpikes = spikes || [];
  const tbody = document.getElementById('spike-table-body');
  if (!spikes || spikes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">Belum ada lonjakan harga yang melewati ambang batas.</td></tr>`;
    return;
  }

  tbody.innerHTML = spikes
    .slice(0, radarState.limit)
    .map((s) => {
      const timeStr = formatDateTime(s.timestamp, true);
      let statusBadge = '';
      if (s.status === 'EXECUTING') {
        statusBadge = `<span class="badge-radar-status sniped">SNIPED 🎯</span>`;
      } else if (s.status === 'SKIPPED') {
        const reason = s.skipReason || 'Dilewati filter proteksi';
        statusBadge = `
          <div class="radar-status-cell">
            <span class="badge-radar-status skipped" title="${escapeHtml(reason)}">DILEWATI 🛡️</span>
            <span class="radar-skip-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>
          </div>
        `;
      } else {
        statusBadge = `<span class="badge-radar-status pending">TERDETEKSI ⏳</span>`;
      }

      let simBadge = '<span class="text-muted" style="font-size: 11px;">-</span>';
      if (s.status === 'EXECUTING') {
        simBadge = '<span class="text-muted" style="font-size: 11px;">(Dieksekusi)</span>';
      } else if (s.status === 'SKIPPED' && s.simResult) {
        const sim = s.simResult;
        const pnl = Number(sim.simulatedPnlPct || 0);
        const pnlSign = pnl >= 0 ? '+' : '';
        const pnlStr = `${pnlSign}${pnl.toFixed(2)}%`;

        if (sim.outcome === 'SAVED_SL') {
          simBadge = `
            <button type="button" class="badge-sim-outcome saved" onclick="openSpikeSimModal('${escapeHtml(s.id)}')" title="Klik untuk rincian: Filter berhasil menyelamatkan modal dari Stop Loss!">
              🛡️ Selamat SL (${pnlStr})
            </button>
          `;
        } else if (sim.outcome === 'MISSED_TP') {
          simBadge = `
            <button type="button" class="badge-sim-outcome missed" onclick="openSpikeSimModal('${escapeHtml(s.id)}')" title="Klik untuk rincian: Koin berbalik arah dan menyentuh Target TP.">
              💸 Terlewat TP (${pnlStr})
            </button>
          `;
        } else if (sim.outcome === 'TIMEOUT') {
          simBadge = `
            <button type="button" class="badge-sim-outcome timeout" onclick="openSpikeSimModal('${escapeHtml(s.id)}')" title="Klik untuk rincian: Pemantauan 30m selesai tanpa kena TP/SL.">
              ⏱️ Timeout (${pnlStr})
            </button>
          `;
        } else {
          simBadge = `
            <button type="button" class="badge-sim-outcome tracking" onclick="openSpikeSimModal('${escapeHtml(s.id)}')" title="Klik untuk rincian: Pemantauan real-time sedang berjalan.">
              ⏳ Pemantauan (${sim.durationMinutes || 0}m | ${pnlStr})
            </button>
          `;
        }
      }

      const startPrice = Number(s.startPrice || 0);
      const currPrice = Number(s.currentPrice || 0);
      const surgePct = Number(s.surgePct || 0);

      return `
        <tr>
          <td>${timeStr}</td>
          <td>
            <b>${escapeHtml(s.symbol)}</b>
            <span class="mobile-spike-sub">$${formatCryptoPrice(startPrice)} ➜ $${formatCryptoPrice(currPrice)}</span>
          </td>
          <td>$${formatCryptoPrice(startPrice)}</td>
          <td>$${formatCryptoPrice(currPrice)}</td>
          <td class="text-green"><b>+${surgePct.toFixed(2)}%</b></td>
          <td>${statusBadge}</td>
          <td>${simBadge}</td>
        </tr>
      `;
    })
    .join('');
}

function openSpikeSimModal(spikeId) {
  const s = currentLoadedSpikes.find((x) => String(x.id) === String(spikeId));
  if (!s || !s.simResult) return;

  const sim = s.simResult;
  const modal = document.getElementById('spike-sim-modal');
  const titleEl = document.getElementById('spike-sim-title');
  const badgeEl = document.getElementById('spike-sim-badge');
  const bodyEl = document.getElementById('spike-sim-body');
  if (!modal || !bodyEl) return;

  const pnl = Number(sim.simulatedPnlPct || 0);
  const pnlSign = pnl >= 0 ? '+' : '';
  const pnlStr = `${pnlSign}${pnl.toFixed(2)}%`;

  let outcomeClass = 'tracking';
  let outcomeTitle = '⏳ Simulasi Pemantauan Sedang Berjalan';
  let bannerClass = 'tracking';
  let bannerText = '';

  if (sim.outcome === 'SAVED_SL') {
    outcomeClass = 'saved';
    outcomeTitle = '🛡️ Penyelamatan Modal Sukses (Selamat dari SL)';
    bannerClass = 'saved';
    bannerText = `<b>🛡️ Filter Berhasil Melindungi Modal!</b><br>
    Setelah lonjakan spike ditolak, harga koin justru terus melonjak naik hingga menyentuh batas <b>Hard Stop Loss</b> ($${formatCryptoPrice(sim.hardSlPrice)}). 
    Keputusan filter membatalkan trade terbukti tepat dan menyelamatkan akun dari kerugian <b>${pnlStr}</b>.`;
  } else if (sim.outcome === 'MISSED_TP') {
    outcomeClass = 'missed';
    outcomeTitle = '💸 Peluang Profit Terlewat (Kena TP)';
    bannerClass = 'missed';
    bannerText = `<b>💸 Peluang Profit Terlewat!</b><br>
    Setelah lonjakan spike ditolak, harga koin berhasil memantul turun dan menyentuh <b>Target Take Profit</b> ($${formatCryptoPrice(sim.targetTpPrice)}) tanpa tersentuh Stop Loss.
    Jika dieksekusi, trade ini akan menghasilkan estimasi profit <b>${pnlStr}</b>. Parameter filter mungkin dapat sedikit dilonggarkan jika koin ini sering lolos.`;
  } else if (sim.outcome === 'TIMEOUT') {
    outcomeClass = 'timeout';
    outcomeTitle = '⏱️ Batas Waktu 30 Menit Tercapai';
    bannerClass = 'timeout';
    bannerText = `<b>⏱️ Pemantauan 30 Menit Selesai</b><br>
    Selama 30 menit pasca-lonjakan, harga bergerak konsolidasi tanpa menyentuh TP maupun SL. Estimasi PnL mengambang di menit ke-30 adalah <b>${pnlStr}</b>.`;
  } else {
    bannerText = `<b>⏳ Simulasi Sedang Berlangsung</b><br>
    Sedang memantau pergerakan harga live Binance secara real-time (Berjalan: <b>${sim.durationMinutes || 0} menit</b>). PnL mengambang saat ini: <b>${pnlStr}</b>.`;
  }

  if (titleEl) titleEl.innerText = `🔬 Simulasi Koin Ditolak: ${s.symbol}`;
  if (badgeEl) {
    badgeEl.className = `badge-sim-outcome ${outcomeClass}`;
    badgeEl.innerText = `${outcomeTitle} (${pnlStr})`;
  }

  const entry = Number(sim.hypotheticalEntryPrice || 0);
  const tp = Number(sim.targetTpPrice || 0);
  const sl = Number(sim.hardSlPrice || 0);
  const high = Number(sim.highestPrice || 0);
  const low = Number(sim.lowestPrice || 0);
  const highDiff = Number(sim.highestDiffPct || 0);
  const lowDiff = Number(sim.lowestDiffPct || 0);
  const highSign = highDiff >= 0 ? '+' : '';
  const lowSign = lowDiff >= 0 ? '+' : '';

  const params = s.paramsSnapshot || {};
  const tpParam = params.takeProfitPct ?? '-';
  const slParam = params.hardStopLossPct ?? '-';

  bodyEl.innerHTML = `
    <div class="sim-insight-banner ${bannerClass}">
      <div>${bannerText}</div>
    </div>

    <div style="background: rgba(0,0,0,0.25); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 12px; margin-bottom: 16px;">
      <div style="font-size: 11px; color: var(--text-muted); font-weight: 700; text-transform: uppercase; margin-bottom: 4px;">Alasan Koin Ditolak / Dilewati:</div>
      <div style="font-size: 13px; color: #ffb84d; font-weight: 600;">${escapeHtml(s.skipReason || 'Filter Proteksi')}</div>
      <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Lonjakan terdeteksi: <b>+${Number(s.surgePct || 0).toFixed(2)}%</b> dalam ${s.lookbackSeconds || 5}s pada ${formatDateTime(s.timestamp, true)}</div>
    </div>

    <div class="td-section-title">📊 Parameter & Level Simulasi Saat Kejadian</div>
    <div class="td-post-exit-grid" style="margin-bottom: 16px;">
      <div class="td-pe-stat">
        <div class="pe-label">Harga Masuk Hipotetis (SHORT)</div>
        <div class="pe-val" style="color: var(--color-cyan);">$${formatCryptoPrice(entry)}</div>
      </div>
      <div class="td-pe-stat">
        <div class="pe-label">Target Take Profit (${tpParam}%)</div>
        <div class="pe-val" style="color: var(--color-green);">$${formatCryptoPrice(tp)}</div>
      </div>
      <div class="td-pe-stat">
        <div class="pe-label">Batas Hard Stop Loss (${slParam}%)</div>
        <div class="pe-val" style="color: var(--color-red);">$${formatCryptoPrice(sl)}</div>
      </div>
      <div class="td-pe-stat">
        <div class="pe-label">Hasil Simulasi PnL</div>
        <div class="pe-val" style="color: ${pnl >= 0 ? 'var(--color-green)' : 'var(--color-red)'}; font-weight: 700;">
          ${pnlStr}
        </div>
      </div>
    </div>

    <div class="td-section-title">⏱️ Ekstrem Pergerakan Harga Pasca-Penolakan</div>
    <div class="td-post-exit-grid">
      <div class="td-pe-stat">
        <div class="pe-label">Puncak Tertinggi (MAE / Pompa)</div>
        <div class="pe-val" style="color: ${highDiff > 0 ? 'var(--color-gold)' : 'var(--text-main)'};">
          $${formatCryptoPrice(high)}
          <small class="pe-diff" style="color: ${highDiff > 0 ? 'var(--color-red)' : 'var(--text-muted)'};">(${highSign}${highDiff.toFixed(2)}%)</small>
        </div>
      </div>
      <div class="td-pe-stat">
        <div class="pe-label">Penurunan Terdalam (MFE / Reversal)</div>
        <div class="pe-val" style="color: ${lowDiff < 0 ? 'var(--color-green)' : 'var(--text-main)'};">
          $${formatCryptoPrice(low)}
          <small class="pe-diff" style="color: ${lowDiff < 0 ? 'var(--color-green)' : 'var(--text-muted)'};">(${lowSign}${lowDiff.toFixed(2)}%)</small>
        </div>
      </div>
      <div class="td-pe-stat">
        <div class="pe-label">Durasi Pengamatan</div>
        <div class="pe-val" style="font-size: 13px; color: var(--color-cyan);">
          ${sim.durationMinutes || 0} Menit
        </div>
      </div>
      <div class="td-pe-stat">
        <div class="pe-label">Status Evaluasi</div>
        <div class="pe-val" style="font-size: 12px; color: ${sim.isComplete ? 'var(--color-green)' : 'var(--color-gold)'};">
          ${sim.isComplete ? '✅ Selesai' : '⏳ Berjalan'}
        </div>
      </div>
    </div>
  `;

  modal.classList.add('active');
}

function closeSpikeSimModal() {
  const modal = document.getElementById('spike-sim-modal');
  if (modal) modal.classList.remove('active');
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
    .map((t, idx) => {
      const realizedPnl = Number(t.realizedPnl || 0);
      const pnlPct = Number(t.pnlPct || 0);
      const isWin = realizedPnl >= 0;
      const pnlColor = isWin ? 'text-green' : 'text-red';
      const sign = isWin ? '+' : '';
      const layerBadge = t.layersFilled
        ? `<span class="tag-counter" style="font-size: 9.5px; padding: 1px 5px; margin-left: 4px;" title="Layer yang terserap">L#${t.layersFilled}</span>`
        : '';

      const feeNum = t.fee !== undefined && t.fee !== null ? Number(t.fee) : null;
      const grossPnlNum = t.grossPnl !== undefined && t.grossPnl !== null ? Number(t.grossPnl) : null;

      const feeIndicator = (feeNum && feeNum > 0)
        ? `<br><span style="font-size: 10px; color: var(--color-text-muted);" title="Gross PnL: ${grossPnlNum !== null ? (grossPnlNum >= 0 ? '+' : '') + '$' + grossPnlNum.toFixed(2) : '-'} | Fee: -$${feeNum.toFixed(3)}">Fee: -$${feeNum.toFixed(3)}</span>`
        : '';

      const safeTradeId = t.id ? String(t.id).replace(/'/g, "\\'") : '';

      return `
        <tr class="clickable-trade-row" onclick="openTradeDetailModal('${safeTradeId}', ${idx})" title="Klik untuk melihat rincian trade & perbandingan parameter" style="cursor: pointer;">
          <td>${formatDateTime(t.timestamp || t.closedAt, true)}</td>
          <td><b>${t.symbol}</b> <span class="badge-side ${t.side === 'LONG' ? 'long' : 'short'}">${t.side || 'SHORT'}</span> ${layerBadge}</td>
          <td><span class="text-cyan font-mono"><b>$${Number(t.marginUsed || 0).toFixed(2)}</b></span></td>
          <td>$${formatCryptoPrice(t.entryPrice)} ➜ $${formatCryptoPrice(t.exitPrice)}</td>
          <td><b>${formatDurationHms(t.durationSeconds)}</b></td>
          <td class="${pnlColor}"><b>${sign}$${realizedPnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)</b>${feeIndicator}</td>
          <td>
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
              <small class="${t.exitReason === 'HARD_STOP_LOSS' ? 'text-red' : t.exitReason === 'FEE_LOSS_EXIT' ? 'text-gold' : 'text-green'}"><b>${
                t.exitReason === 'TAKE_PROFIT' ? '🎯 TP' :
                t.exitReason === 'TRAILING_TP' ? '📈 Trailing TP' :
                t.exitReason === 'BEP_DEFENSE' ? '🛡️ BEP Defense' :
                t.exitReason === 'HARD_STOP_LOSS' ? '🛑 Hard SL' :
                t.exitReason === 'FEE_LOSS_EXIT' ? '💸 TP Minus Fee' :
                t.exitReason === 'TIME_LIMIT_EXIT' ? '⏰ Batas Waktu' :
                t.exitReason === 'EARLY_MOMENTUM_EXIT' ? '⚠️ Early Momentum' :
                t.exitReason === 'MANUAL_CLOSE' ? '⚡ Manual' :
                (t.exitReason || '-')
              }</b></small>
              <button type="button" class="btn btn-xs" onclick="event.stopPropagation(); openTradeDetailModal('${safeTradeId}', ${idx})" style="font-size: 10px; padding: 2px 7px; cursor: pointer; touch-action: manipulation;">🔍 Detail</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function renderPostExitSnapshotHtml(t) {
  const snap = t.postExit30m;
  if (!snap) {
    return `
      <div class="td-post-exit-box">
        <div class="td-post-exit-header">
          <div class="td-post-exit-title">⏱️ Snapshot Harga Pasca-Exit (Jendela 30 Menit)</div>
          <span class="badge-post-status tracking">⏳ Mengambil Data Binance...</span>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); font-style: italic;">
          Sedang mengambil data pergerakan 30 candle 1-menit dari Binance Futures...
        </div>
      </div>
    `;
  }

  const isComplete = !!snap.isComplete;
  const minutes = snap.minutesTracked || 0;
  const high = Number(snap.highestPrice || 0);
  const low = Number(snap.lowestPrice || 0);
  const highDiff = Number(snap.highestDiffPct || 0);
  const lowDiff = Number(snap.lowestDiffPct || 0);

  const highSign = highDiff >= 0 ? '+' : '';
  const lowSign = lowDiff >= 0 ? '+' : '';

  let insightText = '';
  if (lowDiff <= -1.0) {
    insightText = `📉 <b>MFE (Favorable)</b>: Pasca-exit, harga sempat turun hingga <b>${lowSign}${lowDiff.toFixed(2)}%</b> ($${formatCryptoPrice(low)}). Terdapat peluang profit lebih jika TP diperlebar.`;
  } else if (highDiff >= 1.5) {
    insightText = `🛡️ <b>MAE (Adverse)</b>: Pasca-exit, harga sempat melonjak <b>${highSign}${highDiff.toFixed(2)}%</b> ($${formatCryptoPrice(high)}). Keputusan exit berhasil menyelamatkan modal dari floating loss lebih dalam!`;
  } else {
    insightText = `⚖️ Pasca-exit, harga bergerak dalam rentang wajar (High: ${highSign}${highDiff.toFixed(2)}%, Low: ${lowSign}${lowDiff.toFixed(2)}%) di sekitar harga exit.`;
  }

  return `
    <div class="td-post-exit-box">
      <div class="td-post-exit-header">
        <div class="td-post-exit-title">⏱️ Snapshot Harga Pasca-Exit (Jendela 30 Menit)</div>
        <span class="badge-post-status ${isComplete ? 'complete' : 'tracking'}">
          ${isComplete ? '✅ Pemantauan 30m Selesai' : `⏳ Sedang Berjalan (${minutes} / 30 Menit)`}
        </span>
      </div>
      <div class="td-post-exit-grid">
        <div class="td-pe-stat">
          <div class="pe-label">Harga Tertinggi (Peak High)</div>
          <div class="pe-val" style="color: ${highDiff > 0 ? 'var(--color-gold)' : 'var(--text-main)'};">
            $${formatCryptoPrice(high)}
            <small class="pe-diff" style="color: ${highDiff > 0 ? 'var(--color-red)' : 'var(--text-muted)'};">(${highSign}${highDiff.toFixed(2)}%)</small>
          </div>
        </div>
        <div class="td-pe-stat">
          <div class="pe-label">Harga Terendah (Deep Low)</div>
          <div class="pe-val" style="color: ${lowDiff < 0 ? 'var(--color-green)' : 'var(--text-main)'};">
            $${formatCryptoPrice(low)}
            <small class="pe-diff" style="color: ${lowDiff < 0 ? 'var(--color-green)' : 'var(--text-muted)'};">(${lowSign}${lowDiff.toFixed(2)}%)</small>
          </div>
        </div>
        <div class="td-pe-stat">
          <div class="pe-label">Jendela Pengamatan</div>
          <div class="pe-val" style="font-size: 12px; color: var(--color-cyan);">
            ${minutes} Menit Candle 1m
          </div>
        </div>
        <div class="td-pe-insight">
          ${insightText}
        </div>
      </div>
    </div>
  `;
}

function openTradeDetailModal(tradeId, tradeIndex) {
  try {
    let t = null;
    if (tradeId && tradeId !== 'undefined' && tradeId !== 'null') {
      t = recentClosedTrades.find((x) => String(x.id) === String(tradeId));
    }
    if (!t && tradeIndex !== undefined && recentClosedTrades[tradeIndex]) {
      t = recentClosedTrades[tradeIndex];
    }
    if (!t && tradeId) {
      t = recentClosedTrades.find((x) => String(x.symbol).toUpperCase() === String(tradeId).toUpperCase());
    }
    if (!t) {
      console.warn('[Modal] Trade tidak ditemukan:', { tradeId, tradeIndex, count: recentClosedTrades.length });
      return;
    }
    selectedTradeForDetail = t;

    const realizedPnl = Number(t.realizedPnl || 0);
    const pnlPct = Number(t.pnlPct || 0);
    const isWin = realizedPnl >= 0;
    const pnlColor = isWin ? 'text-green' : 'text-red';
    const sign = isWin ? '+' : '';

    // Header Title & Badge
    const titleEl = document.getElementById('td-title');
    if (titleEl) titleEl.innerText = `🔍 Detail Trade: ${t.symbol} SHORT (${t.isPaper ? 'Paper' : 'Live'})`;
    const badge = document.getElementById('td-pnl-badge');
    if (badge) {
      badge.className = `badge-mode ${isWin ? 'live' : 'paper'}`;
      badge.innerText = `${sign}$${realizedPnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`;
    }

    // Fallback snapshot jika trade lama belum memiliki snapshot
    let snap = t.paramsSnapshot;
    if (typeof snap === 'string') {
      try { snap = JSON.parse(snap); } catch (_) { snap = null; }
    }
    snap = snap || {
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
    const currRisk = curr.risk || {};

    console.log('[TradeDetail] currentConfig:', currentConfig ? 'LOADED' : 'NULL/UNDEFINED');
    console.log('[TradeDetail] snap:', snap);
    console.log('[TradeDetail] currGrid:', currGrid);
    console.log('[TradeDetail] currExit:', currExit);

    let diffCount = 0;
    let totalParamCount = 0;

    // Helper formatters
    const formatRatioPct = (v) => {
      if (v === undefined || v === null) return '-';
      const num = Number(v);
      return (num <= 1 ? Math.round(num * 100) : Math.round(num)) + '%';
    };
    const formatVolumeUsdt = (v) => {
      if (v === undefined || v === null) return '-';
      const num = Number(v);
      return num > 0 ? num.toLocaleString('en-US') + ' USDT' : '0 (Nonaktif)';
    };
    const formatZeroDisabled = (unit) => (v) => {
      if (v === undefined || v === null) return '-';
      return Number(v) === 0 ? '0 (Nonaktif)' : `${v}${unit}`;
    };

    // Helper render baris perbandingan
    const renderCompareRow = (name, valSnap, valCurr, unit = '', formatFn = null) => {
      totalParamCount++;
      const hasSnap = valSnap !== undefined && valSnap !== null;
      const hasCurr = valCurr !== undefined && valCurr !== null;

      let displaySnap = '-';
      let displayCurr = '-';

      if (typeof formatFn === 'function') {
        displaySnap = hasSnap ? formatFn(valSnap) : '-';
        displayCurr = hasCurr ? formatFn(valCurr) : '-';
      } else if (typeof valSnap === 'boolean' || typeof valCurr === 'boolean') {
        const formatBool = (v) => (v === true ? 'Aktif (ON)' : v === false ? 'Nonaktif (OFF)' : '-');
        displaySnap = hasSnap ? formatBool(valSnap) : '-';
        displayCurr = hasCurr ? formatBool(valCurr) : '-';
      } else {
        displaySnap = hasSnap ? `${valSnap}${unit}` : '-';
        displayCurr = hasCurr ? `${valCurr}${unit}` : '-';
      }

      let isSame = false;
      if (!hasSnap && !hasCurr) {
        isSame = true;
      } else if (!hasSnap || !hasCurr) {
        isSame = false;
      } else if (typeof valSnap === 'number' && typeof valCurr === 'number') {
        isSame = Math.abs(valSnap - valCurr) < 0.0001;
      } else if (typeof valSnap === 'boolean' || typeof valCurr === 'boolean') {
        isSame = Boolean(valSnap) === Boolean(valCurr);
      } else {
        isSame = String(valSnap).trim().toLowerCase() === String(valCurr).trim().toLowerCase();
      }

      let statusBadge = '';
      if (!hasSnap) {
        statusBadge = `<span class="badge-same" style="opacity: 0.65;" title="Parameter ini belum tersimpan pada log trade lama">N/A</span>`;
      } else if (isSame) {
        statusBadge = `<span class="badge-same">Sama</span>`;
      } else {
        diffCount++;
        statusBadge = `<span class="badge-diff">Berbeda</span>`;
      }

      const valCurrStyle = (!isSame && hasSnap) ? 'color: var(--color-cyan); font-weight: 700;' : '';

      return `
        <tr class="${!isSame && hasSnap ? 'row-diff' : 'row-same'}">
          <td class="param-name">${name}</td>
          <td><b>${displaySnap}</b></td>
          <td style="${valCurrStyle}">${displayCurr}</td>
          <td>${statusBadge}</td>
        </tr>
      `;
    };

    const renderGroupHeader = (title) => `
      <tr class="param-group-header">
        <td colspan="4">${title}</td>
      </tr>
    `;

    // Layers breakdown
    let layers = t.layersDetail;
    if (typeof layers === 'string') {
      try { layers = JSON.parse(layers); } catch (_) { layers = []; }
    }

    let layersHtml = '';
    if (Array.isArray(layers) && layers.length > 0) {
      let prevFilledTime = null;
      layersHtml = `
        <div class="td-section-title">🧱 Rincian Layer Jaring Terisi (${t.layersFilled || 'Grid'})</div>
        <div class="td-layers-wrap">
          ${layers
            .map((l, idx) => {
              const priceNum = Number(l.price || 0);
              const marginNum = Number(l.marginUsdt || 0);
              const layerIdx = l.layerIndex !== undefined ? l.layerIndex : idx;
              const statusStr = l.status || 'PENDING';

              // Hitung waktu terisi & jeda waktu antar layer
              let timeHtml = '';
              if (l.filledAt) {
                const filledDate = new Date(l.filledAt);
                const timeStr = filledDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                let diffStr = '';
                if (prevFilledTime && l.filledAt >= prevFilledTime) {
                  const diffSec = Math.round((l.filledAt - prevFilledTime) / 1000);
                  if (diffSec < 60) {
                    diffStr = `(+${diffSec}s)`;
                  } else {
                    const m = Math.floor(diffSec / 60);
                    const s = diffSec % 60;
                    diffStr = `(+${m}m ${s}s)`;
                  }
                } else if (layerIdx === 0 || idx === 0) {
                  diffStr = '(Entry)';
                }
                timeHtml = `<span class="td-layer-time">⏱️ ${timeStr} <small style="opacity: 0.85;">${diffStr}</small></span>`;
                prevFilledTime = l.filledAt;
              } else if (statusStr === 'FILLED') {
                timeHtml = `<span style="font-size: 10.5px; color: var(--text-muted);">⏱️ Terisi</span>`;
              }

              const volUsdt = l.volumeUsdt !== undefined && l.volumeUsdt !== null
                ? Number(l.volumeUsdt)
                : ((priceNum * Number(l.qty || 0)) || (marginNum * Number(snap.leverage || 5)));

              const layerVol24h = l.vol24hUsdt || (t.marketSnapshot && t.marketSnapshot.vol24hUsdt) || (snap.marketSnapshot && snap.marketSnapshot.vol24hUsdt);
              let vol24hHtml = '';
              if (layerVol24h) {
                const fullVol24Str = Number(layerVol24h).toLocaleString('en-US');
                vol24hHtml = `<span class="badge-vol24h" title="Vol. 24 Jam(USDT): $${fullVol24Str} USDT saat layer terisi">🌐 Vol 24h: <b>$${formatShortUsdt(layerVol24h)} USDT</b></span>`;
              }

              let rsiHtml = '';
              if (l.rsi !== undefined && l.rsi !== null) {
                const rVal = Number(l.rsi);
                const rClass = rVal >= 80 ? 'rsi-hot' : rVal >= 70 ? 'rsi-warm' : '';
                rsiHtml = `<span class="badge-rsi ${rClass}" title="RSI 14 (1m) saat layer terisi">📊 RSI: <b>${rVal.toFixed(1)}</b></span>`;
              }

              let vol1mHtml = '';
              if (l.marketVolume1mUsdt) {
                vol1mHtml = `<span class="badge-vol1m" title="Volume pasar koin 1m saat layer terisi">🌊 Vol 1m: <b>$${formatShortUsdt(l.marketVolume1mUsdt)}</b></span>`;
              }

              return `
                <div class="td-layer-row ${statusStr === 'FILLED' ? 'filled' : ''}">
                  <span><b>Layer #${layerIdx}</b>: $${formatCryptoPrice(priceNum)}</span>
                  <span>Margin: $${marginNum.toFixed(2)} USDT</span>
                  <span>Vol Order: <b class="text-cyan">$${volUsdt.toFixed(2)}</b> USDT</span>
                  ${vol24hHtml}
                  ${rsiHtml}
                  ${vol1mHtml}
                  ${timeHtml}
                  <span class="${statusStr === 'FILLED' ? 'text-green' : 'text-muted'}"><b>[${statusStr}]</b></span>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    }

    const feeNum = t.fee !== undefined && t.fee !== null ? Number(t.fee) : null;
    const grossPnlNum = t.grossPnl !== undefined && t.grossPnl !== null ? Number(t.grossPnl) : null;
    const marginUsedNum = Number(t.marginUsed || 0);

    // Siapkan baris perbandingan parameter terlebih dahulu untuk menghitung diffCount
    const compareRowsHtml = `
      ${renderGroupHeader('🧱 Grid & Martingale')}
      ${renderCompareRow('Modal Per Layer (L0)', snap.marginPerLayerUsdt, currGrid.marginPerLayerUsdt, ' USDT')}
      ${renderCompareRow('Jumlah Layer Jaring', snap.totalLayers, currGrid.totalLayers, ' Lapis')}
      ${renderCompareRow('Jarak Antar Jaring (Spacing)', snap.layerSpacingPct, currGrid.layerSpacingPct, '%')}
      ${renderCompareRow('Pengali Martingale', snap.martingaleMultiplier, currGrid.martingaleMultiplier, 'x')}
      ${renderCompareRow('Maks Margin Per Koin', snap.maxTotalMarginPerCoin, currGrid.maxTotalMarginPerCoin, ' USDT')}
      ${renderCompareRow('Maks Koin Bersamaan', snap.maxConcurrentCoins, currGrid.maxConcurrentCoins, ' Koin')}

      ${renderGroupHeader('🎯 Exit & Take Profit / Stop Loss')}
      ${renderCompareRow('Target Take Profit', snap.takeProfitPct, currExit.takeProfitPct, '%')}
      ${renderCompareRow('Hard Stop Loss', snap.hardStopLossPct, currExit.hardStopLossPct, '%')}
      ${renderCompareRow('Maks Hold Time', snap.maxHoldMinutes, currExit.maxHoldMinutes, ' Menit')}
      ${renderCompareRow('Trailing TP (Callback)', snap.trailingTpEnabled, currExit.trailingTpEnabled)}
      ${renderCompareRow('Jarak Callback Trailing TP', snap.trailingCallbackPct, currExit.trailingCallbackPct, '%')}
      ${renderCompareRow('Stage 1 Partial TP', snap.partialTpEnabled, currExit.partialTpEnabled)}
      ${renderCompareRow('Porsi Pencairan TP 1', snap.partialTpRatio, currExit.partialTpRatio, '', formatRatioPct)}
      ${renderCompareRow('Target TP Tahap 2', snap.takeProfit2Pct, currExit.takeProfit2Pct, '%')}
      ${renderCompareRow('Trailing Stop Loss', snap.trailingSlEnabled, currExit.trailingSlEnabled)}
      ${renderCompareRow('Perpanjang Hold Saat Candle Merah', snap.extendHoldOnRedCandleEnabled, currExit.extendHoldOnRedCandleEnabled)}
      ${renderCompareRow('Durasi Ekstensi Candle Merah', snap.extendHoldSeconds, currExit.extendHoldSeconds, ' Detik')}
      ${renderCompareRow('Maks Ekstensi Candle Merah', snap.maxHoldExtensions, currExit.maxHoldExtensions, 'x')}
      ${renderCompareRow('Early Exit Momentum', snap.earlyExitMomentumEnabled, currExit.earlyExitMomentumEnabled)}
      ${renderCompareRow('Early Exit Min Layer Terisi', snap.earlyExitMinLayersPct, currExit.earlyExitMinLayersPct, '%')}
      ${renderCompareRow('Early Exit Ambang Rugi dari SL', snap.earlyExitMinLossSlPct, currExit.earlyExitMinLossSlPct, '%')}
      ${renderCompareRow('Early Exit Min Candle Bullish', snap.earlyExitMinBullishCandles, currExit.earlyExitMinBullishCandles, ' Candle')}
      ${renderCompareRow('Early Exit Kenaikan Min', snap.earlyExitMinRisePct, currExit.earlyExitMinRisePct, '%')}
      ${renderCompareRow('Cooldown Early Exit', snap.earlyExitCooldownMinutes, currExit.earlyExitCooldownMinutes, ' Menit')}
      ${renderCompareRow('Cooldown Hard SL', snap.hardStopCooldownMinutes, currExit.hardStopCooldownMinutes, ' Menit')}

      ${renderGroupHeader('🛡️ Emergency BEP Defense (Penyelamat Modal)')}
      ${renderCompareRow('Status BEP Defense', snap.bepDefenseEnabled, currExit.bepDefenseEnabled)}
      ${renderCompareRow('Proteksi BEP Layer Akhir', snap.bepFinalLayerEnabled, currExit.bepFinalLayerEnabled)}
      ${renderCompareRow('Paksa BEP di Layer', snap.bepMaxLayersTrigger, currExit.bepMaxLayersTrigger, '', (v) => Number(v) === 0 ? '0 (Hanya Layer Akhir / Velocity)' : `${v} Layer`)}
      ${renderCompareRow('BEP Fast Fill / Velocity', snap.bepFastFillEnabled, currExit.bepFastFillEnabled)}
      ${renderCompareRow('Batas Waktu Cepat (Velocity)', snap.bepFastFillSeconds, currExit.bepFastFillSeconds, ' Detik')}
      ${renderCompareRow('Min Layer Tertelan Kilat', snap.bepFastFillMinLayers, currExit.bepFastFillMinLayers, '', (v) => Number(v) === 0 ? '0 (Otomatis 65%)' : `${v} Layer`)}
      ${renderCompareRow('Buffer Profit BEP (Cover Fee)', snap.bepBufferPct, currExit.bepBufferPct, '%')}
      ${renderCompareRow('Cooldown Pasca BEP', snap.bepCooldownMinutes, currExit.bepCooldownMinutes, ' Menit')}

      ${renderGroupHeader('🔍 Scanner & Filter Spike')}
      ${renderCompareRow('Minimal Spike Lonjakan', snap.spikeMinPercent, currScanner.spikeMinPercent, '%')}
      ${renderCompareRow('Spike Lookback', snap.spikeLookbackSeconds, currScanner.spikeLookbackSeconds, ' Detik')}
      ${renderCompareRow('Volume Spike Multiplier', snap.volumeSpikeMultiplier, currScanner.volumeSpikeMultiplier, 'x')}
      ${renderCompareRow('Min Volume 24 Jam', snap.min24hVolumeUsdt, currScanner.min24hVolumeUsdt, '', formatVolumeUsdt)}
      ${renderCompareRow('Max Volume 24 Jam', snap.max24hVolumeUsdt, currScanner.max24hVolumeUsdt, '', formatVolumeUsdt)}
      ${renderCompareRow('Maksimal Spread Bid-Ask', snap.maxSpreadPct, currScanner.maxSpreadPct, '%')}
      ${renderCompareRow('Cooldown Antar Koin', snap.cooldownMinutes, currScanner.cooldownMinutes, ' Menit')}
      ${renderCompareRow('Filter Bottom Rejection (Sweep)', snap.skipBottomRejectionEnabled, currScanner.skipBottomRejectionEnabled)}
      ${renderCompareRow('Min Rentang Bottom Rejection', snap.bottomRejectionMinRangePct, currScanner.bottomRejectionMinRangePct, '%')}
      ${renderCompareRow('Rasio Ekor Bottom Rejection', snap.bottomRejectionWickRatio, currScanner.bottomRejectionWickRatio, 'x')}
      ${renderCompareRow('Filter Upper Wick Pullback', snap.upperWickPullbackEnabled, currScanner.upperWickPullbackEnabled)}
      ${renderCompareRow('Min Pullback dari Puncak', snap.upperWickPullbackMinPct, currScanner.upperWickPullbackMinPct, '%')}
      ${renderCompareRow('Batas Tunggu Pullback', snap.upperWickPullbackMaxWaitSeconds, currScanner.upperWickPullbackMaxWaitSeconds, ' Detik')}
      ${renderCompareRow('Cooldown Monster Pump', snap.upperWickCooldownMinutes, currScanner.upperWickCooldownMinutes, ' Menit')}
      ${renderCompareRow('Filter Jeda Tape / Trade Gap', snap.tradeGapFilterEnabled, currScanner.tradeGapFilterEnabled)}
      ${renderCompareRow('Maksimal Jeda Trade (Gap)', snap.maxTradeGapSeconds, currScanner.maxTradeGapSeconds, ' Detik')}
      ${renderCompareRow('Cooldown Koin Sepi (Gap)', snap.tradeGapCooldownMinutes, currScanner.tradeGapCooldownMinutes, ' Menit')}
      ${renderCompareRow('Batas Min RSI 1m (Anti-Oversold)', snap.minRsi1m, currScanner.minRsi1m, '', (v) => v ? `≥ ${v}` : 'Nonaktif')}
      ${renderCompareRow('Cooldown RSI Rendah', snap.minRsiCooldownMinutes, currScanner.minRsiCooldownMinutes, ' Menit')}
      ${renderCompareRow('Minimal Rasio Volume 1m', snap.minVolRatio, currScanner.minVolRatio, 'x', (v) => v ? `≥ ${v}x` : 'Nonaktif')}
      ${renderCompareRow('Cooldown Volume Tipis', snap.minVolRatioCooldownMinutes, currScanner.minVolRatioCooldownMinutes, ' Menit')}
      ${renderCompareRow('Maksimal Rasio Volume Breakout', snap.maxVolRatio, currScanner.maxVolRatio, 'x', (v) => v ? `≤ ${v}x` : 'Nonaktif')}
      ${renderCompareRow('Cooldown Breakout Whale', snap.maxVolRatioCooldownMinutes, currScanner.maxVolRatioCooldownMinutes, ' Menit')}
      ${renderCompareRow('Whitelist Koin', snap.whitelistEnabled, currScanner.whitelistEnabled)}

      ${renderGroupHeader('⚙️ Mode Akun & Manajemen Risiko')}
      ${renderCompareRow('Mode Trading', snap.tradingMode, curr.tradingMode, '', (v) => v === 'LIVE' ? '🟢 LIVE' : '🧪 PAPER')}
      ${renderCompareRow('Leverage', snap.leverage, curr.leverage, 'x')}
      ${renderCompareRow('Tipe Margin', snap.marginType, curr.marginType)}
      ${renderCompareRow('Sumber Data Market', snap.dataSource, currScanner.dataSource)}
      ${renderCompareRow('Rem Rugi Harian (Circuit Breaker)', snap.maxDailyLossUsdt, currRisk.maxDailyLossUsdt, ' USDT', formatZeroDisabled(' USDT'))}
      ${renderCompareRow('Batas Saldo Pengaman (Floor)', snap.minSafetyBalanceUsdt, currRisk.minSafetyBalanceUsdt, ' USDT', formatZeroDisabled(' USDT'))}
    `;

    console.log('[TradeDetail] diffCount:', diffCount, 'totalParams:', totalParamCount);
    console.log('[TradeDetail] compareRowsHtml preview:', compareRowsHtml.substring(0, 500));

    const body = document.getElementById('td-body');
    if (body) {
      body.innerHTML = `
        <!-- KPI SUMMARY -->
        <div class="td-kpi-grid">
          <div class="td-kpi-card">
            <div class="td-kpi-label">Net Realized PnL</div>
            <div class="td-kpi-val ${pnlColor}">${sign}$${realizedPnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)</div>
          </div>
          ${(feeNum && feeNum > 0) ? `
          <div class="td-kpi-card">
            <div class="td-kpi-label">Fee Binance (Riil)</div>
            <div class="td-kpi-val text-red">-$${feeNum.toFixed(4)} USDT</div>
          </div>
          <div class="td-kpi-card">
            <div class="td-kpi-label">Gross PnL (Sebelum Fee)</div>
            <div class="td-kpi-val ${grossPnlNum !== null && grossPnlNum >= 0 ? 'text-green' : 'text-red'}">
              ${grossPnlNum !== null ? (grossPnlNum >= 0 ? '+' : '') + '$' + grossPnlNum.toFixed(2) : '-'} USDT
            </div>
          </div>
          ` : ''}
          <div class="td-kpi-card">
            <div class="td-kpi-label">Entry ➜ Exit</div>
            <div class="td-kpi-val" style="font-size: 12.5px;">$${formatCryptoPrice(t.entryPrice)} ➜ $${formatCryptoPrice(t.exitPrice)}</div>
          </div>
          <div class="td-kpi-card">
            <div class="td-kpi-label">Total Margin Terpakai</div>
            <div class="td-kpi-val text-cyan">$${marginUsedNum.toFixed(2)} USDT</div>
          </div>
          <div class="td-kpi-card">
            <div class="td-kpi-label">Durasi & Waktu</div>
            <div class="td-kpi-val">${formatDurationHms(t.durationSeconds)} <small style="font-size: 10px; color: var(--text-muted); font-weight: normal;">(${formatDateTime(t.timestamp || t.closedAt)})</small></div>
          </div>
          <div class="td-kpi-card">
            <div class="td-kpi-label">Alasan Selesai</div>
            <div class="td-kpi-val" style="font-size: 12px; color: ${
              t.exitReason === 'TAKE_PROFIT' || t.exitReason === 'TRAILING_TP' || t.exitReason === 'BEP_DEFENSE' ? 'var(--green)' :
              t.exitReason === 'HARD_STOP_LOSS' ? 'var(--red, #ff4d4d)' :
              t.exitReason === 'FEE_LOSS_EXIT' ? 'var(--gold, #f0b90b)' :
              'var(--text-muted)'
            }">${
              t.exitReason === 'TAKE_PROFIT' ? '🎯 Take Profit' :
              t.exitReason === 'TRAILING_TP' ? '📈 Trailing TP' :
              t.exitReason === 'BEP_DEFENSE' ? '🛡️ BEP Defense (Penyelamatan Modal)' :
              t.exitReason === 'HARD_STOP_LOSS' ? '🛑 Hard Stop Loss' :
              t.exitReason === 'FEE_LOSS_EXIT' ? '💸 TP Minus Fee' :
              t.exitReason === 'TIME_LIMIT_EXIT' ? '⏰ Batas Waktu' :
              t.exitReason === 'EARLY_MOMENTUM_EXIT' ? '⚠️ Early Momentum' :
              t.exitReason === 'MANUAL_CLOSE' ? '⚡ Tutup Manual' :
              (t.exitReason || '-')
            }</div>
          </div>
          <div class="td-kpi-card">
            <div class="td-kpi-label">Layer Terisi</div>
            <div class="td-kpi-val text-purple">${t.layersFilled || '-'}</div>
          </div>
          ${t.maePct !== undefined && t.maePct !== null ? `
          <div class="td-kpi-card">
            <div class="td-kpi-label">Drawdown Terdalam (MAE)</div>
            <div class="td-kpi-val text-red">${Number(t.maePct) > 0 ? '-' : ''}${Math.abs(Number(t.maePct)).toFixed(1)}%</div>
          </div>` : ''}
          ${t.peakPnlPct !== undefined && Number(t.peakPnlPct) > 0 ? `
          <div class="td-kpi-card">
            <div class="td-kpi-label">Puncak Cuan (MFE)</div>
            <div class="td-kpi-val text-green">+${Number(t.peakPnlPct).toFixed(1)}%</div>
          </div>` : ''}
        </div>

        <!-- MARKET SNAPSHOT SAAT ENTRY -->
        ${(() => {
          const mSnap = t.marketSnapshot || snap.marketSnapshot || (t.paramsSnapshot && t.paramsSnapshot.marketSnapshot) || null;
          if (!mSnap || (mSnap.rsi1m === undefined && !mSnap.vol1mUsdt && !mSnap.vol24hUsdt && !mSnap.surgePct)) {
            return '';
          }
          const rsiVal = mSnap.rsi1m !== undefined ? Number(mSnap.rsi1m) : null;
          const rsiClass = rsiVal !== null ? (rsiVal >= 80 ? 'text-red' : rsiVal >= 70 ? 'text-yellow' : 'text-cyan') : '';
          const rsiTag = rsiVal !== null ? (rsiVal >= 80 ? '<small style="font-size:10px; color:#ff4d4d; font-weight:600;"> (Extreme Overbought 🔥)</small>' : rsiVal >= 70 ? '<small style="font-size:10px; color:#f0b90b;"> (Overbought)</small>' : '') : '';

          const highStr = mSnap.high24h ? `$${formatCryptoPrice(mSnap.high24h)}` : '';
          const lowStr = mSnap.low24h ? `$${formatCryptoPrice(mSnap.low24h)}` : '';
          const rangeInfo = highStr && lowStr ? `<small style="font-size:10px; color:var(--text-muted); display:block;">H: ${highStr} | L: ${lowStr}</small>` : '';

          return `
            <div class="td-section-title" style="margin-top: 14px;">📊 Snapshot Pasar Saat Entry (Layer #0)</div>
            <div class="td-kpi-grid">
              ${mSnap.vol24hUsdt ? `
              <div class="td-kpi-card">
                <div class="td-kpi-label">🌐 Vol. 24 Jam (USDT)</div>
                <div class="td-kpi-val text-cyan" title="$${Number(mSnap.vol24hUsdt).toLocaleString('en-US')} USDT">
                  <b>$${formatShortUsdt(mSnap.vol24hUsdt)} USDT</b>
                </div>
              </div>` : ''}
              ${rsiVal !== null ? `
              <div class="td-kpi-card">
                <div class="td-kpi-label">📊 RSI (14) 1m Saat Entry</div>
                <div class="td-kpi-val ${rsiClass}"><b>${rsiVal.toFixed(1)}</b>${rsiTag}</div>
              </div>` : ''}
              ${mSnap.fundingRatePct !== undefined && mSnap.fundingRatePct !== null ? `
              <div class="td-kpi-card">
                <div class="td-kpi-label">🪙 Pendanaan (Funding Rate)</div>
                <div class="td-kpi-val ${Number(mSnap.fundingRatePct) < 0 ? 'text-red' : 'text-green'}">
                  <b>${Number(mSnap.fundingRatePct) >= 0 ? '+' : ''}${Number(mSnap.fundingRatePct).toFixed(4)}%</b>
                  ${Number(mSnap.fundingRatePct) <= -0.5 ? '<small style="font-size:10px; color:#ff4d4d; font-weight:600;"> (High Squeeze ⚠️)</small>' : ''}
                </div>
              </div>` : ''}
              ${mSnap.openInterestUsdt ? `
              <div class="td-kpi-card">
                <div class="td-kpi-label">🔓 Minat Terbuka (OI USDT)</div>
                <div class="td-kpi-val" style="color: #38bdf8;" title="$${Number(mSnap.openInterestUsdt).toLocaleString('en-US')} USDT">
                  <b>$${formatShortUsdt(mSnap.openInterestUsdt)} USDT</b>
                </div>
              </div>` : ''}
              ${mSnap.priceChange24hPct !== undefined && mSnap.priceChange24hPct !== null ? `
              <div class="td-kpi-card">
                <div class="td-kpi-label">📈 Perubahan 24 Jam</div>
                <div class="td-kpi-val ${Number(mSnap.priceChange24hPct) >= 0 ? 'text-green' : 'text-red'}">
                  <b>${Number(mSnap.priceChange24hPct) >= 0 ? '+' : ''}${Number(mSnap.priceChange24hPct).toFixed(1)}%</b>
                  ${rangeInfo}
                </div>
              </div>` : ''}
              ${mSnap.surgePct ? `
              <div class="td-kpi-card">
                <div class="td-kpi-label">⚡ Lonjakan Spike</div>
                <div class="td-kpi-val text-green">+${Number(mSnap.surgePct).toFixed(2)}% <small style="font-size:10px; color:var(--text-muted); font-weight:normal;">(${mSnap.lookbackSeconds || snap.spikeLookbackSeconds || 20}s)</small></div>
              </div>` : ''}
              ${mSnap.vol1mUsdt ? `
              <div class="td-kpi-card">
                <div class="td-kpi-label">🌊 Volume Candle 1m</div>
                <div class="td-kpi-val text-cyan">
                  $${formatShortUsdt(mSnap.vol1mUsdt)} USDT
                  ${mSnap.volRatio ? `<small style="font-size:10px; color:var(--text-muted); font-weight:normal;"> (${mSnap.volRatio}x Normal)</small>` : ''}
                </div>
              </div>` : ''}
            </div>
          `;
        })()}

        <!-- TP / SL INFO -->
        ${(() => {
          const snapData = snap || {};
          const entryP = Number(t.entryPrice || 0);
          // Use stored prices, or compute from entry + snapshot %
          const tpPrice = t.targetTpPrice || (entryP && snapData.takeProfitPct ? entryP * (1 - snapData.takeProfitPct / 100) : 0);
          const tp2Pct = snapData.takeProfit2Pct || (snapData.takeProfitPct ? snapData.takeProfitPct * 2 : 0);
          const tp2Price = t.targetTp2Price || (entryP && tp2Pct ? entryP * (1 - tp2Pct / 100) : 0);
          const slPrice = t.hardSlPrice || (entryP && snapData.hardStopLossPct ? entryP * (1 + snapData.hardStopLossPct / 100) : 0);
          const hasTpSl = tpPrice || slPrice;
          const isPartialTpOn = snapData.partialTpEnabled || t.partialTpDone;
          const tpRatio = snapData.partialTpRatio || 0.7;

          if (!hasTpSl) return '';

          let tpHtml = '';
          if (tpPrice) {
            if (isPartialTpOn && tp2Price) {
              const tp1Pct = Math.round(tpRatio * 100);
              const tp2Pct = 100 - tp1Pct;
              tpHtml = `
                <div class="td-kpi-card" style="flex: 1;">
                  <div class="td-kpi-label">🎯 TP 1 (Stage 1 — ${tp1Pct}% Posisi)</div>
                  <div class="td-kpi-val text-green">$${formatCryptoPrice(tpPrice)} <small style="opacity:0.7; font-weight:400;">(−${snapData.takeProfitPct || '?'}%)</small></div>
                </div>
                <div class="td-kpi-card" style="flex: 1;">
                  <div class="td-kpi-label">🎯 TP 2 (Stage 2 — ${tp2Pct}% Sisa)</div>
                  <div class="td-kpi-val text-green">$${formatCryptoPrice(tp2Price)} <small style="opacity:0.7; font-weight:400;">(−${snapData.takeProfit2Pct || (snapData.takeProfitPct ? snapData.takeProfitPct * 2 : '?')}%)</small></div>
                </div>`;
            } else {
              tpHtml = `
                <div class="td-kpi-card" style="flex: 1;">
                  <div class="td-kpi-label">🎯 Target Take Profit</div>
                  <div class="td-kpi-val text-green">$${formatCryptoPrice(tpPrice)} <small style="opacity:0.7; font-weight:400;">(−${snapData.takeProfitPct || '?'}%)</small></div>
                </div>`;
            }
          }

          let slHtml = '';
          if (slPrice) {
            slHtml = `
              <div class="td-kpi-card" style="flex: 1;">
                <div class="td-kpi-label">🛑 Hard Stop Loss</div>
                <div class="td-kpi-val text-red">$${formatCryptoPrice(slPrice)} <small style="opacity:0.7; font-weight:400;">(+${snapData.hardStopLossPct || '?'}%)</small></div>
              </div>`;
          }

          const partialBadge = isPartialTpOn
            ? `<span class="badge-mode live" style="font-size: 10px; margin-left: 6px;">Dual TP Aktif</span>`
            : '';
          const partialDoneHtml = t.partialTpDone
            ? `<div class="td-kpi-card" style="flex: 1;">
                 <div class="td-kpi-label">✅ Stage 1 (Partial TP)</div>
                 <div class="td-kpi-val text-green">Sudah Tercairkan</div>
               </div>`
            : '';

          return `
            <div class="td-section-title" style="margin-top: 12px;">🎯 Target TP & SL Saat Trade${partialBadge}</div>
            <div class="td-kpi-grid" style="margin-bottom: 8px;">
              ${tpHtml}
              ${slHtml}
              ${partialDoneHtml}
            </div>`;
        })()}

        <!-- SNAPSHOT 30 MENIT PASCA-EXIT -->
        <div id="td-post-exit-container">
          ${renderPostExitSnapshotHtml(t)}
        </div>

        <!-- PARAMETER COMPARISON TABLE -->
        <div class="param-comparison-section">
          <div class="param-filter-bar">
            <div class="td-section-title" style="margin: 0;">
              ⚖️ Perbandingan Parameter (Trade Ini vs Aktif Sekarang)
              ${diffCount > 0 
                ? `<span class="badge-diff" style="margin-left: 8px;">${diffCount} Parameter Berbeda</span>` 
                : `<span class="badge-same" style="margin-left: 8px;">Semua Identik</span>`}
            </div>
            <label style="font-size: 11px; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; user-select: none;">
              <input type="checkbox" id="td-diff-only-checkbox" onchange="toggleDiffOnlyParams(this.checked)" style="accent-color: var(--color-cyan);">
              Hanya tampilkan yang berbeda
            </label>
          </div>

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
                ${compareRowsHtml}
              </tbody>
            </table>
          </div>
        </div>

        ${layersHtml}
      `;
    }

    const modalEl = document.getElementById('trade-detail-modal');
    if (modalEl) modalEl.classList.add('open');

    // Fetch snapshot 30 menit pasca-exit secara dinamis dari server jika belum lengkap
    if (!t.postExit30m || !t.postExit30m.isComplete) {
      fetch(`/api/trades/${encodeURIComponent(t.id)}/post-exit-30m`)
        .then((res) => res.json())
        .then((data) => {
          if (data && data.success && data.snapshot) {
            t.postExit30m = data.snapshot;
            const container = document.getElementById('td-post-exit-container');
            if (container && selectedTradeForDetail && String(selectedTradeForDetail.id) === String(t.id)) {
              container.innerHTML = renderPostExitSnapshotHtml(t);
            }
          }
        })
        .catch(() => {});
    }
    
    // Auto-scroll ke parameter comparison table
    setTimeout(() => {
      const paramSection = document.querySelector('.param-comparison-section');
      if (paramSection) {
        paramSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        console.log('[TradeDetail] Auto-scrolled to parameter comparison table');
      }
    }, 150);
  } catch (err) {
    console.error('[TradeDetailModal] Error rendering trade detail modal:', err);
    const modalEl = document.getElementById('trade-detail-modal');
    if (modalEl) modalEl.classList.add('open');
  }
}

function toggleDiffOnlyParams(diffOnly) {
  const rows = document.querySelectorAll('.param-compare-table tbody tr');
  rows.forEach((tr) => {
    if (tr.classList.contains('param-group-header')) return;
    const isDiff = tr.classList.contains('row-diff');
    tr.style.display = (diffOnly && !isDiff) ? 'none' : '';
  });

  document.querySelectorAll('.param-group-header').forEach((header) => {
    if (!diffOnly) {
      header.style.display = '';
      return;
    }
    let next = header.nextElementSibling;
    let hasVisibleChild = false;
    while (next && !next.classList.contains('param-group-header')) {
      if (next.style.display !== 'none') {
        hasVisibleChild = true;
        break;
      }
      next = next.nextElementSibling;
    }
    header.style.display = hasVisibleChild ? '' : 'none';
  });
}

function closeTradeDetailModal() {
  document.getElementById('trade-detail-modal')?.classList.remove('open');
}

window.openTradeDetailModal = openTradeDetailModal;
window.closeTradeDetailModal = closeTradeDetailModal;
window.toggleDiffOnlyParams = toggleDiffOnlyParams;
window.applySnapshotParamsToConfig = applySnapshotParamsToConfig;

function applySnapshotParamsToConfig() {
  if (!selectedTradeForDetail) return;
  const snap = selectedTradeForDetail.paramsSnapshot || {};

  // Helper set form values
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.value = val;
  };
  const setChecked = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) el.checked = !!val;
  };

  // 1. Grid & Martingale
  setVal('cfg-margin-layer', snap.marginPerLayerUsdt);
  setVal('cfg-total-layers', snap.totalLayers);
  setVal('cfg-layer-spacing', snap.layerSpacingPct);
  setVal('cfg-martingale', snap.martingaleMultiplier);
  setVal('cfg-max-margin', snap.maxTotalMarginPerCoin);
  setVal('cfg-max-coins', snap.maxConcurrentCoins);

  // 2. Exit, TP & SL
  setVal('cfg-tp-pct', snap.takeProfitPct);
  setVal('cfg-sl-pct', snap.hardStopLossPct);
  setVal('cfg-max-hold', snap.maxHoldMinutes);

  if (snap.trailingTpEnabled !== undefined) {
    setChecked('cfg-trailing-tp-enabled', snap.trailingTpEnabled);
    if (typeof toggleTrailingTpInput === 'function') toggleTrailingTpInput();
  }
  setVal('cfg-trailing-tp-callback', snap.trailingCallbackPct);

  if (snap.partialTpEnabled !== undefined) {
    setChecked('cfg-partial-tp-enabled', snap.partialTpEnabled);
    if (typeof togglePartialTpInput === 'function') togglePartialTpInput();
  }
  if (snap.partialTpRatio !== undefined) {
    const r = snap.partialTpRatio;
    setVal('cfg-partial-tp-ratio', r <= 1 ? Math.round(r * 100) : r);
    if (typeof updateTpPortionHint === 'function') updateTpPortionHint();
  }
  if (snap.takeProfit2Pct !== undefined) {
    setVal('cfg-tp2-pct', snap.takeProfit2Pct);
  }

  if (snap.extendHoldOnRedCandleEnabled !== undefined) {
    setChecked('cfg-extend-hold-red-enabled', snap.extendHoldOnRedCandleEnabled);
    if (typeof toggleExtendHoldRedInput === 'function') toggleExtendHoldRedInput();
  }
  setVal('cfg-extend-hold-seconds', snap.extendHoldSeconds);
  setVal('cfg-extend-hold-max-extensions', snap.maxHoldExtensions);

  if (snap.bepDefenseEnabled !== undefined) {
    setChecked('cfg-bep-defense-enabled', snap.bepDefenseEnabled);
    if (typeof toggleBepDefenseInput === 'function') toggleBepDefenseInput();
  }
  if (snap.bepFinalLayerEnabled !== undefined) {
    setChecked('cfg-bep-final-layer-enabled', snap.bepFinalLayerEnabled);
  }
  setVal('cfg-bep-max-layers-trigger', snap.bepMaxLayersTrigger);
  setVal('cfg-bep-fast-fill-seconds', snap.bepFastFillSeconds);
  setVal('cfg-bep-fast-fill-layers', snap.bepFastFillMinLayers);
  setVal('cfg-bep-buffer-pct', snap.bepBufferPct);
  setVal('cfg-bep-cooldown', snap.bepCooldownMinutes);

  if (snap.trailingSlEnabled !== undefined) {
    setChecked('cfg-trailing-sl-enabled', snap.trailingSlEnabled);
    if (typeof toggleTrailingSL === 'function') toggleTrailingSL();
  }

  if (snap.earlyExitMomentumEnabled !== undefined) {
    setChecked('cfg-early-exit-momentum-enabled', snap.earlyExitMomentumEnabled);
  }
  setVal('cfg-early-exit-min-layers-pct', snap.earlyExitMinLayersPct ?? 40);
  setVal('cfg-early-exit-min-loss-sl-pct', snap.earlyExitMinLossSlPct ?? 50);
  setVal('cfg-early-exit-candles', snap.earlyExitMinBullishCandles ?? 5);
  setVal('cfg-early-exit-rise', snap.earlyExitMinRisePct ?? 1.5);
  setVal('cfg-early-exit-cooldown', snap.earlyExitCooldownMinutes);
  setVal('cfg-hard-sl-cooldown', snap.hardStopCooldownMinutes);

  // 3. Scanner & Filters
  setVal('cfg-spike-pct', snap.spikeMinPercent);
  setVal('cfg-cooldown', snap.cooldownMinutes);
  setVal('cfg-min-24h-vol', snap.min24hVolumeUsdt);
  setVal('cfg-max-24h-vol', snap.max24hVolumeUsdt ?? 300000000);
  setVal('cfg-max-spread', snap.maxSpreadPct);

  if (snap.skipBottomRejectionEnabled !== undefined) {
    setChecked('cfg-bottom-rejection-enabled', snap.skipBottomRejectionEnabled);
    if (typeof toggleBottomRejectionInput === 'function') toggleBottomRejectionInput();
  }
  setVal('cfg-bottom-rejection-range', snap.bottomRejectionMinRangePct);
  setVal('cfg-bottom-rejection-ratio', snap.bottomRejectionWickRatio);

  if (snap.upperWickPullbackEnabled !== undefined) {
    setChecked('cfg-upper-wick-pullback-enabled', snap.upperWickPullbackEnabled);
    if (typeof toggleUpperWickInput === 'function') toggleUpperWickInput();
  }
  setVal('cfg-upper-wick-pullback-min', snap.upperWickPullbackMinPct);
  setVal('cfg-upper-wick-pullback-wait', snap.upperWickPullbackMaxWaitSeconds);
  setVal('cfg-upper-wick-pullback-cooldown', snap.upperWickCooldownMinutes);

  if (snap.tradeGapFilterEnabled !== undefined) {
    setChecked('cfg-trade-gap-enabled', snap.tradeGapFilterEnabled);
    if (typeof toggleTradeGapInput === 'function') toggleTradeGapInput();
  }
  setVal('cfg-max-trade-gap-seconds', snap.maxTradeGapSeconds);
  setVal('cfg-trade-gap-cooldown', snap.tradeGapCooldownMinutes);
  setVal('cfg-min-rsi', snap.minRsi1m ?? '');
  setVal('cfg-min-rsi-cooldown', snap.minRsiCooldownMinutes ?? '');
  setVal('cfg-min-vol-ratio', snap.minVolRatio ?? '');
  setVal('cfg-min-vol-ratio-cooldown', snap.minVolRatioCooldownMinutes ?? '');
  setVal('cfg-max-vol-ratio', snap.maxVolRatio ?? '');
  setVal('cfg-max-vol-ratio-cooldown', snap.maxVolRatioCooldownMinutes ?? '');

  if (snap.whitelistEnabled !== undefined) {
    setChecked('cfg-whitelist-enabled', snap.whitelistEnabled);
    if (typeof toggleWhitelistInput === 'function') toggleWhitelistInput();
  }
  if (Array.isArray(snap.whitelistSymbols)) {
    setVal('cfg-whitelist-symbols', snap.whitelistSymbols.join(', '));
    const wlInst = coinSelectorInstances['cfg-whitelist'];
    if (wlInst) {
      wlInst.selected.clear();
      snap.whitelistSymbols.forEach((s) => wlInst.selected.add(s.toUpperCase()));
      renderCoinSelector('cfg-whitelist');
    }
  }

  // 4. Mode Akun & Manajemen Risiko
  setVal('cfg-mode', snap.tradingMode);
  setVal('cfg-leverage', snap.leverage);
  setVal('cfg-margin-type', snap.marginType);
  setVal('cfg-data-source', snap.dataSource);
  if (typeof toggleDataSourceGroup === 'function') toggleDataSourceGroup();
  setVal('cfg-risk-max-daily-loss', snap.maxDailyLossUsdt);
  setVal('cfg-risk-min-balance', snap.minSafetyBalanceUsdt);

  isFormModifiedByUser = true;

  closeTradeDetailModal();
  openSettingsModal(true); // skip reload agar snapshot yang baru diterapkan tidak tertimpa
  alert('✅ Seluruh parameter dari trade ini berhasil dimuat ke formulir pengaturan! Silakan periksa lalu klik "Simpan Perubahan" jika ingin menggunakannya.');
}

let terminalAutoScroll = true;

function normalizeLogTime(raw) {
  if (!raw) return '--:--:--';
  const str = String(raw).trim();
  // Format HH.mm.ss dari locale id-ID dinormalisasi ke HH:mm:ss
  if (/^\d{1,2}\.\d{2}\.\d{2}$/.test(str)) {
    return str.replace(/\./g, ':');
  }
  // Tangani ISO string
  if (str.includes('T')) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, '0');
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }
  }
  return str;
}

function updateTerminalCount() {
  const tag = document.getElementById('terminal-count-tag');
  const terminal = document.getElementById('terminal-logs');
  if (tag && terminal) {
    const rows = terminal.querySelectorAll('.log-row');
    tag.textContent = `${rows.length} Log`;
  }
}

function setupTerminalScrollListener() {
  const terminal = document.getElementById('terminal-logs');
  if (!terminal || terminal.dataset.scrollListenerAttached) return;
  terminal.dataset.scrollListenerAttached = 'true';

  terminal.addEventListener('scroll', () => {
    // Toleransi 35px dari bawah
    const isNearBottom = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight <= 35;
    terminalAutoScroll = isNearBottom;

    const scrollBtn = document.getElementById('btn-scroll-bottom');
    if (scrollBtn) {
      scrollBtn.style.display = isNearBottom ? 'none' : 'inline-flex';
    }
  });
}

function scrollTerminalToBottom() {
  const terminal = document.getElementById('terminal-logs');
  if (!terminal) return;
  terminalAutoScroll = true;
  terminal.scrollTop = terminal.scrollHeight;
  const scrollBtn = document.getElementById('btn-scroll-bottom');
  if (scrollBtn) {
    scrollBtn.style.display = 'none';
  }
}

function renderLogs(logs) {
  const terminal = document.getElementById('terminal-logs');
  if (!terminal) return;
  setupTerminalScrollListener();
  terminal.innerHTML = '';

  if (!Array.isArray(logs) || logs.length === 0) {
    terminal.innerHTML = '<div class="terminal-empty">Menunggu aktivitas engine &amp; order stream...</div>';
    updateTerminalCount();
    return;
  }

  // Pastikan log selalu urut secara kronologis (paling lama di atas, paling baru di bawah)
  const sorted = [...logs];
  if (sorted.length > 1) {
    if (sorted[0].time && sorted[sorted.length - 1].time) {
      sorted.sort((a, b) => (a.time || 0) - (b.time || 0));
    } else {
      // Deteksi jika log terbalik dari memory backend versi lama (index 0 lebih baru dari index terakhir)
      const t0 = String(sorted[0].timestamp || '').replace(/\./g, ':');
      const tEnd = String(sorted[sorted.length - 1].timestamp || '').replace(/\./g, ':');
      if (t0 > tEnd) {
        sorted.reverse();
      }
    }
  }

  // Render log terurut
  sorted.forEach((l) => appendLog(l, true));

  // Langsung bawa scroll ke posisi log paling baru di bawah
  terminal.scrollTop = terminal.scrollHeight;
  terminalAutoScroll = true;

  const scrollBtn = document.getElementById('btn-scroll-bottom');
  if (scrollBtn) scrollBtn.style.display = 'none';

  updateTerminalCount();
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

function appendLog(log, skipScroll = false) {
  if (!log) return;
  const terminal = document.getElementById('terminal-logs');
  if (!terminal) return;
  setupTerminalScrollListener();

  // Hapus placeholder jika ada
  const emptyHint = terminal.querySelector('.terminal-empty');
  if (emptyHint) {
    terminal.removeChild(emptyHint);
  }

  // Cegah duplikasi entri log yang sama di DOM UI
  if (log.id && document.getElementById(`log-${log.id}`)) {
    return;
  }

  const div = document.createElement('div');
  if (log.id) {
    div.id = `log-${log.id}`;
  }
  const lvl = String(log.level || 'INFO').toUpperCase();
  div.className = `log-row log-row-${lvl.toLowerCase()}`;

  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = normalizeLogTime(log.timestamp);
  if (log.timestamp) {
    timeSpan.title = log.timestamp;
  }

  const badgeSpan = document.createElement('span');
  badgeSpan.className = `log-badge log-badge-${lvl.toLowerCase()}`;
  badgeSpan.textContent = lvl;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'log-msg';
  msgSpan.textContent = formatLogMessage(log.message);

  div.appendChild(timeSpan);
  div.appendChild(badgeSpan);
  div.appendChild(msgSpan);

  // Log baru selalu ditambahkan di paling bawah (kronologis ke bawah)
  terminal.appendChild(div);

  // Batasi 200 baris DOM (hapus yang paling atas/lama jika penuh)
  if (terminal.children.length > 200) {
    terminal.removeChild(terminal.firstElementChild);
  }

  updateTerminalCount();

  // Auto-scroll ke bawah jika pengguna sedang berada di dasar
  if (!skipScroll && terminalAutoScroll) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function clearLocalLogs() {
  const terminal = document.getElementById('terminal-logs');
  if (terminal) {
    terminal.innerHTML = '<div class="terminal-empty">Terminal log dibersihkan. Menunggu event baru...</div>';
  }
  const scrollBtn = document.getElementById('btn-scroll-bottom');
  if (scrollBtn) scrollBtn.style.display = 'none';
  terminalAutoScroll = true;
  updateTerminalCount();
}

window.scrollTerminalToBottom = scrollTerminalToBottom;
window.clearLocalLogs = clearLocalLogs;

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
  setVal('cfg-min-24h-vol', cfg.scanner?.min24hVolumeUsdt ?? 1500000);
  setVal('cfg-max-24h-vol', cfg.scanner?.max24hVolumeUsdt ?? 300000000);
  setVal('cfg-max-spread', cfg.scanner?.maxSpreadPct ?? 0.25);
  const abCheckbox = document.getElementById('cfg-auto-blacklist');
  if (abCheckbox) abCheckbox.checked = !!cfg.scanner?.autoBlacklist;
  setVal('cfg-max-24h-change', cfg.scanner?.max24hChangePct ?? 40);
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
  setVal('cfg-upper-wick-pullback-cooldown', cfg.scanner?.upperWickCooldownMinutes ?? cfg.scanner?.cooldownMinutes ?? 10);
  const tradeGapCheckbox = document.getElementById('cfg-trade-gap-enabled');
  if (tradeGapCheckbox) {
    tradeGapCheckbox.checked = cfg.scanner?.tradeGapFilterEnabled !== false;
    toggleTradeGapInput();
  }
  setVal('cfg-max-trade-gap-seconds', cfg.scanner?.maxTradeGapSeconds ?? 10);
  setVal('cfg-trade-gap-cooldown', cfg.scanner?.tradeGapCooldownMinutes ?? 5);
  setVal('cfg-min-rsi', cfg.scanner?.minRsi1m ?? 50);
  setVal('cfg-min-rsi-cooldown', cfg.scanner?.minRsiCooldownMinutes ?? 10);
  setVal('cfg-min-vol-ratio', cfg.scanner?.minVolRatio ?? 1.0);
  setVal('cfg-min-vol-ratio-cooldown', cfg.scanner?.minVolRatioCooldownMinutes ?? 5);
  setVal('cfg-max-vol-ratio', cfg.scanner?.maxVolRatio ?? 20.0);
  setVal('cfg-max-vol-ratio-cooldown', cfg.scanner?.maxVolRatioCooldownMinutes ?? 10);
  const eemCheckbox = document.getElementById('cfg-early-exit-momentum-enabled');
  if (eemCheckbox) eemCheckbox.checked = !!cfg.exit?.earlyExitMomentumEnabled;
  setVal('cfg-early-exit-min-layers-pct', cfg.exit?.earlyExitMinLayersPct ?? 60);
  setVal('cfg-early-exit-min-loss-sl-pct', cfg.exit?.earlyExitMinLossSlPct ?? 60);
  setVal('cfg-early-exit-candles', cfg.exit?.earlyExitMinBullishCandles || 5);
  setVal('cfg-early-exit-rise', cfg.exit?.earlyExitMinRisePct || 1.5);
  setVal('cfg-early-exit-cooldown', cfg.exit?.earlyExitCooldownMinutes || 60);
  setVal('cfg-hard-sl-cooldown', cfg.exit?.hardStopCooldownMinutes || 180);

  // Partial Take Profit
  const ptCheckbox = document.getElementById('cfg-partial-tp-enabled');
  if (ptCheckbox) {
    ptCheckbox.checked = !!cfg.exit?.partialTpEnabled;
    togglePartialTpInput();
  }
  setVal('cfg-tp2-pct', cfg.exit?.takeProfit2Pct ?? (cfg.exit?.takeProfitPct ? Math.round(cfg.exit.takeProfitPct * 2 * 10) / 10 : 2.4));
  setVal('cfg-partial-tp-ratio', cfg.exit?.partialTpRatio ? Math.round(cfg.exit.partialTpRatio * 100) : 70);
  if (typeof updateTpPortionHint === 'function') updateTpPortionHint();

  // Emergency BEP Defense
  const bepDefCheckbox = document.getElementById('cfg-bep-defense-enabled');
  if (bepDefCheckbox) {
    bepDefCheckbox.checked = cfg.exit?.bepDefenseEnabled !== false;
    toggleBepDefenseInput();
  }
  const bepFinalCheckbox = document.getElementById('cfg-bep-final-layer-enabled');
  if (bepFinalCheckbox) {
    bepFinalCheckbox.checked = cfg.exit?.bepFinalLayerEnabled !== false;
  }
  setVal('cfg-bep-max-layers-trigger', cfg.exit?.bepMaxLayersTrigger ?? 0);
  setVal('cfg-bep-fast-fill-seconds', cfg.exit?.bepFastFillSeconds ?? 120);
  setVal('cfg-bep-fast-fill-layers', cfg.exit?.bepFastFillMinLayers ?? 0);
  setVal('cfg-bep-buffer-pct', cfg.exit?.bepBufferPct ?? 0.08);
  setVal('cfg-bep-cooldown', cfg.exit?.bepCooldownMinutes ?? 15);

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
  setChecked('cfg-tg-on-emergency', tg.notifyOnEmergency !== false);
  setChecked('cfg-tg-on-autobl', tg.notifyOnAutoBlacklist !== false);
  setVal('cfg-tg-heartbeat-hours', tg.heartbeatIntervalHours ?? 6);

  // Risk Management
  setVal('cfg-risk-max-daily-loss', cfg.risk?.maxDailyLossUsdt ?? 30);
  setVal('cfg-risk-min-balance', cfg.risk?.minSafetyBalanceUsdt ?? 15);

  // Whitelist
  const wlCheckbox = document.getElementById('cfg-whitelist-enabled');
  if (wlCheckbox) {
    wlCheckbox.checked = !!cfg.scanner?.whitelistEnabled;
    toggleWhitelistInput();
  }
  const wlSymbols = (cfg.scanner?.whitelistSymbols || []).filter(Boolean);
  setVal('cfg-whitelist-symbols', wlSymbols.join(', '));
  const wlInst = coinSelectorInstances['cfg-whitelist'];
  if (wlInst) {
    wlInst.selected.clear();
    wlSymbols.forEach((s) => wlInst.selected.add(s.toUpperCase()));
    renderCoinSelector('cfg-whitelist');
  }
  setVal('cfg-exclude-symbols', (cfg.scanner?.excludeSymbols ?? ['USDCUSDT', 'FDUSDUSDT', 'BTCUSDT', 'ETHUSDT']).join(', '));

  // Momentum Long
  const longEnabledCheckbox = document.getElementById('cfg-long-enabled');
  if (longEnabledCheckbox) {
    longEnabledCheckbox.checked = cfg.momentumLong?.enabled !== false;
    toggleLongSettingsGroup();
  }
  setVal('cfg-long-min-surge', cfg.momentumLong?.minSurgePct ?? 3.0);
  setVal('cfg-long-min-vol-ratio', cfg.momentumLong?.minVolRatio ?? 4.0);
  setVal('cfg-long-max-funding', cfg.momentumLong?.maxFundingRatePct ?? 0.05);
  setVal('cfg-long-margin', cfg.momentumLong?.marginUsdt ?? 3);
  setVal('cfg-long-leverage', cfg.momentumLong?.leverage ?? 5);
  setVal('cfg-long-tp', cfg.momentumLong?.takeProfitPct ?? 6.0);
  const longTrailingCheckbox = document.getElementById('cfg-long-trailing-enabled');
  if (longTrailingCheckbox) {
    longTrailingCheckbox.checked = cfg.momentumLong?.trailingTpEnabled !== false;
  }
  setVal('cfg-long-trailing-activation', cfg.momentumLong?.trailingActivationPct ?? 1.5);
  setVal('cfg-long-trailing-callback', cfg.momentumLong?.trailingCallbackPct ?? 0.8);
  setVal('cfg-long-sl', cfg.momentumLong?.stopLossPct ?? 2.5);
  setVal('cfg-long-max-hold', cfg.momentumLong?.maxHoldMinutes ?? 60);
  setVal('cfg-long-cooldown', cfg.momentumLong?.cooldownMinutes ?? 15);
}

window.toggleLongSettingsGroup = function() {
  const isEnabled = document.getElementById('cfg-long-enabled')?.checked;
  const group = document.getElementById('cfg-long-params-group');
  if (group) group.style.display = isEnabled ? 'flex' : 'none';
};

// Preset Early Exit Momentum
window.applyEarlyExitPreset = function(preset) {
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el && val !== undefined && val !== null) {
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const eemCheckbox = document.getElementById('cfg-early-exit-momentum-enabled');
  if (eemCheckbox) {
    eemCheckbox.checked = true;
    eemCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
  }

  isFormModifiedByUser = true;

  if (preset === 'A') {
    setVal('cfg-early-exit-min-layers-pct', 60);
    setVal('cfg-early-exit-min-loss-sl-pct', 60);
    setVal('cfg-early-exit-candles', 5);
    setVal('cfg-early-exit-rise', 1.5);
    setVal('cfg-early-exit-cooldown', 60);
    alert('🎯 Preset Opsi A (Anti-Keluar Dini / Longgar) berhasil dipasang!\n• Min Layer Terisi: 60% (butuh min 4 dari 6 layer)\n• Ambang Rugi: 60% dari Hard SL\n• Candle Momentum: 5 (75s candle hijau nonstop)\n• Kenaikan Min: 1.5%\n• Cooldown: 60 Menit\n\nKlik "Simpan Pengaturan" untuk menyimpan ke server.');
  } else if (preset === 'B') {
    setVal('cfg-early-exit-min-layers-pct', 50);
    setVal('cfg-early-exit-min-loss-sl-pct', 50);
    setVal('cfg-early-exit-candles', 4);
    setVal('cfg-early-exit-rise', 1.2);
    setVal('cfg-early-exit-cooldown', 60);
    alert('🛡️ Preset Opsi B (Moderat) berhasil dipasang!\n• Min Layer Terisi: 50% (butuh min 3 dari 6 layer)\n• Ambang Rugi: 50% dari Hard SL\n• Candle Momentum: 4 (60s candle hijau)\n• Kenaikan Min: 1.2%\n• Cooldown: 60 Menit\n\nKlik "Simpan Pengaturan" untuk menyimpan ke server.');
  }
};

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
      min24hVolumeUsdt: parseFloat(getVal('cfg-min-24h-vol', '1500000')) || 0,
      max24hVolumeUsdt: parseFloat(getVal('cfg-max-24h-vol', '300000000')) || 0,
      maxSpreadPct: parseFloat(getVal('cfg-max-spread', '0.25')) || 0,
    autoBlacklist: !!document.getElementById('cfg-auto-blacklist')?.checked,
      max24hChangePct: parseFloat(getVal('cfg-max-24h-change', '40')) || 0,
      skipBottomRejectionEnabled: !!document.getElementById('cfg-bottom-rejection-enabled')?.checked,
      bottomRejectionMinRangePct: parseFloat(getVal('cfg-bottom-rejection-range', '1.5')) || 1.5,
      bottomRejectionWickRatio: parseFloat(getVal('cfg-bottom-rejection-ratio', '2.0')) || 2.0,
      upperWickPullbackEnabled: !!document.getElementById('cfg-upper-wick-pullback-enabled')?.checked,
      upperWickPullbackMinPct: parseFloat(getVal('cfg-upper-wick-pullback-min', '0.3')) || 0.3,
      upperWickPullbackMaxWaitSeconds: parseInt(getVal('cfg-upper-wick-pullback-wait', '5'), 10) || 5,
      upperWickCooldownMinutes: parseInt(getVal('cfg-upper-wick-pullback-cooldown', '10'), 10) || 10,
      tradeGapFilterEnabled: !!document.getElementById('cfg-trade-gap-enabled')?.checked,
      maxTradeGapSeconds: parseFloat(getVal('cfg-max-trade-gap-seconds', '10')) || 10,
      tradeGapCooldownMinutes: parseInt(getVal('cfg-trade-gap-cooldown', '5'), 10) || 5,
      minRsi1m: parseFloat(getVal('cfg-min-rsi', '50')) || 0,
      minRsiCooldownMinutes: parseInt(getVal('cfg-min-rsi-cooldown', '10'), 10) || 10,
      minVolRatio: parseFloat(getVal('cfg-min-vol-ratio', '1.0')) || 0,
      minVolRatioCooldownMinutes: parseInt(getVal('cfg-min-vol-ratio-cooldown', '5'), 10) || 5,
      maxVolRatio: parseFloat(getVal('cfg-max-vol-ratio', '20.0')) || 0,
      maxVolRatioCooldownMinutes: parseInt(getVal('cfg-max-vol-ratio-cooldown', '10'), 10) || 10,
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
      earlyExitMinLayersPct: parseFloat(getVal('cfg-early-exit-min-layers-pct', '60')) || 60,
      earlyExitMinLossSlPct: parseFloat(getVal('cfg-early-exit-min-loss-sl-pct', '60')) || 60,
      earlyExitMinBullishCandles: parseInt(getVal('cfg-early-exit-candles', '5')) || 5,
      earlyExitMinRisePct: parseFloat(getVal('cfg-early-exit-rise', '1.5')) || 1.5,
      earlyExitCooldownMinutes: parseInt(getVal('cfg-early-exit-cooldown', '60')) || 60,
      hardStopCooldownMinutes: parseInt(getVal('cfg-hard-sl-cooldown', '180')) || 180,
      bepDefenseEnabled: !!document.getElementById('cfg-bep-defense-enabled')?.checked,
      bepFinalLayerEnabled: document.getElementById('cfg-bep-final-layer-enabled') ? !!document.getElementById('cfg-bep-final-layer-enabled').checked : true,
      bepMaxLayersTrigger: parseInt(getVal('cfg-bep-max-layers-trigger', '0'), 10) || 0,
      bepFastFillEnabled: true,
      bepFastFillSeconds: parseInt(getVal('cfg-bep-fast-fill-seconds', '120'), 10) || 120,
      bepFastFillMinLayers: parseInt(getVal('cfg-bep-fast-fill-layers', '0'), 10) || 0,
      bepBufferPct: parseFloat(getVal('cfg-bep-buffer-pct', '0.08')) || 0.08,
      bepCooldownMinutes: parseInt(getVal('cfg-bep-cooldown', '15'), 10) || 15,
      takeProfit2Pct: parseFloat(getVal('cfg-tp2-pct', '2.4')) || 2.4,
      partialTpEnabled: !!document.getElementById('cfg-partial-tp-enabled')?.checked,
      partialTpRatio: (parseFloat(getVal('cfg-partial-tp-ratio', '70')) || 70) / 100,
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
    risk: {
      maxDailyLossUsdt: parseFloat(getVal('cfg-risk-max-daily-loss', '30')) || 0,
      minSafetyBalanceUsdt: parseFloat(getVal('cfg-risk-min-balance', '15')) || 0,
    },
    telegram: {
      enabled: !!document.getElementById('cfg-tg-enabled')?.checked,
      botToken: (getVal('cfg-tg-token', '') || '').trim(),
      chatId: (getVal('cfg-tg-chatid', '') || '').trim(),
      notifyOnNewOrder: !!document.getElementById('cfg-tg-on-new')?.checked,
      notifyOnLayerFill: !!document.getElementById('cfg-tg-on-layer')?.checked,
      notifyOnClose: !!document.getElementById('cfg-tg-on-close')?.checked,
      notifyOnEmergency: !!document.getElementById('cfg-tg-on-emergency')?.checked,
      notifyOnAutoBlacklist: !!document.getElementById('cfg-tg-on-autobl')?.checked,
      heartbeatIntervalHours: parseInt(getVal('cfg-tg-heartbeat-hours', '6'), 10) || 0,
    },
    momentumLong: {
      enabled: !!document.getElementById('cfg-long-enabled')?.checked,
      minSurgePct: parseFloat(getVal('cfg-long-min-surge', '3.0')) || 3.0,
      minVolRatio: parseFloat(getVal('cfg-long-min-vol-ratio', '4.0')) || 4.0,
      maxFundingRatePct: parseFloat(getVal('cfg-long-max-funding', '0.05')) ?? 0.05,
      marginUsdt: parseFloat(getVal('cfg-long-margin', '3')) || 3,
      leverage: parseInt(getVal('cfg-long-leverage', '5')) || 5,
      takeProfitPct: parseFloat(getVal('cfg-long-tp', '6.0')) || 6.0,
      trailingTpEnabled: !!document.getElementById('cfg-long-trailing-enabled')?.checked,
      trailingActivationPct: parseFloat(getVal('cfg-long-trailing-activation', '1.5')) || 1.5,
      trailingCallbackPct: parseFloat(getVal('cfg-long-trailing-callback', '0.8')) || 0.8,
      stopLossPct: parseFloat(getVal('cfg-long-sl', '2.5')) || 2.5,
      maxHoldMinutes: parseInt(getVal('cfg-long-max-hold', '60')) || 60,
      cooldownMinutes: parseInt(getVal('cfg-long-cooldown', '15')) || 15,
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
// ACTIVE COIN LIST & CACHE (24 HOURS TTL)
// ==========================================
const SYMBOLS_CACHE_KEY = 'wicksniper_tradable_symbols';
const SYMBOLS_TIME_KEY = 'wicksniper_symbols_cached_at';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

let globalTradableSymbols = [];
const coinSelectorInstances = {
  'cfg-whitelist': { selected: new Set(), rawInputId: 'cfg-whitelist-symbols', searchId: 'cfg-whitelist-search', listId: 'cfg-whitelist-list', countId: 'cfg-whitelist-count' },
  'bt-symbols': { selected: new Set(), rawInputId: 'bt-symbols', searchId: 'bt-symbols-search', listId: 'bt-symbols-list', countId: 'bt-symbols-count' }
};

async function loadTradableSymbols(forceRefresh = false) {
  if (!forceRefresh) {
    try {
      const cached = localStorage.getItem(SYMBOLS_CACHE_KEY);
      const cachedTime = parseInt(localStorage.getItem(SYMBOLS_TIME_KEY) || '0', 10);
      if (cached && (Date.now() - cachedTime < ONE_DAY_MS)) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          globalTradableSymbols = parsed;
          renderAllCoinSelectors();
          return globalTradableSymbols;
        }
      }
    } catch (e) {
      console.warn('Gagal membaca cache koin:', e);
    }
  }

  try {
    const res = await fetch('/api/symbols' + (forceRefresh ? '?refresh=1' : '')).then((r) => r.json());
    if (res && res.success && Array.isArray(res.symbols) && res.symbols.length > 0) {
      globalTradableSymbols = res.symbols;
      localStorage.setItem(SYMBOLS_CACHE_KEY, JSON.stringify(globalTradableSymbols));
      localStorage.setItem(SYMBOLS_TIME_KEY, String(Date.now()));
      renderAllCoinSelectors();
      return globalTradableSymbols;
    }
  } catch (err) {
    console.error('Gagal memuat koin dari server:', err);
  }

  if (globalTradableSymbols.length === 0) {
    globalTradableSymbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'SUIUSDT', 'NEARUSDT'];
    renderAllCoinSelectors();
  }
  return globalTradableSymbols;
}

function renderCoinSelector(instanceKey) {
  const inst = coinSelectorInstances[instanceKey];
  if (!inst) return;
  const listEl = document.getElementById(inst.listId);
  if (!listEl) return;

  const searchEl = document.getElementById(inst.searchId);
  const filterQuery = (searchEl ? searchEl.value.trim().toUpperCase() : '');

  const rawInput = document.getElementById(inst.rawInputId);
  if (rawInput && inst.selected.size === 0 && rawInput.value.trim()) {
    const symbols = rawInput.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    symbols.forEach((s) => inst.selected.add(s));
  }

  if (globalTradableSymbols.length === 0) {
    listEl.innerHTML = `<div style="padding: 12px; color: var(--text-muted); font-size: 11px; grid-column: 1 / -1; text-align: center;">Memuat daftar koin Binance...</div>`;
    updateCoinSelectorBadge(instanceKey);
    return;
  }

  const filtered = filterQuery
    ? globalTradableSymbols.filter((s) => s.toUpperCase().includes(filterQuery))
    : globalTradableSymbols;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div style="padding: 12px; color: var(--text-muted); font-size: 11px; grid-column: 1 / -1; text-align: center;">Tidak ada koin yang cocok dengan "${filterQuery}"</div>`;
    updateCoinSelectorBadge(instanceKey);
    return;
  }

  listEl.innerHTML = filtered.map((sym) => {
    const isChecked = inst.selected.has(sym);
    return `
      <div class="coin-chip-item ${isChecked ? 'active' : ''}" onclick="toggleCoinChip(event, '${instanceKey}', '${sym}')" title="${sym}">
        <input type="checkbox" value="${sym}" ${isChecked ? 'checked' : ''} style="pointer-events: none;">
        <span>${sym}</span>
      </div>
    `;
  }).join('');

  updateCoinSelectorBadge(instanceKey);
}

function updateCoinSelectorBadge(instanceKey) {
  const inst = coinSelectorInstances[instanceKey];
  if (!inst) return;
  const countEl = document.getElementById(inst.countId);
  if (countEl) {
    countEl.textContent = `${inst.selected.size} koin terpilih`;
  }
}

function toggleCoinChip(event, instanceKey, symbol) {
  if (event) {
    event.stopPropagation();
  }
  const inst = coinSelectorInstances[instanceKey];
  if (!inst) return;

  if (inst.selected.has(symbol)) {
    inst.selected.delete(symbol);
  } else {
    inst.selected.add(symbol);
  }

  const rawInput = document.getElementById(inst.rawInputId);
  if (rawInput) {
    rawInput.value = Array.from(inst.selected).join(', ');
    rawInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  renderCoinSelector(instanceKey);
}

function syncCoinsFromInput(instanceKey) {
  const inst = coinSelectorInstances[instanceKey];
  if (!inst) return;
  const rawInput = document.getElementById(inst.rawInputId);
  if (!rawInput) return;

  inst.selected.clear();
  const symbols = rawInput.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  symbols.forEach((s) => inst.selected.add(s));

  renderCoinSelector(instanceKey);
}

function filterCoinList(instanceKey) {
  renderCoinSelector(instanceKey);
}

function selectAllFilteredCoins(instanceKey) {
  const inst = coinSelectorInstances[instanceKey];
  if (!inst) return;
  const searchEl = document.getElementById(inst.searchId);
  const filterQuery = (searchEl ? searchEl.value.trim().toUpperCase() : '');

  const filtered = filterQuery
    ? globalTradableSymbols.filter((s) => s.toUpperCase().includes(filterQuery))
    : globalTradableSymbols;

  filtered.forEach((s) => inst.selected.add(s));

  const rawInput = document.getElementById(inst.rawInputId);
  if (rawInput) {
    rawInput.value = Array.from(inst.selected).join(', ');
    rawInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  renderCoinSelector(instanceKey);
}

function clearAllSelectedCoins(instanceKey) {
  const inst = coinSelectorInstances[instanceKey];
  if (!inst) return;
  inst.selected.clear();

  const rawInput = document.getElementById(inst.rawInputId);
  if (rawInput) {
    rawInput.value = '';
    rawInput.dispatchEvent(new Event('change', { bubbles: true }));
  }

  renderCoinSelector(instanceKey);
}

function copyWhitelistToBacktest() {
  const wlInst = coinSelectorInstances['cfg-whitelist'];
  const btInst = coinSelectorInstances['bt-symbols'];
  if (!wlInst || !btInst) return;

  const rawWl = document.getElementById('cfg-whitelist-symbols');
  const wlSymbols = rawWl && rawWl.value.trim()
    ? rawWl.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : Array.from(wlInst.selected);

  btInst.selected.clear();
  wlSymbols.forEach((s) => btInst.selected.add(s));

  const btRaw = document.getElementById('bt-symbols');
  if (btRaw) {
    btRaw.value = wlSymbols.join(', ');
    btRaw.dispatchEvent(new Event('change', { bubbles: true }));
  }

  renderCoinSelector('bt-symbols');
}

function toggleRawInput(wrapId) {
  const el = document.getElementById(wrapId);
  if (el) {
    el.style.display = (el.style.display === 'none' || !el.style.display) ? 'block' : 'none';
  }
}

async function refreshCoinCache(btnEl, force = true) {
  if (typeof btnEl === 'boolean') {
    force = btnEl;
    btnEl = null;
  }
  const btn = btnEl || (typeof event !== 'undefined' && event?.currentTarget);
  if (btn && btn.textContent) btn.textContent = '⏳ Memuat...';
  try {
    await loadTradableSymbols(force);
    renderAllCoinSelectors();
  } finally {
    if (btn && btn.textContent) btn.textContent = '🔄 Refresh Binance';
  }
}

function renderAllCoinSelectors() {
  Object.keys(coinSelectorInstances).forEach((k) => renderCoinSelector(k));
}

window.filterCoinList = filterCoinList;
window.selectAllFilteredCoins = selectAllFilteredCoins;
window.clearAllSelectedCoins = clearAllSelectedCoins;
window.copyWhitelistToBacktest = copyWhitelistToBacktest;
window.toggleRawInput = toggleRawInput;
window.refreshCoinCache = refreshCoinCache;
window.syncCoinsFromInput = syncCoinsFromInput;
window.toggleCoinChip = toggleCoinChip;

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

function updateTpPortionHint() {
  const ratioInput = document.getElementById('cfg-partial-tp-ratio');
  const hintEl = document.getElementById('tp-portion-hint');
  if (!hintEl) return;
  const tp1Val = Math.min(99, Math.max(1, parseInt(ratioInput?.value || '70', 10)));
  const tp2Val = 100 - tp1Val;
  hintEl.textContent = `Cairkan ${tp1Val}% di TP 1, sisa ${tp2Val}% memburu TP 2 dengan proteksi Auto BEP.`;
}
window.updateTpPortionHint = updateTpPortionHint;

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

function toggleTradeGapInput() {
  const checkbox = document.getElementById('cfg-trade-gap-enabled');
  const group = document.getElementById('cfg-trade-gap-params');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'flex' : 'none';
  }
}
window.toggleTradeGapInput = toggleTradeGapInput;

function toggleMaxVolRatioInput() {
  const checkbox = document.getElementById('cfg-max-vol-ratio-enabled');
  const group = document.getElementById('cfg-max-vol-ratio-params');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'flex' : 'none';
  }
}
window.toggleMaxVolRatioInput = toggleMaxVolRatioInput;

function toggleBepDefenseInput() {
  const checkbox = document.getElementById('cfg-bep-defense-enabled');
  const group = document.getElementById('cfg-bep-defense-params');
  if (group) {
    group.style.display = checkbox && checkbox.checked ? 'flex' : 'none';
  }
}
window.toggleBepDefenseInput = toggleBepDefenseInput;

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
    const btInst = coinSelectorInstances['bt-symbols'];
    if (btInst) {
      btInst.selected.clear();
      symbolsInput.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).forEach((s) => btInst.selected.add(s));
      renderCoinSelector('bt-symbols');
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
  if (cfg.exit?.earlyExitMinLayersPct !== undefined && document.getElementById('bt-early-exit-min-layers-pct')) {
    document.getElementById('bt-early-exit-min-layers-pct').value = cfg.exit.earlyExitMinLayersPct;
  }
  if (cfg.exit?.earlyExitMinLossSlPct !== undefined && document.getElementById('bt-early-exit-min-loss-sl-pct')) {
    document.getElementById('bt-early-exit-min-loss-sl-pct').value = cfg.exit.earlyExitMinLossSlPct;
  }
  if (cfg.exit?.earlyExitMinBullishCandles !== undefined) document.getElementById('bt-early-exit-candles').value = cfg.exit.earlyExitMinBullishCandles;
  if (cfg.exit?.earlyExitMinRisePct !== undefined) document.getElementById('bt-early-exit-rise').value = cfg.exit.earlyExitMinRisePct;
  if (cfg.exit?.earlyExitCooldownMinutes !== undefined) document.getElementById('bt-early-exit-cooldown').value = cfg.exit.earlyExitCooldownMinutes;
  if (cfg.exit?.hardStopCooldownMinutes !== undefined) document.getElementById('bt-hard-sl-cooldown').value = cfg.exit.hardStopCooldownMinutes;

  const btptCheckbox = document.getElementById('bt-partial-tp-enabled');
  if (btptCheckbox) btptCheckbox.checked = !!cfg.exit?.partialTpEnabled;
  const btptRatio = document.getElementById('bt-partial-tp-ratio');
  if (btptRatio) {
    btptRatio.value = cfg.exit?.partialTpRatio !== undefined ? Math.round(cfg.exit.partialTpRatio * 100) : 70;
  }
  const btTp2 = document.getElementById('bt-tp2-pct');
  if (btTp2) {
    btTp2.value = cfg.exit?.takeProfit2Pct ?? (cfg.exit?.takeProfitPct ? Math.round(cfg.exit.takeProfitPct * 2 * 10) / 10 : 2.4);
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

  renderCoinSelector('bt-symbols');
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
    earlyExitMinLayersPct: getNum('bt-early-exit-min-layers-pct', 40),
    earlyExitMinLossSlPct: getNum('bt-early-exit-min-loss-sl-pct', 50),
    earlyExitMinBullishCandles: getInt('bt-early-exit-candles', 5),
    earlyExitMinRisePct: getNum('bt-early-exit-rise', 1.5),
    earlyExitCooldownMinutes: getInt('bt-early-exit-cooldown', 60),
    hardStopCooldownMinutes: getInt('bt-hard-sl-cooldown', 180),
    partialTpEnabled: !!document.getElementById('bt-partial-tp-enabled')?.checked,
    partialTpRatio: getNum('bt-partial-tp-ratio', 70) / 100,
    takeProfit2Pct: getNum('bt-tp2-pct', 2.4),
    bepBufferPct: currentConfig?.exit?.bepBufferPct ?? 0.08,
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
          else if (t.exitReason === 'BEP_DEFENSE') exitReasonLabel = '🛡️ BEP Defense';
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
              <td>$${formatCryptoPrice(t.entryPrice)} ➜ $${formatCryptoPrice(t.exitPrice)}</td>
              <td><b>${formatDurationHms((t.durationMinutes || 0) * 60)}</b></td>
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
  loadTradableSymbols();
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

