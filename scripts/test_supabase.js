/**
 * Diagnostic Script: Test Supabase Database Connection
 * Usage: node scripts/test_supabase.js
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    content.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const parts = trimmed.split('=');
        if (parts.length >= 2) {
            const key = parts[0].trim();
            const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[key]) process.env[key] = val;
        }
    });
}

const supabaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;

async function testSupabase() {
    console.log('Testing Supabase Connection...');
    if (!supabaseUrl) {
        console.error('❌ No SUPABASE_DB_URL or DATABASE_URL found in .env!');
        console.log('👉 Please set SUPABASE_DB_URL in your .env file.');
        process.exit(1);
    }

    console.log(`Connecting to: ${supabaseUrl.replace(/:[^:@]+@/, ':****@')}...`);
    const pool = new Pool({
        connectionString: supabaseUrl,
        ssl: { rejectUnauthorized: false }
    });

    try {
        const res = await pool.query('SELECT NOW() as current_time, version()');
        console.log('✅ Supabase Connection Successful!');
        console.log('Server Time:', res.rows[0].current_time);
        console.log('PostgreSQL Version:', res.rows[0].version.split(' ')[0], res.rows[0].version.split(' ')[1]);
        await pool.end();
        process.exit(0);
    } catch (err) {
        console.error('❌ Connection Failed:', err.message);
        await pool.end();
        process.exit(1);
    }
}

testSupabase();
