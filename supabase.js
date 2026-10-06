/**
 * Supabase Client Integration Module for SNACK TIME
 * 
 * Provides direct access to Supabase services:
 * - Realtime subscriptions
 * - Storage (for item photos/receipts)
 * - Managed PostgreSQL Auth and Database
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

// Ensure .env is loaded
function loadEnv() {
    const envPath = path.join(__dirname, '.env');
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
}
loadEnv();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

let supabase = null;

if (supabaseUrl && supabaseKey) {
    try {
        supabase = createClient(supabaseUrl, supabaseKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false
            }
        });
        console.log('⚡ Supabase Client initialized successfully!');
    } catch (err) {
        console.warn('⚠️ Failed to initialize Supabase client:', err.message);
    }
}

module.exports = {
    supabase,
    isConfigured: () => Boolean(supabase),
    getUrl: () => supabaseUrl
};
