require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Events,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');
const db = require('./database');

const inviteTracker = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMembers,
  ],
});

// ================= invite cache =================

const invitesCache = new Map();

// ================= security config =================

const BUY_COOLDOWN_MS = Number(process.env.BUY_COOLDOWN_MS || 4000);
const MAX_BUYS_PER_MINUTE = Number(process.env.MAX_BUYS_PER_MINUTE || 3);
const AUTO_KICK_ON_ABUSE = String(process.env.AUTO_KICK_ON_ABUSE || 'false') === 'true';
const SECURITY_LOG_CHANNEL_ID = process.env.SECURITY_LOG_CHANNEL_ID || '';
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '';
const NORMAL_LOG_RETENTION_DAYS = Number(process.env.NORMAL_LOG_RETENTION_DAYS || 7);
const SECURITY_LOG_RETENTION_DAYS = Number(process.env.SECURITY_LOG_RETENTION_DAYS || 30);
const NEW_MEMBER_PROTECTION_MINUTES = Number(process.env.NEW_MEMBER_PROTECTION_MINUTES || 10);
const HIGH_RISK_THRESHOLD = Number(process.env.HIGH_RISK_THRESHOLD || 12);

const buyCooldowns = new Map();

const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN'
];

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);

  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

validateEnv();

// ================= product ui config =================

const PRODUCT_IMAGES = {
  1: 'https://i.imgur.com/iu6UwVJ.png',
  2: 'https://i.imgur.com/aqVabeG.png',
};

const PRODUCT_RISK_CONFIG = {
  1: 2,
  2: 6,
};

const PRODUCTS_PER_PAGE = 1;

// ================= helpers =================

async function updateServerStatsChannels(guild) {
  try {
    const membersChannelId = process.env.STATS_MEMBERS_CHANNEL_ID;
    const boostsChannelId = process.env.STATS_BOOSTS_CHANNEL_ID;

    const totalMembers = guild.memberCount;
    const boostCount = guild.premiumSubscriptionCount || 0;

    if (membersChannelId) {
      const membersChannel = guild.channels.cache.get(membersChannelId)
        || await guild.channels.fetch(membersChannelId).catch(() => null);

      if (membersChannel) {
        const newName = `Members: ${totalMembers}`;
        if (membersChannel.name !== newName) {
          await membersChannel.setName(newName);
        }
      }
    }

    if (boostsChannelId) {
      const boostsChannel = guild.channels.cache.get(boostsChannelId)
        || await guild.channels.fetch(boostsChannelId).catch(() => null);

      if (boostsChannel) {
        const newName = `Boosts: ${boostCount}`;
        if (boostsChannel.name !== newName) {
          await boostsChannel.setName(newName);
        }
      }
    }
  } catch (err) {
    console.error('updateServerStatsChannels error:', err.message);
  }
}

function trackInvite(inviterId, isNewAccount, isDefaultAvatar) {
  if (!inviteTracker.has(inviterId)) {
    inviteTracker.set(inviterId, []);
  }

  const now = Date.now();

  inviteTracker.get(inviterId).push({
    time: now,
    isNewAccount,
    isDefaultAvatar
  });

  const oneHour = 60 * 60 * 1000;

  inviteTracker.set(
    inviterId,
    inviteTracker.get(inviterId).filter(x => now - x.time < oneHour)
  );
}

function initPurchaseHistoryTable() {
  return new Promise((resolve, reject) => {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS purchase_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          product_id INTEGER NOT NULL,
          product_name TEXT NOT NULL,
          code_value TEXT NOT NULL,
          delivered_via TEXT NOT NULL DEFAULT 'dm',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      resolve();
    } catch (err) {
      console.error('initPurchaseHistoryTable error:', err.message);
      reject(err);
    }
  });
}

function savePurchaseHistory(userId, product, codeValue, deliveredVia = 'dm') {
  return new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`
        INSERT INTO purchase_history (user_id, product_id, product_name, code_value, delivered_via)
        VALUES (?, ?, ?, ?, ?)
      `);

      const result = stmt.run(
        userId,
        product.id,
        product.name,
        codeValue,
        deliveredVia
      );

      resolve({ id: Number(result.lastInsertRowid) });
    } catch (err) {
      console.error('savePurchaseHistory error:', err.message);
      reject(err);
    }
  });
}

function getUserPurchaseHistory(userId, limit = 10) {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT * FROM purchase_history
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(userId, limit);

      resolve(rows || []);
    } catch (err) {
      console.error('getUserPurchaseHistory error:', err.message);
      reject(err);
    }
  });
}

function getLatestUserPurchase(userId) {
  return new Promise((resolve, reject) => {
    try {
      const row = db.prepare(`
        SELECT * FROM purchase_history
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(userId);

      resolve(row || null);
    } catch (err) {
      console.error('getLatestUserPurchase error:', err.message);
      reject(err);
    }
  });
}

function getStockByProduct(productId) {
  return new Promise((resolve, reject) => {
    try {
      const row = db.prepare(`
        SELECT COUNT(*) as count
        FROM codes
        WHERE product_id = ? AND is_used = 0
      `).get(productId);

      resolve(row?.count || 0);
    } catch (err) {
      console.error('getStockByProduct error:', err.message);
      reject(err);
    }
  });
}

function getAllStock() {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT product_id, COUNT(*) as count
        FROM codes
        WHERE is_used = 0
        GROUP BY product_id
        ORDER BY product_id ASC
      `).all();

      resolve(rows || []);
    } catch (err) {
      console.error('getAllStock error:', err.message);
      reject(err);
    }
  });
}

function getOrCreateUser(userId) {
  return new Promise((resolve, reject) => {
    try {
      let row = db.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).get(userId);

      if (row) {
        resolve(row);
        return;
      }

      db.prepare(`
        INSERT INTO users (user_id, points, invite_count)
        VALUES (?, 0, 0)
      `).run(userId);

      row = db.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).get(userId);

      resolve(row || null);
    } catch (err) {
      console.error('getOrCreateUser error:', err.message);
      reject(err);
    }
  });
}

function addPoints(userId, amount) {
  return new Promise((resolve, reject) => {
    try {
      db.prepare(`
        INSERT INTO users (user_id, points, invite_count)
        VALUES (?, ?, 0)
        ON CONFLICT(user_id) DO UPDATE SET points = points + ?
      `).run(userId, amount, amount);

      const row = db.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).get(userId);

      resolve(row || null);
    } catch (err) {
      console.error('addPoints error:', err.message);
      reject(err);
    }
  });
}

function addInvitePoint(userId) {
  return new Promise((resolve, reject) => {
    try {
      db.prepare(`
        INSERT INTO users (user_id, points, invite_count)
        VALUES (?, 1, 1)
        ON CONFLICT(user_id) DO UPDATE SET
          points = points + 1,
          invite_count = invite_count + 1
      `).run(userId);

      const row = db.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).get(userId);

      resolve(row || null);
    } catch (err) {
      console.error('addInvitePoint error:', err.message);
      reject(err);
    }
  });
}

function hasInviteRecord(invitedUserId) {
  return new Promise((resolve, reject) => {
    try {
      const row = db.prepare(`
        SELECT * FROM invites WHERE invited_user_id = ?
      `).get(invitedUserId);

      resolve(row || null);
    } catch (err) {
      console.error('hasInviteRecord error:', err.message);
      reject(err);
    }
  });
}

function saveInviteRecord(invitedUserId, inviterId) {
  return new Promise((resolve, reject) => {
    try {
      db.prepare(`
        INSERT INTO invites (invited_user_id, inviter_id)
        VALUES (?, ?)
      `).run(invitedUserId, inviterId);

      resolve();
    } catch (err) {
      console.error('saveInviteRecord error:', err.message);
      reject(err);
    }
  });
}

function getOrCreateUser(userId) {
  return new Promise((resolve, reject) => {
    try {
      let row = db.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).get(userId);

      if (row) {
        resolve(row);
        return;
      }

      db.prepare(`
        INSERT INTO users (user_id, points, invite_count)
        VALUES (?, 0, 0)
      `).run(userId);

      row = db.prepare(`
        SELECT * FROM users WHERE user_id = ?
      `).get(userId);

      resolve(row || {
        user_id: userId,
        points: 0,
        invite_count: 0
      });
    } catch (err) {
      console.error('getOrCreateUser error:', err.message);
      reject(err);
    }
  });
}

function seedProducts() {
  try {
    db.prepare(`
      INSERT INTO products (id, name, cost, active, risk_score)
      VALUES (1, 'Gift Card 🪙', 10, 1, 2)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        cost = excluded.cost,
        active = excluded.active,
        risk_score = excluded.risk_score
    `).run();
    console.log('✅ Product 1 ready');

    db.prepare(`
      INSERT INTO products (id, name, cost, active, risk_score)
      VALUES (2, 'Royal Card 👑', 20, 1, 6)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        cost = excluded.cost,
        active = excluded.active,
        risk_score = excluded.risk_score
    `).run();
    console.log('✅ Product 2 ready');
  } catch (err) {
    console.error('seedProducts error:', err.message);
  }
}

function getProducts() {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT * FROM products
        WHERE active = 1
        ORDER BY id ASC
      `).all();

      resolve(rows || []);
    } catch (err) {
      console.error('getProducts error:', err.message);
      reject(err);
    }
  });
}

function addCode(productId, codeValue) {
  return new Promise((resolve, reject) => {
    try {
      const result = db.prepare(`
        INSERT INTO codes (product_id, code_value, is_used)
        VALUES (?, ?, 0)
      `).run(productId, codeValue);

      resolve({ id: Number(result.lastInsertRowid) });
    } catch (err) {
      console.error('addCode error:', err.message);
      reject(err);
    }
  });
}

function getProductById(productId) {
  return new Promise((resolve, reject) => {
    try {
      const row = db.prepare(`
        SELECT * FROM products
        WHERE id = ? AND active = 1
      `).get(productId);

      resolve(row || null);
    } catch (err) {
      console.error('getProductById error:', err.message);
      reject(err);
    }
  });
}

function getTopInviters(limit = 10) {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT user_id, invite_count, points
        FROM users
        ORDER BY invite_count DESC, points DESC
        LIMIT ?
      `).all(limit);

      resolve(rows || []);
    } catch (err) {
      console.error('getTopInviters error:', err.message);
      reject(err);
    }
  });
}

function getProductRisk(productId, dbRiskScore = null) {
  if (typeof dbRiskScore === 'number') return dbRiskScore;
  return PRODUCT_RISK_CONFIG[productId] || 1;
}

// ================= interaction reply helpers =================

async function replySmart(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

async function safeReply(interaction, payload) {
  if (interaction.replied || interaction.deferred) {
    return interaction.editReply(payload);
  }
  return interaction.reply(payload);
}

// ================= security helpers =================

function logAction(userId, action, detail = '') {
  return new Promise((resolve, reject) => {
    try {
      const result = db.prepare(`
        INSERT INTO logs (user_id, action, detail)
        VALUES (?, ?, ?)
      `).run(userId || null, action, detail);

      resolve(Number(result.lastInsertRowid));
    } catch (err) {
      console.error('logAction error:', err.message);
      reject(err);
    }
  });
}

function getRecentLogs(userId, seconds = 60) {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT * FROM logs
        WHERE user_id = ?
        AND created_at >= datetime('now', '-' || ? || ' seconds')
        ORDER BY created_at DESC
      `).all(userId, seconds);

      resolve(rows || []);
    } catch (err) {
      console.error('getRecentLogs error:', err.message);
      reject(err);
    }
  });
}

function getRecentSecurityLogsByUser(userId, limit = 10) {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT * FROM logs
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(userId, limit);

      resolve(rows || []);
    } catch (err) {
      console.error('getRecentSecurityLogsByUser error:', err.message);
      reject(err);
    }
  });
}

function getRecentSecurityLogs(limit = 10) {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT * FROM logs
        ORDER BY created_at DESC
        LIMIT ?
      `).all(limit);

      resolve(rows || []);
    } catch (err) {
      console.error('getRecentSecurityLogs error:', err.message);
      reject(err);
    }
  });
}

function getSecuritySummary24h() {
  return new Promise((resolve, reject) => {
    try {
      const rows = db.prepare(`
        SELECT * FROM logs
        WHERE action IN ('SECURITY_FLAG', 'AUTO_KICK', 'BUY_BLOCKED')
        AND created_at >= datetime('now', '-24 hours')
        ORDER BY created_at DESC
      `).all();

      const flags = rows.filter(r => r.action === 'SECURITY_FLAG');
      const kicks = rows.filter(r => r.action === 'AUTO_KICK');
      const blocked = rows.filter(r => r.action === 'BUY_BLOCKED');
      const lastFlag = flags[0] || null;
      const lastKick = kicks[0] || null;

      resolve({
        recentFlags24h: flags.length,
        recentKicks24h: kicks.length,
        blockedAttempts24h: blocked.length,
        lastFlaggedUserId: lastFlag?.user_id || null,
        lastFlaggedTime: lastFlag?.created_at || null,
        lastAutoKick: !!lastKick,
        lastAutoKickTime: lastKick?.created_at || null,
        lastAutoKickUserId: lastKick?.user_id || null
      });
    } catch (err) {
      console.error('getSecuritySummary24h error:', err.message);
      reject(err);
    }
  });
}

function getSecurityState(userId) {
  return new Promise((resolve, reject) => {
    try {
      const row = db.prepare(`
        SELECT * FROM security_state WHERE user_id = ?
      `).get(userId);

      resolve(row || null);
    } catch (err) {
      console.error('getSecurityState error:', err.message);
      reject(err);
    }
  });
}

function upsertSecurityState(userId, data) {
  return new Promise((resolve, reject) => {
    try {
      db.prepare(`
        INSERT INTO security_state (user_id, is_blocked, blocked_reason, risk_score, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          is_blocked = excluded.is_blocked,
          blocked_reason = excluded.blocked_reason,
          risk_score = excluded.risk_score,
          updated_at = CURRENT_TIMESTAMP
      `).run(
        userId,
        data.is_blocked ? 1 : 0,
        data.blocked_reason || '',
        data.risk_score || 0
      );

      resolve();
    } catch (err) {
      console.error('upsertSecurityState error:', err.message);
      reject(err);
    }
  });
}

function resetSecurityState(userId) {
  return new Promise((resolve, reject) => {
    try {
      db.prepare(`
        DELETE FROM security_state WHERE user_id = ?
      `).run(userId);

      resolve();
    } catch (err) {
      console.error('resetSecurityState error:', err.message);
      reject(err);
    }
  });
}

function getShopLockState(guildId) {
  return new Promise((resolve, reject) => {
    try {
      const row = db.prepare(`
        SELECT * FROM shop_settings WHERE guild_id = ?
      `).get(guildId);

      resolve(row || { guild_id: guildId, shop_locked: 0, lock_reason: '' });
    } catch (err) {
      console.error('getShopLockState error:', err.message);
      reject(err);
    }
  });
}

function setShopLockState(guildId, locked, reason = '') {
  return new Promise((resolve, reject) => {
    try {
      db.prepare(`
        INSERT INTO shop_settings (guild_id, shop_locked, lock_reason, updated_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(guild_id) DO UPDATE SET
          shop_locked = excluded.shop_locked,
          lock_reason = excluded.lock_reason,
          updated_at = CURRENT_TIMESTAMP
      `).run(guildId, locked ? 1 : 0, reason);

      resolve();
    } catch (err) {
      console.error('setShopLockState error:', err.message);
      reject(err);
    }
  });
}

function cleanupOldLogs() {
  try {
    db.prepare(`
      DELETE FROM logs
      WHERE action NOT IN ('SECURITY_FLAG', 'AUTO_KICK')
      AND created_at < datetime('now', '-' || ? || ' days')
    `).run(NORMAL_LOG_RETENTION_DAYS);

    db.prepare(`
      DELETE FROM logs
      WHERE action IN ('SECURITY_FLAG', 'AUTO_KICK')
      AND created_at < datetime('now', '-' || ? || ' days')
    `).run(SECURITY_LOG_RETENTION_DAYS);

    console.log('🧹 Old logs cleaned');
  } catch (err) {
    console.error('cleanupOldLogs failed:', err.message);
  }
}

const purchaseProductAtomicTx = db.transaction((userId, productId) => {
  const product = db.prepare(`
    SELECT * FROM products
    WHERE id = ? AND active = 1
  `).get(productId);

  if (!product) {
    return { ok: false, reason: 'PRODUCT_NOT_FOUND' };
  }

  const user = db.prepare(`
    SELECT * FROM users WHERE user_id = ?
  `).get(userId);

  const points = user?.points || 0;
  if (points < product.cost) {
    return { ok: false, reason: 'NOT_ENOUGH_POINTS', product };
  }

  const code = db.prepare(`
    SELECT * FROM codes
    WHERE product_id = ? AND is_used = 0
    ORDER BY id ASC
    LIMIT 1
  `).get(productId);

  if (!code) {
    return { ok: false, reason: 'OUT_OF_STOCK', product };
  }

  const useResult = db.prepare(`
    UPDATE codes
    SET is_used = 1
    WHERE id = ? AND is_used = 0
  `).run(code.id);

  if (useResult.changes === 0) {
    return { ok: false, reason: 'CODE_ALREADY_TAKEN', product };
  }

  const deductResult = db.prepare(`
    UPDATE users
    SET points = points - ?
    WHERE user_id = ? AND points >= ?
  `).run(product.cost, userId, product.cost);

  if (deductResult.changes === 0) {
    return { ok: false, reason: 'NOT_ENOUGH_POINTS', product };
  }

  return {
    ok: true,
    product,
    code
  };
});

function purchaseProductAtomic(userId, productId) {
  return new Promise((resolve, reject) => {
    try {
      const result = purchaseProductAtomicTx(userId, productId);
      resolve(result);
    } catch (err) {
      console.error('purchaseProductAtomic error:', err.message);
      reject(err);
    }
  });
}

async function findSecurityLogChannel(guild) {
  if (!guild) return null;

  if (SECURITY_LOG_CHANNEL_ID) {
    const byId = guild.channels.cache.get(SECURITY_LOG_CHANNEL_ID);
    if (byId?.isTextBased?.()) return byId;
  }

  const preferredNames = ['security-logs', 'mod-log', 'alerts', 'security-log', '后台🔒', '后台', 'logs'];

  for (const name of preferredNames) {
    const channel = guild.channels.cache.find(
      ch => ch.isTextBased?.() && ch.name === name
    );
    if (channel) return channel;
  }

  return null;
}

function buildSecurityActionButtons(userId = 'unknown') {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sec_lockshop')
        .setLabel('Lock Shop')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('sec_unlockshop')
        .setLabel('Unlock Shop')
        .setEmoji('🔓')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('sec_status')
        .setLabel('Security Status')
        .setEmoji('📊')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('sec_filter_logs')
        .setLabel('Filter Logs')
        .setEmoji('📜')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sec_reset_${userId}`)
        .setLabel('Reset User Security')
        .setEmoji('♻️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!userId || userId === 'unknown')
    )
  ];
}

async function notifySecurityAlert(guild, user, title, description) {
  try {
    const channel = await findSecurityLogChannel(guild);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(0xED4245)
      .setDescription(description)
      .setTimestamp();

    if (user) {
      embed.setThumbnail(member.user.displayAvatarURL({ size: 256 }))
      embed.addFields(
        { name: 'User', value: `${user.tag}`, inline: true },
        { name: 'User ID', value: `${user.id}`, inline: true }
      );
    }

    await channel.send({
      embeds: [embed],
      components: buildSecurityActionButtons(user?.id || 'unknown')
    });
  } catch (err) {
    console.error('notifySecurityAlert error:', err.message);
  }
}

async function handleSuspiciousUser(interaction, info) {
  const guild = interaction.guild;
  const user = interaction.user;

  await upsertSecurityState(user.id, {
    is_blocked: 1,
    blocked_reason: `Auto blocked by security system | buys:${info.buyCount} fails:${info.failCount} risk:${info.riskScore}`,
    risk_score: info.riskScore
  });

  await logAction(
    user.id,
    'SECURITY_FLAG',
    `buys:${info.buyCount} | fails:${info.failCount} | blocked:${info.blockedCount} | highRisk:${info.highRiskCount} | risk:${info.riskScore}`
  );

  await notifySecurityAlert(
    guild,
    user,
    'Suspicious Activity Detected',
    `A user triggered abnormal purchase activity.

Buys in last 60s: **${info.buyCount}**
Fails in last 60s: **${info.failCount}**
Blocked Attempts: **${info.blockedCount}**
High-Risk Buys: **${info.highRiskCount}**
Risk Score: **${info.riskScore}**
Action: **Shop access blocked**`
  );

  if (!AUTO_KICK_ON_ABUSE || !guild) return false;

  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return false;

    if (
      member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      member.permissions.has(PermissionsBitField.Flags.KickMembers)
    ) {
      await notifySecurityAlert(
        guild,
        user,
        'Suspicious Activity (No Kick)',
        'The user appears suspicious, but has elevated permissions, so no auto-kick was performed.'
      );
      return false;
    }

    if (!member.kickable) {
      await notifySecurityAlert(
        guild,
        user,
        'Suspicious Activity (Kick Failed)',
        'The user appears suspicious, but the bot cannot kick this member. Check bot role position and permissions.'
      );
      return false;
    }

    await member.kick('Security auto-kick: suspicious purchase activity');
    await logAction(user.id, 'AUTO_KICK', 'Security auto-kick for suspicious purchase activity');

    await notifySecurityAlert(
      guild,
      user,
      'User Auto-Kicked',
      'The member was automatically kicked for suspicious purchase activity.'
    );

    return true;
  } catch (err) {
    console.error('handleSuspiciousUser error:', err.message);
    return false;
  }
}

async function validatePurchaseAccess(interaction, productId) {
  const user = interaction.user;
  const guild = interaction.guild;

  if (!guild) {
    return { ok: false, reason: 'GUILD_ONLY', message: 'This feature can only be used within a server.' };
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    return { ok: false, reason: 'MEMBER_NOT_FOUND', message: 'Unable to retrieve your server member information.' };
  }

  const shopState = await getShopLockState(guild.id);
  if (shopState.shop_locked) {
    return {
      ok: false,
      reason: 'SHOP_LOCKED',
      message: `🛡️ The store is currently locked by an administrator.\nReason: ${shopState.lock_reason || 'Not provided'}`
    };
  }

  const sec = await getSecurityState(user.id);
  if (sec?.is_blocked) {
    return {
      ok: false,
      reason: 'SECURITY_BLOCKED',
      message: `🚫 Your account is currently restricted from redemption by the security system.\nReason: ${sec.blocked_reason || 'High-risk behavior.'}`
    };
  }

  if (member.joinedAt) {
    const joinedMs = new Date(member.joinedAt).getTime();
    const now = Date.now();
    const diffMinutes = (now - joinedMs) / 1000 / 60;

    if (diffMinutes < NEW_MEMBER_PROTECTION_MINUTES) {
      const waitMins = Math.ceil(NEW_MEMBER_PROTECTION_MINUTES - diffMinutes);
      return {
        ok: false,
        reason: 'NEW_MEMBER_COOLDOWN',
        message: `🕒 You recently joined the server and must wait **${waitMins} minute(s)** before redeeming.`
      };
    }
  }

  const product = await getProductById(productId);
  if (!product) {
    return { ok: false, reason: 'PRODUCT_NOT_FOUND', message: 'The product could not be found.' };
  }

  const productRisk = getProductRisk(product.id, product.risk_score);

  return {
    ok: true,
    member,
    product,
    productRisk
  };
}

// ================= ui helpers =================

function getRankIcon(index) {
  if (index === 0) return '🥇';
  if (index === 1) return '🥈';
  if (index === 2) return '🥉';
  return `#${index + 1}`;
}

function getRankColor(index) {
  if (index === 0) return 0xFFD700;
  if (index === 1) return 0xC0C0C0;
  if (index === 2) return 0xCD7F32;
  return 0x5865F2;
}

function buildLeaderboardButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('panel_leaderboard')
      .setLabel('View Leaderboard')
      .setEmoji('🏆')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('panel_points')
      .setLabel('My Points')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Secondary)
  );
}

function buildPartnerPanelButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_partner_modal')
      .setLabel('Post Invite')
      .setEmoji('🎮')
      .setStyle(ButtonStyle.Success)
  );
}

function buildSecurityPanelButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('sec_lockshop')
        .setLabel('Lock Shop')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('sec_unlockshop')
        .setLabel('Unlock Shop')
        .setEmoji('🔓')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('sec_status')
        .setLabel('Security Status')
        .setEmoji('📊')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('sec_filter_logs')
        .setLabel('Filter Logs')
        .setEmoji('📜')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildPartnerEmbed({ user, gameLink, profileLink, note }) {
  const embed = new EmbedBuilder()
    .setTitle('Looking for Teammates')
    .setColor(0x5865F2)
    .setDescription(
      `🔥 **Roblox squad time!**

I'm looking for people to join my game.

👉 **Game Link**
${gameLink}

👤 **Add Me**
${profileLink}

📝 **Note**
${note}`
    )
    .setFooter({ text: `Posted by ${user.username}` })
    .setTimestamp();

  embed.setThumbnail(user.displayAvatarURL({ size: 256 }));
  return embed;
}

async function buildShopPage(page = 0) {
  const products = await getProducts();

  if (!products.length) {
    return { embeds: [], components: [] };
  }

  const totalPages = Math.ceil(products.length / PRODUCTS_PER_PAGE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const product = products[safePage];
  const stock = await getStockByProduct(product.id);

  const embed = new EmbedBuilder()
    .setTitle(`🛒 ${product.name}`)
    .setDescription('Welcome to the Rewards Store. Click the button below to redeem.')
    .setColor(0x5865F2)
    .addFields(
      { name: 'Product ID', value: `${product.id}`, inline: true },
      { name: 'Price', value: `${product.cost} points`, inline: true },
      { name: 'Stock', value: `${stock}`, inline: true },
      { name: 'Risk Score', value: `${getProductRisk(product.id, product.risk_score)}`, inline: true },
    )
    .setFooter({ text: `Page ${safePage + 1} / ${totalPages}` });

  if (PRODUCT_IMAGES[product.id]) {
    embed.setImage(PRODUCT_IMAGES[product.id]);
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`shop_prev_${safePage}`)
      .setLabel('Previous Page')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 0),
    new ButtonBuilder()
      .setCustomId(`shop_buy_${product.id}`)
      .setLabel(stock > 0 ? 'Redeem Now' : 'Out of Stock')
      .setEmoji(stock > 0 ? '🛒' : '❌')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(stock <= 0),
    new ButtonBuilder()
      .setCustomId(`shop_next_${safePage}`)
      .setLabel('Next Page')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages - 1),
  );

  return {
    embeds: [embed],
    components: [row1],
  };
}

async function buildConfirmBuyUI(productId) {
  const product = await getProductById(productId);
  if (!product) return null;

  const stock = await getStockByProduct(productId);

  const embed = new EmbedBuilder()
    .setTitle('🧾 Confirm Redemption')
    .setColor(0xF1C40F)
    .setDescription(`Are you sure you want to redeem **${product.name}**?`)
    .addFields(
      { name: 'Price', value: `${product.cost} points`, inline: true },
      { name: 'Stock', value: `${stock}`, inline: true },
      { name: 'Risk Score', value: `${getProductRisk(product.id, product.risk_score)}`, inline: true },
    )
    .setFooter({ text: 'Points will be deducted immediately and the redemption code will be sent after confirmation.' });

  if (PRODUCT_IMAGES[product.id]) {
    embed.setImage(PRODUCT_IMAGES[product.id]);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_buy_${product.id}`)
      .setLabel('Confirm Purchase')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(stock <= 0),
    new ButtonBuilder()
      .setCustomId(`cancel_buy_${product.id}`)
      .setLabel('Cancel')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
  );

  return { embed, row };
}

// ================= purchase =================

async function processPurchase(interaction, productId) {
  const userId = interaction.user.id;

  const access = await validatePurchaseAccess(interaction, productId);
  if (!access.ok) {
    await logAction(
      userId,
      'BUY_BLOCKED',
      `${access.reason} | product:${productId}`
    );

    return replySmart(interaction, {
      content: access.message,
      ephemeral: true
    });
  }

  const cooldownKey = `buy_${userId}`;
  if (buyCooldowns.has(cooldownKey)) {
    return replySmart(interaction, {
      content: '⏳ Please wait a few seconds before redeeming again.',
      ephemeral: true
    });
  }

  buyCooldowns.set(cooldownKey, true);
  setTimeout(() => {
    buyCooldowns.delete(cooldownKey);
  }, BUY_COOLDOWN_MS);

  if (access.productRisk >= 5) {
    await logAction(
      userId,
      'BUY_HIGH_RISK',
      `product:${productId} | risk:${access.productRisk}`
    );
  }

  const result = await purchaseProductAtomic(userId, productId);

  if (!result.ok) {
    await logAction(
      userId,
      'BUY_FAIL',
      `${result.reason}${result.product ? ` | product:${result.product.id}` : ''}`
    );

    if (result.reason === 'PRODUCT_NOT_FOUND') {
      return replySmart(interaction, {
        content: 'Product not found.',
        ephemeral: true
      });
    }

    if (result.reason === 'NOT_ENOUGH_POINTS') {
      return replySmart(interaction, {
        content: `Insufficient points. You need ${result.product.cost} points.`,
        ephemeral: true
      });
    }

    if (result.reason === 'OUT_OF_STOCK' || result.reason === 'CODE_ALREADY_TAKEN') {
      return replySmart(interaction, {
        content: 'This product is currently out of stock. It may have just been redeemed by someone else.',
        ephemeral: true
      });
    }

    return replySmart(interaction, {
      content: 'Redemption failed. Please try again later.',
      ephemeral: true
    });
  }

  const { product, code } = result;

  try {
    const message = `🎉 **Redemption Successful**

🎁 **Product:** ${product.name}

🔑 **Your Code:**
\`${code.code_value}\`

📖 **How to Redeem:**
https://en.help.roblox.com/hc/en-us/articles/115005566223-How-to-redeem-and-spend-your-Gift-Card

👉 **Redeem Here:**
https://www.roblox.com/redeem
`;

    await interaction.user.send({
      content: message
    });

    await savePurchaseHistory(
      userId,
      product,
      code.code_value,
      'dm'
    );

    await logAction(
      userId,
      'BUY_SUCCESS',
      `product:${product.id} | code_id:${code.id} | risk:${access.productRisk}`
    );

    const abuse = await detectAbuse(userId, access.productRisk);
    if (abuse.suspicious) {
      await handleSuspiciousUser(interaction, abuse);
    }

    const successPayload = {
      content: `✅ Redemption successful! Product: **${product.name}**.\n\nYour redemption code has been sent to your DMs.\n\nThis message will close in 5 minutes.`,
      ephemeral: true,
      fetchReply: true
    };

    let successMsg;
    if (interaction.deferred || interaction.replied) {
      successMsg = await interaction.followUp(successPayload);
    } else {
      successMsg = await interaction.reply(successPayload);
    }

    setTimeout(async () => {
      try {
        await interaction.webhook.deleteMessage(successMsg.id);
      } catch (err) {
        console.error('purchase success delete error:', err.message);
      }
    }, 5 * 60 * 1000);

    return;
  } catch (err) {
    console.error('DM send error:', err.message);

    await savePurchaseHistory(
      userId,
      product,
      code.code_value,
      'ephemeral'
    );

    console.warn('User has DMs closed:', userId);

    await logAction(
      userId,
      'BUY_SUCCESS_DM_FAIL',
      `product:${product.id} | code_id:${code.id}`
    );

    const fallbackPayload = {
      content: `✅ Redemption successful, but I couldn't send you a DM. Here is your code:\n\`${code.code_value}\`\n\nThis message will close in 5 minutes.`,
      ephemeral: true,
      fetchReply: true
    };

    let fallbackMsg;
    if (interaction.deferred || interaction.replied) {
      fallbackMsg = await interaction.followUp(fallbackPayload);
    } else {
      fallbackMsg = await interaction.reply(fallbackPayload);
    }

    setTimeout(async () => {
      try {
        await interaction.webhook.deleteMessage(fallbackMsg.id);
      } catch (err) {
        console.error('purchase fallback delete error:', err.message);
      }
    }, 5 * 60 * 1000);

    return;
  }
}

// ================= command handlers =================

async function handlePing(interaction) {
  return interaction.reply('🏓 Pong!');
}

async function handlePoints(interaction) {
  const user = await getOrCreateUser(interaction.user.id);

  const embed = new EmbedBuilder()
    .setTitle('💰 My Points')
    .setColor(0x57F287)
    .setDescription(
      `You currently have **${user.points}** points.\nInvites: **${user.invite_count}**`
    )
    .setFooter({ text: 'Invite & Points System' });

  return safeReply(interaction, {
    embeds: [embed],
    ephemeral: true
  });
}

async function handleAddPoints(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({
      content: 'This command can only be used inside a server.',
      ephemeral: true
    });
  }

  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const targetUser = interaction.options.getUser('user');
  const amount = interaction.options.getInteger('amount');

  if (!targetUser) {
    return interaction.reply({
      content: 'Target user not found.',
      ephemeral: true
    });
  }

  if (!amount || amount <= 0) {
    return interaction.reply({
      content: 'The amount must be greater than 0.',
      ephemeral: true
    });
  }

  const updatedUser = await addPoints(targetUser.id, amount);
  await logAction(
    interaction.user.id,
    'ADMIN_ADD_POINTS',
    `target:${targetUser.id} | amount:${amount}`
  );

  return interaction.reply(
    `✅ Added ${amount} points to ${targetUser.username}. They now have ${updatedUser.points} points.`
  );
}

async function handleShop(interaction) {
  if (!interaction.guild) {
    return interaction.reply({
      content: 'This command can only be used inside a server.',
      ephemeral: true
    });
  }

  const shopState = await getShopLockState(interaction.guild.id);
  if (shopState.shop_locked) {
    return interaction.reply({
      content: `🛡️ The store is currently locked by an administrator.\nReason: ${shopState.lock_reason || 'Not provided'}`,
      ephemeral: true
    });
  }

  const ui = await buildShopPage(0);

  if (!ui.embeds.length) {
    return interaction.reply({
      content: '🛒 The store currently has no available products.',
      ephemeral: true
    });
  }

  return interaction.reply({
    content: '🛒 **Welcome to the Rewards Store.**',
    embeds: ui.embeds,
    components: ui.components
  });
}

async function handleAddCode(interaction) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
  }

  const productId = interaction.options.getInteger('product_id');
  const code = interaction.options.getString('code');

  const product = await getProductById(productId);
  if (!product) {
    return interaction.reply({ content: 'The product could not be found.', ephemeral: true });
  }

  const result = await addCode(productId, code);
  await logAction(
    interaction.user.id,
    'ADMIN_ADD_CODE',
    `product:${productId} | code_id:${result.id}`
  );

  return interaction.reply(`✅ Code added successfully.\nProduct: ${product.name}\nCode ID: ${result.id}`);
}

async function handleDeleteCode(interaction) {
  if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
    return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
  }

  const codeId = interaction.options.getInteger('code_id');

  try {
    db.prepare(`DELETE FROM codes WHERE id = ?`).run(codeId);
  } catch (err) {
    console.error('deleteCode error:', err.message);
    throw err;
  }

  await logAction(
    interaction.user.id,
    'ADMIN_DELETE_CODE',
    `code_id:${codeId}`
  );

  return interaction.reply(`🗑️ Deleted code ID ${codeId}.`);
}

async function handleStock(interaction) {
  const rows = await getAllStock();

  if (!rows.length) {
    return interaction.reply({
      content: '📦 No stock available.',
      ephemeral: true
    });
  }

  const lines = [];

  for (const row of rows) {
    const product = await getProductById(row.product_id);
    if (product) {
      lines.push(`Product ${row.product_id} (${product.name}): ${row.count}`);
    } else {
      lines.push(`Product ${row.product_id}: ${row.count}`);
    }
  }

  return interaction.reply({
    content: `📦 **Stock Overview**\n\n${lines.join('\n')}`,
    ephemeral: true
  });
}

async function handleCodes(interaction) {
  const productId = interaction.options.getInteger('product_id');
  const stock = await getStockByProduct(productId);
  const product = await getProductById(productId);

  if (!product) {
    return interaction.reply({ content: 'The product could not be found.', ephemeral: true });
  }

  return interaction.reply({
    content: `📦 Remaining stock for Product ${product.id} (${product.name}): ${stock}`,
    ephemeral: true
  });
}

async function handleMyCodes(interaction) {
  const rows = await getUserPurchaseHistory(interaction.user.id, 10);

  if (!rows.length) {
    return interaction.reply({
      content: 'You do not have any purchase records yet.',
      ephemeral: true
    });
  }

  let desc = '';

  for (const row of rows) {
    desc += `**${row.product_name}**\n`;
    desc += `Code: \`${row.code_value}\`\n`;
    desc += `Delivered Via: ${row.delivered_via}\n`;
    desc += `Time: ${row.created_at}\n\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎟️ My Purchase History')
    .setColor(0x5865F2)
    .setDescription(desc.slice(0, 4000))
    .setFooter({ text: `Showing latest ${rows.length} purchase record(s)` })
    .setTimestamp();

  return interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleResendCode(interaction) {
  const latest = await getLatestUserPurchase(interaction.user.id);

  if (!latest) {
    return interaction.reply({
      content: 'No purchase record was found for your account.',
      ephemeral: true
    });
  }

  const message = `🎟️ **Your Latest Purchased Code**

🎁 **Product:** ${latest.product_name}

🔑 **Code:**
\`${latest.code_value}\`

📖 **How to Redeem:**
https://en.help.roblox.com/hc/en-us/articles/115005566223-How-to-redeem-and-spend-your-Gift-Card

👉 **Redeem Here:**
https://www.roblox.com/redeem`;

  try {
    await interaction.user.send({
      content: message
    });

    await logAction(
      interaction.user.id,
      'CODE_RESENT',
      `product:${latest.product_id} | delivery:dm`
    );

    return interaction.reply({
      content: '✅ Your latest code has been re-sent to your DMs.',
      ephemeral: true
    });
  } catch (err) {
    console.error('resendCode DM error:', err.message);

    await logAction(
      interaction.user.id,
      'CODE_RESENT_DM_FAIL',
      `product:${latest.product_id} | delivery:ephemeral`
    );

    return interaction.reply({
      content: `✅ I could not send you a DM, so here is your latest code:\n\`${latest.code_value}\``,
      ephemeral: true
    });
  }
}

async function handleCheckCodes(interaction) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const targetUser = interaction.options.getUser('user');
  const rows = await getUserPurchaseHistory(targetUser.id, 20);

  if (!rows.length) {
    return interaction.reply({
      content: `No purchase records found for ${targetUser.tag}.`,
      ephemeral: true
    });
  }

  let desc = '';

  for (const row of rows) {
    desc += `**${row.product_name}**\n`;
    desc += `User: <@${row.user_id}>\n`;
    desc += `Code: \`${row.code_value}\`\n`;
    desc += `Delivery: ${row.delivered_via}\n`;
    desc += `Time: ${row.created_at}\n\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle(`📦 Purchase History: ${targetUser.tag}`)
    .setColor(0xED4245)
    .setDescription(desc.slice(0, 4000))
    .setFooter({ text: `Showing latest ${rows.length} record(s)` })
    .setTimestamp();

  return interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleBuy(interaction) {
  const productId = interaction.options.getInteger('product_id');
  return processPurchase(interaction, productId);
}

async function handleLeaderboard(interaction) {
  const rows = await getTopInviters(10);

  if (!rows.length) {
    return safeReply(interaction, {
      content: 'No leaderboard data available yet.',
      ephemeral: true
    });
  }

  const firstUser = await client.users.fetch(rows[0].user_id).catch(() => null);

  let desc = '';

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const user = await client.users.fetch(row.user_id).catch(() => null);
    const name = user ? user.username : `User ${row.user_id}`;
    const icon = getRankIcon(i);

    desc += `${icon} **${name}**\n└ Invites: **${row.invite_count}** | Points: **${row.points}**\n\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🏆 Invite Leaderboard')
    .setDescription(desc)
    .setColor(getRankColor(0))
    .setFooter({ text: 'Sorted by invites, then points' });

  if (firstUser) {
    embed.setThumbnail(firstUser.displayAvatarURL({ size: 256 }));
  }

  return safeReply(interaction, {
    embeds: [embed],
    ephemeral: true
  });
}

async function handlePanel(interaction) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🏆 Invite Center')
    .setDescription(
      'Use the buttons below to quickly view the leaderboard or check your points.'
    )
    .setColor(0x5865F2)
    .setFooter({ text: 'Roblox 20B' });

  return interaction.reply({
    embeds: [embed],
    components: [buildLeaderboardButtons()]
  });
}

async function handlePartner(interaction) {
  const gameLink = interaction.options.getString('game_link');
  const profileLink = interaction.options.getString('profile_link');
  const note = interaction.options.getString('note') || 'Come join and have fun!';

  const embed = buildPartnerEmbed({
    user: interaction.user,
    gameLink,
    profileLink,
    note
  });

  return interaction.reply({
    embeds: [embed]
  });
}

async function handlePartnerPanel(interaction) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🎮 Find a Partner')
    .setColor(0x5865F2)
    .setDescription(
      'Want to invite others to join your Roblox game?\n\n' +
      'Click **Post Invite** below, fill in the form, and the bot will post a clean invite message for you.'
    )
    .setFooter({ text: 'Easy invite format' });

  return interaction.reply({
    embeds: [embed],
    components: [buildPartnerPanelButtons()]
  });
}

async function handleSecurityLogs(interaction, page = 1, forcedLimit = 10, filteredUserId = null) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return replySmart(interaction, {
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const limit = Math.max(1, Math.min(forcedLimit || 10, 20));

  let targetUser = null;
  let targetUserId = filteredUserId;

  if (!targetUserId && interaction.isChatInputCommand()) {
    targetUser = interaction.options.getUser('user');
    targetUserId = targetUser?.id || null;
  }

  if (targetUserId && !targetUser) {
    targetUser = await client.users.fetch(targetUserId).catch(() => null);
  }

  const rows = targetUserId
    ? await getRecentSecurityLogsByUser(targetUserId, 200)
    : await getRecentSecurityLogs(200);

  if (!rows.length) {
    return replySmart(interaction, {
      content: targetUser
        ? `No security logs found for ${targetUser.tag}.`
        : 'No security logs available.',
      ephemeral: true
    });
  }

  const totalPages = Math.max(1, Math.ceil(rows.length / limit));
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = (safePage - 1) * limit;
  const pageRows = rows.slice(start, start + limit);

  let desc = '';

  for (const row of pageRows) {
    const userText = row.user_id ? `<@${row.user_id}>` : 'Unknown';
    desc += `**${row.action}**\n`;
    desc += `User: ${userText}\n`;
    desc += `Detail: ${row.detail || 'N/A'}\n`;
    desc += `Time: ${row.created_at}\n\n`;
  }

  const title = targetUser
    ? `🛡️ Security Logs: ${targetUser.tag} (Page ${safePage}/${totalPages})`
    : `🛡️ Security Logs (Page ${safePage}/${totalPages})`;

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(0xED4245)
    .setDescription(desc.slice(0, 4000))
    .setFooter({
      text: `Showing ${pageRows.length} logs on this page • Total logs loaded: ${rows.length}`
    })
    .setTimestamp();

  const prevId = targetUserId
    ? `sec_logs_prev_${safePage}_${targetUserId}`
    : `sec_logs_prev_${safePage}`;

  const nextId = targetUserId
    ? `sec_logs_next_${safePage}_${targetUserId}`
    : `sec_logs_next_${safePage}`;

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(prevId)
      .setLabel('Previous')
      .setEmoji('⬅️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage <= 1),
    new ButtonBuilder()
      .setCustomId(nextId)
      .setLabel('Next')
      .setEmoji('➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(safePage >= totalPages)
  );

  if (interaction.isButton()) {
    return interaction.update({
      embeds: [embed],
      components: [...buildSecurityPanelButtons(), navRow]
    });
  }

  if (interaction.isModalSubmit()) {
    return interaction.reply({
      embeds: [embed],
      components: [...buildSecurityPanelButtons(), navRow],
      ephemeral: true
    });
  }

  return replySmart(interaction, {
    embeds: [embed],
    components: [...buildSecurityPanelButtons(), navRow],
    ephemeral: true
  });
}

async function handleSecurityStatus(interaction) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return replySmart(interaction, {
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const summary = await getSecuritySummary24h();
  const shopState = interaction.guild
    ? await getShopLockState(interaction.guild.id)
    : { shop_locked: 0, lock_reason: '' };

  let lastFlaggedUser = 'None';
  if (summary.lastFlaggedUserId) {
    lastFlaggedUser = `<@${summary.lastFlaggedUserId}>`;
  }

  let lastFlaggedTime = summary.lastFlaggedTime || 'None';
  let lastAutoKick = summary.lastAutoKick ? 'Yes' : 'No';

  if (summary.lastAutoKick && summary.lastAutoKickUserId) {
    lastAutoKick += ` (<@${summary.lastAutoKickUserId}>)`;
  }

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Security System Status')
    .setColor(0x5865F2)
    .addFields(
      {
        name: 'Auto Kick on Abuse',
        value: AUTO_KICK_ON_ABUSE ? 'Enabled' : 'Disabled',
        inline: true
      },
      {
        name: 'Buy Cooldown',
        value: `${BUY_COOLDOWN_MS / 1000}s`,
        inline: true
      },
      {
        name: 'Max Buys Per Minute',
        value: `${MAX_BUYS_PER_MINUTE}`,
        inline: true
      },
      {
        name: 'New Member Protection',
        value: `${NEW_MEMBER_PROTECTION_MINUTES} min`,
        inline: true
      },
      {
        name: 'High Risk Threshold',
        value: `${HIGH_RISK_THRESHOLD}`,
        inline: true
      },
      {
        name: 'Blocked Attempts (24h)',
        value: `${summary.blockedAttempts24h}`,
        inline: true
      },
      {
        name: 'Recent Flags (24h)',
        value: `${summary.recentFlags24h}`,
        inline: true
      },
      {
        name: 'Recent Auto Kicks (24h)',
        value: `${summary.recentKicks24h}`,
        inline: true
      },
      {
        name: 'Last Auto Kick',
        value: `${lastAutoKick}`,
        inline: true
      },
      {
        name: 'Last Flagged User',
        value: `${lastFlaggedUser}`,
        inline: false
      },
      {
        name: 'Last Flagged Time',
        value: `${lastFlaggedTime}`,
        inline: false
      },
      {
        name: 'Shop Locked',
        value: shopState.shop_locked ? `Yes (${shopState.lock_reason || 'No reason'})` : 'No',
        inline: false
      },
      {
        name: 'Security Log Channel ID',
        value: SECURITY_LOG_CHANNEL_ID || 'Auto-detect',
        inline: false
      }
    )
    .setFooter({
      text: `Normal logs: ${NORMAL_LOG_RETENTION_DAYS}d • Security logs: ${SECURITY_LOG_RETENTION_DAYS}d`
    })
    .setTimestamp();

  return replySmart(interaction, {
    embeds: [embed],
    components: buildSecurityPanelButtons(),
    ephemeral: true
  });
}

async function handleLockShop(interaction, customReason = null) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return replySmart(interaction, {
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const reason = customReason || (
    interaction.isChatInputCommand()
      ? (interaction.options.getString('reason') || 'Security emergency')
      : 'Locked from security panel'
  );

  await setShopLockState(interaction.guild.id, true, reason);
  await logAction(
    interaction.user.id,
    'ADMIN_LOCK_SHOP',
    `guild:${interaction.guild.id} | reason:${reason}`
  );

  return replySmart(interaction, {
    content: `🔒 The store has been locked.\nReason: ${reason}`,
    ephemeral: interaction.isButton()
  });
}

async function handleUnlockShop(interaction) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return replySmart(interaction, {
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  await setShopLockState(interaction.guild.id, false, '');
  await logAction(
    interaction.user.id,
    'ADMIN_UNLOCK_SHOP',
    `guild:${interaction.guild.id}`
  );

  return replySmart(interaction, {
    content: '🔓 The store has been unlocked.',
    ephemeral: interaction.isButton()
  });
}

async function handleSecurityReset(interaction, forcedUserId = null) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return replySmart(interaction, {
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const targetUser = forcedUserId
    ? await client.users.fetch(forcedUserId).catch(() => null)
    : interaction.options.getUser('user');

  const reason = interaction.isChatInputCommand()
    ? (interaction.options.getString('reason') || 'No reason provided')
    : 'Triggered from security panel';

  const targetUserId = forcedUserId || targetUser?.id;

  if (!targetUserId) {
    return replySmart(interaction, {
      content: 'Target user not found.',
      ephemeral: true
    });
  }

  await resetSecurityState(targetUserId);

  await logAction(
    interaction.user.id,
    'ADMIN_SECURITY_RESET',
    `target:${targetUserId} | reason:${reason}`
  );

  return replySmart(interaction, {
    content: `✅ Security status for <@${targetUserId}> has been reset.\nReason: ${reason}`,
    ephemeral: true
  });
}

async function handleSecurityPanel(interaction) {
  if (
    interaction.inGuild() &&
    !interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)
  ) {
    return interaction.reply({
      content: 'You do not have permission.',
      ephemeral: true
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🛡️ Security Control Panel')
    .setColor(0xED4245)
    .setDescription(
      'Use the buttons below to manage the security system quickly.\n\n' +
      '• Lock / unlock the store\n' +
      '• Check security status\n' +
      '• Open recent security logs'
    )
    .setFooter({ text: 'Admin only' })
    .setTimestamp();

  return interaction.reply({
    embeds: [embed],
    components: buildSecurityPanelButtons()
  });
}

// ================= bot events =================

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Logged in as ${readyClient.user.tag}`);
  await initPurchaseHistoryTable();
  seedProducts();
  cleanupOldLogs();

  for (const [, guild] of readyClient.guilds.cache) {
    await updateServerStatsChannels(guild);
  }

  const cleanupInterval = setInterval(cleanupOldLogs, 60 * 60 * 1000);
  cleanupInterval.unref();

  for (const [guildId, guild] of readyClient.guilds.cache) {
    try {
      const invites = await guild.invites.fetch();

      invitesCache.set(
        guildId,
        new Map(invites.map(invite => [invite.code, invite.uses]))
      );

      console.log(`📥 Cached invites for ${guild.name}`);
    } catch (err) {
      console.error(`Failed to fetch invites for guild ${guildId}:`, err.message);
    }
  }
});

client.on(Events.InviteCreate, async (invite) => {
  try {
    const guild = invite.guild;
    if (!guild) return;

    const invites = await guild.invites.fetch();
    invitesCache.set(
      guild.id,
      new Map(invites.map(inv => [inv.code, inv.uses]))
    );
  } catch (err) {
    console.error('InviteCreate error:', err.message);
  }
});

client.on(Events.InviteDelete, async (invite) => {
  try {
    const guild = invite.guild;
    if (!guild) return;

    const invites = await guild.invites.fetch();
    invitesCache.set(
      guild.id,
      new Map(invites.map(inv => [inv.code, inv.uses]))
    );
  } catch (err) {
    console.error('InviteDelete error:', err.message);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    const guild = member.guild;
    const newInvites = await guild.invites.fetch();
    const oldInvites = invitesCache.get(guild.id);

    if (!oldInvites) {
      invitesCache.set(
        guild.id,
        new Map(newInvites.map(inv => [inv.code, inv.uses]))
      );
      await updateServerStatsChannels(guild);
      return;
    }

    const usedInvite = newInvites.find(invite => {
      const oldUses = oldInvites.get(invite.code) || 0;
      return invite.uses > oldUses;
    });

    invitesCache.set(
      guild.id,
      new Map(newInvites.map(inv => [inv.code, inv.uses]))
    );

    await updateServerStatsChannels(guild);

    if (!usedInvite) return;

    const inviter = usedInvite.inviter;
    if (!inviter) return;

    const existing = await hasInviteRecord(member.id);
    const isRepeatJoin = !!existing;

    const accountAgeDays =
      (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);

    const isNewAccount = accountAgeDays < 3;
    const isDefaultAvatar = member.user.avatar === null;

    trackInvite(inviter.id, isNewAccount, isDefaultAvatar);

    const data = inviteTracker.get(inviter.id) || [];
    const total = data.length;
    const newCount = data.filter(x => x.isNewAccount).length;
    const defaultCount = data.filter(x => x.isDefaultAvatar).length;

    const newRate = total ? newCount / total : 0;
    const defaultRate = total ? defaultCount / total : 0;

    let risk = 0;
    if (total >= 5) risk += 2;
    if (newRate > 0.6) risk += 3;
    if (defaultRate > 0.5) risk += 2;

    let updatedUser;

if (!isRepeatJoin) {
  await saveInviteRecord(member.id, inviter.id);
}

if (risk >= 5) {
  await logAction(
    inviter.id,
    'INVITE_ABUSE_ALERT',
    `invites:${total} new:${newRate.toFixed(2)} default:${defaultRate.toFixed(2)} risk:${risk}`
  );

  await logAction(
    inviter.id,
    'INVITE_REWARD_BLOCKED',
    `invited:${member.id} | invites:${total} | newRate:${newRate.toFixed(2)} | defaultRate:${defaultRate.toFixed(2)} | risk:${risk}`
  );

  await notifySecurityAlert(
    guild,
    inviter,
    'Invite Reward Blocked',
    `An inviter was flagged as high-risk, so invite reward was blocked.

Inviter: <@${inviter.id}>
Tracked invites (1h): **${total}**
New account rate: **${newRate.toFixed(2)}**
Default avatar rate: **${defaultRate.toFixed(2)}**
Risk score: **${risk}**
Action: **Invite reward blocked**`
  );

  return;
}

if (isRepeatJoin) {
  updatedUser = await getOrCreateUser(inviter.id);
} else {
  updatedUser = await addInvitePoint(inviter.id);
}

    await logAction(inviter.id, 'INVITE_REWARD', `invited:${member.id}`);

    console.log('WELCOME_CHANNEL_ID =', WELCOME_CHANNEL_ID);
    console.log('guild.systemChannel =', guild.systemChannel?.name);

    const welcomeChannel =
      (WELCOME_CHANNEL_ID
        ? guild.channels.cache.get(WELCOME_CHANNEL_ID) ||
          await guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null)
        : null) ||
      guild.systemChannel ||
      guild.channels.cache.find(
        ch => ch.isTextBased?.() && ch.name === 'welcome'
      ) ||
      guild.channels.cache.find(
        ch => ch.isTextBased?.() && ch.name === 'general'
      );

    if (welcomeChannel) {
  const imageUrl = `https://api.popcat.xyz/welcomecard?background=https://i.imgur.com/iu6UwVJ.png&text1=${encodeURIComponent(member.user.username)}&text2=Welcome&text3=Member%20%23${guild.memberCount}&avatar=${member.user.displayAvatarURL({ extension: 'png' })}`;

const embed = new EmbedBuilder()
  .setColor(0xF1C40F)
  .setTitle(`Welcome to ${guild.name}!`)
  .setDescription(
    `👤 **Invited by:** <@${inviter.id}>\n` +
    `📈 **Their total invites:** ${updatedUser.invite_count}\n` +
    `${isRepeatJoin ? '⚠️ **Repeat join:** no points added\n' : ''}`
  )
  .setImage(imageUrl) // 👈 只保留这个
  .setTimestamp();

await welcomeChannel.send({
  embeds: [embed]
});

    try {
  await inviter.send(
    `🎉 You successfully invited **${member.user.tag}** to join **${guild.name}**!\nYou earned **1 point**.\nCurrent points: **${updatedUser.points}**\nTotal invites: **${updatedUser.invite_count}**`
  );
} catch (dmErr) {
  console.error(`Failed to DM inviter ${inviter.tag}:`, dmErr.message);
}
  } catch (err) {
    console.error('GuildMemberAdd invite tracking error:', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await updateServerStatsChannels(member.guild);
  } catch (err) {
    console.error('GuildMemberRemove stats update error:', err.message);
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  try {
    const oldBoost = !!oldMember.premiumSince;
    const newBoost = !!newMember.premiumSince;

    if (oldBoost !== newBoost) {
      await updateServerStatsChannels(newMember.guild);
    }
  } catch (err) {
    console.error('GuildMemberUpdate stats update error:', err.message);
  }
});

// ================= interactions =================

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'ping') return handlePing(interaction);
      if (commandName === 'points') return handlePoints(interaction);
      if (commandName === 'addpoints') return handleAddPoints(interaction);
      if (commandName === 'shop') return handleShop(interaction);
      if (commandName === 'addcode') return handleAddCode(interaction);
      if (commandName === 'deletecode') return handleDeleteCode(interaction);
      if (commandName === 'stock') return handleStock(interaction);
      if (commandName === 'codes') return handleCodes(interaction);
      if (commandName === 'buy') return handleBuy(interaction);
      if (commandName === 'mycodes') return handleMyCodes(interaction);
      if (commandName === 'resendcode') return handleResendCode(interaction);
      if (commandName === 'checkcodes') return handleCheckCodes(interaction);
      if (commandName === 'leaderboard') return handleLeaderboard(interaction);
      if (commandName === 'panel') return handlePanel(interaction);
      if (commandName === 'partner') return handlePartner(interaction);
      if (commandName === 'partnerpanel') return handlePartnerPanel(interaction);

      if (commandName === 'securitylogs') {
        const limit = interaction.options.getInteger('limit') || 10;
        return handleSecurityLogs(interaction, 1, limit);
      }

      if (commandName === 'securitystatus') return handleSecurityStatus(interaction);
      if (commandName === 'lockshop') return handleLockShop(interaction);
      if (commandName === 'unlockshop') return handleUnlockShop(interaction);
      if (commandName === 'securityreset') return handleSecurityReset(interaction);
      if (commandName === 'securitypanel') return handleSecurityPanel(interaction);
    }

    if (interaction.isButton()) {
      const { customId } = interaction;

      if (customId === 'panel_leaderboard') {
        return handleLeaderboard(interaction);
      }

      if (customId === 'panel_points') {
        return handlePoints(interaction);
      }

      if (customId === 'open_partner_modal') {
        const modal = new ModalBuilder()
          .setCustomId('partner_modal')
          .setTitle('Post Your Roblox Invite');

        const gameLinkInput = new TextInputBuilder()
          .setCustomId('game_link')
          .setLabel('Game Link')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Paste your Roblox game link here')
          .setRequired(true);

        const profileLinkInput = new TextInputBuilder()
          .setCustomId('profile_link')
          .setLabel('Profile Link')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Paste your Roblox profile link here')
          .setRequired(true);

        const noteInput = new TextInputBuilder()
          .setCustomId('note')
          .setLabel('Short Note')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Example: Join up, let’s grind together!')
          .setRequired(false)
          .setMaxLength(200);

        modal.addComponents(
          new ActionRowBuilder().addComponents(gameLinkInput),
          new ActionRowBuilder().addComponents(profileLinkInput),
          new ActionRowBuilder().addComponents(noteInput)
        );

        return interaction.showModal(modal);
      }

      if (customId.startsWith('shop_prev_')) {
        const currentPage = Number(customId.split('_')[2]);
        const ui = await buildShopPage(currentPage - 1);
        return interaction.update(ui);
      }

      if (customId.startsWith('shop_next_')) {
        const currentPage = Number(customId.split('_')[2]);
        const ui = await buildShopPage(currentPage + 1);
        return interaction.update(ui);
      }

      if (customId.startsWith('shop_buy_')) {
        const productId = Number(customId.split('_')[2]);
        const confirmUI = await buildConfirmBuyUI(productId);

        if (!confirmUI) {
          return interaction.reply({
            content: 'The product could not be found.',
            ephemeral: true
          });
        }

        return interaction.reply({
          embeds: [confirmUI.embed],
          components: [confirmUI.row],
          ephemeral: true
        });
      }

      if (customId.startsWith('confirm_buy_')) {
        const productId = Number(customId.split('_')[2]);

        await interaction.update({
          content: 'Processing your purchase... This window will close in 2 seconds.',
          embeds: [],
          components: [],
        });

        setTimeout(async () => {
          try {
            await interaction.deleteReply();
          } catch (err) {
            console.error('confirm_buy deleteReply error:', err.message);
          }
        }, 3000);

        return processPurchase(interaction, productId);
      }

      if (customId.startsWith('cancel_buy_')) {
        await interaction.update({
          content: 'This redemption has been cancelled.',
          embeds: [],
          components: [],
        });

        setTimeout(async () => {
          try {
            await interaction.deleteReply();
          } catch (err) {
            console.error('cancel_buy deleteReply error:', err.message);
          }
        }, 3000);

        return;
      }

      if (customId === 'sec_lockshop') {
        return handleLockShop(interaction, 'Locked from security panel');
      }

      if (customId === 'sec_unlockshop') {
        return handleUnlockShop(interaction);
      }

      if (customId === 'sec_status') {
        return handleSecurityStatus(interaction);
      }

      if (customId === 'sec_filter_logs') {
        const modal = new ModalBuilder()
          .setCustomId('sec_filter_logs_modal')
          .setTitle('Filter Security Logs');

        const userInput = new TextInputBuilder()
          .setCustomId('target_user')
          .setLabel('User ID or Mention')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Example: 123456789012345678 or <@123456789012345678>')
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(userInput)
        );

        return interaction.showModal(modal);
      }

      if (customId.startsWith('sec_logs_prev_')) {
        const parts = customId.split('_');
        const currentPage = Number(parts[3]);
        const filteredUserId = parts[4] || null;
        return handleSecurityLogs(interaction, currentPage - 1, 10, filteredUserId);
      }

      if (customId.startsWith('sec_logs_next_')) {
        const parts = customId.split('_');
        const currentPage = Number(parts[3]);
        const filteredUserId = parts[4] || null;
        return handleSecurityLogs(interaction, currentPage + 1, 10, filteredUserId);
      }

      if (customId.startsWith('sec_reset_')) {
        const userId = customId.replace('sec_reset_', '');
        return handleSecurityReset(interaction, userId);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'sec_filter_logs_modal') {
        const rawInput = interaction.fields.getTextInputValue('target_user').trim();
        const match = rawInput.match(/\d{17,20}/);
        const targetUserId = match ? match[0] : null;

        if (!targetUserId) {
          return interaction.reply({
            content: 'Invalid input. Please enter a valid user ID or mention.',
            ephemeral: true
          });
        }

        return handleSecurityLogs(interaction, 1, 10, targetUserId);
      }

      if (interaction.customId === 'partner_modal') {
        const gameLink = interaction.fields.getTextInputValue('game_link').trim();
        const profileLink = interaction.fields.getTextInputValue('profile_link').trim();
        const noteRaw = interaction.fields.getTextInputValue('note');
        const note = noteRaw?.trim() || 'Come join and have fun!';

        const embed = buildPartnerEmbed({
          user: interaction.user,
          gameLink,
          profileLink,
          note
        });

        if (!interaction.channel) {
          return interaction.reply({
            content: '❌ I could not find the channel to post your invite.',
            ephemeral: true
          });
        }

        try {
          await interaction.channel.send({
            embeds: [embed]
          });

          return interaction.reply({
            content: '✅ Your invite has been posted.',
            ephemeral: true
          });
        } catch (err) {
          console.error('partner_modal send error:', err);

          return interaction.reply({
            content: '❌ Failed to post your invite message in this channel.',
            ephemeral: true
          });
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);

    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({
          content: '❌ An error occurred. Please check the server console logs.',
          ephemeral: true
        });
      } else {
        await interaction.reply({
          content: '❌ An error occurred. Please check the server console logs.',
          ephemeral: true
        });
      }
    } catch (replyErr) {
      console.error('Failed to send interaction error reply:', replyErr);
    }
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  try {
    client.destroy();
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    process.exit(0);
  }
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  try {
    client.destroy();
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Discord login failed:', err);
  process.exit(1);
});