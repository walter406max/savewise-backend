const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const DAY_MS = 86400000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function parseAmount(value, max = 1000000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01) {
    throw new HttpError(400, 'Enter a valid amount greater than 0');
  }
  if (n > max) {
    throw new HttpError(400, 'Maximum amount is $' + max.toLocaleString());
  }
  return round2(n);
}

function parseId(value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id');
  return n;
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });

function signToken(userId) {
  if (!process.env.JWT_SECRET) {
    throw new HttpError(500, 'JWT_SECRET is not set on the server');
  }
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

// Runs fn inside a DB transaction with the user's row locked
async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!r.rows.length) {
      throw new HttpError(401, 'Account not found. Please sign in again.');
    }
    const result = await fn(client, r.rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function addTx(client, userId, type, wallet, amount, description) {
  await client.query(
    'INSERT INTO transactions (user_id, type, wallet, amount, description) VALUES ($1,$2,$3,$4,$5)',
    [userId, type, wallet, amount, description]
  );
}

function formatLock(lock, now = new Date()) {
  const end = new Date(lock.end_date);
  const msLeft = Math.max(0, end - now);
  return {
    id: lock.id,
    amount: Number(lock.amount),
    lock_days: lock.lock_days,
    start_date: lock.start_date,
    end_date: lock.end_date,
    status: lock.status,
    seconds_left: Math.floor(msLeft / 1000),
    days_left: Math.ceil(msLeft / DAY_MS),
    can_withdraw: lock.status === 'active' && now >= end,
  };
}

function formatGoal(g) {
  const target = Number(g.target_amount);
  const saved = Number(g.saved_amount);
  return {
    id: g.id,
    name: g.name,
    target_amount: target,
    saved_amount: saved,
    deadline: g.deadline,
    days_left: Number(g.days_left),
    percent: target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0,
  };
}

function formatTx(t) {
  return {
    id: t.id,
    type: t.type,
    wallet: t.wallet,
    amount: Number(t.amount),
    description: t.description,
    created_at: t.created_at,
  };
}

module.exports = {
  DAY_MS, HttpError, round2, parseAmount, parseId, asyncHandler, signToken,
  authenticate, withUser, addTx, formatLock, formatGoal, formatTx,
};const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const DAY_MS = 86400000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function parseAmount(value, max = 1000000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.01) {
    throw new HttpError(400, 'Enter a valid amount greater than 0');
  }
  if (n > max) {
    throw new HttpError(400, 'Maximum amount is $' + max.toLocaleString());
  }
  return round2(n);
}

function parseId(value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id');
  return n;
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  });

function signToken(userId) {
  if (!process.env.JWT_SECRET) {
    throw new HttpError(500, 'JWT_SECRET is not set on the server');
  }
  return jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.id;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

// Runs fn inside a DB transaction with the user's row locked
async function withUser(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId]);
    if (!r.rows.length) {
      throw new HttpError(401, 'Account not found. Please sign in again.');
    }
    const result = await fn(client, r.rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function addTx(client, userId, type, wallet, amount, description) {
  await client.query(
    'INSERT INTO transactions (user_id, type, wallet, amount, description) VALUES ($1,$2,$3,$4,$5)',
    [userId, type, wallet, amount, description]
  );
}

function formatLock(lock, now = new Date()) {
  const end = new Date(lock.end_date);
  const msLeft = Math.max(0, end - now);
  return {
    id: lock.id,
    amount: Number(lock.amount),
    lock_days: lock.lock_days,
    start_date: lock.start_date,
    end_date: lock.end_date,
    status: lock.status,
    seconds_left: Math.floor(msLeft / 1000),
    days_left: Math.ceil(msLeft / DAY_MS),
    can_withdraw: lock.status === 'active' && now >= end,
  };
}

function formatGoal(g) {
  const target = Number(g.target_amount);
  const saved = Number(g.saved_amount);
  return {
    id: g.id,
    name: g.name,
    target_amount: target,
    saved_amount: saved,
    deadline: g.deadline,
    days_left: Number(g.days_left),
    percent: target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0,
  };
}

function formatTx(t) {
  return {
    id: t.id,
    type: t.type,
    wallet: t.wallet,
    amount: Number(t.amount),
    description: t.description,
    created_at: t.created_at,
  };
}

module.exports = {
  DAY_MS, HttpError, round2, parseAmount, parseId, asyncHandler, signToken,
  authenticate, withUser, addTx, formatLock, formatGoal, formatTx,
};
