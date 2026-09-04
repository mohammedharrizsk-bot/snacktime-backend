const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const DEFAULT_VENDOR_HASH = bcrypt.hashSync('vendor123', 10);
const DEFAULT_STUDENT_HASH = bcrypt.hashSync('student123', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://snacktime_user:PT1ICFTuGctt8QS7da3FmVWMMJ8bLw33@dpg-dadeph2fngtc73b3vv7g-a.singapore-postgres.render.com:5432/snacktime',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  console.log('Connecting to PostgreSQL database...');
  await pool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, email VARCHAR(100) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await pool.query('CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL, price DECIMAL(10, 2) NOT NULL, stock INT NOT NULL DEFAULT 0, sold INT NOT NULL DEFAULT 0, is_special BOOLEAN DEFAULT FALSE, original_price DECIMAL(10, 2), vendor_id INT DEFAULT 1, version INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await pool.query('CREATE TABLE IF NOT EXISTS orders (id VARCHAR(50) PRIMARY KEY, user_id INT NULL, vendor_id INT DEFAULT 1, customer VARCHAR(50) NOT NULL, total DECIMAL(10, 2) NOT NULL, status VARCHAR(20) DEFAULT \'pending\', time VARCHAR(50) NULL, placed_at BIGINT NOT NULL, method VARCHAR(50) NOT NULL, rating INT NULL, feedback TEXT NULL, cancel_reason TEXT NULL, token INT NULL, payment_id VARCHAR(100) NULL, version INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  await pool.query('CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id VARCHAR(50) NOT NULL REFERENCES orders(id) ON DELETE CASCADE, item_id INT NOT NULL, name VARCHAR(100) NOT NULL, qty INT NOT NULL, price DECIMAL(10, 2) NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value VARCHAR(255))');
  await pool.query('CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, order_id VARCHAR(50) NOT NULL, customer VARCHAR(50) NOT NULL, items TEXT NOT NULL, rating INT NOT NULL, feedback TEXT NULL, time VARCHAR(100) NOT NULL)');
  await pool.query('CREATE TABLE IF NOT EXISTS support_tickets (id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL, order_id VARCHAR(50) NULL, message TEXT NOT NULL, status VARCHAR(20) DEFAULT \'open\', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');

  const userRes = await pool.query('SELECT COUNT(*) as count FROM users');
  if (parseInt(userRes.rows[0].count) === 0) {
    await pool.query('INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4)', ['vendor', 'vendor@vendor.snacktime.com', DEFAULT_VENDOR_HASH, 'vendor']);
    await pool.query('INSERT INTO users (username, email, password_hash, role) VALUES ($1, $2, $3, $4)', ['student', 'student@sece.ac.in', DEFAULT_STUDENT_HASH, 'student']);
    console.log('✅ Default users seeded into Cloud PostgreSQL DB!');
  }

  const invRes = await pool.query('SELECT COUNT(*) as count FROM inventory');
  if (parseInt(invRes.rows[0].count) === 0) {
    const items = [
      ['Samosa', 15, 50],
      ['Cold Coffee', 40, 30],
      ['Masala Dosa', 60, 20],
      ['Veg Sandwich', 35, 40],
      ['Tea', 10, 80],
      ['Coffee', 15, 60],
      ['Biscuits', 10, 100],
      ['Bonda', 20, 40],
      ['Sugarcane Juice', 30, 25],
      ['Sweet Corn', 25, 35],
      ['French Fries', 50, 30],
      ['Horlicks', 20, 50],
      ['Boost', 20, 50]
    ];
    for (const item of items) {
      await pool.query('INSERT INTO inventory (name, price, stock) VALUES ($1, $2, $3)', item);
    }
    console.log('✅ Default inventory seeded into Cloud PostgreSQL DB!');
  }

  const setRes = await pool.query('SELECT COUNT(*) as count FROM settings WHERE setting_key = $1', ['shop_status']);
  if (parseInt(setRes.rows[0].count) === 0) {
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2)', ['shop_status', 'open']);
    await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2)', ['break_end_time', 'null']);
  }

  const allUsers = await pool.query('SELECT id, username, email, role FROM users');
  console.log('✅ Cloud PostgreSQL Initialized Successfully! Users in DB:', allUsers.rows);
  await pool.end();
}

run().catch(e => {
  console.error('PostgreSQL Initialization Error:', e);
  pool.end();
  process.exit(1);
});
