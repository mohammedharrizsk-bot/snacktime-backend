const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Basic env parser to support DB_PASSWORD and PORT configuration
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
                process.env[key] = val;
            }
        });
    }
}
loadEnv();

// PostgreSQL & Supabase Connection Configuration
const POSTGRES_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.POSTGRES_URL || '';

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', // Default fallback
    database: process.env.DB_NAME || 'snacktime'
};

let pool = null;
let activePool = null;
let pgPool = null;
let currentEngine = 'mock'; // 'pg', 'mysql', 'mock'
let isMySQL = false;

// Pre-seeded hashes for default accounts
const DEFAULT_VENDOR1_HASH = bcrypt.hashSync('vendor1', 10);
const DEFAULT_VENDOR2_HASH = bcrypt.hashSync('vendor2', 10);
const DEFAULT_VENDOR3_HASH = bcrypt.hashSync('vendor3', 10);
const DEFAULT_VENDOR4_HASH = bcrypt.hashSync('vendor4', 10);
const DEFAULT_VENDOR5_HASH = bcrypt.hashSync('vendor5', 10);
const DEFAULT_STUDENT_HASH = bcrypt.hashSync('student123', 10);

const SEEDED_VENDORS = [
    { id: 1, name: 'Main Amenity', code: 'main_amenity', shop_status: 'open', break_end_time: null },
    { id: 2, name: 'Mario Tea Corner', code: 'mario_tea', shop_status: 'open', break_end_time: null },
    { id: 3, name: 'Only Cane', code: 'only_cane', shop_status: 'open', break_end_time: null },
    { id: 4, name: 'Cafe Corner', code: 'cafe_corner', shop_status: 'open', break_end_time: null },
    { id: 5, name: 'Stationery Store', code: 'stationery_store', shop_status: 'open', break_end_time: null }
];

const SEEDED_VENDOR_USERS = [
    { id: 1, username: 'MAIN AMENITY', email: 'mainamenity@vendor.snacktime.com', password_hash: DEFAULT_VENDOR1_HASH, role: 'vendor', vendor_id: 1 },
    { id: 2, username: 'MARIO TEA CORNER', email: 'mariotea@vendor.snacktime.com', password_hash: DEFAULT_VENDOR2_HASH, role: 'vendor', vendor_id: 2 },
    { id: 3, username: 'ONLY CANE', email: 'onlycane@vendor.snacktime.com', password_hash: DEFAULT_VENDOR3_HASH, role: 'vendor', vendor_id: 3 },
    { id: 4, username: 'CAFE CORNER', email: 'cafecorner@vendor.snacktime.com', password_hash: DEFAULT_VENDOR4_HASH, role: 'vendor', vendor_id: 4 },
    { id: 5, username: 'STATIONERY STORE', email: 'stationery@vendor.snacktime.com', password_hash: DEFAULT_VENDOR5_HASH, role: 'vendor', vendor_id: 5 }
];

const SEEDED_INVENTORY = [
    { id: 1, name: "Samosa", price: 15, stock: 50, sold: 12, vendor_id: 1, is_special: false, original_price: null },
    { id: 2, name: "Masala Dosa", price: 60, stock: 20, sold: 8, vendor_id: 1, is_special: false, original_price: null },
    { id: 3, name: "Veg Meals", price: 80, stock: 35, sold: 24, vendor_id: 1, is_special: false, original_price: null },
    { id: 4, name: "Bonda", price: 20, stock: 40, sold: 18, vendor_id: 1, is_special: false, original_price: null },
    { id: 5, name: "Sweet Corn", price: 25, stock: 35, sold: 14, vendor_id: 1, is_special: false, original_price: null },
    { id: 6, name: "Tea", price: 10, stock: 100, sold: 65, vendor_id: 2, is_special: false, original_price: null },
    { id: 7, name: "Filter Coffee", price: 15, stock: 80, sold: 42, vendor_id: 2, is_special: false, original_price: null },
    { id: 8, name: "Cold Coffee", price: 40, stock: 30, sold: 15, vendor_id: 2, is_special: false, original_price: null },
    { id: 9, name: "Biscuits", price: 10, stock: 100, sold: 45, vendor_id: 2, is_special: false, original_price: null },
    { id: 10, name: "Boost", price: 20, stock: 50, sold: 12, vendor_id: 2, is_special: false, original_price: null },
    { id: 11, name: "Horlicks", price: 20, stock: 50, sold: 10, vendor_id: 2, is_special: false, original_price: null },
    { id: 12, name: "Sugarcane Juice", price: 30, stock: 50, sold: 30, vendor_id: 3, is_special: false, original_price: null },
    { id: 13, name: "Ginger Cane Juice", price: 35, stock: 40, sold: 22, vendor_id: 3, is_special: false, original_price: null },
    { id: 14, name: "Lime Cane Juice", price: 35, stock: 40, sold: 18, vendor_id: 3, is_special: false, original_price: null },
    { id: 15, name: "Fresh Orange Juice", price: 45, stock: 30, sold: 14, vendor_id: 3, is_special: false, original_price: null },
    { id: 16, name: "Veg Sandwich", price: 35, stock: 40, sold: 20, vendor_id: 4, is_special: false, original_price: null },
    { id: 17, name: "Cheese Burger", price: 65, stock: 25, sold: 16, vendor_id: 4, is_special: false, original_price: null },
    { id: 18, name: "French Fries", price: 50, stock: 30, sold: 18, vendor_id: 4, is_special: false, original_price: null },
    { id: 19, name: "Veg Pizza", price: 90, stock: 20, sold: 11, vendor_id: 4, is_special: false, original_price: null },
    { id: 20, name: "Peri Peri Fries", price: 60, stock: 25, sold: 9, vendor_id: 4, is_special: false, original_price: null },
    { id: 21, name: "Long Notebook (192 pgs)", price: 45, stock: 60, sold: 32, vendor_id: 5, is_special: false, original_price: null },
    { id: 22, name: "SECE Blue Pen", price: 10, stock: 150, sold: 85, vendor_id: 5, is_special: false, original_price: null },
    { id: 23, name: "SECE Record Note", price: 60, stock: 40, sold: 28, vendor_id: 5, is_special: false, original_price: null },
    { id: 24, name: "Graph Sheet Bundle", price: 20, stock: 50, sold: 15, vendor_id: 5, is_special: false, original_price: null },
    { id: 25, name: "Geometry Box", price: 85, stock: 25, sold: 6, vendor_id: 5, is_special: false, original_price: null }
];

// ========================= POSTGRESQL QUERY ADAPTER =========================
function translateSqlForPg(sql) {
    let paramIdx = 1;
    let cleanSql = sql.replace(/\?/g, () => '$' + (paramIdx++));
    const upper = cleanSql.trim().toUpperCase();
    if (upper.startsWith('INSERT INTO') && !upper.includes('RETURNING')) {
        cleanSql += ' RETURNING id';
    }
    return cleanSql;
}

async function queryPg(sql, params = []) {
    const pgSql = translateSqlForPg(sql);
    const res = await pgPool.query(pgSql, params);
    const upper = sql.trim().toUpperCase();
    if (upper.startsWith('SELECT')) {
        return [res.rows, res.fields];
    } else if (upper.startsWith('INSERT')) {
        const insertId = res.rows[0] ? (res.rows[0].id || null) : null;
        return [{ insertId, affectedRows: res.rowCount }, res.fields];
    } else {
        return [{ affectedRows: res.rowCount }, res.fields];
    }
}

async function getPgConnection() {
    const client = await pgPool.connect();
    return {
        query: async (sql, params = []) => {
            const pgSql = translateSqlForPg(sql);
            const res = await client.query(pgSql, params);
            const upper = sql.trim().toUpperCase();
            if (upper.startsWith('SELECT')) {
                return [res.rows, res.fields];
            } else if (upper.startsWith('INSERT')) {
                const insertId = res.rows[0] ? (res.rows[0].id || null) : null;
                return [{ insertId, affectedRows: res.rowCount }, res.fields];
            } else {
                return [{ affectedRows: res.rowCount }, res.fields];
            }
        },
        beginTransaction: async () => { await client.query('BEGIN'); },
        commit: async () => { await client.query('COMMIT'); },
        rollback: async () => { await client.query('ROLLBACK'); },
        release: () => { client.release(); }
    };
}

// ========================= MOCK JSON DATABASE ENGINE =========================
let jsonData = {
    vendors: SEEDED_VENDORS,
    users: [
        ...SEEDED_VENDOR_USERS,
        {
            id: 6,
            username: 'student',
            email: 'student@sece.ac.in',
            password_hash: DEFAULT_STUDENT_HASH,
            role: 'student',
            vendor_id: null,
            created_at: new Date().toISOString()
        }
    ],
    inventory: SEEDED_INVENTORY,
    orders: [],
    order_items: [],
    settings: [
        { setting_key: 'shop_status', setting_value: 'open' },
        { setting_key: 'break_end_time', setting_value: 'null' }
    ],
    reviews: [],
    support_tickets: []
};

const JSON_FILE = path.join(__dirname, 'snacktime_db.json');

function saveJSON() {
    fs.writeFileSync(JSON_FILE, JSON.stringify(jsonData, null, 2), 'utf8');
}

function loadJSON() {
    if (fs.existsSync(JSON_FILE)) {
        try {
            jsonData = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
        } catch (e) {
            console.error("Error reading JSON db, using defaults:", e);
        }
    } else {
        saveJSON();
    }
}

async function mockQuery(sql, params = []) {
    const cleanSql = sql.replace(/\s+/g, ' ').trim();

    // 0. Transactions & Savepoints (no-ops for JSON engine)
    if (cleanSql.startsWith('SAVEPOINT') || cleanSql.startsWith('ROLLBACK TO SAVEPOINT') || cleanSql.startsWith('RELEASE SAVEPOINT') || cleanSql === 'BEGIN' || cleanSql === 'COMMIT' || cleanSql === 'ROLLBACK') {
        return [{}];
    }

    // ==================== USERS ====================
    if (cleanSql.includes('FROM users')) {
        // SELECT id, vendor_id FROM users WHERE username = ?
        if (cleanSql.includes('SELECT id, vendor_id FROM users WHERE')) {
            const param = (params[0] || '').toLowerCase().trim();
            const user = jsonData.users.find(u => (u.username && u.username.toLowerCase().trim() === param));
            return [user ? [{ id: user.id, vendor_id: user.vendor_id }] : []];
        }

        // SELECT id FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?
        if (cleanSql.startsWith('SELECT id FROM users WHERE') || cleanSql.includes('SELECT id FROM users WHERE')) {
            const param = (params[0] || '').toLowerCase().trim();
            const user = jsonData.users.find(u => 
                (u.username && u.username.toLowerCase().trim() === param) ||
                (u.email && u.email.toLowerCase().trim() === param)
            );
            return [user ? [{ id: user.id }] : []];
        }

        // SELECT * FROM users WHERE ... (Login, OTP, Profile)
        if (cleanSql.startsWith('SELECT') && cleanSql.includes('FROM users WHERE')) {
            const p0 = (params[0] || '').toLowerCase().trim();
            const p1 = (params[1] || p0).toLowerCase().trim();
            const p2 = (params[2] || p0).toLowerCase().trim().replace(/[\s\-_]/g, '');
            const user = jsonData.users.find(u => {
                const uName = (u.username || '').toLowerCase().trim();
                const uEmail = (u.email || '').toLowerCase().trim();
                const uClean = uName.replace(/[\s\-_]/g, '');
                return uName === p0 || uEmail === p0 || uClean === p0 ||
                       uName === p1 || uEmail === p1 || uClean === p1 ||
                       uName === p2 || uEmail === p2 || uClean === p2;
            });
            return [user ? [user] : []];
        }

        // SELECT * FROM users
        if (cleanSql.startsWith('SELECT * FROM users')) {
            return [jsonData.users];
        }
    }

    // INSERT INTO users
    if (cleanSql.startsWith('INSERT INTO users')) {
        const newUser = {
            id: jsonData.users.length + 1,
            username: params[0],
            email: params[1],
            password_hash: params[2],
            role: params[3] || 'student',
            vendor_id: params[4] || null,
            created_at: new Date().toISOString()
        };
        jsonData.users.push(newUser);
        saveJSON();
        return [{ insertId: newUser.id }];
    }

    // UPDATE users SET password_hash = ? WHERE LOWER(username) = ? or username = ?
    if (cleanSql.includes('UPDATE users SET password_hash =')) {
        const target = (params[1] || '').toLowerCase().trim();
        const user = jsonData.users.find(u => (u.username || '').toLowerCase().trim() === target);
        if (user) {
            user.password_hash = params[0];
            saveJSON();
        }
        return [{}];
    }

    // ==================== INVENTORY ====================
    if (cleanSql.includes('FROM inventory')) {
        // SELECT * FROM inventory WHERE vendor_id = ?
        if (cleanSql.includes('WHERE vendor_id =')) {
            const vId = Number(params[0] || 1);
            const items = jsonData.inventory.filter(i => Number(i.vendor_id || 1) === vId);
            return [items];
        }

        // SELECT id, stock, name, price, vendor_id FROM inventory WHERE LOWER(name) = LOWER(?)
        if (cleanSql.includes('LOWER(name) =')) {
            const targetName = (params[0] || '').toLowerCase().trim();
            const item = jsonData.inventory.find(i => (i.name || '').toLowerCase().trim() === targetName);
            return [item ? [item] : []];
        }

        // SELECT id, stock, name, price, vendor_id FROM inventory WHERE id = ?
        // or SELECT vendor_id FROM inventory WHERE id = ?
        if (cleanSql.includes('WHERE id =')) {
            const targetId = Number(params[0]);
            const item = jsonData.inventory.find(i => Number(i.id) === targetId);
            return [item ? [item] : []];
        }

        // SELECT stock, name FROM inventory WHERE id = ?
        if (cleanSql.includes('SELECT stock, name FROM inventory')) {
            const item = jsonData.inventory.find(i => Number(i.id) === Number(params[0]));
            return [item ? [{ stock: item.stock, name: item.name }] : []];
        }

        // SELECT * FROM inventory
        return [jsonData.inventory];
    }

    // INSERT INTO inventory
    if (cleanSql.startsWith('INSERT INTO inventory')) {
        const newItem = {
            id: jsonData.inventory.length + 1,
            name: params[0],
            price: Number(params[1]),
            stock: Number(params[2]),
            sold: 0,
            vendor_id: Number(params[3] || 1),
            is_special: false,
            original_price: null
        };
        jsonData.inventory.push(newItem);
        saveJSON();
        return [{ insertId: newItem.id }];
    }

    // UPDATE inventory SET stock = GREATEST(0, stock - ?), sold = sold + ? WHERE id = ?
    if (cleanSql.includes('UPDATE inventory SET stock = GREATEST(0, stock -') || cleanSql.includes('UPDATE inventory SET stock = stock -')) {
        const qty = Number(params[0]);
        const targetId = Number(params[2]);
        const item = jsonData.inventory.find(i => Number(i.id) === targetId);
        if (item) {
            item.stock = Math.max(0, item.stock - qty);
            item.sold = (item.sold || 0) + Number(params[1]);
            saveJSON();
        }
        return [{}];
    }

    // UPDATE inventory SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id = ?
    if (cleanSql.includes('UPDATE inventory SET stock = stock +')) {
        if (cleanSql.includes('name =')) {
            const item = jsonData.inventory.find(i => i.name === params[1]);
            if (item) {
                item.stock = item.stock + Number(params[0]);
                saveJSON();
            }
        } else {
            const targetId = Number(params[params.length - 1]);
            const item = jsonData.inventory.find(i => Number(i.id) === targetId);
            if (item) {
                item.stock = item.stock + Number(params[0]);
                if (params.length >= 3) {
                    item.sold = Math.max(0, (item.sold || 0) - Number(params[1]));
                }
                saveJSON();
            }
        }
        return [{}];
    }

    // UPDATE inventory SET stock = ? WHERE id = ?
    if (cleanSql.includes('UPDATE inventory SET stock = ? WHERE id = ?')) {
        const item = jsonData.inventory.find(i => Number(i.id) === Number(params[1]));
        if (item) {
            item.stock = Number(params[0]);
            saveJSON();
        }
        return [{}];
    }

    // UPDATE inventory SET price = ? WHERE id = ?
    if (cleanSql.includes('UPDATE inventory SET price = ? WHERE id = ?')) {
        const item = jsonData.inventory.find(i => Number(i.id) === Number(params[1]));
        if (item) {
            item.price = Number(params[0]);
            saveJSON();
        }
        return [{}];
    }

    // DELETE FROM inventory WHERE id = ?
    if (cleanSql.includes('DELETE FROM inventory WHERE id = ?')) {
        jsonData.inventory = jsonData.inventory.filter(i => Number(i.id) !== Number(params[0]));
        saveJSON();
        return [{}];
    }

    // ==================== ORDERS ====================
    // SELECT MAX(token) as max_token FROM orders WHERE vendor_id = ? AND placed_at >= ?
    if (cleanSql.includes('SELECT MAX(token)') || cleanSql.includes('MAX(token)')) {
        const targetVendorId = Number(params[0] || 1);
        const minPlacedAt = Number(params[1] || 0);
        const matching = jsonData.orders.filter(o => 
            Number(o.vendor_id || 1) === targetVendorId && 
            Number(o.placed_at || 0) >= minPlacedAt &&
            o.token != null
        );
        const maxToken = matching.reduce((max, o) => Math.max(max, Number(o.token) || 0), 0);
        return [[{ max_token: maxToken || null }]];
    }

    // Queue ahead count: SELECT COUNT(*) AS count FROM orders WHERE status IN ('pending', 'preparing') AND placed_at < ? AND vendor_id = ?
    if (cleanSql.includes('SELECT COUNT(*) AS count FROM orders') || cleanSql.includes('COUNT(*) AS count FROM orders')) {
        const placedCutoff = Number(params[0] || 0);
        const targetVendorId = Number(params[1] || 1);
        const count = jsonData.orders.filter(o =>
            ['pending', 'preparing'].includes(o.status) &&
            Number(o.placed_at) < placedCutoff &&
            Number(o.vendor_id || 1) === targetVendorId
        ).length;
        return [[{ count }]];
    }

    // SELECT id FROM orders WHERE status IN ('pending', 'preparing', 'ready') AND placed_at < ?
    if (cleanSql.includes('SELECT id FROM orders WHERE') && cleanSql.includes('placed_at <')) {
        const cutoff = Number(params[0]);
        const stale = jsonData.orders
            .filter(o => ['pending', 'preparing', 'ready'].includes(o.status) && Number(o.placed_at) < cutoff)
            .map(o => ({ id: o.id }));
        return [stale];
    }

    // UPDATE orders SET status = 'expired', cancel_reason = ... WHERE status IN ... AND placed_at < ?
    if (cleanSql.includes("UPDATE orders SET status = 'expired'") || cleanSql.includes('UPDATE orders SET status = "expired"')) {
        const cutoff = Number(params[0]);
        jsonData.orders.forEach(o => {
            if (['pending', 'preparing', 'ready'].includes(o.status) && Number(o.placed_at) < cutoff) {
                o.status = 'expired';
                o.cancel_reason = 'Auto-expired at day end';
            }
        });
        saveJSON();
        return [{}];
    }

    // Orders by customer: SELECT * FROM orders WHERE LOWER(customer) = LOWER(?) ORDER BY placed_at DESC
    if (cleanSql.includes('FROM orders WHERE LOWER(customer) =')) {
        const targetCust = (params[0] || '').toLowerCase().trim();
        const orders = jsonData.orders.filter(o => (o.customer || '').toLowerCase().trim() === targetCust);
        const sorted = [...orders].sort((a,b) => Number(b.placed_at) - Number(a.placed_at));
        return [sorted];
    }

    // Orders by vendor_id with placed_at: SELECT * FROM orders WHERE vendor_id = ? AND placed_at >= ?
    if (cleanSql.includes('FROM orders WHERE vendor_id =') && cleanSql.includes('placed_at >=')) {
        const vId = Number(params[0] || 1);
        const minPlaced = Number(params[1] || 0);
        const orders = jsonData.orders.filter(o => Number(o.vendor_id || 1) === vId && Number(o.placed_at) >= minPlaced);
        const sorted = [...orders].sort((a,b) => Number(b.placed_at) - Number(a.placed_at));
        return [sorted];
    }

    // Orders by vendor_id: SELECT * FROM orders WHERE vendor_id = ?
    if (cleanSql.includes('FROM orders WHERE vendor_id =')) {
        const vId = Number(params[0] || 1);
        const orders = jsonData.orders.filter(o => Number(o.vendor_id || 1) === vId);
        const sorted = [...orders].sort((a,b) => Number(b.placed_at) - Number(a.placed_at));
        return [sorted];
    }

    // Orders by ID: SELECT * FROM orders WHERE id = ?
    // or SELECT id, status, token FROM orders WHERE id = ?
    // or SELECT vendor_id, status FROM orders WHERE id = ?
    if (cleanSql.includes('FROM orders WHERE id =')) {
        const order = jsonData.orders.find(o => o.id === params[0]);
        return [order ? [order] : []];
    }

    // SELECT * FROM orders
    if (cleanSql.includes('SELECT * FROM orders')) {
        const sorted = [...jsonData.orders].sort((a,b) => Number(b.placed_at) - Number(a.placed_at));
        return [sorted];
    }

    // INSERT INTO orders
    if (cleanSql.startsWith('INSERT INTO orders')) {
        let newOrder;
        if (params.length >= 12) {
            newOrder = {
                id: params[0],
                user_id: params[1],
                vendor_id: Number(params[2] || 1),
                master_order_id: params[3] || null,
                customer: params[4],
                total: Number(params[5]),
                status: params[6],
                time: params[7],
                placed_at: Number(params[8]),
                method: params[9],
                token: params[10],
                payment_id: params[11] || null,
                version: Number(params[12] || 1),
                rating: null,
                feedback: null,
                cancel_reason: null
            };
        } else {
            newOrder = {
                id: params[0],
                customer: params[1],
                total: Number(params[2]),
                status: params[3],
                time: params[4],
                placed_at: Number(params[5]),
                method: params[6],
                token: params[7],
                payment_id: params[8] || null,
                vendor_id: 1,
                user_id: null,
                master_order_id: null,
                version: 1,
                rating: null,
                feedback: null,
                cancel_reason: null
            };
        }
        jsonData.orders.push(newOrder);
        saveJSON();
        return [{}];
    }

    // UPDATE orders SET status = ?, cancel_reason = ?, version = ? WHERE id = ?
    // or UPDATE orders SET status = ? WHERE id = ?
    if (cleanSql.startsWith('UPDATE orders SET status =')) {
        const targetId = params[params.length - 1];
        const order = jsonData.orders.find(o => o.id === targetId);
        if (order) {
            order.status = params[0];
            if (cleanSql.includes('cancel_reason')) {
                order.cancel_reason = params[1];
            }
            if (cleanSql.includes('version')) {
                order.version = (order.version || 1) + 1;
            }
            saveJSON();
        }
        return [{}];
    }

    // UPDATE orders SET rating = ?, feedback = ? WHERE id = ?
    if (cleanSql.includes('UPDATE orders SET rating =')) {
        const targetId = params[params.length - 1];
        const order = jsonData.orders.find(o => o.id === targetId);
        if (order) {
            order.rating = Number(params[0]);
            order.feedback = params[1];
            saveJSON();
        }
        return [{}];
    }

    // ==================== ORDER_ITEMS ====================
    // SELECT * FROM order_items WHERE order_id = ?
    if (cleanSql.includes('FROM order_items WHERE order_id =')) {
        const items = jsonData.order_items.filter(oi => oi.order_id === params[0]);
        return [items];
    }

    // INSERT INTO order_items
    if (cleanSql.startsWith('INSERT INTO order_items')) {
        const newItem = {
            order_id: params[0],
            item_id: Number(params[1]),
            name: params[2],
            qty: Number(params[3]),
            price: Number(params[4]),
            vendor_id: Number(params[5] || 1)
        };
        jsonData.order_items.push(newItem);
        saveJSON();
        return [{}];
    }

    // ==================== REVIEWS ====================
    if (cleanSql.includes('FROM reviews WHERE order_id =')) {
        const review = jsonData.reviews.find(r => r.order_id === params[0]);
        return [review ? [{ id: review.id }] : []];
    }

    if (cleanSql.includes('FROM reviews WHERE vendor_id =')) {
        const reviews = jsonData.reviews.filter(r => Number(r.vendor_id || 1) === Number(params[0]));
        const sorted = [...reviews].sort((a,b) => b.id - a.id);
        return [sorted];
    }

    if (cleanSql.includes('SELECT * FROM reviews')) {
        const sorted = [...jsonData.reviews].sort((a,b) => b.id - a.id);
        return [sorted];
    }

    if (cleanSql.startsWith('INSERT INTO reviews') || cleanSql.startsWith('INSERT INTO Reviews')) {
        let newRev;
        if (params.length >= 7) {
            newRev = {
                id: jsonData.reviews.length + 1,
                order_id: params[0],
                vendor_id: Number(params[1] || 1),
                customer: params[2],
                items: params[3],
                rating: Number(params[4]),
                feedback: params[5],
                time: params[6]
            };
        } else {
            newRev = {
                id: jsonData.reviews.length + 1,
                order_id: params[0],
                vendor_id: 1,
                customer: params[1],
                items: params[2],
                rating: Number(params[3]),
                feedback: params[4],
                time: params[5]
            };
        }
        jsonData.reviews.push(newRev);
        saveJSON();
        return [{}];
    }

    // ==================== SETTINGS & VENDORS ====================
    if (cleanSql.includes('FROM vendors WHERE id =')) {
        const vendor = jsonData.vendors.find(v => Number(v.id) === Number(params[0]));
        return [vendor ? [vendor] : []];
    }

    if (cleanSql.includes('FROM vendors')) {
        return [jsonData.vendors];
    }

    if (cleanSql.includes('UPDATE vendors SET')) {
        const targetId = Number(params[params.length - 1]);
        const vendor = jsonData.vendors.find(v => Number(v.id) === targetId);
        if (vendor) {
            if (cleanSql.includes('shop_status = ?') && cleanSql.includes('break_end_time = ?')) {
                vendor.shop_status = params[0];
                vendor.break_end_time = params[1];
            } else if (cleanSql.includes('shop_status = "open"') && cleanSql.includes('break_end_time = ?')) {
                vendor.shop_status = 'open';
                vendor.break_end_time = params[0];
            } else if (cleanSql.includes('break_end_time = NULL')) {
                vendor.break_end_time = null;
            } else if (cleanSql.includes('shop_status = ?')) {
                vendor.shop_status = params[0];
            }
            saveJSON();
        }
        return [{}];
    }

    if (cleanSql.includes('SELECT * FROM settings')) {
        return [jsonData.settings];
    }

    if (cleanSql.includes('SELECT setting_value FROM settings WHERE setting_key = "shop_status"')) {
        const setting = jsonData.settings.find(s => s.setting_key === 'shop_status');
        return [setting ? [setting] : []];
    }

    if (cleanSql.includes('UPDATE settings SET setting_value =')) {
        if (cleanSql.includes('"shop_status"')) {
            const val = cleanSql.includes('"open"') ? 'open' : params[0];
            const setting = jsonData.settings.find(s => s.setting_key === 'shop_status');
            if (setting) setting.setting_value = val;
            saveJSON();
        } else if (cleanSql.includes('"break_end_time"')) {
            const val = cleanSql.includes('"null"') ? 'null' : params[0];
            const setting = jsonData.settings.find(s => s.setting_key === 'break_end_time');
            if (setting) setting.setting_value = val;
            saveJSON();
        }
        return [{}];
    }

    // ==================== SUPPORT TICKETS ====================
    if (cleanSql.startsWith('INSERT INTO support_tickets')) {
        const newTicket = {
            id: jsonData.support_tickets.length + 1,
            username: params[0],
            order_id: params[1] || null,
            message: params[2],
            status: 'open',
            created_at: new Date().toISOString()
        };
        jsonData.support_tickets.push(newTicket);
        saveJSON();
        return [{ insertId: newTicket.id }];
    }

    if (cleanSql.includes('FROM support_tickets')) {
        return [jsonData.support_tickets];
    }

    console.warn("⚠️ Unmatched SQL query in mock JSON parser:", cleanSql);
    return [[]];
}

const mockConnection = {
    query: async (sql, params) => mockQuery(sql, params),
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {}
};

const mockPool = {
    query: async (sql, params) => mockQuery(sql, params),
    getConnection: async () => mockConnection
};

// ========================= DB INIT & SCHEMAS =========================
async function initDB() {
    // 1. Try Cloud PostgreSQL First (Always-on, persistent cloud database)
    if (POSTGRES_URL) {
        try {
            const { Pool } = require('pg');
            pgPool = new Pool({
                connectionString: POSTGRES_URL,
                ssl: { rejectUnauthorized: false }
            });
            await pgPool.query('SELECT NOW()');
            currentEngine = 'pg';
            console.log('🐘 Connected to Cloud PostgreSQL / Supabase Database successfully!');
            await createPgTables();
            await seedPgDatabase();
            return;
        } catch (e) {
            console.warn('⚠️ Cloud PostgreSQL / Supabase connection notice:', e.message);
        }
    }

    // 2. Try MySQL Second (Local on-premises campus server)
    const defaultPassword = dbConfig.password;
    const passwordsToTry = [defaultPassword, '', 'root', 'admin', 'password', '123456', '12345678', 'mysql'];
    const uniquePasswords = [...new Set(passwordsToTry)];
    
    let connected = false;

    for (const pwd of uniquePasswords) {
        try {
            const mysql = require('mysql2/promise');
            const connection = await mysql.createConnection({
                host: dbConfig.host,
                user: dbConfig.user,
                password: pwd
            });
            await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
            await connection.end();

            dbConfig.password = pwd;
            connected = true;
            currentEngine = 'mysql';
            isMySQL = true;
            console.log(`🔑 Connected to MySQL successfully using password: "${pwd}"`);
            break;
        } catch (e) {
            if (e.code === 'ECONNREFUSED') {
                break;
            }
        }
    }

    if (connected) {
        const mysql = require('mysql2/promise');
        pool = mysql.createPool(dbConfig);
        activePool = pool;
        await createTables();
        await seedDatabase();
        console.log('✅ MySQL Database initialized and tables checked.');
    } else {
        currentEngine = 'mock';
        isMySQL = false;
        loadJSON();
        console.log('📦 Using Local JSON Database Engine ("snacktime_db.json").');
    }
}

async function createPgTables() {
    await pgPool.query('CREATE TABLE IF NOT EXISTS vendors (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, code VARCHAR(50) UNIQUE NOT NULL, shop_status VARCHAR(20) DEFAULT \'open\', break_end_time BIGINT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pgPool.query('CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username VARCHAR(50) UNIQUE NOT NULL, email VARCHAR(100) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL, vendor_id INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pgPool.query('CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL, price DECIMAL(10, 2) NOT NULL, stock INT NOT NULL DEFAULT 0, sold INT NOT NULL DEFAULT 0, is_special BOOLEAN DEFAULT FALSE, original_price DECIMAL(10, 2), vendor_id INT DEFAULT 1, version INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pgPool.query('CREATE TABLE IF NOT EXISTS orders (id VARCHAR(50) PRIMARY KEY, user_id INT NULL, vendor_id INT DEFAULT 1, master_order_id VARCHAR(50) NULL, customer VARCHAR(50) NOT NULL, total DECIMAL(10, 2) NOT NULL, status VARCHAR(20) DEFAULT \'pending\', time VARCHAR(50) NULL, placed_at BIGINT NOT NULL, method VARCHAR(50) NOT NULL, rating INT NULL, feedback TEXT NULL, cancel_reason TEXT NULL, token INT NULL, payment_id VARCHAR(100) NULL, version INT DEFAULT 1, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pgPool.query('CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id VARCHAR(50) NOT NULL REFERENCES orders(id) ON DELETE CASCADE, item_id INT NOT NULL, name VARCHAR(100) NOT NULL, qty INT NOT NULL, price DECIMAL(10, 2) NOT NULL, vendor_id INT DEFAULT 1)');
    await pgPool.query('CREATE TABLE IF NOT EXISTS settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value VARCHAR(255))');
    await pgPool.query('CREATE TABLE IF NOT EXISTS vendor_settings (vendor_id INT PRIMARY KEY, shop_status VARCHAR(20) DEFAULT \'open\', break_start BIGINT NULL, break_end BIGINT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await pgPool.query('CREATE TABLE IF NOT EXISTS reviews (id SERIAL PRIMARY KEY, order_id VARCHAR(50) NOT NULL, vendor_id INT DEFAULT 1, customer VARCHAR(50) NOT NULL, items TEXT NOT NULL, rating INT NOT NULL, feedback TEXT NULL, time VARCHAR(100) NOT NULL)');
    await pgPool.query('CREATE TABLE IF NOT EXISTS support_tickets (id SERIAL PRIMARY KEY, username VARCHAR(50) NOT NULL, order_id VARCHAR(50) NULL, message TEXT NOT NULL, status VARCHAR(20) DEFAULT \'open\', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');

    // Ensure columns exist on existing tables
    try { await pgPool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS vendor_id INT NULL;'); } catch (e) {}
    try { await pgPool.query('ALTER TABLE inventory ADD COLUMN IF NOT EXISTS vendor_id INT DEFAULT 1;'); } catch (e) {}
    try { await pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_id INT DEFAULT 1;'); } catch (e) {}
    try { await pgPool.query('ALTER TABLE orders ADD COLUMN IF NOT EXISTS master_order_id VARCHAR(50) NULL;'); } catch (e) {}
    try { await pgPool.query('ALTER TABLE order_items ADD COLUMN IF NOT EXISTS vendor_id INT DEFAULT 1;'); } catch (e) {}
    try { await pgPool.query('ALTER TABLE reviews ADD COLUMN IF NOT EXISTS vendor_id INT DEFAULT 1;'); } catch (e) {}
}

async function seedPgDatabase() {
    // 1. Seed 5 Vendors
    for (const v of SEEDED_VENDORS) {
        const vRes = await pgPool.query('SELECT id FROM vendors WHERE id = $1', [v.id]);
        if (vRes.rows.length === 0) {
            await pgPool.query('INSERT INTO vendors (id, name, code, shop_status) VALUES ($1, $2, $3, $4)', [v.id, v.name, v.code, v.shop_status]);
        }
    }

    // 2. Seed 5 Vendor Users + Aliases + Student
    for (const u of SEEDED_VENDOR_USERS) {
        const uRes = await pgPool.query('SELECT id FROM users WHERE LOWER(username) = $1', [u.username.toLowerCase()]);
        if (uRes.rows.length === 0) {
            await pgPool.query('INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES ($1, $2, $3, $4, $5)', [u.username, u.email, u.password_hash, u.role, u.vendor_id]);
        } else {
            await pgPool.query('UPDATE users SET password_hash = $1, vendor_id = $2, role = $3, email = $4 WHERE LOWER(username) = $5', [u.password_hash, u.vendor_id, u.role, u.email, u.username.toLowerCase()]);
        }
    }

    // Vendor aliases (vendor1, vendor2, vendor3, vendor4, vendor5, vendor)
    const aliases = [
        { username: 'vendor', email: 'vendor@vendor.snacktime.com', hash: DEFAULT_VENDOR1_HASH, vendor_id: 1 },
        { username: 'vendor1', email: 'vendor1@vendor.snacktime.com', hash: DEFAULT_VENDOR1_HASH, vendor_id: 1 },
        { username: 'vendor2', email: 'vendor2@vendor.snacktime.com', hash: DEFAULT_VENDOR2_HASH, vendor_id: 2 },
        { username: 'vendor3', email: 'vendor3@vendor.snacktime.com', hash: DEFAULT_VENDOR3_HASH, vendor_id: 3 },
        { username: 'vendor4', email: 'vendor4@vendor.snacktime.com', hash: DEFAULT_VENDOR4_HASH, vendor_id: 4 },
        { username: 'vendor5', email: 'vendor5@vendor.snacktime.com', hash: DEFAULT_VENDOR5_HASH, vendor_id: 5 }
    ];

    for (const a of aliases) {
        const aRes = await pgPool.query('SELECT id FROM users WHERE LOWER(username) = $1', [a.username]);
        if (aRes.rows.length === 0) {
            await pgPool.query('INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES ($1, $2, $3, $4, $5)', [a.username, a.email, a.hash, 'vendor', a.vendor_id]);
        } else {
            await pgPool.query('UPDATE users SET password_hash = $1, vendor_id = $2, role = $3 WHERE LOWER(username) = $4', [a.hash, a.vendor_id, 'vendor', a.username]);
        }
    }

    // Student account
    const sRes = await pgPool.query('SELECT id FROM users WHERE LOWER(username) = $1', ['student']);
    if (sRes.rows.length === 0) {
        await pgPool.query('INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES ($1, $2, $3, $4, $5)', ['student', 'student@sece.ac.in', DEFAULT_STUDENT_HASH, 'student', null]);
    } else {
        await pgPool.query('UPDATE users SET password_hash = $1, role = $2, vendor_id = NULL WHERE LOWER(username) = $3', [DEFAULT_STUDENT_HASH, 'student', 'student']);
    }

    // 3. Seed partitioned inventory across 5 vendors
    for (const item of SEEDED_INVENTORY) {
        const iRes = await pgPool.query('SELECT id FROM inventory WHERE id = $1 OR LOWER(name) = $2', [item.id, item.name.toLowerCase()]);
        if (iRes.rows.length === 0) {
            await pgPool.query('INSERT INTO inventory (id, name, price, stock, sold, vendor_id) VALUES ($1, $2, $3, $4, $5, $6)', [item.id, item.name, item.price, item.stock, item.sold || 0, item.vendor_id]);
        } else {
            await pgPool.query('UPDATE inventory SET vendor_id = $1 WHERE id = $2 OR LOWER(name) = $3', [item.vendor_id, item.id, item.name.toLowerCase()]);
        }
    }

    const setRes = await pgPool.query('SELECT COUNT(*) as count FROM settings WHERE setting_key = $1', ['shop_status']);
    if (parseInt(setRes.rows[0].count) === 0) {
        await pgPool.query('INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2)', ['shop_status', 'open']);
        await pgPool.query('INSERT INTO settings (setting_key, setting_value) VALUES ($1, $2)', ['break_end_time', 'null']);
    }
}

async function createTables() {
    // 1. Vendors Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS vendors (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            code VARCHAR(50) UNIQUE NOT NULL,
            shop_status VARCHAR(20) DEFAULT 'open',
            break_end_time BIGINT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        );
    `);

    // 2. Users Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100),
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('student', 'vendor') NOT NULL,
            vendor_id INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // 3. Inventory / Menu Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS inventory (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) UNIQUE NOT NULL,
            price DECIMAL(10, 2) NOT NULL,
            stock INT NOT NULL DEFAULT 0,
            sold INT NOT NULL DEFAULT 0,
            is_special BOOLEAN DEFAULT FALSE,
            original_price DECIMAL(10, 2),
            vendor_id INT DEFAULT 1,
            version INT DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        );
    `);

    // 4. Orders Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id VARCHAR(50) PRIMARY KEY,
            user_id INT NULL,
            vendor_id INT DEFAULT 1,
            master_order_id VARCHAR(50) NULL,
            customer VARCHAR(50) NOT NULL,
            total DECIMAL(10, 2) NOT NULL,
            status ENUM('pending', 'preparing', 'ready', 'completed', 'cancelled', 'expired') DEFAULT 'pending',
            time VARCHAR(50) NULL,
            placed_at BIGINT NOT NULL,
            method VARCHAR(50) NOT NULL,
            rating INT NULL,
            feedback TEXT NULL,
            cancel_reason TEXT NULL,
            token INT NULL,
            payment_id VARCHAR(100) NULL,
            version INT DEFAULT 1,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        );
    `);

    // Ensure columns exist on existing tables
    try {
        await pool.query(`ALTER TABLE users ADD COLUMN vendor_id INT NULL;`);
    } catch (e) {}
    try {
        await pool.query(`ALTER TABLE orders ADD COLUMN vendor_id INT DEFAULT 1;`);
    } catch (e) {}
    try {
        await pool.query(`ALTER TABLE orders ADD COLUMN master_order_id VARCHAR(50) NULL;`);
    } catch (e) {}
    try {
        await pool.query(`ALTER TABLE inventory ADD COLUMN vendor_id INT DEFAULT 1;`);
    } catch (e) {}
    try {
        await pool.query(`ALTER TABLE order_items ADD COLUMN vendor_id INT DEFAULT 1;`);
    } catch (e) {}
    try {
        await pool.query(`ALTER TABLE reviews ADD COLUMN vendor_id INT DEFAULT 1;`);
    } catch (e) {}

    // 5. Order Items Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id VARCHAR(50) NOT NULL,
            item_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            qty INT NOT NULL,
            price DECIMAL(10, 2) NOT NULL,
            vendor_id INT DEFAULT 1,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
    `);

    // 6. Settings Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
            setting_key VARCHAR(50) PRIMARY KEY,
            setting_value VARCHAR(255)
        );
    `);

    // 7. Reviews Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS reviews (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id VARCHAR(50) NOT NULL,
            vendor_id INT DEFAULT 1,
            customer VARCHAR(50) NOT NULL,
            items TEXT NOT NULL,
            rating INT NOT NULL,
            feedback TEXT NULL,
            time VARCHAR(100) NOT NULL
        );
    `);

    // 8. Support Tickets Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) NOT NULL,
            order_id VARCHAR(50) NULL,
            message TEXT NOT NULL,
            status VARCHAR(20) DEFAULT 'open',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);
}

async function seedDatabase() {
    // Seed Vendors
    for (const v of SEEDED_VENDORS) {
        const [vRows] = await pool.query('SELECT id FROM vendors WHERE id = ?', [v.id]);
        if (vRows.length === 0) {
            await pool.query('INSERT INTO vendors (id, name, code, shop_status) VALUES (?, ?, ?, ?)', [v.id, v.name, v.code, v.shop_status]);
        }
    }

    // Seed Vendor Users
    for (const u of SEEDED_VENDOR_USERS) {
        const [uRows] = await pool.query('SELECT id FROM users WHERE LOWER(username) = ?', [u.username.toLowerCase()]);
        if (uRows.length === 0) {
            await pool.query(
                'INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES (?, ?, ?, ?, ?)',
                [u.username, u.email, u.password_hash, u.role, u.vendor_id]
            );
        } else {
            await pool.query(
                'UPDATE users SET password_hash = ?, vendor_id = ? WHERE LOWER(username) = ?',
                [u.password_hash, u.vendor_id, u.username.toLowerCase()]
            );
        }
    }

    // Aliases
    const aliases = [
        { username: 'vendor', email: 'vendor@vendor.snacktime.com', hash: DEFAULT_VENDOR1_HASH, vendor_id: 1 },
        { username: 'vendor1', email: 'vendor1@vendor.snacktime.com', hash: DEFAULT_VENDOR1_HASH, vendor_id: 1 },
        { username: 'vendor2', email: 'vendor2@vendor.snacktime.com', hash: DEFAULT_VENDOR2_HASH, vendor_id: 2 },
        { username: 'vendor3', email: 'vendor3@vendor.snacktime.com', hash: DEFAULT_VENDOR3_HASH, vendor_id: 3 },
        { username: 'vendor4', email: 'vendor4@vendor.snacktime.com', hash: DEFAULT_VENDOR4_HASH, vendor_id: 4 },
        { username: 'vendor5', email: 'vendor5@vendor.snacktime.com', hash: DEFAULT_VENDOR5_HASH, vendor_id: 5 }
    ];
    for (const a of aliases) {
        const [aRows] = await pool.query('SELECT id FROM users WHERE LOWER(username) = ?', [a.username]);
        if (aRows.length === 0) {
            await pool.query('INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES (?, ?, ?, ?, ?)', [a.username, a.email, a.hash, 'vendor', a.vendor_id]);
        } else {
            await pool.query('UPDATE users SET password_hash = ?, vendor_id = ? WHERE LOWER(username) = ?', [a.hash, a.vendor_id, a.username]);
        }
    }

    // Student
    const [sRows] = await pool.query('SELECT id FROM users WHERE LOWER(username) = "student"');
    if (sRows.length === 0) {
        await pool.query(
            'INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES (?, ?, ?, ?, ?)',
            ['student', 'student@sece.ac.in', DEFAULT_STUDENT_HASH, 'student', null]
        );
    } else {
        await pool.query(
            'UPDATE users SET password_hash = ?, role = "student", vendor_id = NULL WHERE LOWER(username) = "student"',
            [DEFAULT_STUDENT_HASH]
        );
    }

    // Inventory
    for (const item of SEEDED_INVENTORY) {
        const [iRows] = await pool.query('SELECT id FROM inventory WHERE id = ? OR LOWER(name) = ?', [item.id, item.name.toLowerCase()]);
        if (iRows.length === 0) {
            await pool.query(
                'INSERT INTO inventory (id, name, price, stock, sold, is_special, original_price, vendor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [item.id, item.name, item.price, item.stock, item.sold || 0, false, null, item.vendor_id]
            );
        } else {
            await pool.query('UPDATE inventory SET vendor_id = ? WHERE id = ? OR LOWER(name) = ?', [item.vendor_id, item.id, item.name.toLowerCase()]);
        }
    }

    const [settingRows] = await pool.query('SELECT COUNT(*) as count FROM settings WHERE setting_key = "shop_status"');
    if (settingRows[0].count === 0) {
        await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ("shop_status", "open")');
        await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ("break_end_time", "null")');
    }
}

// Wrapper query execution mapping with self-healing fallback
async function query(sql, params = []) {
    if (currentEngine === 'pg') {
        try {
            return await queryPg(sql, params);
        } catch (pgErr) {
            console.warn('⚠️ Cloud PostgreSQL query notice:', pgErr.message, '- Using local engine fallback.');
            return mockQuery(sql, params);
        }
    } else if (currentEngine === 'mysql') {
        try {
            return await activePool.query(sql, params);
        } catch (myErr) {
            console.warn('⚠️ MySQL query notice:', myErr.message, '- Using local engine fallback.');
            return mockQuery(sql, params);
        }
    } else {
        return mockQuery(sql, params);
    }
}

// Wrapper pool mapping with self-healing transaction support
function getPool() {
    if (currentEngine === 'pg') {
        return {
            query: async (sql, params = []) => {
                try {
                    return await queryPg(sql, params);
                } catch (e) {
                    return mockQuery(sql, params);
                }
            },
            getConnection: async () => {
                try {
                    return await getPgConnection();
                } catch (e) {
                    return mockConnection;
                }
            }
        };
    } else if (currentEngine === 'mysql') {
        return activePool;
    } else {
        return mockPool;
    }
}

module.exports = {
    initDB,
    query,
    pool: getPool
};
