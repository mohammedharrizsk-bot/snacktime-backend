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

// MySQL Connection Configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '', // Default fallback
    database: process.env.DB_NAME || 'snacktime'
};

let pool = null;
let activePool = null;
let isMySQL = true;

// Pre-seeded hashes for default accounts
const DEFAULT_VENDOR_HASH = bcrypt.hashSync('vendor123', 10);
const DEFAULT_STUDENT_HASH = bcrypt.hashSync('student123', 10);

// ========================= MOCK JSON DATABASE ENGINE =========================
let jsonData = {
    users: [
        {
            id: 1,
            username: 'vendor',
            email: 'vendor@vendor.snacktime.com',
            password_hash: DEFAULT_VENDOR_HASH,
            role: 'vendor',
            created_at: new Date().toISOString()
        },
        {
            id: 2,
            username: 'student',
            email: 'student@sece.ac.in',
            password_hash: DEFAULT_STUDENT_HASH,
            role: 'student',
            created_at: new Date().toISOString()
        }
    ],
    inventory: [
        { id: 1,  name: "Samosa",          price: 15,  stock: 50, sold: 12, is_special: false, original_price: null },
        { id: 2,  name: "Cold Coffee",     price: 40,  stock: 30, sold: 5,  is_special: false, original_price: null  },
        { id: 3,  name: "Masala Dosa",     price: 60,  stock: 20, sold: 8,  is_special: false, original_price: null  },
        { id: 4,  name: "Veg Sandwich",    price: 35,  stock: 40, sold: 15, is_special: false, original_price: null },
        { id: 5,  name: "Tea",             price: 10,  stock: 80, sold: 30, is_special: false, original_price: null },
        { id: 6,  name: "Coffee",          price: 15,  stock: 60, sold: 22, is_special: false, original_price: null },
        { id: 7,  name: "Biscuits",        price: 10,  stock: 100, sold: 45, is_special: false, original_price: null },
        { id: 8,  name: "Bonda",           price: 20,  stock: 40, sold: 18, is_special: false, original_price: null },
        { id: 9,  name: "Sugarcane Juice", price: 30,  stock: 25, sold: 10, is_special: false, original_price: null },
        { id: 10, name: "Sweet Corn",      price: 25,  stock: 35, sold: 14, is_special: false, original_price: null },
        { id: 11, name: "French Fries",    price: 50,  stock: 30, sold: 9,  is_special: false, original_price: null  },
        { id: 12, name: "Horlicks",        price: 20,  stock: 50, sold: 0,  is_special: false, original_price: null  },
        { id: 13, name: "Boost",           price: 20,  stock: 50, sold: 0,  is_special: false, original_price: null  }
    ],
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

    // 28. SELECT * FROM support_tickets
    if (cleanSql.includes('SELECT * FROM support_tickets')) {
        const sorted = [...jsonData.support_tickets].sort((a,b) => b.id - a.id);
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
    const defaultPassword = dbConfig.password;
    const passwordsToTry = [defaultPassword, '', 'root', 'admin', 'password', '123456', '12345678', 'mysql'];
    const uniquePasswords = [...new Set(passwordsToTry)];
    
    let connected = false;
    let lastError = null;

    for (const pwd of uniquePasswords) {
        try {
            const connection = await mysql.createConnection({
                host: dbConfig.host,
                user: dbConfig.user,
                password: pwd
            });
            await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
            await connection.end();

            dbConfig.password = pwd;
            connected = true;
            isMySQL = true;
            console.log(`🔑 Connected to MySQL successfully using password: "${pwd}"`);
            break;
        } catch (e) {
            lastError = e;
            if (e.code === 'ECONNREFUSED') {
                break;
            }
        }
    }

    if (connected) {
        pool = mysql.createPool(dbConfig);
        activePool = pool;
        await createTables();
        await seedDatabase();
        console.log('✅ MySQL Database initialized and tables checked.');
    } else {
        isMySQL = false;
        loadJSON();
        console.log(`
⚠️ MySQL connection failed (Access Denied or Not Running).
👉 FALLING BACK to a self-contained local JSON database ("snacktime_db.json")!
🚀 Node server running offline mode — everything will work out of the box with zero dependencies!
        `);
    }
}

async function createTables() {
    // 1. Users Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            email VARCHAR(100),
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('student', 'vendor') NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // 2. Inventory / Menu Table
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

    // 3. Orders Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
            id VARCHAR(50) PRIMARY KEY,
            user_id INT NULL,
            vendor_id INT DEFAULT 1,
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

    // Ensure columns exist if table was already created
    try {
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id INT NULL;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS vendor_id INT DEFAULT 1;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS time VARCHAR(50) NULL;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS token INT NULL;`);
        await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_id VARCHAR(100) NULL;`);
        await pool.query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS vendor_id INT DEFAULT 1;`);
        await pool.query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS version INT DEFAULT 1;`);
        await pool.query(`ALTER TABLE inventory ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;`);
    } catch (e) {
        try { await pool.query(`ALTER TABLE orders ADD COLUMN user_id INT NULL;`); } catch(err) {}
        try { await pool.query(`ALTER TABLE orders ADD COLUMN vendor_id INT DEFAULT 1;`); } catch(err) {}
        try { await pool.query(`ALTER TABLE orders ADD COLUMN version INT DEFAULT 1;`); } catch(err) {}
        try { await pool.query(`ALTER TABLE orders ADD COLUMN time VARCHAR(50) NULL;`); } catch(err) {}
        try { await pool.query(`ALTER TABLE orders ADD COLUMN token INT NULL;`); } catch(err) {}
        try { await pool.query(`ALTER TABLE orders ADD COLUMN payment_id VARCHAR(100) NULL;`); } catch(err) {}
        try { await pool.query(`ALTER TABLE inventory ADD COLUMN vendor_id INT DEFAULT 1;`); } catch(err) {}
        try { await pool.query(`ALTER TABLE inventory ADD COLUMN version INT DEFAULT 1;`); } catch(err) {}
    }

    // 4. Order Items Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS order_items (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id VARCHAR(50) NOT NULL,
            item_id INT NOT NULL,
            name VARCHAR(100) NOT NULL,
            qty INT NOT NULL,
            price DECIMAL(10, 2) NOT NULL,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
        );
    `);

    // 5. Settings Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
            setting_key VARCHAR(50) PRIMARY KEY,
            setting_value VARCHAR(255)
        );
    `);

    // 6. Reviews / Feedback Table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS reviews (
            id INT AUTO_INCREMENT PRIMARY KEY,
            order_id VARCHAR(50) NOT NULL,
            customer VARCHAR(50) NOT NULL,
            items TEXT NOT NULL,
            rating INT NOT NULL,
            feedback TEXT NULL,
            time VARCHAR(100) NOT NULL
        );
    `);

    // 7. Support Tickets Table
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
    const [userRows] = await pool.query('SELECT COUNT(*) as count FROM users');
    if (userRows[0].count === 0) {
        console.log('🌱 Seeding default vendor & student accounts into MySQL...');
        await pool.query(
            'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
            ['vendor', 'vendor@vendor.snacktime.com', DEFAULT_VENDOR_HASH, 'vendor']
        );
        await pool.query(
            'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
            ['student', 'student@sece.ac.in', DEFAULT_STUDENT_HASH, 'student']
        );
    }

    const [rows] = await pool.query('SELECT COUNT(*) as count FROM inventory');
    if (rows[0].count === 0) {
        console.log('🌱 Seeding initial inventory into MySQL...');
        const initialInventory = [
            { id: 1,  name: "Samosa",          price: 15,  stock: 50, sold: 12 },
            { id: 2,  name: "Cold Coffee",     price: 40,  stock: 30, sold: 5  },
            { id: 3,  name: "Masala Dosa",     price: 60,  stock: 20, sold: 8  },
            { id: 4,  name: "Veg Sandwich",    price: 35,  stock: 40, sold: 15 },
            { id: 5,  name: "Tea",             price: 10,  stock: 80, sold: 30 },
            { id: 6,  name: "Coffee",          price: 15,  stock: 60, sold: 22 },
            { id: 7,  name: "Biscuits",        price: 10,  stock: 100, sold: 45 },
            { id: 8,  name: "Bonda",           price: 20,  stock: 40, sold: 18 },
            { id: 9,  name: "Sugarcane Juice", price: 30,  stock: 25, sold: 10 },
            { id: 10, name: "Sweet Corn",      price: 25,  stock: 35, sold: 14 },
            { id: 11, name: "French Fries",    price: 50,  stock: 30, sold: 9  },
            { id: 12, name: "Horlicks",        price: 20,  stock: 50, sold: 0  },
            { id: 13, name: "Boost",           price: 20,  stock: 50, sold: 0  }
        ];

        for (const item of initialInventory) {
            await pool.query(
                'INSERT INTO inventory (id, name, price, stock, sold, is_special, original_price) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [item.id, item.name, item.price, item.stock, item.sold, false, null]
            );
        }
    }

    const [settingRows] = await pool.query('SELECT COUNT(*) as count FROM settings WHERE setting_key = "shop_status"');
    if (settingRows[0].count === 0) {
        await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ("shop_status", "open")');
        await pool.query('INSERT INTO settings (setting_key, setting_value) VALUES ("break_end_time", "null")');
    }
}

// Wrapper query execution mapping
async function query(sql, params) {
    if (isMySQL) {
        return activePool.query(sql, params);
    } else {
        return mockQuery(sql, params);
    }
}

// Wrapper pool mapping
function getPool() {
    if (isMySQL) {
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
