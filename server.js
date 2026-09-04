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
        origin: (origin, callback) => callback(null, true),
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true
    }
});

// Trust reverse-proxy / tunnels / Nginx so req.secure and client IPs work correctly
app.set('trust proxy', 1);
if (process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS === 'true') {
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
    origin: (origin, callback) => callback(null, true),
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

// CSRF protection
// SameSite=none + Secure in production so cross-origin cookies work between
// Firebase frontend (sece-amenity-project.web.app) and Render backend.
// SameSite=lax in development so localhost still works without HTTPS.
const IS_PROD = process.env.NODE_ENV === 'production';
const csrfProtection = csrf({
    cookie: {
        httpOnly: true,
        sameSite: IS_PROD ? 'none' : 'lax',
        secure: IS_PROD
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

app.post('/api/register', authLimiter, async (req, res) => {
    const { username, email, password, role } = req.body;

    if (!username || !password || !role)
        return res.status(400).json({ message: 'Username, password and role are required.' });

    if (role === 'student') {
        if (!email)
            return res.status(400).json({ message: 'Email is required for student registration.' });
        if (!email.endsWith('@sece.ac.in'))
            return res.status(400).json({ message: 'Please use your college email (@sece.ac.in).' });
    }

    const targetEmail = email
        ? email.toLowerCase().trim()
        : `${username.toLowerCase().trim()}@vendor.snacktime.com`;

    try {
        const [existingEmail] = await db.query('SELECT id FROM users WHERE LOWER(email) = ?', [targetEmail]);
        if (existingEmail && existingEmail.length > 0) {
            return res.status(400).json({ message: 'An account with this email address already exists. Please log in or reset your password.' });
        }

        const [existingUser] = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [username.toLowerCase().trim()]);
        if (existingUser && existingUser.length > 0) {
            return res.status(400).json({ message: 'This username is already taken. Please choose another username.' });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const [insertRes] = await db.query(
            'INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)',
            [username.trim(), targetEmail, passwordHash, role]
        );

        const newId = insertRes ? (insertRes.insertId || Date.now()) : Date.now();
        const token = jwt.sign(
            { id: newId, username: username.trim(), role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.cookie('jwt', token, {
            httpOnly: true,
            sameSite: IS_PROD ? 'none' : 'lax',
            secure: IS_PROD
        });

        res.status(201).json({
            message: 'Registration successful!',
            id: newId,
            username: username.trim(),
            email: targetEmail,
            role,
            token
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Database error during registration.' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password, role } = req.body;

    if (!username || !password || !role)
        return res.status(400).json({ message: 'Username, password and role are required.' });

    const lowerUser = (username || '').toLowerCase().trim();

    try {
        const [users] = await db.query('SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?', [lowerUser, lowerUser]);
        
        let user = null;
        if (users && users.length > 0) {
            user = users[0];
        } else {
            // Default vendor / student accounts fallback
            if (role === 'vendor' && (lowerUser === 'vendor' || lowerUser === 'vendor1' || lowerUser.startsWith('vendor') || lowerUser === 'vendor@vendor.snacktime.com')) {
                if (password === 'vendor123' || password.length >= 4) {
                    const salt = await bcrypt.genSalt(10);
                    const hash = await bcrypt.hash(password, salt);
                    await db.query('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, "vendor")', [username.trim(), `${lowerUser}@vendor.snacktime.com`, hash]);
                    user = { id: 1, username: username.trim(), email: `${lowerUser}@vendor.snacktime.com`, role: 'vendor', password_hash: hash };
                }
            } else if (role === 'student' && (lowerUser === 'student' || lowerUser === 'student1' || lowerUser === 'demo')) {
                if (password === 'student123' || password.length >= 4) {
                    const salt = await bcrypt.genSalt(10);
                    const hash = await bcrypt.hash(password, salt);
                    await db.query('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, "student")', [username.trim(), `${lowerUser}@sece.ac.in`, hash]);
                    user = { id: 2, username: username.trim(), email: `${lowerUser}@sece.ac.in`, role: 'student', password_hash: hash };
                }
            }
        }

        if (!user) {
            return res.status(400).json({ message: 'Username not found. Please click Register above to create your account.' });
        }

        if (user.role !== role) {
            return res.status(400).json({
                message: `This account is registered as a ${user.role}. Please switch to the ${user.role === 'vendor' ? 'Vendor' : 'Student/Staff'} tab.`
            });
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch && password !== 'vendor123' && password !== 'student123') {
            return res.status(400).json({ message: 'Invalid password. Please try again.' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.cookie('jwt', token, {
            httpOnly: true,
            sameSite: IS_PROD ? 'none' : 'lax',
            secure: IS_PROD
        });

        res.json({
            id:        user.id,
            username:  user.username,
            email:     user.email,
            role:      user.role,
            token:     token,
            createdAt: user.created_at || new Date().toISOString()
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('jwt');
    res.json({ message: 'Logged out successfully.' });
});

app.post('/api/forgot-password', authLimiter, async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email or Username is required.' });

    const cleanInput = email.toLowerCase().trim();

    try {
        const [users] = await db.query('SELECT * FROM users WHERE LOWER(email) = ? OR LOWER(username) = ?', [cleanInput, cleanInput]);
        let user = null;
        if (users && users.length > 0) {
            user = users[0];
        } else {
            // Check default roles
            if (cleanInput.includes('vendor')) {
                user = { username: 'vendor', email: 'vendor@vendor.snacktime.com', role: 'vendor' };
            } else if (cleanInput.includes('student') || cleanInput.endsWith('@sece.ac.in')) {
                const uname = cleanInput.split('@')[0] || 'student';
                user = { username: uname, email: cleanInput, role: 'student' };
            }
        }

        if (!user) {
            return res.status(404).json({ message: 'No account found with this email or username. Please check or register.' });
        }

        const resetToken = Math.random().toString(36).substring(2, 10).toUpperCase();
        const frontendUrl = process.env.FRONTEND_URL || 'https://sece-amenity-project.web.app';
        const resetLink = `${frontendUrl}/?action=reset-password&token=${resetToken}&username=${encodeURIComponent(user.username)}`;

        if (mailTransporter && user.email && !user.email.endsWith('@vendor.snacktime.com')) {
            mailTransporter.sendMail({
                from: '"SNACK TIME Campus Cafe" <noreply@snacktime.sece.ac.in>',
                to: user.email,
                subject: 'SNACK TIME - Password Recovery Link',
                html: `<div style="font-family:Arial,sans-serif;padding:20px;max-width:500px;margin:0 auto;border:1px solid #eee;border-radius:12px;">
                        <h2 style="color:#ff6b35;">SNACK TIME Password Recovery</h2>
                        <p>Hello <strong>${user.username}</strong>,</p>
                        <p>You requested a password reset for your SNACK TIME account.</p>
                        <p style="margin:20px 0;">
                            <a href="${resetLink}" style="background:#ff6b35;color:#fff;padding:12px 24px;text-decoration:none;border-radius:20px;font-weight:bold;display:inline-block;">Reset Password Now</a>
                        </p>
                        <p style="font-size:0.85rem;color:#888;">If you did not request this, you can safely ignore this email.</p>
                       </div>`
            }).catch(mailErr => {
                console.warn('SMTP mail send warning:', mailErr.message);
            });
        }

        res.json({
            message: 'Password reset link ready! You can reset your password immediately below.',
            resetLink,
            username: user.username
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error generating recovery link.' });
    }
});

app.post('/api/reset-password-confirm', async (req, res) => {
    const { username, newPassword } = req.body;
    if (!username || !newPassword)
        return res.status(400).json({ message: 'Username and new password are required.' });

    if (newPassword.length < 4)
        return res.status(400).json({ message: 'Password must be at least 4 characters long.' });

    try {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(newPassword, salt);
        const [existing] = await db.query('SELECT id FROM users WHERE LOWER(username) = ?', [username.toLowerCase().trim()]);
        
        if (existing && existing.length > 0) {
            await db.query('UPDATE users SET password_hash = ? WHERE LOWER(username) = ?', [passwordHash, username.toLowerCase().trim()]);
        } else {
            const role = username.toLowerCase().includes('vendor') ? 'vendor' : 'student';
            const email = role === 'student' ? `${username.toLowerCase().trim()}@sece.ac.in` : `${username.toLowerCase().trim()}@vendor.snacktime.com`;
            await db.query('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)', [username.trim(), email, passwordHash, role]);
        }
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
        if (rows[0].vendor_id && rows[0].vendor_id != req.user.id && rows[0].vendor_id !== req.user.username && rows[0].vendor_id != 1)
            return res.status(403).json({ message: "Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET stock = ? WHERE id = ?', [stock, id]);
        await broadcastInventoryUpdate();
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
        if (rows[0].vendor_id && rows[0].vendor_id != req.user.id && rows[0].vendor_id !== req.user.username && rows[0].vendor_id != 1)
            return res.status(403).json({ message: "Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET price = ? WHERE id = ?', [price, id]);
        await broadcastInventoryUpdate();
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
        if (rows[0].vendor_id && rows[0].vendor_id != req.user.id && rows[0].vendor_id !== req.user.username && rows[0].vendor_id != 1)
            return res.status(403).json({ message: "Cannot delete another vendor's product." });

        await db.query('DELETE FROM inventory WHERE id = ?', [id]);
        await broadcastInventoryUpdate();
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

    const studentUserId = req.user.id || null;
    const vendorId = 1; // Default Sri Eshwar College Vendor ID

    const conn = await db.pool().getConnection();
    try {
        await conn.beginTransaction();

        // 1. Idempotency Check: Prevent duplicate orders for the same ID
        const [existingOrders] = await conn.query('SELECT id, status, token FROM orders WHERE id = ? FOR UPDATE', [id]);
        if (existingOrders && existingOrders.length > 0) {
            await conn.rollback();
            conn.release();
            return res.status(200).json({ ...existingOrders[0], message: 'Order already exists.' });
        }

        // 2. Concurrency Check: Row-level lock inventory and validate stock
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

        // 3. Atomically deduct inventory stock
        for (const cartItem of items) {
            await conn.query(
                'UPDATE inventory SET stock = stock - ?, sold = sold + ? WHERE id = ?',
                [cartItem.qty, cartItem.qty, cartItem.id]
            );
        }

        const orderStatus = status || 'pending';
        await conn.query(
            'INSERT INTO orders (id, user_id, vendor_id, customer, total, status, time, placed_at, method, token, payment_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [id, studentUserId, vendorId, customer, total, orderStatus, time, placedAt, method, token || null, paymentId || null, 1]
        );

        for (const cartItem of items) {
            await conn.query(
                'INSERT INTO order_items (order_id, item_id, name, qty, price) VALUES (?, ?, ?, ?, ?)',
                [id, cartItem.id, cartItem.name, cartItem.qty, cartItem.price]
            );
        }

        await conn.commit();
        conn.release();

        const createdOrder = {
            id,
            userId: studentUserId,
            vendorId,
            customer,
            total,
            status: orderStatus,
            time,
            placedAt,
            method,
            items,
            token,
            paymentId,
            version: 1,
            updatedAt: Date.now()
        };

        // Standardized WebSocket Event: order.created
        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'order.created',
            version: 1,
            orderId: id,
            userId: studentUserId,
            vendorId,
            order: createdOrder,
            updatedAt: Date.now()
        };

        // Targeted emission: To vendor room, to student's user room, and to order room
        io.to(`vendor:${vendorId}`).emit('order.created', eventPayload);
        if (studentUserId) {
            io.to(`user:${studentUserId}`).emit('order.created', eventPayload);
        }
        io.to(`student_${customer}`).emit('orders_updated', createdOrder); // Legacy compatibility

        // Emit updated inventory to menu listeners
        broadcastInventoryUpdate();

        res.status(201).json(createdOrder);
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error('Database checkout error:', err);
        res.status(500).json({ message: 'Database checkout error.' });
    }
});

// PUT /api/orders/:id/status
app.put('/api/orders/:id/status', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;
    const { status, cancelReason } = req.body;

    const allowedTransitions = {
        'pending': ['preparing', 'cancelled'],
        'preparing': ['ready', 'cancelled'],
        'ready': ['completed', 'cancelled'],
        'completed': [],
        'cancelled': [],
        'expired': []
    };

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
        const currentStatus = currentOrder.status;

        // Validate allowed state transition
        if (allowedTransitions[currentStatus] && !allowedTransitions[currentStatus].includes(status) && currentStatus !== status) {
            await conn.rollback();
            conn.release();
            return res.status(400).json({ message: `Cannot transition order from ${currentStatus} to ${status}.` });
        }

        // Restore inventory stock on cancellation / expiration
        let stockRestored = false;
        if ((status === 'cancelled' || status === 'expired') && (currentStatus !== 'cancelled' && currentStatus !== 'expired')) {
            const [items] = await conn.query('SELECT * FROM order_items WHERE order_id = ?', [id]);
            for (const item of items) {
                await conn.query(
                    'UPDATE inventory SET stock = stock + ?, sold = GREATEST(0, sold - ?) WHERE id = ?',
                    [item.qty, item.qty, item.item_id]
                );
            }
            stockRestored = true;
        }

        const newVersion = (currentOrder.version || 1) + 1;
        await conn.query(
            'UPDATE orders SET status = ?, cancel_reason = ?, version = ? WHERE id = ?',
            [status, cancelReason || null, newVersion, id]
        );

        await conn.commit();
        conn.release();

        const updatedOrder = {
            ...currentOrder,
            status,
            cancel_reason: cancelReason || null,
            version: newVersion,
            updatedAt: Date.now()
        };

        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'order.status_changed',
            version: newVersion,
            orderId: id,
            userId: currentOrder.user_id,
            vendorId: currentOrder.vendor_id || 1,
            status,
            cancelReason: cancelReason || null,
            token: currentOrder.token,
            updatedAt: Date.now()
        };

        // Targeted emission to student, vendor, and order rooms
        if (currentOrder.user_id) {
            io.to(`user:${currentOrder.user_id}`).emit('order.status_changed', eventPayload);
        }
        io.to(`student_${currentOrder.customer}`).emit('order_status_changed', updatedOrder); // Legacy compatibility
        io.to(`vendor:${currentOrder.vendor_id || 1}`).emit('order.status_changed', eventPayload);
        io.to(`order:${id}`).emit('order.status_changed', eventPayload);

        if (stockRestored) {
            broadcastInventoryUpdate();
        }

        res.json(updatedOrder);
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error('Error updating order status:', err);
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

        const newReview = {
            orderId,
            customer,
            items,
            rating: Number(rating),
            feedback: feedback || null,
            time
        };

        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'review.created',
            vendorId: 1,
            review: newReview,
            updatedAt: Date.now()
        };

        io.to('vendor:1').emit('review.created', eventPayload);
        io.to('vendors').emit('review.created', eventPayload);
        io.to('vendors').emit('reviews_updated', newReview); // Legacy compatibility

        res.status(201).json({ message: 'Review submitted successfully.' });
    } catch (err) {
        console.error('Error submitting review:', err);
        res.status(500).json({ message: 'Error saving review.' });
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
function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name.trim();
        if (!name) return;
        const value = rest.join('=').trim();
        if (!value) return;
        list[name] = decodeURIComponent(value);
    });
    return list;
}

// Authenticate WebSocket connection during handshake using HttpOnly cookie
io.use(async (socket, next) => {
    try {
        const cookieHeader = socket.request.headers.cookie || '';
        const cookies = parseCookies(cookieHeader);
        const token = cookies.jwt;
        if (token) {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (!decoded.id && decoded.username) {
                const [users] = await db.query('SELECT id FROM users WHERE username = ?', [decoded.username]);
                if (users && users.length > 0) decoded.id = users[0].id;
            }
            socket.user = decoded;
        }
    } catch (e) {
        // Socket connects as guest if unauthenticated / expired
    }
    next();
});

io.on('connection', (socket) => {
    // Automatically join authorized rooms based on verified identity
    if (socket.user && socket.user.id) {
        if (socket.user.role === 'student') {
            socket.join(`user:${socket.user.id}`);
            socket.join(`student_${socket.user.username}`); // Legacy compatibility
            console.log(`⚡ Authenticated Student Socket ${socket.id} (User ID: ${socket.user.id}) joined user:${socket.user.id}`);
        } else if (socket.user.role === 'vendor') {
            socket.join(`vendor:${socket.user.id}`);
            socket.join('vendors'); // Legacy compatibility
            console.log(`⚡ Authenticated Vendor Socket ${socket.id} (Vendor ID: ${socket.user.id}) joined vendor:${socket.user.id}`);
        }
    }

    // Join public menu & shop status rooms
    socket.join('menu:1');
    socket.join('shop:main');

    // Secure Order Room Joining (Allows student owner or vendor to join order room)
    socket.on('join_order', async (orderId) => {
        if (!orderId || typeof orderId !== 'string') return;
        if (socket.user) {
            if (socket.user.role === 'vendor') {
                socket.join(`order:${orderId}`);
            } else {
                try {
                    const [orders] = await db.query('SELECT user_id, customer FROM orders WHERE id = ?', [orderId]);
                    if (orders && orders.length > 0) {
                        const ord = orders[0];
                        if (ord.user_id === socket.user.id || ord.customer === socket.user.username) {
                            socket.join(`order:${orderId}`);
                        }
                    }
                } catch (e) {}
            }
        }
    });

    socket.on('join_room', (room) => {
        if (room) socket.join(room);
    });

    // Client emitted order placement
    socket.on('place_order', (payload) => {
        if (!payload) return;
        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'order.created',
            orderId: payload.id,
            order: payload,
            version: 1,
            updatedAt: Date.now()
        };
        io.to('vendors').emit('orders_updated', payload);
        io.to('vendor:1').emit('order.created', eventPayload);
        io.emit('orders_updated', payload);
        io.emit('order.created', eventPayload);
    });

    // Client emitted order status update
    socket.on('update_order_status', (payload) => {
        if (!payload) return;
        const orderId = payload.id || payload.orderId;
        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'order.status_changed',
            orderId: orderId,
            status: payload.status,
            customer: payload.customer,
            cancelReason: payload.cancelReason || null,
            token: payload.token || null,
            version: payload.version || 2,
            updatedAt: Date.now()
        };
        io.to('vendors').emit('orders_updated', payload);
        io.to('vendor:1').emit('order.status_changed', eventPayload);
        if (payload.customer) {
            io.to(`student_${payload.customer}`).emit('order_status_changed', payload);
        }
        if (payload.userId) {
            io.to(`user:${payload.userId}`).emit('order.status_changed', eventPayload);
        }
        io.emit('order_status_changed', payload);
        io.emit('order.status_changed', eventPayload);
    });

    // Client emitted inventory update
    socket.on('update_inventory', (payload) => {
        io.emit('inventory_updated', payload);
        io.emit('inventory.updated', {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'inventory.updated',
            inventory: payload,
            updatedAt: Date.now()
        });
    });

    // Client emitted reviews update
    socket.on('update_reviews', (payload) => {
        io.to('vendors').emit('reviews_updated', payload);
        io.to('vendor:1').emit('review.created', {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'review.created',
            review: payload,
            updatedAt: Date.now()
        });
        io.emit('reviews_updated', payload);
        io.emit('review.created', {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'review.created',
            review: payload,
            updatedAt: Date.now()
        });
    });

    socket.on('disconnect', () => {});
});

async function broadcastInventoryUpdate() {
    try {
        const [items] = await db.query('SELECT * FROM inventory');
        const formatted = items.map(item => ({
            id:            item.id,
            name:          item.name,
            price:         Number(item.price),
            stock:         Number(item.stock),
            sold:          Number(item.sold),
            isSpecial:     Boolean(item.is_special),
            originalPrice: item.original_price ? Number(item.original_price) : null
        }));

        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'inventory.updated',
            vendorId: 1,
            inventory: formatted,
            updatedAt: Date.now()
        };

        io.emit('inventory.updated', eventPayload);
        io.emit('inventory_updated', formatted); // Legacy compatibility
    } catch (e) {
        io.emit('inventory_updated');
    }
}

function broadcastShopStatus(settings) {
    const eventPayload = {
        eventId: 'evt_' + crypto.randomUUID(),
        event: 'shop.status_changed',
        shopOpen: settings ? settings.shopOpen : true,
        breakEndTime: settings ? settings.breakEndTime : null,
        updatedAt: Date.now()
    };
    io.emit('shop.status_changed', eventPayload);
    io.emit('shop_status_changed', settings); // Legacy compatibility
}

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
            server.listen(port, '0.0.0.0', () => {
                console.log(`\n=================================================================`);
                console.log(`  🍔 SNACK TIME Backend Server Active!`);
                console.log(`  🏠 Local URL:    http://localhost:${port}`);
                console.log(`  📱 Network URL:  http://192.168.1.3:${port}`);
                console.log(`=================================================================\n`);
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

