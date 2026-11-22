const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Add it in Render > Environment.');
}

// Neon requires SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  connectionTimeoutMillis: 15000, // Neon free can take a few seconds to wake up
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected database error:', err.message);
});

function query(text, params) {
  return pool.query(text, params);
}

// Creates all tables if they don't exist yet (runs every time the server starts)
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(100) NOT NULL,
      email VARCHAR(150) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      flex_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      flex_last_claim TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_interest NUMERIC(14,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name VARCHAR(100) NOT NULL,
      target_amount NUMERIC(14,2) NOT NULL,
      saved_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      deadline DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS safelocks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL,
      rate NUMERIC(5,2) NOT NULL DEFAULT 12,
      lock_days INTEGER NOT NULL,
      start_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      end_date TIMESTAMPTZ NOT NULL,
      last_claim TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      interest_earned NUMERIC(14,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS autosave_rules (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL,
      frequency VARCHAR(20) NOT NULL,
      next_run TIMESTAMPTZ NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(30) NOT NULL,
      wallet VARCHAR(20) NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at DESC);'
  );

  console.log('Database ready');
}

module.exports = { pool, query, initDb };
