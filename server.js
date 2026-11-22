require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');

const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const goalRoutes = require('./routes/goals');

const app = express();

// ---- CORS ----
// FRONTEND_URL is optional. If set, only that site can call the API.
// You can list several, separated by commas.
// If not set, any origin is allowed (fine for a demo app).
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json());

// ---- Health check (Render uses this to see the app is alive) ----
app.get('/', (req, res) => {
  res.json({ app: 'SaveWise API', status: 'running' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---- Routes ----
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/goals', goalRoutes);

// ---- 404 ----
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

// ---- Start ----
const PORT = process.env.PORT || 5000;

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log('SaveWise API running on port ' + PORT);
    });
  })
  .catch((err) => {
    console.error('Database setup failed:', err.message);
    process.exit(1);
  });
