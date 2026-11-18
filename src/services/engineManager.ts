import { WickSniperEngine } from './engine';
import { db } from './db';
import { logger } from './logger';
import { BotConfig, EngineStatus, UserRecord, UserSummary } from '../types';
import { hashPassword, verifyPassword } from '../utils/auth';

export class EngineManager {
  private engines: Map<string, WickSniperEngine> = new Map();
  private primaryEngine: WickSniperEngine;
  private configPath: string;
  private isInitialized: boolean = false;
  private onEngineStatusListeners: Array<(userId: string, status: EngineStatus) => void> = [];
  private onEngineConfigListeners: Array<(userId: string, config: BotConfig) => void> = [];

  constructor(configPath: string) {
    this.configPath = configPath;
    this.primaryEngine = new WickSniperEngine(configPath, 'admin');
    this.engines.set('admin', this.primaryEngine);
    this.hookEngineEvents(this.primaryEngine);
  }

  public onEngineStatus(cb: (userId: string, status: EngineStatus) => void) {
    this.onEngineStatusListeners.push(cb);
  }

  public onEngineConfig(cb: (userId: string, config: BotConfig) => void) {
    this.onEngineConfigListeners.push(cb);
  }

  private hookEngineEvents(eng: WickSniperEngine) {
    eng.onStatus((status) => {
      this.onEngineStatusListeners.forEach((cb) => cb(eng.userId, status));
    });
    eng.onConfig((config) => {
      this.onEngineConfigListeners.forEach((cb) => cb(eng.userId, config));
    });
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    try {
      // 1. Inisialisasi Database PostgreSQL
      await db.init();

      // 2. Pastikan akun Master Admin terdaftar di tabel wicksniper_users
      await this.ensureMasterAdminUser();

      // 3. Muat dan jalankan semua profil R&D aktif dari database
      await this.loadProfilesFromDb();

      logger.log('SUCCESS', `👥 [MULTI-USER R&D] Berhasil memuat ${this.engines.size} profil trading engine.`);
    } catch (err: any) {
      logger.log('ERROR', `❌ [ENGINE MANAGER INIT ERROR] ${err.message}`);
    }
  }

  private async ensureMasterAdminUser(): Promise<void> {
    if (!db.isConnected) return;
    try {
      const existingAdmin = await db.getUserById('admin');
      if (!existingAdmin) {
        const adminPass = this.primaryEngine.getConfig().security?.password || 'admin123';
        const initialAdmin: UserRecord = {
          id: 'admin',
          username: 'admin',
          passwordHash: hashPassword(adminPass),
          role: 'ADMIN',
          displayName: 'Administrator (Master)',
          status: 'ACTIVE',
          config: this.primaryEngine.getConfig(),
          virtualBalance: this.primaryEngine.getStatus().virtualBalance || 1000,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await db.createUser(initialAdmin);
        logger.log('INFO', '👑 [SECURITY] Akun master admin berhasil didaftarkan di PostgreSQL.');
      }
    } catch (err: any) {
      logger.log('WARN', `Gagal memastikan akun master admin: ${err.message}`);
    }
  }

  private async loadProfilesFromDb(): Promise<void> {
    if (!db.isConnected) return;
    try {
      const users = await db.getUsers();
      for (const user of users) {
        if (user.id === 'admin') continue; // Admin sudah di-instantiate di constructor
        if (user.status !== 'ACTIVE') continue;

        try {
          const userEngine = new WickSniperEngine(
            this.configPath,
            user.id,
            user.config,
            user.virtualBalance
          );
          this.engines.set(user.id, userEngine);
          this.hookEngineEvents(userEngine);
          await userEngine.start();
          logger.log('INFO', `🚀 [R&D PROFILE RUNNING] Profil '${user.displayName}' (@${user.username}) aktif berjalan.`);
        } catch (engineErr: any) {
          logger.log('ERROR', `Gagal memulai engine untuk profil ${user.username}: ${engineErr.message}`);
        }
      }
    } catch (err: any) {
      logger.log('ERROR', `Gagal memuat profil R&D: ${err.message}`);
    }
  }

  public getPrimaryEngine(): WickSniperEngine {
    return this.primaryEngine;
  }

  public getEngine(userId?: string): WickSniperEngine {
    if (!userId || userId === 'admin') {
      return this.primaryEngine;
    }
    const found = this.engines.get(userId);
    return found || this.primaryEngine;
  }

  public hasEngine(userId: string): boolean {
    return this.engines.has(userId);
  }

  public getAllEngines(): WickSniperEngine[] {
    return Array.from(this.engines.values());
  }

  public async authenticate(username: string, password: string): Promise<UserRecord | null> {
    const cleanUsername = (username || '').trim().toLowerCase();
    if (!cleanUsername) return null;

    if (db.isConnected) {
      const user = await db.getUserByUsername(cleanUsername);
      if (user) {
        if (verifyPassword(password, user.passwordHash)) {
          return user;
        }
        // Fallback untuk admin jika password di config.json diubah manual
        if (user.id === 'admin' && this.primaryEngine.verifyPassword(password)) {
          // Sync hash baru ke database
          const newHash = hashPassword(password);
          await db.updateUser('admin', { passwordHash: newHash }).catch(() => {});
          return { ...user, passwordHash: newHash };
        }
        return null;
      }
    }

    // Memory fallback jika database belum terhubung
    if (cleanUsername === 'admin' && this.primaryEngine.verifyPassword(password)) {
      return {
        id: 'admin',
        username: 'admin',
        passwordHash: '',
        role: 'ADMIN',
        displayName: 'Administrator (Fallback)',
        status: 'ACTIVE',
        config: this.primaryEngine.getConfig(),
        virtualBalance: this.primaryEngine.getStatus().virtualBalance || 1000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    return null;
  }

  public async getUserSummaries(): Promise<UserSummary[]> {
    let users: UserRecord[] = [];
    if (db.isConnected) {
      users = await db.getUsers();
    }

    if (users.length === 0) {
      // Memory fallback untuk admin
      users = [{
        id: 'admin',
        username: 'admin',
        passwordHash: '',
        role: 'ADMIN',
        displayName: 'Administrator (Master)',
        status: 'ACTIVE',
        config: this.primaryEngine.getConfig(),
        virtualBalance: this.primaryEngine.getStatus().virtualBalance || 1000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }];
    }

    return users.map((u) => {
      const userEngine = this.engines.get(u.id);
      const cfg = userEngine ? userEngine.getConfig() : u.config;
      const status = userEngine ? userEngine.getStatus() : null;

      const virtualBalance = status ? status.virtualBalance : u.virtualBalance;
      const todayPnl = status?.dailyPnl !== undefined ? status.dailyPnl : 0;
      const startBal = Math.max(1, virtualBalance - todayPnl);
      const todayPnlPct = Math.round((todayPnl / startBal) * 10000) / 100;
      const totalTrades = status ? status.totalTrades : 0;
      const winRate = status ? status.winRate : 0;
      const activePositionsCount = status ? status.activePositionsCount : 0;

      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName || u.username,
        role: u.role,
        status: u.status,
        tradingMode: (cfg?.tradingMode as 'LIVE' | 'PAPER') || 'PAPER',
        virtualBalance: Math.round(virtualBalance * 100) / 100,
        todayPnl,
        todayPnlPct,
        totalTrades,
        winRate,
        activePositionsCount,
        keyParams: {
          spikeMinPercent: cfg?.scanner?.spikeMinPercent ?? 2.0,
          takeProfitPct: cfg?.exit?.takeProfitPct ?? 1.5,
          stopLossPct: cfg?.exit?.hardStopLossPct ?? 3.0,
          leverage: cfg?.leverage ?? 5,
          marginPerLayer: cfg?.grid?.marginPerLayerUsdt ?? 25,
          maxActivePositions: cfg?.grid?.maxConcurrentCoins ?? 3,
        },
      };
    });
  }

  public async createUserProfile(params: {
    username: string;
    password: string;
    displayName: string;
    role?: 'ADMIN' | 'USER';
    initialBalance?: number;
    cloneFromProfileId?: string;
    configOverrides?: Partial<BotConfig>;
  }): Promise<UserRecord> {
    const cleanUsername = params.username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!cleanUsername || cleanUsername.length < 3) {
      throw new Error('Username minimal 3 karakter (hanya huruf, angka, underscore).');
    }
    if (!params.password || params.password.length < 6) {
      throw new Error('Password minimal 6 karakter.');
    }

    if (db.isConnected) {
      const existing = await db.getUserByUsername(cleanUsername);
      if (existing) {
        throw new Error(`Username '${cleanUsername}' sudah digunakan. Pilih username lain.`);
      }
    }

    const baseEngine = this.getEngine(params.cloneFromProfileId || 'admin');
    const baseConfig = JSON.parse(JSON.stringify(baseEngine.getConfig()));
    const finalConfig: BotConfig = {
      ...baseConfig,
      ...(params.configOverrides || {}),
      scanner: {
        ...baseConfig.scanner,
        ...(params.configOverrides?.scanner || {}),
      },
      exit: {
        ...baseConfig.exit,
        ...(params.configOverrides?.exit || {}),
      },
      grid: {
        ...baseConfig.grid,
        ...(params.configOverrides?.grid || {}),
      },
      risk: {
        ...baseConfig.risk,
        ...(params.configOverrides?.risk || {}),
      },
      tradingMode: 'PAPER', // Profil baru selalu aman dalam mode simulasi paper trading
    };

    const userId = `usr_${cleanUsername}_${Date.now().toString(36)}`;
    const userRecord: UserRecord = {
      id: userId,
      username: cleanUsername,
      passwordHash: hashPassword(params.password),
      role: params.role || 'USER',
      displayName: params.displayName || cleanUsername,
      status: 'ACTIVE',
      config: finalConfig,
      virtualBalance: params.initialBalance || 1000,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (db.isConnected) {
      await db.createUser(userRecord);
    }

    // Buat & aktifkan engine baru di memory
    const newEngine = new WickSniperEngine(
      this.configPath,
      userId,
      finalConfig,
      userRecord.virtualBalance
    );
    this.engines.set(userId, newEngine);
    this.hookEngineEvents(newEngine);
    await newEngine.start();

    logger.log('SUCCESS', `🎉 [PROFIL R&D BARU DIBUAT] Profil '${userRecord.displayName}' (@${cleanUsername}) siap berburu spike.`);
    return userRecord;
  }

  public async updateUserProfile(
    userId: string,
    updates: {
      displayName?: string;
      password?: string;
      role?: 'ADMIN' | 'USER';
      status?: 'ACTIVE' | 'DISABLED';
      virtualBalance?: number;
      config?: Partial<BotConfig>;
    }
  ): Promise<void> {
    const user = await db.getUserById(userId);
    if (!user) throw new Error(`User profil ${userId} tidak ditemukan.`);

    const dbUpdates: Partial<UserRecord> = {};
    if (updates.displayName) dbUpdates.displayName = updates.displayName;
    if (updates.password) dbUpdates.passwordHash = hashPassword(updates.password);
    if (updates.role && userId !== 'admin') dbUpdates.role = updates.role;
    if (updates.status && userId !== 'admin') dbUpdates.status = updates.status;
    if (updates.virtualBalance !== undefined) dbUpdates.virtualBalance = updates.virtualBalance;

    const engine = this.engines.get(userId);
    if (updates.config && engine) {
      await engine.saveConfig(updates.config);
      dbUpdates.config = engine.getConfig();
    }

    if (db.isConnected) {
      await db.updateUser(userId, dbUpdates);
    }

    if (updates.status === 'DISABLED' && engine && userId !== 'admin') {
      engine.stop();
      this.engines.delete(userId);
    } else if (updates.status === 'ACTIVE' && !engine && userId !== 'admin') {
      const activeUser = await db.getUserById(userId);
      if (activeUser) {
        const userEngine = new WickSniperEngine(this.configPath, userId, activeUser.config, activeUser.virtualBalance);
        this.engines.set(userId, userEngine);
        this.hookEngineEvents(userEngine);
        await userEngine.start();
      }
    }
  }

  public async deleteUserProfile(userId: string): Promise<void> {
    if (userId === 'admin') {
      throw new Error('Akun master admin tidak dapat dihapus.');
    }
    const engine = this.engines.get(userId);
    if (engine) {
      engine.stop();
      this.engines.delete(userId);
    }
    if (db.isConnected) {
      await db.deleteUser(userId);
    }
    logger.log('INFO', `🗑️ Profil R&D ${userId} berhasil dihapus.`);
  }
}
