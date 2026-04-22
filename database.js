const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, 'bot.db');
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`📦 SQLite path: ${dbPath}`);

const db = new Database(dbPath);
console.log('✅ Connected to SQLite database');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      points INTEGER DEFAULT 0,
      invite_count INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invited_user_id TEXT UNIQUE,
      inviter_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      cost INTEGER NOT NULL,
      active INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      code_value TEXT NOT NULL,
      is_used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      action TEXT NOT NULL,
      detail TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_logs_user_time
    ON logs(user_id, created_at)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_logs_action_time
    ON logs(action, created_at)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS security_state (
      user_id TEXT PRIMARY KEY,
      is_blocked INTEGER DEFAULT 0,
      blocked_reason TEXT,
      risk_score INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS shop_settings (
      guild_id TEXT PRIMARY KEY,
      shop_locked INTEGER DEFAULT 0,
      lock_reason TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(
    `
    ALTER TABLE products ADD COLUMN risk_score INTEGER DEFAULT 1
    `,
    (err) => {
      if (err && !String(err.message).includes('duplicate column name')) {
        console.error('❌ add risk_score column error:', err.message);
      }
    }
  );
});

module.exports = db;