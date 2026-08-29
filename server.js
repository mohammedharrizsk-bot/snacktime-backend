const crypto     = require('crypto');
const express    = require('express');
const http       = require('http');
const socketIo   = require('socket.io');
const cors       = require('cors');
const bcrypt     = require('bcryptjs');
const nodemailer = require('nodemailer');
const jwt        = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit  = require('express-rate-limit');
const helmet     = require('helmet');
const csrf       = require('csurf');
const db         = require('./db');

// Cryptographically secure JWT secret handling
const JWT_SECRET = process.env.JWT_SECRET || (() => {
    const fallback = crypto.randomBytes(32).toString('hex');
    console.warn('⚠️ WARNING: JWT_SECRET not found in process.env. Generated a secure 256-bit runtime secret.');
    return fallback;
})();

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, {
    cors: {
        origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
        methods: ['GET', 'POST']
    }
});

// Trust Nginx reverse-proxy so req.secure works correctly
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
        if (req.secure) return next();
        res.redirect(301, 'https://' + req.headers.host + req.url);
    });
}

// Comprehensive Security Headers Middleware (A+ Security Rating)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                "https://unpkg.com",
                "https://cdn.jsdelivr.net",
                "https://checkout.razorpay.com"
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                "https://fonts.googleapis.com"
            ],
            fontSrc: [
                "'self'",
                "https://fonts.gstatic.com",
                "data:"
            ],
            imgSrc: [
                "'self'",
                "data:",
                "blob:",
                "https:"
            ],
            connectSrc: [
                "'self'",
                "wss:",
                "ws:",
                "https:",
                "http:"
            ],
            frameSrc: [
                "'self'",
                "https://api.razorpay.com",
                "https://checkout.razorpay.com"
            ],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"]
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: {
        maxAge: 63072000,
        includeSubDomains: true,
        preload: true
    }
}));

// Additional Security Headers
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(self "https://checkout.razorpay.com")');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
});

app.use(cookieParser());
app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true
}));

// Payload size limit to prevent Denial of Service (DoS) buffer flooding
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Global Rate limiter for API endpoints (DDoS / Brute-force protection)
const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', globalApiLimiter);

// Rate limiter for auth endpoints
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many login/registration attempts, please try again in a minute.' }
});

// CSRF protection (cookie-based, SameSite=Strict)
const csrfProtection = csrf({
    cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production'
    }
});

// Static file serving
app.use(express.static(__dirname));

// CSRF token endpoint (frontend calls this once on load)
app.get('/api/csrf-token', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
});

// JWT authentication middleware
function authenticate(req, res, next) {
    const token =
        req.cookies.jwt ||
        (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    if (!token) return res.status(401).json({ message: 'Authentication required.' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (_) {
        return res.status(401).json({ message: 'Invalid or expired token.' });
    }
}

// Role-based authorization helper
function authorize(allowedRoles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ message: 'Unauthenticated.' });
        if (!allowedRoles.includes(req.user.role))
            return res.status(403).json({ message: 'Forbidden: insufficient permissions.' });
        next();
    };
}

// ──────────────────────────────────────────────────────────────
// PUBLIC AUTH ROUTES (no authenticate middleware)
// ──────────────────────────────────────────────────────────────

app.post('/api/register', authLimiter, csrfProtection, async (req, res) => {
    const { username, email, password, role } = req.body;

    if (!username || !password || !role)
        return res.status(400).json({ message: 'Username, password and role are required.' });

    if (role === 'student') {
        if (!email)
            return res.status(400).json({ message: 'Email is required for student registration.' });
        if (!email.endsWith('@sece.ac.in'))
            return res.status(400).json({ message: 'Please use your college email (@sece.ac.in).' });
    }

    const targetEmail = role === 'student'
        ? email.toLowerCase()
        : `${username.toLowerCase()}@vendor.snacktime.com`;

    try {
        const [existing] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0)
            return res.status(400).json({ message: 'Username is already taken.' });

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        await db.query(
            'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
            [username, targetEmail, passwordHash, role]
        );

        res.status(201).json({ message: 'Registration successful!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Database error during registration.' });
    }
});

app.post('/api/login', authLimiter, csrfProtection, async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role)
        return res.status(400).json({ message: 'Username, password and role are required.' });

    try {
        const [users] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0)
            return res.status(400).json({ message: 'Username not found.' });

        const user = users[0];

        if (user.role !== role)
            return res.status(400).json({ message: 'Role mismatch.' });

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch)
            return res.status(400).json({ message: 'Invalid credentials.' });

        const token = jwt.sign(
            { username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '2h' }
        );
        res.cookie('jwt', token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production'
        });

        res.json({
            username:  user.username,
            email:     user.email,
            role:      user.role,
            createdAt: user.created_at
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

app.post('/api/logout', csrfProtection, (req, res) => {
    res.clearCookie('jwt');
    res.json({ message: 'Logged out successfully.' });
});

app.post('/api/forgot-password', authLimiter, csrfProtection, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    try {
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        if (users.length === 0)
            return res.status(404).json({ message: 'No account found with this email.' });

        const user = users[0];
        const resetToken = Math.random().toString(36).substring(2, 10).toUpperCase();
        const host = req.get('host');
        const protocol = req.secure ? 'https' : 'http';
        const resetLink = `${protocol}://${host}/?action=reset-password&token=${resetToken}&username=${encodeURIComponent(user.username)}`;

        if (mailTransporter) {
            try {
                await mailTransporter.sendMail({
                    from: '"SNACK TIME Campus Cafe" <noreply@snacktime.sece.ac.in>',
                    to: email,
                    subject: 'SNACK TIME - Password Recovery Link',
                    html: `<div style="font-family:Arial,sans-serif;padding:20px;">
                            <h2 style="color:#ff6b35;">SNACK TIME Password Recovery</h2>
                            <p>Hello, <strong>${user.username}</strong>,</p>
                            <p>Click the button below to reset your password:</p>
                            <a href="${resetLink}" style="background:#ff6b35;color:#fff;padding:12px 24px;text-decoration:none;border-radius:20px;font-weight:bold;display:inline-block;">Reset Password</a>
                            <p style="font-size:0.85rem;color:#8e6852;">If you did not request this, ignore this email.</p>
                           </div>`
                });
            } catch (mailErr) {
                console.warn('SMTP mail send warning:', mailErr.message);
            }
        }

        res.json({
            message: 'Password recovery link created! Check your email or use the link below.',
            resetLink,
            username: user.username
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error generating recovery link.' });
    }
});

app.post('/api/reset-password-confirm', csrfProtection, async (req, res) => {
    const { username, newPassword } = req.body;
    if (!username || !newPassword)
        return res.status(400).json({ message: 'Username and new password are required.' });

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);
        await db.query('UPDATE users SET password_hash = ? WHERE username = ?', [passwordHash, username]);
        res.json({ message: 'Password reset successfully!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error resetting password.' });
    }
});

// ──────────────────────────────────────────────────────────────
// PROTECTED API ROUTES (require JWT + CSRF)
// ──────────────────────────────────────────────────────────────
app.use('/api', authenticate, csrfProtection);

// GET /api/inventory
app.get('/api/inventory', async (req, res) => {
    try {
        const [items] = await db.query('SELECT * FROM inventory ORDER BY id ASC');
        res.json(items.map(i => ({
            id:            Number(i.id),
            name:          i.name,
            price:         Number(i.price),
            stock:         Number(i.stock),
            sold:          Number(i.sold),
            isSpecial:     Boolean(i.is_special),
            originalPrice: i.original_price ? Number(i.original_price) : null,
            vendorId:      i.vendor_id || null
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching inventory.' });
    }
});

// POST /api/inventory
app.post('/api/inventory', authorize(['vendor']), async (req, res) => {
    const { name, price, stock } = req.body;
    if (!name || isNaN(price) || isNaN(stock))
        return res.status(400).json({ message: 'Invalid parameters.' });

    try {
        const [result] = await db.query(
            'INSERT INTO inventory (name, price, stock, sold, is_special, vendor_id) VALUES (?, ?, ?, 0, false, ?)',
            [name, price, stock, req.user.username]
        );
        broadcastInventoryUpdate();
        res.status(201).json({ id: result.insertId, name, price, stock, sold: 0, vendorId: req.user.username });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error adding item.' });
    }
});

// PUT /api/inventory/:id/stock
app.put('/api/inventory/:id/stock', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;
    const { stock } = req.body;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (rows[0].vendor_id && rows[0].vendor_id !== req.user.username)
            return res.status(403).json({ message: "Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET stock = ? WHERE id = ?', [stock, id]);
        broadcastInventoryUpdate();
        res.json({ message: 'Stock updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating stock.' });
    }
});

// PUT /api/inventory/:id/price
app.put('/api/inventory/:id/price', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;
    const { price } = req.body;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (rows[0].vendor_id && rows[0].vendor_id !== req.user.username)
            return res.status(403).json({ message: "Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET price = ? WHERE id = ?', [price, id]);
        broadcastInventoryUpdate();
        res.json({ message: 'Price updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating price.' });
    }
});

// DELETE /api/inventory/:id
app.delete('/api/inventory/:id', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (rows[0].vendor_id && rows[0].vendor_id !== req.user.username)
            return res.status(403).json({ message: "Cannot delete another vendor's product." });

        await db.query('DELETE FROM inventory WHERE id = ?', [id]);
        broadcastInventoryUpdate();
        res.json({ message: 'Item deleted successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting item.' });
    }
});

// GET /api/orders
app.get('/api/orders', async (req, res) => {
    try {
        let ordersQuery = 'SELECT * FROM orders ORDER BY placed_at DESC';
        let queryParams = [];

        if (req.user.role === 'student') {
            ordersQuery = 'SELECT * FROM orders WHERE customer = ? ORDER BY placed_at DESC';
            queryParams = [req.user.username];
        }

        const [orders] = await db.query(ordersQuery, queryParams);
        const fullOrders = [];

        for (const order of orders) {

            const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
            fullOrders.push({
                id:           order.id,
                customer:     order.customer,
                total:        Number(order.total),
                status:       order.status,
                time:         order.time,
                placedAt:     Number(order.placed_at),
                method:       order.method,
                rating:       order.rating,
                feedback:     order.feedback,
                cancelReason: order.cancel_reason,
                token:        order.token,
                paymentId:    order.payment_id,
                items: items.map(item => ({
                    id:    item.item_id,
                    name:  item.name,
                    qty:   item.qty,
                    price: Number(item.price)
                }))
            });
        }
        res.json(fullOrders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching orders.' });
    }
});

// POST /api/orders
app.post('/api/orders', authorize(['student']), async (req, res) => {
    const { id, customer, total, time, placedAt, method, items, token, paymentId, status } = req.body;

    if (!id || !customer || !items || items.length === 0)
        return res.status(400).json({ message: 'Invalid order data.' });

    if (customer !== req.user.username)
        return res.status(403).json({ message: 'You can only place orders for yourself.' });

    const conn = await db.pool().getConnection();
    try {
        await conn.beginTransaction();

        for (const cartItem of items) {
            const [rows] = await conn.query(
                'SELECT stock, name FROM inventory WHERE id = ? FOR UPDATE', [cartItem.id]
            );
            if (rows.length === 0 || rows[0].stock < cartItem.qty) {
                await conn.rollback();
                conn.release();
                const name = rows.length > 0 ? rows[0].name : 'Item';
                return res.status(400).json({ message: `"${name}" is now out of stock. Please update your cart.` });
            }
        }

        for (const cartItem of items) {
            await conn.query(
                'UPDATE inventory SET stock = stock - ?, sold = sold + ? WHERE id = ?',
                [cartItem.qty, cartItem.qty, cartItem.id]
            );
        }

        const orderStatus = status || 'pending';
        await conn.query(
            'INSERT INTO orders (id, customer, total, status, time, placed_at, method, token, payment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, customer, total, orderStatus, time, placedAt, method, token || null, paymentId || null]
        );

        for (const cartItem of items) {
            await conn.query(
                'INSERT INTO order_items (order_id, item_id, name, qty, price) VALUES (?, ?, ?, ?, ?)',
                [id, cartItem.id, cartItem.name, cartItem.qty, cartItem.price]
            );
        }

        await conn.commit();
        conn.release();

        const createdOrder = { id, customer, total, status: orderStatus, time, placedAt, method, items, token, paymentId };
        broadcastOrderUpdate(createdOrder);
        broadcastInventoryUpdate();
        res.status(201).json(createdOrder);
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error(err);
        res.status(500).json({ message: 'Database checkout error.' });
    }
});

// PUT /api/orders/:id/status
app.put('/api/orders/:id/status', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;
    const { status, cancelReason } = req.body;

    const conn = await db.pool().getConnection();
    try {
        await conn.beginTransaction();

        const [orders] = await conn.query('SELECT * FROM orders WHERE id = ? FOR UPDATE', [id]);
        if (orders.length === 0) {
            await conn.rollback();
            conn.release();
            return res.status(404).json({ message: 'Order not found.' });
        }

        const currentOrder = orders[0];

        if (status === 'cancelled' || status === 'expired') {
            const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [id]);
            for (const item of items) {
                await conn.query(
                    'UPDATE inventory SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id = ?',
                    [item.qty, item.qty, item.item_id]
                );
            }
        }

        await conn.query(
            'UPDATE orders SET status = ?, cancel_reason = ? WHERE id = ?',
            [status, cancelReason || null, id]
        );

        await conn.commit();
        conn.release();

        const updatedOrder = { ...currentOrder, status, cancel_reason: cancelReason || null };
        broadcastOrderUpdate(updatedOrder);
        broadcastInventoryUpdate();
        res.json(updatedOrder);
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error(err);
        res.status(500).json({ message: 'Error updating order status.' });
    }
});

// POST /api/reviews
app.post('/api/reviews', authorize(['student']), async (req, res) => {
    const { orderId, customer, items, rating, feedback, time } = req.body;

    if (customer !== req.user.username)
        return res.status(403).json({ message: 'You can only review your own orders.' });

    try {
        await db.query(
            'INSERT INTO reviews (order_id, customer, items, rating, feedback, time) VALUES (?, ?, ?, ?, ?, ?)',
            [orderId, customer, items, rating, feedback || null, time]
        );
        await db.query(
            'UPDATE orders SET rating = ?, feedback = ? WHERE id = ?',
            [rating, feedback || null, orderId]
        );
        io.emit('reviews_updated');
        res.status(201).json({ message: 'Review submitted successfully!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error submitting review.' });
    }
});

// GET /api/reviews
app.get('/api/reviews', async (req, res) => {
    try {
        const [reviews] = await db.query('SELECT * FROM reviews ORDER BY id DESC');
        res.json(reviews);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching reviews.' });
    }
});

// POST /api/support-tickets
app.post('/api/support-tickets', async (req, res) => {
    const { orderId, message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required.' });

    try {
        const [result] = await db.query(
            'INSERT INTO support_tickets (username, order_id, message, status) VALUES (?, ?, ?, "open")',
            [req.user.username, orderId || null, message]
        );
        res.status(201).json({ id: result.insertId, message: 'Support ticket submitted successfully!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error submitting support ticket.' });
    }
});

// GET /api/support-tickets
app.get('/api/support-tickets', async (req, res) => {
    try {
        let sql = 'SELECT * FROM support_tickets ORDER BY id DESC';
        let params = [];

        if (req.user.role === 'student') {
            sql = 'SELECT * FROM support_tickets WHERE username = ? ORDER BY id DESC';
            params = [req.user.username];
        }

        const [tickets] = await db.query(sql, params);
        res.json(tickets);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching support tickets.' });
    }
});

// GET /api/settings
app.get('/api/settings', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT * FROM settings');
        const map = {};
        rows.forEach(r => {
            let val = r.setting_value;
            if (val === 'null')   val = null;
            if (val === 'open')   val = true;
            if (val === 'closed') val = false;
            map[r.setting_key] = val;
        });
        res.json({
            shopOpen:     map.shop_status !== false,
            breakEndTime: map.break_end_time ? Number(map.break_end_time) : null
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching settings.' });
    }
});

// PUT /api/settings/shop
app.put('/api/settings/shop', authorize(['vendor']), async (req, res) => {
    const { shopOpen } = req.body;
    const value = shopOpen ? 'open' : 'closed';
    try {
        await db.query('UPDATE settings SET setting_value = ? WHERE setting_key = "shop_status"', [value]);
        if (!shopOpen)
            await db.query('UPDATE settings SET setting_value = "null" WHERE setting_key = "break_end_time"');
        const settings = { shopOpen, breakEndTime: null };
        broadcastShopStatus(settings);
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating shop status.' });
    }
});

// PUT /api/settings/break
app.put('/api/settings/break', authorize(['vendor']), async (req, res) => {
    const { minutes } = req.body;
    if (!minutes || isNaN(minutes))
        return res.status(400).json({ message: 'Invalid minutes.' });

    const breakEndTime = Date.now() + minutes * 60000;
    try {
        await db.query('UPDATE settings SET setting_value = "open" WHERE setting_key = "shop_status"');
        await db.query(
            'UPDATE settings SET setting_value = ? WHERE setting_key = "break_end_time"',
            [String(breakEndTime)]
        );
        const settings = { shopOpen: true, breakEndTime };
        broadcastShopStatus(settings);
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error setting break timer.' });
    }
});

// DELETE /api/settings/break
app.delete('/api/settings/break', authorize(['vendor']), async (req, res) => {
    try {
        await db.query('UPDATE settings SET setting_value = "null" WHERE setting_key = "break_end_time"');
        const [rows] = await db.query('SELECT setting_value FROM settings WHERE setting_key = "shop_status"');
        const shopOpen = rows[0].setting_value === 'open';
        const settings = { shopOpen, breakEndTime: null };
        broadcastShopStatus(settings);
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error clearing break timer.' });
    }
});

// ── CENTRALIZED ERROR HANDLER (Masks stack traces in production) ────────────
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).json({ message: 'Invalid or missing CSRF token. Please refresh the page.' });
    }
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ message: 'Payload too large. Request aborted.' });
    }
    console.error('Unhandled Application Error:', err);
    res.status(err.status || 500).json({
        message: process.env.NODE_ENV === 'production' ? 'Internal server error.' : (err.message || 'Server error.')
    });
});

// ── REAL-TIME (SOCKET.IO) ────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log('⚡ Client connected:', socket.id);

    socket.on('join_room', (room) => {
        socket.join(room);
        console.log(`Socket ${socket.id} joined room: ${room}`);
    });

    // Client emitted order placement
    socket.on('place_order', (orderPayload) => {
        io.to('vendors').emit('orders_updated', orderPayload);
    });

    // Client emitted order status update
    socket.on('update_order_status', (orderData) => {
        if (orderData && orderData.customer) {
            io.to(`student_${orderData.customer}`).emit('order_status_changed', orderData);
        }
        io.to('vendors').emit('orders_updated', orderData);
    });

    // Client emitted inventory update
    socket.on('update_inventory', (inventoryData) => {
        io.emit('inventory_updated', inventoryData);
    });

    // Client emitted reviews/feedback update
    socket.on('update_reviews', (reviewsData) => {
        io.to('vendors').emit('reviews_updated', reviewsData);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
    });
});

function broadcastInventoryUpdate() { io.emit('inventory_updated'); }
function broadcastOrderUpdate(order) {
    if (order && order.customer) {
        io.to(`student_${order.customer}`).emit('order_status_changed', order);
    }
    io.to('vendors').emit('orders_updated', order);
}
function broadcastShopStatus(status) { io.emit('shop_status_changed', status); }

// ── NODEMAILER ───────────────────────────────────────────────────────────────
const SMTP_CONFIG = {
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   Number(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE !== 'false',
    auth: {
        user: process.env.SMTP_USER || 'YOUR_EMAIL@gmail.com',
        pass: process.env.SMTP_PASS || 'YOUR_APP_PASSWORD'
    }
};

let mailTransporter;
async function initNodemailer() {
    if (SMTP_CONFIG.auth.user !== 'YOUR_EMAIL@gmail.com') {
        mailTransporter = nodemailer.createTransport(SMTP_CONFIG);
        console.log('Custom SMTP Mailer configured.');
    } else {
        try {
            const testAccount = await nodemailer.createTestAccount();
            mailTransporter = nodemailer.createTransport({
                host: 'smtp.ethereal.email',
                port: 587,
                secure: false,
                auth: { user: testAccount.user, pass: testAccount.pass }
            });
            console.log('Nodemailer running in TEST mode (Ethereal Email).');
        } catch (e) {
            console.error('Failed to initialise SMTP mailer:', e);
        }
    }
}

// ── SERVER LAUNCH ────────────────────────────────────────────────────────────
const PORT     = Number(process.env.PORT) || 3000;
const ALT_PORT = 3001;

async function startServer() {
    try {
        await db.initDB();
        await initNodemailer();

        const listenOnPort = (port) => {
            server.listen(port, () => {
                console.log(`SNACK TIME Backend running on http://localhost:${port}`);
            }).on('error', (err) => {
                if ((err.code === 'EACCES' || err.code === 'EADDRINUSE') && port === PORT) {
                    console.log(`Port ${PORT} busy. Trying ${ALT_PORT}...`);
                    listenOnPort(ALT_PORT);
                } else {
                    console.error('Server failed to start:', err);
                }
            });
        };

        listenOnPort(PORT);
    } catch (err) {
        console.error('Server failed to start:', err);
    }
}

startServer();

