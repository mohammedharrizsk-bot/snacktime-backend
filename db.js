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

// PostgreSQL & MySQL Connection Configuration
const DEFAULT_PG_URL = 'postgresql://snacktime_user:PT1ICFTuGctt8QS7da3FmVWMMJ8bLw33@dpg-dadeph2fngtc73b3vv7g-a.singapore-postgres.render.com:5432/snacktime';
const POSTGRES_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || DEFAULT_PG_URL;

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

    // 1. SELECT id FROM users WHERE username = ?
    if (cleanSql.includes('SELECT id FROM users WHERE username =')) {
        const user = jsonData.users.find(u => u.username.toLowerCase() === (params[0] || '').toLowerCase());
        return [user ? [{ id: user.id }] : []];
    }

    // 2. SELECT * FROM users WHERE username = ?
    if (cleanSql.includes('SELECT * FROM users WHERE username =')) {
        const user = jsonData.users.find(u => u.username.toLowerCase() === (params[0] || '').toLowerCase());
        return [user ? [user] : []];
    }

    // 3. SELECT * FROM users WHERE email = ?
    if (cleanSql.includes('SELECT * FROM users WHERE email =')) {
        const user = jsonData.users.find(u => u.email.toLowerCase() === (params[0] || '').toLowerCase());
        return [user ? [user] : []];
    }

    // 4. INSERT INTO users
    if (cleanSql.startsWith('INSERT INTO users')) {
        const newUser = {
            id: jsonData.users.length + 1,
            username: params[0],
            email: params[1],
            password_hash: params[2],
            role: params[3],
            created_at: new Date().toISOString()
        };
        jsonData.users.push(newUser);
        saveJSON();
        return [{ insertId: newUser.id }];
    }

    // 5. UPDATE users SET password_hash = ? WHERE username = ?
    if (cleanSql.includes('UPDATE users SET password_hash =')) {
        const user = jsonData.users.find(u => u.username === params[1]);
        if (user) {
            user.password_hash = params[0];
            saveJSON();
        }
        return [{}];
    }

    // 6. SELECT * FROM inventory
    if (cleanSql.includes('SELECT * FROM inventory')) {
        return [jsonData.inventory];
    }

    // 7. INSERT INTO inventory
    if (cleanSql.startsWith('INSERT INTO inventory')) {
        const newItem = {
            id: jsonData.inventory.length + 1,
            name: params[0],
            price: Number(params[1]),
            stock: Number(params[2]),
            sold: 0,
            is_special: false,
            original_price: null
        };
        jsonData.inventory.push(newItem);
        saveJSON();
        return [{ insertId: newItem.id }];
    }

    // 8. UPDATE inventory SET stock = ? WHERE id = ?
    if (cleanSql.includes('UPDATE inventory SET stock = ? WHERE id = ?')) {
        const item = jsonData.inventory.find(i => Number(i.id) === Number(params[1]));
        if (item) {
            item.stock = Number(params[0]);
            saveJSON();
        }
        return [{}];
    }

    // 9. UPDATE inventory SET price = ? WHERE id = ?
    if (cleanSql.includes('UPDATE inventory SET price = ? WHERE id = ?')) {
        const item = jsonData.inventory.find(i => Number(i.id) === Number(params[1]));
        if (item) {
            item.price = Number(params[0]);
            saveJSON();
        }
        return [{}];
    }

    // 10. DELETE FROM inventory WHERE id = ?
    if (cleanSql.includes('DELETE FROM inventory WHERE id = ?')) {
        jsonData.inventory = jsonData.inventory.filter(i => Number(i.id) !== Number(params[0]));
        saveJSON();
        return [{}];
    }

    // 11. SELECT * FROM orders WHERE id = ?
    if (cleanSql.includes('SELECT * FROM orders WHERE id =')) {
        const order = jsonData.orders.find(o => o.id === params[0]);
        return [order ? [order] : []];
    }

    // 11b. SELECT * FROM orders
    if (cleanSql.includes('SELECT * FROM orders')) {
        const sorted = [...jsonData.orders].sort((a,b) => Number(b.placed_at) - Number(a.placed_at));
        return [sorted];
    }

    // 12. SELECT * FROM order_items WHERE order_id = ?
    if (cleanSql.includes('SELECT * FROM order_items WHERE order_id =')) {
        const items = jsonData.order_items.filter(oi => oi.order_id === params[0]);
        return [items];
    }

    // 13. SELECT stock, name FROM inventory WHERE id = ?
    if (cleanSql.includes('SELECT stock, name FROM inventory WHERE id =')) {
        const item = jsonData.inventory.find(i => Number(i.id) === Number(params[0]));
        return [item ? [{ stock: item.stock, name: item.name }] : []];
    }

    // 14. UPDATE inventory SET stock = stock - ?, sold = sold + ? WHERE id = ?
    if (cleanSql.includes('UPDATE inventory SET stock = stock -')) {
        const item = jsonData.inventory.find(i => Number(i.id) === Number(params[2]));
        if (item) {
            item.stock = Math.max(0, item.stock - Number(params[0]));
            item.sold = item.sold + Number(params[1]);
            saveJSON();
        }
        return [{}];
    }

    // 15. INSERT INTO orders
    if (cleanSql.startsWith('INSERT INTO orders')) {
        const newOrder = {
            id: params[0],
            customer: params[1],
            total: Number(params[2]),
            status: params[3],
            time: params[4],
            placed_at: Number(params[5]),
            method: params[6],
            token: params[7],
            payment_id: params[8],
            rating: null,
            feedback: null,
            cancel_reason: null
        };
        jsonData.orders.push(newOrder);
        saveJSON();
        return [{}];
    }

    // 16. INSERT INTO order_items
    if (cleanSql.startsWith('INSERT INTO order_items')) {
        const newItem = {
            order_id: params[0],
            item_id: Number(params[1]),
            name: params[2],
            qty: Number(params[3]),
            price: Number(params[4])
        };
        jsonData.order_items.push(newItem);
        saveJSON();
        return [{}];
    }

    // 17. UPDATE inventory SET stock = stock + ? WHERE name = ? or id = ?
    if (cleanSql.includes('UPDATE inventory SET stock = stock +')) {
        if (cleanSql.includes('name =')) {
            const item = jsonData.inventory.find(i => i.name === params[1]);
            if (item) {
                item.stock = item.stock + Number(params[0]);
                saveJSON();
            }
        } else {
            const targetId = params.length >= 3 ? params[2] : params[1];
            const item = jsonData.inventory.find(i => Number(i.id) === Number(targetId));
            if (item) {
                item.stock = item.stock + Number(params[0]);
                if (params.length >= 3) {
                    item.sold = Math.max(0, item.sold - Number(params[1]));
                }
                saveJSON();
            }
        }
        return [{}];
    }

    // 18. UPDATE orders SET status = ?, cancel_reason = ? WHERE id = ?
    if (cleanSql.includes('UPDATE orders SET status =') && cleanSql.includes('cancel_reason =')) {
        const order = jsonData.orders.find(o => o.id === params[2]);
        if (order) {
            order.status = params[0];
            order.cancel_reason = params[1];
            saveJSON();
        }
        return [{}];
    }

    // 19. UPDATE orders SET status = ? WHERE id = ?
    if (cleanSql.includes('UPDATE orders SET status =') && !cleanSql.includes('cancel_reason')) {
        const order = jsonData.orders.find(o => o.id === params[1]);
        if (order) {
            order.status = params[0];
            saveJSON();
        }
        return [{}];
    }

    // 20. UPDATE orders SET rating = ?, feedback = ? WHERE id = ?
    if (cleanSql.includes('UPDATE orders SET rating =')) {
        const order = jsonData.orders.find(o => o.id === params[2]);
        if (order) {
            order.rating = Number(params[0]);
            order.feedback = params[1];
            saveJSON();
        }
        return [{}];
    }

    // 21. INSERT INTO reviews
    if (cleanSql.startsWith('INSERT INTO reviews') || cleanSql.startsWith('INSERT INTO Reviews')) {
        const newReview = {
            id: jsonData.reviews.length + 1,
            order_id: params[0],
            customer: params[1],
            items: params[2],
            rating: Number(params[3]),
            feedback: params[4],
            time: params[5]
        };
        jsonData.reviews.push(newReview);
        saveJSON();
        return [{}];
    }

    // 22. SELECT * FROM reviews
    if (cleanSql.includes('SELECT * FROM reviews')) {
        const sorted = [...jsonData.reviews].sort((a,b) => b.id - a.id);
        return [sorted];
    }

    // 23. SELECT * FROM settings
    if (cleanSql.includes('SELECT * FROM settings')) {
        return [jsonData.settings];
    }

    // 24. UPDATE settings SET setting_value = ? WHERE setting_key = "shop_status"
    if (cleanSql.includes('UPDATE settings SET setting_value =') && cleanSql.includes('shop_status')) {
        const setting = jsonData.settings.find(s => s.setting_key === 'shop_status');
        if (setting) {
            setting.setting_value = params[0];
            saveJSON();
        }
        return [{}];
    }

    // 25. UPDATE settings SET setting_value = ? WHERE setting_key = "break_end_time"
    if (cleanSql.includes('UPDATE settings SET setting_value =') && cleanSql.includes('break_end_time')) {
        const setting = jsonData.settings.find(s => s.setting_key === 'break_end_time');
        if (setting) {
            setting.setting_value = params[0];
            saveJSON();
        }
        return [{}];
    }

    // 26. SELECT setting_value FROM settings WHERE setting_key = "shop_status"
    if (cleanSql.includes('SELECT setting_value FROM settings WHERE setting_key = "shop_status"')) {
        const setting = jsonData.settings.find(s => s.setting_key === 'shop_status');
        return [setting ? [setting] : []];
    }

    // 27. INSERT INTO support_tickets
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

    // 29. SELECT * FROM vendors
    if (cleanSql.includes('SELECT * FROM vendors WHERE id =')) {
        const vendor = jsonData.vendors.find(v => Number(v.id) === Number(params[0]));
        return [vendor ? [vendor] : []];
    }
    if (cleanSql.includes('SELECT * FROM vendors')) {
        return [jsonData.vendors];
    }

    // 30. UPDATE vendors SET shop_status = ?, break_end_time = ? WHERE id = ?
    if (cleanSql.includes('UPDATE vendors SET shop_status =') || cleanSql.includes('UPDATE vendors SET')) {
        const targetId = params[params.length - 1];
        const vendor = jsonData.vendors.find(v => Number(v.id) === Number(targetId));
        if (vendor) {
            if (params.length >= 3) {
                vendor.shop_status = params[0];
                vendor.break_end_time = params[1];
            } else if (params.length === 2) {
                vendor.shop_status = params[0];
            }
            saveJSON();
        }
        return [{}];
    }

    // 31. Inventory by vendor_id
    if (cleanSql.includes('FROM inventory WHERE vendor_id =')) {
        const items = jsonData.inventory.filter(i => Number(i.vendor_id || 1) === Number(params[0]));
        return [items];
    }

    // 32. Orders by vendor_id
    if (cleanSql.includes('FROM orders WHERE vendor_id =')) {
        const orders = jsonData.orders.filter(o => Number(o.vendor_id || 1) === Number(params[0]));
        const sorted = [...orders].sort((a,b) => Number(b.placed_at) - Number(a.placed_at));
        return [sorted];
    }

    // 33. Reviews by vendor_id
    if (cleanSql.includes('FROM reviews WHERE vendor_id =')) {
        const reviews = jsonData.reviews.filter(r => Number(r.vendor_id || 1) === Number(params[0]));
        const sorted = [...reviews].sort((a,b) => b.id - a.id);
        return [sorted];
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
            console.log('🐘 Connected to Cloud PostgreSQL Database successfully!');
            await createPgTables();
            await seedPgDatabase();
            return;
        } catch (e) {
            console.warn('⚠️ Cloud PostgreSQL connection notice:', e.message);
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
        const uRes = await pgPool.query('SELECT id FROM users WHERE LOWER(username) = $1 OR id = $2', [u.username.toLowerCase(), u.id]);
        if (uRes.rows.length === 0) {
            await pgPool.query('INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES ($1, $2, $3, $4, $5)', [u.username, u.email, u.password_hash, u.role, u.vendor_id]);
        } else {
            await pgPool.query('UPDATE users SET password_hash = $1, vendor_id = $2 WHERE id = $3 OR LOWER(username) = $4', [u.password_hash, u.vendor_id, u.id, u.username.toLowerCase()]);
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
            await pgPool.query('UPDATE users SET password_hash = $1, vendor_id = $2 WHERE LOWER(username) = $3', [a.hash, a.vendor_id, a.username]);
        }
    }

    // Student account
    const sRes = await pgPool.query('SELECT id FROM users WHERE username = $1', ['student']);
    if (sRes.rows.length === 0) {
        await pgPool.query('INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES ($1, $2, $3, $4, $5)', ['student', 'student@sece.ac.in', DEFAULT_STUDENT_HASH, 'student', null]);
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
    const [sRows] = await pool.query('SELECT id FROM users WHERE username = "student"');
    if (sRows.length === 0) {
        await pool.query(
            'INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES (?, ?, ?, ?, ?)',
            ['student', 'student@sece.ac.in', DEFAULT_STUDENT_HASH, 'student', null]
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

// Wrapper query execution mapping
async function query(sql, params = []) {
    if (currentEngine === 'pg') {
        return queryPg(sql, params);
    } else if (currentEngine === 'mysql') {
        return activePool.query(sql, params);
    } else {
        return mockQuery(sql, params);
    }
}

// Wrapper pool mapping
function getPool() {
    if (currentEngine === 'pg') {
        return {
            query: async (sql, params = []) => queryPg(sql, params),
            getConnection: async () => getPgConnection()
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
