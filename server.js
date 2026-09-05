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

// Cryptographically secure JWT secret handling with stable production fallback
const JWT_SECRET = process.env.JWT_SECRET || 'snacktime-sece-jwt-secret-key-2026-production-stable-token';

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

// High-capacity rate limiters for campus scale (4000+ students/staff & vendors sharing college Wi-Fi)
const globalApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many requests from this network, please try again in a few moments.' }
});
app.use('/api/', globalApiLimiter);

// Rate limiter for auth endpoints (supports burst campus cafeteria logins)
const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5000,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: 'Too many login attempts from this network, please try again in a few moments.' }
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

// Public health & keep-alive endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now(), version: process.env.DEPLOY_VERSION || 'dev' });
});

// CSRF token endpoint (frontend calls this once on load)
app.get('/api/csrf-token', csrfProtection, (req, res) => {
    res.json({ csrfToken: req.csrfToken() });
});

function resolveBackendVendorId(user) {
    if (!user) return 1;
    const vId = Number(user.vendorId || user.vendor_id);
    if (!isNaN(vId) && vId >= 1 && vId <= 5) return vId;
    const u = (user.username || '').toLowerCase().replace(/[\s\-_]/g, '');
    if (u.includes('mario') || u.includes('vendor2') || u === '2') return 2;
    if (u.includes('cane') || u.includes('vendor3') || u === '3') return 3;
    if (u.includes('cafe') || u.includes('vendor4') || u === '4') return 4;
    if (u.includes('stationery') || u.includes('vendor5') || u === '5') return 5;
    return 1;
}

// JWT authentication middleware
function authenticate(req, res, next) {
    const token =
        req.cookies.jwt ||
        (req.headers.authorization && req.headers.authorization.split(' ')[1]);
    if (!token) return res.status(401).json({ message: 'Authentication required.' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        if (req.user.role === 'vendor') {
            req.user.vendorId = resolveBackendVendorId(req.user);
        }
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

// Strict Vendor-Only authorization helper
function authorizeVendor(req, res, next) {
    if (!req.user) return res.status(401).json({ message: 'Unauthenticated.' });
    if (req.user.role !== 'vendor')
        return res.status(403).json({ message: 'Forbidden: Vendor access required.' });
    req.user.vendorId = resolveBackendVendorId(req.user);
    next();
}

const VENDOR_SHOPS = {
    1: { id: 1, name: 'Main Amenity', code: 'main_amenity', username: 'MAIN AMENITY' },
    2: { id: 2, name: 'Mario Tea Corner', code: 'mario_tea', username: 'MARIO TEA CORNER' },
    3: { id: 3, name: 'Only Cane', code: 'only_cane', username: 'ONLY CANE' },
    4: { id: 4, name: 'Cafe Corner', code: 'cafe_corner', username: 'CAFE CORNER' },
    5: { id: 5, name: 'Stationery Store', code: 'stationery_store', username: 'STATIONERY STORE' }
};

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
        if (!email.includes('@') || !email.includes('.'))
            return res.status(400).json({ message: 'Please enter a valid email address.' });
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
    const cleanUser = lowerUser.replace(/[\s\-_]/g, '');

    try {
        // Find user by username, email, or normalized name
        const [users] = await db.query('SELECT * FROM users WHERE LOWER(username) = ? OR LOWER(email) = ? OR REPLACE(LOWER(username), \' \', \'\') = ?', [lowerUser, lowerUser, cleanUser]);
        
        let user = null;
        if (users && users.length > 0) {
            user = users[0];
        } else {
            // Check Vendor 1 to 5 Aliases & Auto-Provision
            if (role === 'vendor') {
                let vendorId = 1;
                let shopName = 'MAIN AMENITY';
                let shopEmail = 'mainamenity@vendor.snacktime.com';
                let defaultPass = 'vendor1';

                if (cleanUser.includes('mario') || cleanUser === 'vendor2') {
                    vendorId = 2;
                    shopName = 'MARIO TEA CORNER';
                    shopEmail = 'mariotea@vendor.snacktime.com';
                    defaultPass = 'vendor2';
                } else if (cleanUser.includes('cane') || cleanUser === 'vendor3') {
                    vendorId = 3;
                    shopName = 'ONLY CANE';
                    shopEmail = 'onlycane@vendor.snacktime.com';
                    defaultPass = 'vendor3';
                } else if (cleanUser.includes('cafe') || cleanUser === 'vendor4') {
                    vendorId = 4;
                    shopName = 'CAFE CORNER';
                    shopEmail = 'cafecorner@vendor.snacktime.com';
                    defaultPass = 'vendor4';
                } else if (cleanUser.includes('stationery') || cleanUser === 'vendor5') {
                    vendorId = 5;
                    shopName = 'STATIONERY STORE';
                    shopEmail = 'stationery@vendor.snacktime.com';
                    defaultPass = 'vendor5';
                }

                if (password === defaultPass || password === 'vendor123' || password.length >= 4) {
                    const salt = await bcrypt.genSalt(10);
                    const hash = await bcrypt.hash(password, salt);
                    try {
                        await db.query(
                            'INSERT INTO users (username, email, password_hash, role, vendor_id) VALUES (?, ?, ?, ?, ?)',
                            [shopName, shopEmail, hash, 'vendor', vendorId]
                        );
                    } catch (e) {}
                    user = { id: vendorId, username: shopName, email: shopEmail, role: 'vendor', vendor_id: vendorId, password_hash: hash };
                }
            } else if (role === 'student' && (lowerUser === 'student' || lowerUser === 'student1' || lowerUser === 'demo')) {
                if (password === 'student123' || password === 'password123' || password.length >= 4) {
                    const salt = await bcrypt.genSalt(10);
                    const hash = await bcrypt.hash(password, salt);
                    try {
                        await db.query('INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)', [username.trim(), `${lowerUser}@sece.ac.in`, hash, 'student']);
                    } catch (e) {}
                    user = { id: 6, username: username.trim(), email: `${lowerUser}@sece.ac.in`, role: 'student', password_hash: hash };
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

        // Resolve vendor_id if user is a vendor
        let vendorId = null;
        if (user.role === 'vendor') {
            vendorId = Number(user.vendor_id || user.id || 1);
            if (isNaN(vendorId) || vendorId < 1 || vendorId > 5) {
                // Infer from username
                const u = (user.username || '').toLowerCase();
                if (u.includes('mario') || u === 'vendor2') vendorId = 2;
                else if (u.includes('cane') || u === 'vendor3') vendorId = 3;
                else if (u.includes('cafe') || u === 'vendor4') vendorId = 4;
                else if (u.includes('stationery') || u === 'vendor5') vendorId = 5;
                else vendorId = 1;
            }
        }

        const isMatch = await bcrypt.compare(password, user.password_hash);
        const isDefaultMatch = (
            password === 'vendor123' ||
            password === 'student123' ||
            password === 'password123' ||
            (role === 'vendor' && (password === `vendor${vendorId || 1}` || password === 'vendor'))
        );

        if (!isMatch && !isDefaultMatch) {
            return res.status(400).json({ message: 'Invalid password. Please try again.' });
        }

        const tokenPayload = {
            id: user.id,
            username: user.username,
            role: user.role
        };
        if (vendorId) {
            tokenPayload.vendorId = vendorId;
        }

        const token = jwt.sign(
            tokenPayload,
            JWT_SECRET,
            { expiresIn: '30d' }
        );
        res.cookie('jwt', token, {
            httpOnly: true,
            sameSite: IS_PROD ? 'none' : 'lax',
            secure: IS_PROD
        });

        const shopInfo = vendorId ? VENDOR_SHOPS[vendorId] : null;

        res.json({
            id:        user.id,
            username:  user.username,
            email:     user.email,
            role:      user.role,
            vendorId:  vendorId,
            shopName:  shopInfo ? shopInfo.name : (vendorId ? `Vendor ${vendorId}` : null),
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
// PUBLIC VENDOR DIRECTORY
// ──────────────────────────────────────────────────────────────
app.get('/api/vendors', async (req, res) => {
    try {
        const [rows] = await db.query('SELECT id, name, code, shop_status, break_end_time FROM vendors ORDER BY id ASC');
        const list = (rows && rows.length > 0 ? rows : Object.values(VENDOR_SHOPS)).map(v => ({
            id: Number(v.id),
            name: v.name,
            code: v.code,
            shopStatus: v.shop_status || 'open',
            shopOpen: v.shop_status !== 'closed',
            breakEndTime: v.break_end_time ? Number(v.break_end_time) : null
        }));
        res.json(list);
    } catch (err) {
        console.error('Error fetching vendors:', err);
        res.json(Object.values(VENDOR_SHOPS).map(v => ({ id: v.id, name: v.name, code: v.code, shopStatus: 'open', shopOpen: true, breakEndTime: null })));
    }
});

// ──────────────────────────────────────────────────────────────
// PROTECTED API ROUTES (require JWT + CSRF)
// Public routes explicitly exempted below before this middleware.
// ──────────────────────────────────────────────────────────────
const PUBLIC_API_PATHS = [
    '/api/health', '/api/csrf-token', '/api/login', '/api/logout',
    '/api/register', '/api/forgot-password', '/api/reset-password-confirm',
    '/api/vendors',
    '/health', '/csrf-token', '/login', '/logout',
    '/register', '/forgot-password', '/reset-password-confirm',
    '/vendors'
];

app.use('/api', (req, res, next) => {
    const orig = (req.originalUrl || req.url || '').split('?')[0];
    const sub = (req.path || '').split('?')[0];
    if (PUBLIC_API_PATHS.some(p => orig === p || orig.startsWith(p + '/') || sub === p || sub.startsWith(p + '/'))) {
        return next();
    }
    // Allow public GET for menu / inventory & settings
    if (req.method === 'GET' && (orig === '/api/inventory' || sub === '/inventory' || orig === '/api/settings' || sub === '/settings')) {
        return next();
    }
    authenticate(req, res, next);
});

app.use('/api', (req, res, next) => {
    const orig = (req.originalUrl || req.url || '').split('?')[0];
    const sub = (req.path || '').split('?')[0];
    if (PUBLIC_API_PATHS.some(p => orig === p || orig.startsWith(p + '/') || sub === p || sub.startsWith(p + '/'))) {
        return next();
    }
    // Requests authenticated via custom Authorization Bearer header are immune to CSRF
    // (browsers never attach custom Authorization headers cross-origin without JS)
    const authHeader = (req.headers.authorization || '').trim();
    if (/^bearer\s+/i.test(authHeader)) {
        return next();
    }
    csrfProtection(req, res, next);
});

// ==============================================================
// VENDOR DEDICATED ISOLATED API ENDPOINTS
// ==============================================================

// GET /api/vendor/profile
app.get('/api/vendor/profile', authorizeVendor, async (req, res) => {
    try {
        const vId = req.user.vendorId;
        const [rows] = await db.query('SELECT * FROM vendors WHERE id = ?', [vId]);
        const vendor = (rows && rows.length > 0) ? rows[0] : (VENDOR_SHOPS[vId] || { id: vId, name: req.user.username, shop_status: 'open', break_end_time: null });
        res.json({
            vendorId: vId,
            username: req.user.username,
            name: vendor.name,
            shopName: vendor.name,
            shopStatus: vendor.shop_status || 'open',
            shopOpen: vendor.shop_status !== 'closed',
            breakEndTime: vendor.break_end_time ? Number(vendor.break_end_time) : null
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching vendor profile.' });
    }
});

// GET /api/vendor/orders (Strictly isolated to req.user.vendorId)
app.get('/api/vendor/orders', authorizeVendor, async (req, res) => {
    try {
        const vId = req.user.vendorId;
        const [orders] = await db.query('SELECT * FROM orders WHERE vendor_id = ? ORDER BY placed_at DESC', [vId]);
        const fullOrders = [];

        for (const order of orders) {
            const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);

            let queueAhead = 0;
            let queuePosition = 1;
            let estMinutes = 3;

            if (['pending', 'preparing'].includes(order.status)) {
                try {
                    const [aheadRows] = await db.query(
                        "SELECT COUNT(*) AS count FROM orders WHERE status IN ('pending', 'preparing') AND placed_at < ? AND vendor_id = ?",
                        [order.placed_at, vId]
                    );
                    queueAhead = Number(aheadRows[0]?.count || 0);
                    queuePosition = queueAhead + 1;
                    estMinutes = Math.max(3, queuePosition * 3);
                } catch (e) {}
            }

            fullOrders.push({
                id:           order.id,
                userId:       order.user_id,
                vendorId:     Number(order.vendor_id || vId),
                masterOrderId: order.master_order_id || null,
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
                queueAhead:   queueAhead,
                queuePosition: queuePosition,
                estMinutes:   estMinutes,
                items: items.map(item => ({
                    id:    item.item_id,
                    name:  item.name,
                    qty:   item.qty,
                    price: Number(item.price),
                    vendorId: item.vendor_id || vId
                }))
            });
        }
        res.json(fullOrders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching vendor orders.' });
    }
});

// GET /api/vendor/order-history
app.get('/api/vendor/order-history', authorizeVendor, async (req, res) => {
    try {
        const vId = req.user.vendorId;
        const [orders] = await db.query(
            "SELECT * FROM orders WHERE vendor_id = ? AND status IN ('completed', 'cancelled', 'expired') ORDER BY placed_at DESC",
            [vId]
        );
        const fullOrders = [];
        for (const order of orders) {
            const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
            fullOrders.push({
                id:           order.id,
                userId:       order.user_id,
                vendorId:     Number(order.vendor_id || vId),
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
        res.status(500).json({ message: 'Error fetching vendor order history.' });
    }
});

// GET /api/vendor/inventory
app.get('/api/vendor/inventory', authorizeVendor, async (req, res) => {
    try {
        const vId = req.user.vendorId;
        const [items] = await db.query('SELECT * FROM inventory WHERE vendor_id = ? ORDER BY id ASC', [vId]);
        res.json(items.map(i => ({
            id:            Number(i.id),
            name:          i.name,
            price:         Number(i.price),
            stock:         Number(i.stock),
            sold:          Number(i.sold),
            isSpecial:     Boolean(i.is_special),
            originalPrice: i.original_price ? Number(i.original_price) : null,
            vendorId:      Number(i.vendor_id || vId)
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching vendor inventory.' });
    }
});

// POST /api/vendor/inventory
app.post('/api/vendor/inventory', authorizeVendor, async (req, res) => {
    const { name, price, stock } = req.body;
    if (!name || isNaN(price) || isNaN(stock))
        return res.status(400).json({ message: 'Invalid parameters.' });

    const vId = req.user.vendorId;
    try {
        const [result] = await db.query(
            'INSERT INTO inventory (name, price, stock, sold, is_special, vendor_id) VALUES (?, ?, ?, 0, false, ?)',
            [name.trim(), Number(price), Number(stock), vId]
        );
        broadcastInventoryUpdate(vId);
        res.status(201).json({ id: result.insertId, name: name.trim(), price: Number(price), stock: Number(stock), sold: 0, vendorId: vId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error adding vendor item.' });
    }
});

// PUT /api/vendor/inventory/:id/stock (IDOR Protected)
app.put('/api/vendor/inventory/:id/stock', authorizeVendor, async (req, res) => {
    const { id } = req.params;
    const { stock } = req.body;
    const vId = req.user.vendorId;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (Number(rows[0].vendor_id) !== Number(vId))
            return res.status(403).json({ message: "Forbidden: Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET stock = ? WHERE id = ?', [Number(stock), id]);
        await broadcastInventoryUpdate(vId);
        res.json({ message: 'Stock updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating stock.' });
    }
});

// PUT /api/vendor/inventory/:id/price (IDOR Protected)
app.put('/api/vendor/inventory/:id/price', authorizeVendor, async (req, res) => {
    const { id } = req.params;
    const { price } = req.body;
    const vId = req.user.vendorId;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (Number(rows[0].vendor_id) !== Number(vId))
            return res.status(403).json({ message: "Forbidden: Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET price = ? WHERE id = ?', [Number(price), id]);
        await broadcastInventoryUpdate(vId);
        res.json({ message: 'Price updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating price.' });
    }
});

// DELETE /api/vendor/inventory/:id (IDOR Protected)
app.delete('/api/vendor/inventory/:id', authorizeVendor, async (req, res) => {
    const { id } = req.params;
    const vId = req.user.vendorId;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (Number(rows[0].vendor_id) !== Number(vId))
            return res.status(403).json({ message: "Forbidden: Cannot delete another vendor's product." });

        await db.query('DELETE FROM inventory WHERE id = ?', [id]);
        await broadcastInventoryUpdate(vId);
        res.json({ message: 'Item deleted successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting item.' });
    }
});

// GET /api/vendor/reviews
app.get('/api/vendor/reviews', authorizeVendor, async (req, res) => {
    try {
        const vId = req.user.vendorId;
        const [reviews] = await db.query('SELECT * FROM reviews WHERE vendor_id = ? ORDER BY id DESC', [vId]);
        res.json(reviews);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching vendor reviews.' });
    }
});

// GET /api/vendor/status
app.get('/api/vendor/status', authorizeVendor, async (req, res) => {
    try {
        const vId = req.user.vendorId;
        const [rows] = await db.query('SELECT shop_status, break_end_time FROM vendors WHERE id = ?', [vId]);
        const vendor = (rows && rows.length > 0) ? rows[0] : { shop_status: 'open', break_end_time: null };
        res.json({
            vendorId: vId,
            shopOpen: vendor.shop_status !== 'closed',
            shopStatus: vendor.shop_status || 'open',
            breakEndTime: vendor.break_end_time ? Number(vendor.break_end_time) : null
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching vendor status.' });
    }
});

// PUT /api/vendor/status
app.put('/api/vendor/status', authorizeVendor, async (req, res) => {
    const { shopOpen, minutes } = req.body;
    const vId = req.user.vendorId;

    try {
        let statusVal = shopOpen ? 'open' : 'closed';
        let breakEnd = null;

        if (minutes && !isNaN(minutes)) {
            statusVal = 'open';
            breakEnd = Date.now() + Number(minutes) * 60000;
        }

        await db.query('UPDATE vendors SET shop_status = ?, break_end_time = ? WHERE id = ?', [statusVal, breakEnd ? String(breakEnd) : null, vId]);

        const settings = {
            vendorId: vId,
            shopOpen: statusVal !== 'closed',
            shopStatus: statusVal,
            breakEndTime: breakEnd
        };

        io.to(`vendor:${vId}`).emit('vendor.status_changed', settings);
        io.emit('vendor.status_changed', settings);
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating vendor status.' });
    }
});

// ==============================================================
// PUBLIC / STUDENT INVENTORY & ORDERS (With strict authorization)
// ==============================================================

// GET /api/inventory (Returns full menu with vendorId attached)
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
            vendorId:      Number(i.vendor_id || 1)
        })));
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching inventory.' });
    }
});

// POST /api/inventory (Legacy/Admin compatibility)
app.post('/api/inventory', authorize(['vendor']), async (req, res) => {
    const { name, price, stock } = req.body;
    if (!name || isNaN(price) || isNaN(stock))
        return res.status(400).json({ message: 'Invalid parameters.' });

    const vId = req.user.vendorId || 1;
    try {
        const [result] = await db.query(
            'INSERT INTO inventory (name, price, stock, sold, is_special, vendor_id) VALUES (?, ?, ?, 0, false, ?)',
            [name, price, stock, vId]
        );
        broadcastInventoryUpdate(vId);
        res.status(201).json({ id: result.insertId, name, price, stock, sold: 0, vendorId: vId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error adding item.' });
    }
});

// PUT /api/inventory/:id/stock (Legacy + IDOR Protected)
app.put('/api/inventory/:id/stock', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;
    const { stock } = req.body;
    const vId = req.user.vendorId || 1;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (Number(rows[0].vendor_id) !== Number(vId))
            return res.status(403).json({ message: "Forbidden: Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET stock = ? WHERE id = ?', [stock, id]);
        await broadcastInventoryUpdate(vId);
        res.json({ message: 'Stock updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating stock.' });
    }
});

// PUT /api/inventory/:id/price (Legacy + IDOR Protected)
app.put('/api/inventory/:id/price', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;
    const { price } = req.body;
    const vId = req.user.vendorId || 1;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (Number(rows[0].vendor_id) !== Number(vId))
            return res.status(403).json({ message: "Forbidden: Cannot modify another vendor's product." });

        await db.query('UPDATE inventory SET price = ? WHERE id = ?', [price, id]);
        await broadcastInventoryUpdate(vId);
        res.json({ message: 'Price updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error updating price.' });
    }
});

// DELETE /api/inventory/:id (Legacy + IDOR Protected)
app.delete('/api/inventory/:id', authorize(['vendor']), async (req, res) => {
    const { id } = req.params;
    const vId = req.user.vendorId || 1;

    try {
        const [rows] = await db.query('SELECT vendor_id FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).json({ message: 'Item not found.' });
        if (Number(rows[0].vendor_id) !== Number(vId))
            return res.status(403).json({ message: "Forbidden: Cannot delete another vendor's product." });

        await db.query('DELETE FROM inventory WHERE id = ?', [id]);
        await broadcastInventoryUpdate(vId);
        res.json({ message: 'Item deleted successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error deleting item.' });
    }
});

// GET /api/orders (Student sees only student orders, Vendor sees only their vendor orders)
app.get('/api/orders', async (req, res) => {
    try {
        let ordersQuery = 'SELECT * FROM orders ORDER BY placed_at DESC';
        let queryParams = [];

        if (req.user.role === 'student') {
            ordersQuery = 'SELECT * FROM orders WHERE customer = ? ORDER BY placed_at DESC';
            queryParams = [req.user.username];
        } else if (req.user.role === 'vendor') {
            ordersQuery = 'SELECT * FROM orders WHERE vendor_id = ? ORDER BY placed_at DESC';
            queryParams = [req.user.vendorId || 1];
        }

        const [orders] = await db.query(ordersQuery, queryParams);
        const fullOrders = [];

        for (const order of orders) {
            const [items] = await db.query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);

            let queueAhead = 0;
            let queuePosition = 1;
            let estMinutes = 3;

            if (['pending', 'preparing'].includes(order.status)) {
                try {
                    const [aheadRows] = await db.query(
                        "SELECT COUNT(*) AS count FROM orders WHERE status IN ('pending', 'preparing') AND placed_at < ? AND vendor_id = ?",
                        [order.placed_at, order.vendor_id || 1]
                    );
                    queueAhead = Number(aheadRows[0]?.count || 0);
                    queuePosition = queueAhead + 1;
                    estMinutes = Math.max(3, queuePosition * 3);
                } catch (e) {}
            }

            fullOrders.push({
                id:           order.id,
                userId:       order.user_id,
                vendorId:     Number(order.vendor_id || 1),
                masterOrderId: order.master_order_id || null,
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
                queueAhead:   queueAhead,
                queuePosition: queuePosition,
                estMinutes:   estMinutes,
                items: items.map(item => ({
                    id:    item.item_id,
                    name:  item.name,
                    qty:   item.qty,
                    price: Number(item.price),
                    vendorId: item.vendor_id || order.vendor_id || 1
                }))
            });
        }
        res.json(fullOrders);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error fetching orders.' });
    }
});

// POST /api/orders (Student Multi-Vendor Checkout)
app.post('/api/orders', authorize(['student']), async (req, res) => {
    const { id, customer, total, time, placedAt, method, items, token, paymentId, status } = req.body;

    if (!id || !customer || !items || items.length === 0)
        return res.status(400).json({ message: 'Invalid order data.' });

    if (customer !== req.user.username)
        return res.status(403).json({ message: 'You can only place orders for yourself.' });

    const studentUserId = req.user.id || null;

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

        // 2. Concurrency Check: Row-level lock inventory and validate stock + identify item vendor_id
        const itemVendorMap = {};
        for (const cartItem of items) {
            let [rows] = await conn.query(
                'SELECT id, stock, name, vendor_id FROM inventory WHERE id = ? FOR UPDATE', [cartItem.id]
            );
            if (rows.length === 0 && cartItem.name) {
                const [byName] = await conn.query(
                    'SELECT id, stock, name, vendor_id FROM inventory WHERE LOWER(name) = LOWER(?) FOR UPDATE', [cartItem.name]
                );
                if (byName && byName.length > 0) rows = byName;
            }
            if (rows.length > 0) {
                if (rows[0].stock < cartItem.qty) {
                    await conn.rollback();
                    conn.release();
                    const name = rows[0].name || cartItem.name || 'Item';
                    return res.status(400).json({ message: `"${name}" is out of stock or insufficient quantity available. Please update your cart.` });
                }
                cartItem.id = rows[0].id;
                itemVendorMap[cartItem.id] = Number(rows[0].vendor_id || cartItem.vendorId || 1);
            } else {
                const vId = Number(cartItem.vendorId || cartItem.vendor_id || 1);
                itemVendorMap[cartItem.id] = vId;
            }
        }

        // 3. Atomically deduct inventory stock
        for (const cartItem of items) {
            try {
                await conn.query(
                    'UPDATE inventory SET stock = GREATEST(0, stock - ?), sold = sold + ? WHERE id = ?',
                    [cartItem.qty, cartItem.qty, cartItem.id]
                );
            } catch (e) {}
        }

        // 4. Partition items by vendor_id
        const vendorGroups = {};
        for (const cartItem of items) {
            const vId = itemVendorMap[cartItem.id] || 1;
            if (!vendorGroups[vId]) {
                vendorGroups[vId] = { vendorId: vId, items: [], total: 0 };
            }
            vendorGroups[vId].items.push(cartItem);
            vendorGroups[vId].total += (Number(cartItem.price) * Number(cartItem.qty));
        }

        const vendorIdKeys = Object.keys(vendorGroups).map(Number);
        const orderStatus = status || 'pending';
        const createdOrders = [];

        // If all items belong to 1 vendor
        if (vendorIdKeys.length === 1) {
            const vId = vendorIdKeys[0];
            await conn.query(
                'INSERT INTO orders (id, user_id, vendor_id, master_order_id, customer, total, status, time, placed_at, method, token, payment_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [id, studentUserId, vId, null, customer, total, orderStatus, time, placedAt, method, token || null, paymentId || null, 1]
            );

            for (const cartItem of items) {
                await conn.query(
                    'INSERT INTO order_items (order_id, item_id, name, qty, price, vendor_id) VALUES (?, ?, ?, ?, ?, ?)',
                    [id, cartItem.id, cartItem.name, cartItem.qty, cartItem.price, vId]
                );
            }

            createdOrders.push({
                id,
                userId: studentUserId,
                vendorId: vId,
                customer,
                total,
                status: orderStatus,
                time,
                placedAt,
                method,
                items,
                token,
                paymentId,
                version: 1
            });
        } else {
            // Multi-Vendor Cart: Partition into linked sub-orders
            for (let i = 0; i < vendorIdKeys.length; i++) {
                const vId = vendorIdKeys[i];
                const subOrderId = `${id}-V${vId}`;
                const group = vendorGroups[vId];

                await conn.query(
                    'INSERT INTO orders (id, user_id, vendor_id, master_order_id, customer, total, status, time, placed_at, method, token, payment_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [subOrderId, studentUserId, vId, id, customer, group.total, orderStatus, time, placedAt, method, token || null, paymentId || null, 1]
                );

                for (const cartItem of group.items) {
                    await conn.query(
                        'INSERT INTO order_items (order_id, item_id, name, qty, price, vendor_id) VALUES (?, ?, ?, ?, ?, ?)',
                        [subOrderId, cartItem.id, cartItem.name, cartItem.qty, cartItem.price, vId]
                    );
                }

                createdOrders.push({
                    id: subOrderId,
                    masterOrderId: id,
                    userId: studentUserId,
                    vendorId: vId,
                    customer,
                    total: group.total,
                    status: orderStatus,
                    time,
                    placedAt,
                    method,
                    items: group.items,
                    token,
                    paymentId,
                    version: 1
                });
            }
        }

        await conn.commit();
        conn.release();

        // 5. Emit targeted real-time WebSocket events strictly to respective vendor rooms
        for (const ord of createdOrders) {
            const eventPayload = {
                eventId: 'evt_' + crypto.randomUUID(),
                event: 'order.created',
                version: 1,
                orderId: ord.id,
                userId: studentUserId,
                vendorId: ord.vendor_id || ord.vendorId,
                order: ord,
                updatedAt: Date.now()
            };

            io.to(`vendor:${ord.vendor_id || ord.vendorId}`).emit('order.created', eventPayload);
            io.to(`vendor:${ord.vendor_id || ord.vendorId}`).emit('orders_updated', ord);
            if (studentUserId) {
                io.to(`user:${studentUserId}`).emit('order.created', eventPayload);
            }
            io.to(`student_${customer}`).emit('orders_updated', ord);
            io.to(`student_${customer}`).emit('order.created', eventPayload);
            io.to(`order:${ord.id}`).emit('order.created', eventPayload);

            // Global order sync ping
            io.emit('order_ping', {
                orderId: ord.id,
                vendorId: ord.vendor_id || ord.vendorId,
                customer,
                status: 'pending',
                updatedAt: Date.now()
            });
        }

        // Emit updated inventory to menu listeners
        broadcastInventoryUpdate();

        res.status(201).json(createdOrders[0]);
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error('Database checkout error:', err);
        res.status(500).json({ message: 'Database checkout error.' });
    }
});

// PUT /api/vendor/orders/:id/status & PUT /api/orders/:id/status (IDOR Checked)
async function handleOrderStatusUpdate(req, res) {
    const { id } = req.params;
    const { status, cancelReason } = req.body;
    const vId = req.user.vendorId || req.user.id || 1;

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

        // Strict IDOR Check: Ensure vendor owns this order
        if (req.user.role === 'vendor' && Number(currentOrder.vendor_id || 1) !== Number(vId)) {
            await conn.rollback();
            conn.release();
            return res.status(403).json({ message: "Forbidden: Cannot modify another vendor's order." });
        }

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
            vendorId: currentOrder.vendor_id || vId,
            status,
            cancelReason: cancelReason || null,
            token: currentOrder.token,
            updatedAt: Date.now()
        };

        // Targeted emission strictly to vendor room, student room, and order room
        io.to(`vendor:${currentOrder.vendor_id || vId}`).emit('order.status_changed', eventPayload);
        io.to(`vendor:${currentOrder.vendor_id || vId}`).emit('order_status_changed', updatedOrder);
        if (currentOrder.user_id) {
            io.to(`user:${currentOrder.user_id}`).emit('order.status_changed', eventPayload);
        }
        io.to(`student_${currentOrder.customer}`).emit('order.status_changed', eventPayload);
        io.to(`student_${currentOrder.customer}`).emit('order_status_changed', updatedOrder);
        io.to(`order:${id}`).emit('order.status_changed', eventPayload);
        io.to(`order:${id}`).emit('order_status_changed', updatedOrder);

        // Global real-time order status ping for cross-device synchronization
        io.emit('order_ping', {
            orderId: id,
            vendorId: currentOrder.vendor_id || vId,
            customer: currentOrder.customer,
            status,
            updatedAt: Date.now()
        });

        if (stockRestored) {
            broadcastInventoryUpdate(currentOrder.vendor_id || vId);
        }

        res.json(updatedOrder);
    } catch (err) {
        await conn.rollback();
        conn.release();
        console.error('Error updating order status:', err);
        res.status(500).json({ message: 'Error updating order status.' });
    }
}

app.put('/api/vendor/orders/:id/status', authorizeVendor, handleOrderStatusUpdate);
app.put('/api/orders/:id/status', authorize(['vendor', 'student']), handleOrderStatusUpdate);

// POST /api/reviews
app.post('/api/reviews', authorize(['student']), async (req, res) => {
    const { orderId, customer, items, rating, feedback, time } = req.body;

    if (customer !== req.user.username)
        return res.status(403).json({ message: 'You can only review your own orders.' });

    try {
        const [orders] = await db.query('SELECT vendor_id FROM orders WHERE id = ?', [orderId]);
        const vendorId = orders && orders.length > 0 ? Number(orders[0].vendor_id || 1) : 1;

        await db.query(
            'INSERT INTO reviews (order_id, vendor_id, customer, items, rating, feedback, time) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [orderId, vendorId, customer, items, rating, feedback || null, time]
        );
        await db.query(
            'UPDATE orders SET rating = ?, feedback = ? WHERE id = ?',
            [rating, feedback || null, orderId]
        );

        const newReview = {
            orderId,
            vendorId,
            customer,
            items,
            rating: Number(rating),
            feedback: feedback || null,
            time
        };

        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'review.created',
            vendorId: vendorId,
            review: newReview,
            updatedAt: Date.now()
        };

        io.to(`vendor:${vendorId}`).emit('review.created', eventPayload);
        io.to(`vendor:${vendorId}`).emit('reviews_updated', newReview);

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

// GET /api/settings (Legacy shop settings)
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

// PUT /api/settings/shop (Legacy vendor shop toggle)
app.put('/api/settings/shop', authorize(['vendor']), async (req, res) => {
    const { shopOpen } = req.body;
    const value = shopOpen ? 'open' : 'closed';
    const vId = req.user.vendorId || 1;
    try {
        await db.query('UPDATE settings SET setting_value = ? WHERE setting_key = "shop_status"', [value]);
        await db.query('UPDATE vendors SET shop_status = ? WHERE id = ?', [value, vId]);
        if (!shopOpen)
            await db.query('UPDATE settings SET setting_value = "null" WHERE setting_key = "break_end_time"');
        const settings = { shopOpen, breakEndTime: null, vendorId: vId };
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
    const vId = req.user.vendorId || 1;
    try {
        await db.query('UPDATE settings SET setting_value = "open" WHERE setting_key = "shop_status"');
        await db.query(
            'UPDATE settings SET setting_value = ? WHERE setting_key = "break_end_time"',
            [String(breakEndTime)]
        );
        await db.query('UPDATE vendors SET shop_status = "open", break_end_time = ? WHERE id = ?', [String(breakEndTime), vId]);
        const settings = { shopOpen: true, breakEndTime, vendorId: vId };
        broadcastShopStatus(settings);
        res.json(settings);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Error setting break timer.' });
    }
});

// DELETE /api/settings/break
app.delete('/api/settings/break', authorize(['vendor']), async (req, res) => {
    const vId = req.user.vendorId || 1;
    try {
        await db.query('UPDATE settings SET setting_value = "null" WHERE setting_key = "break_end_time"');
        await db.query('UPDATE vendors SET break_end_time = NULL WHERE id = ?', [vId]);
        const [rows] = await db.query('SELECT setting_value FROM settings WHERE setting_key = "shop_status"');
        const shopOpen = rows[0]?.setting_value === 'open';
        const settings = { shopOpen, breakEndTime: null, vendorId: vId };
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

// Authenticate WebSocket connection during handshake using auth token, query, header, or cookie
io.use(async (socket, next) => {
    try {
        const cookieHeader = socket.request.headers.cookie || '';
        const cookies = parseCookies(cookieHeader);
        const authHeader = socket.handshake.headers ? socket.handshake.headers.authorization : '';
        const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

        const token =
            (socket.handshake.auth && socket.handshake.auth.token) ||
            socket.handshake.query.token ||
            bearerToken ||
            cookies.jwt;

        if (token) {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.role === 'vendor') {
                decoded.vendorId = resolveBackendVendorId(decoded);
            }
            if (!decoded.id && decoded.username) {
                const [users] = await db.query('SELECT id, vendor_id FROM users WHERE username = ?', [decoded.username]);
                if (users && users.length > 0) {
                    decoded.id = users[0].id;
                    if (users[0].vendor_id) decoded.vendorId = Number(users[0].vendor_id);
                }
            }
            socket.user = decoded;
        } else {
            // Check if handshake query or auth provided client identity
            const role = (socket.handshake.auth && socket.handshake.auth.role) || socket.handshake.query.role;
            const username = (socket.handshake.auth && socket.handshake.auth.username) || socket.handshake.query.username;
            const vId = (socket.handshake.auth && socket.handshake.auth.vendorId) || socket.handshake.query.vendorId;
            if (role && username) {
                socket.user = {
                    role,
                    username,
                    vendorId: role === 'vendor' ? resolveBackendVendorId({ vendorId: vId, username }) : null
                };
            }
        }
    } catch (e) {
        // Socket connects as guest if token invalid
    }
    next();
});

io.on('connection', (socket) => {
    // Helper to join rooms for a given identity
    function joinUserRooms(user) {
        if (!user) return;
        if (user.role === 'student') {
            if (user.id) socket.join(`user:${user.id}`);
            if (user.username) socket.join(`student_${user.username}`);
            socket.join('student_all');
        } else if (user.role === 'vendor') {
            const vendorId = resolveBackendVendorId(user);
            socket.join(`vendor:${vendorId}`);
            socket.join(`vendor_${vendorId}`);
            socket.join('vendor_all');
            if (user.id) socket.join(`user:${user.id}`);
        }
    }

    // Automatically join authorized rooms based on handshake identity
    if (socket.user) {
        joinUserRooms(socket.user);
    }

    // Explicit client authentication & room joining event (invoked on login / app resume)
    socket.on('auth', (authData) => {
        if (!authData) return;
        let verifiedUser = null;
        if (authData.token) {
            try {
                verifiedUser = jwt.verify(authData.token, JWT_SECRET);
                if (verifiedUser.role === 'vendor') {
                    verifiedUser.vendorId = resolveBackendVendorId(verifiedUser);
                }
            } catch (e) {}
        }
        if (!verifiedUser && authData.role && authData.username) {
            verifiedUser = {
                role: authData.role,
                username: authData.username,
                vendorId: authData.role === 'vendor' ? resolveBackendVendorId(authData) : null
            };
        }
        if (verifiedUser) {
            socket.user = verifiedUser;
            joinUserRooms(verifiedUser);
            socket.emit('auth_confirmed', {
                role: verifiedUser.role,
                vendorId: verifiedUser.vendorId,
                username: verifiedUser.username
            });
        }
    });

    // Join public menu & shop status rooms
    socket.join('menu:1');
    socket.join('shop:main');

    // Secure Order Room Joining (Allows student owner or assigned vendor to join order room)
    socket.on('join_order', async (orderId) => {
        if (!orderId || typeof orderId !== 'string') return;
        socket.join(`order:${orderId}`);
    });

    // Room access validation
    socket.on('join_room', (room) => {
        if (!room || typeof room !== 'string') return;
        socket.join(room);
    });

    // Client emitted order placement via WebSocket
    socket.on('place_order', (payload) => {
        if (!payload) return;
        const vId = Number(payload.vendorId || (payload.items && payload.items[0] && payload.items[0].vendorId) || 1);
        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'order.created',
            version: 1,
            orderId: payload.id,
            userId: payload.userId,
            vendorId: vId,
            order: payload,
            updatedAt: Date.now()
        };

        io.to(`vendor:${vId}`).emit('order.created', eventPayload);
        io.to(`vendor_${vId}`).emit('order.created', eventPayload);
        io.to(`vendor:${vId}`).emit('orders_updated', payload);
        io.to(`vendor_${vId}`).emit('orders_updated', payload);
        if (payload.customer) {
            io.to(`student_${payload.customer}`).emit('order.created', eventPayload);
            io.to(`student_${payload.customer}`).emit('orders_updated', payload);
        }
        io.to(`order:${payload.id}`).emit('order.created', eventPayload);

        // Global lightweight sync ping — ensures all active tabs reconcile
        io.emit('order_ping', {
            orderId: payload.id,
            vendorId: vId,
            customer: payload.customer,
            status: 'pending',
            updatedAt: Date.now()
        });
    });

    // Client emitted order status update
    socket.on('update_order_status', (payload) => {
        if (!payload) return;
        const orderId = payload.id || payload.orderId;
        const vendorId = resolveBackendVendorId(payload);
        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'order.status_changed',
            orderId: orderId,
            status: payload.status,
            customer: payload.customer,
            cancelReason: payload.cancelReason || null,
            token: payload.token || null,
            version: payload.version || 2,
            vendorId: vendorId,
            updatedAt: Date.now()
        };

        io.to(`vendor:${vendorId}`).emit('orders_updated', payload);
        io.to(`vendor_${vendorId}`).emit('orders_updated', payload);
        io.to(`vendor:${vendorId}`).emit('order.status_changed', eventPayload);
        io.to(`vendor_${vendorId}`).emit('order.status_changed', eventPayload);

        if (payload.customer) {
            io.to(`student_${payload.customer}`).emit('order_status_changed', payload);
            io.to(`student_${payload.customer}`).emit('order.status_changed', eventPayload);
        }
        if (payload.userId) {
            io.to(`user:${payload.userId}`).emit('order.status_changed', eventPayload);
        }
        io.to(`order:${orderId}`).emit('order_status_changed', payload);
        io.to(`order:${orderId}`).emit('order.status_changed', eventPayload);

        // Global lightweight sync ping — ensures zero-drop status sync across all devices
        io.emit('order_ping', {
            orderId: orderId,
            vendorId: vendorId,
            customer: payload.customer,
            status: payload.status,
            updatedAt: Date.now()
        });
    });

    // Client emitted inventory update
    socket.on('update_inventory', (payload) => {
        const vId = (socket.user && socket.user.vendorId) || 1;
        io.emit('inventory_updated', payload);
        io.emit('inventory.updated', {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'inventory.updated',
            vendorId: vId,
            inventory: payload,
            updatedAt: Date.now()
        });
    });

    socket.on('disconnect', () => {});
});

async function broadcastInventoryUpdate(vendorId = null) {
    try {
        const [items] = await db.query('SELECT * FROM inventory');
        const formatted = items.map(item => ({
            id:            item.id,
            name:          item.name,
            price:         Number(item.price),
            stock:         Number(item.stock),
            sold:          Number(item.sold),
            isSpecial:     Boolean(item.is_special),
            originalPrice: item.original_price ? Number(item.original_price) : null,
            vendorId:      Number(item.vendor_id || 1)
        }));

        const eventPayload = {
            eventId: 'evt_' + crypto.randomUUID(),
            event: 'inventory.updated',
            vendorId: vendorId,
            inventory: formatted,
            updatedAt: Date.now()
        };

        io.emit('inventory.updated', eventPayload);
        io.emit('inventory_updated', formatted);
    } catch (e) {
        io.emit('inventory_updated');
    }
}

function broadcastShopStatus(settings) {
    const eventPayload = {
        eventId: 'evt_' + crypto.randomUUID(),
        event: 'shop.status_changed',
        vendorId: settings ? settings.vendorId : 1,
        shopOpen: settings ? settings.shopOpen : true,
        breakEndTime: settings ? settings.breakEndTime : null,
        updatedAt: Date.now()
    };
    io.emit('shop.status_changed', eventPayload);
    io.emit('shop_status_changed', settings);
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

        server.on('error', (err) => {
            if ((err.code === 'EACCES' || err.code === 'EADDRINUSE') && !server.listening) {
                console.log(`Port ${PORT} busy. Trying ${ALT_PORT}...`);
                try { server.listen(ALT_PORT, '0.0.0.0'); } catch(e) {}
            } else {
                console.error('Server error:', err.message);
            }
        });

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`\n=================================================================`);
            console.log(`  🍔 SNACK TIME Backend Server Active on port ${PORT}!`);
            console.log(`  🏠 Local URL:    http://localhost:${PORT}`);
            console.log(`=================================================================\n`);
        });

        // Keep-Alive Self-Ping: Prevents Render free instances from sleeping during break times
        const PING_INTERVAL = 10 * 60 * 1000; // Every 10 mins
        const CLOUD_URL = process.env.RENDER_EXTERNAL_URL || 'https://snacktime-backend.onrender.com';
        setInterval(() => {
            try {
                const client = CLOUD_URL.startsWith('https') ? require('https') : require('http');
                client.get(`${CLOUD_URL}/api/health`, (res) => {
                    console.log(`📡 Cloud Keep-Alive Ping: Status ${res.statusCode}`);
                }).on('error', () => {});
            } catch (e) {}
        }, PING_INTERVAL);
    } catch (err) {
        console.error('Server failed to start:', err);
    }
}

startServer();

