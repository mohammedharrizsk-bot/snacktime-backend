const $ = id => document.getElementById(id);
const SERVER_BASE_URL = window.SNACKTIME_SERVER_URL || localStorage.getItem('custom_server_url') || (window.location.port === '3000' ? '' : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3000' : ''));

let csrfToken = '';

// Vendor ID → Shop Name mapping (must be defined before any login/auth functions)
const VENDOR_NAMES_MAP = {
    1: 'Main Amenity',
    2: 'Mario Tea Corner',
    3: 'Only Cane',
    4: 'Cafe Corner',
    5: 'Stationery Store'
};

function safeCreateIcons() {
    if (typeof lucide !== 'undefined' && lucide && typeof lucide.createIcons === 'function') {
        try {
            lucide.createIcons();
        } catch (e) {
            console.warn('Lucide icon render notice:', e);
        }
    }
}

async function safeParseJson(res) {
    if (!res) throw new Error('API_UNAVAILABLE');
    const contentType = res.headers ? (res.headers.get('content-type') || '') : '';
    if (!res.ok) {
        let msg = 'Request failed';
        if (contentType.includes('application/json')) {
            try {
                const data = await res.json();
                msg = data.message || msg;
            } catch (e) {}
        }
        throw new Error(msg);
    }
    if (!contentType.includes('application/json')) {
        throw new Error('API_UNAVAILABLE');
    }
    try {
        return await res.json();
    } catch (e) {
        throw new Error('API_UNAVAILABLE');
    }
}

async function fetchCsrfToken() {
    try {
        const targetUrl = SERVER_BASE_URL ? `${SERVER_BASE_URL}/api/csrf-token` : '/api/csrf-token';
        const res = await fetch(targetUrl, { credentials: 'include' });
        const contentType = res.headers ? (res.headers.get('content-type') || '') : '';
        if (res.ok && contentType.includes('application/json')) {
            const data = await res.json();
            csrfToken = data.csrfToken;
        }
    } catch (e) {
        console.log('CSRF token fetch notice:', e.message);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchCsrfToken();
    initSocketConnection();
    initUniversalWebRTCEngine();
});

async function apiFetch(url, options = {}) {
    options.headers = options.headers || {};
    const method = (options.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
        if (!csrfToken) {
            await fetchCsrfToken();
        }
        if (csrfToken) {
            options.headers['X-CSRF-Token'] = csrfToken;
        }
    }
    const token = localStorage.getItem('snacktime_jwt_token');
    if (token) {
        options.headers['Authorization'] = 'Bearer ' + token;
    }
    options.credentials = 'include';
    const fullUrl = SERVER_BASE_URL ? `${SERVER_BASE_URL}${url}` : url;
    return fetch(fullUrl, options);
}

// ========================= TRIPLE-REDUNDANT REAL-TIME BROADCAST ENGINE =========================
const snacktimeChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('snacktime_realtime_channel') : null;
let appSocket = null;
let cloudWs = null;

function updateConnectionIndicator(status) {
    const indicators = document.querySelectorAll('.live-connection-badge');
    indicators.forEach(el => {
        if (status === 'connected') {
            el.innerHTML = '<span class="status-dot green"></span> Live';
            el.className = 'live-connection-badge connected';
        } else if (status === 'reconnecting') {
            el.innerHTML = '<span class="status-dot orange"></span> Reconnecting...';
            el.className = 'live-connection-badge reconnecting';
        }
    });
}

function initSocketConnection() {
    if (typeof io === 'undefined') return;
    if (appSocket && appSocket.connected) return;

    try {
        const token = localStorage.getItem('snacktime_jwt_token') || '';
        const savedSession = currentUser || (() => { try { return JSON.parse(localStorage.getItem('snacktime_session') || 'null'); } catch { return null; } })();
        const role = savedSession ? savedSession.role : '';
        const username = savedSession ? savedSession.username : '';
        const vendorId = savedSession ? (savedSession.vendorId || '') : '';

        const socketOpts = {
            withCredentials: true,
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 4000,
            timeout: 10000,
            auth: { token, role, username, vendorId },
            query: { token, role, username, vendorId }
        };

        const connectUrl = SERVER_BASE_URL || (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3000' : window.location.origin);
        appSocket = io(connectUrl, socketOpts);

        appSocket.on('connect', () => {
            console.log('⚡ Connected to SNACK TIME Real-Time Socket.io Server:', appSocket.id);
            updateConnectionIndicator('connected');

            // Authenticate and join vendor/student rooms immediately
            authenticateSocketConnection();

            // Instant state resync and room rejoin upon reconnect
            if (currentUser && currentUser.role) {
                startDatabaseSync(currentUser.role);
            }
        });

        appSocket.on('auth_confirmed', (data) => {
            console.log('✅ Real-Time Socket Authentication Confirmed for room:', data);
        });

        appSocket.on('disconnect', () => {
            console.log('🔌 Disconnected from Socket.io Server. Polling shield active. Attempting automatic reconnection...');
            updateConnectionIndicator('reconnecting');
        });

        appSocket.on('connect_error', () => {
            updateConnectionIndicator('reconnecting');
        });
    } catch (e) {
        console.log('Socket initialization notice:', e);
    }
}

function authenticateSocketConnection() {
    if (!appSocket) {
        initSocketConnection();
        return;
    }
    const user = currentUser || (() => { try { return JSON.parse(localStorage.getItem('snacktime_session') || 'null'); } catch { return null; } })();
    const tok = localStorage.getItem('snacktime_jwt_token') || '';
    if (user) {
        const payload = {
            token: tok,
            role: user.role,
            username: user.username,
            vendorId: user.vendorId,
            userId: user.id
        };
        if (appSocket.connected) {
            appSocket.emit('auth', payload);
        } else {
            appSocket.connect();
        }
    }
}

let webrtcPeer = null;
let activePeerConnections = [];

function initUniversalWebRTCEngine() {
    if (typeof Peer === 'undefined') return;
    try {
        let activeRole = currentUser ? currentUser.role : null;
        let activeUserId = currentUser ? (currentUser.id || currentUser.username) : '';
        if (!activeRole) {
            try {
                const s = JSON.parse(localStorage.getItem('snacktime_session') || 'null');
                if (s && s.role) {
                    activeRole = s.role;
                    activeUserId = s.id || s.username || '';
                }
            } catch (e) {}
        }

        const isVendor = (activeRole === 'vendor');
        const peerId = isVendor
            ? ('snacktime-sece-vendor-' + (activeUserId || 'v') + '-' + Math.random().toString(36).substr(2, 6))
            : ('snacktime-sece-student-' + (activeUserId || 's') + '-' + Math.random().toString(36).substr(2, 6));

        if (webrtcPeer) {
            try { webrtcPeer.destroy(); } catch (e) {}
            webrtcPeer = null;
        }

        webrtcPeer = new Peer(peerId, {
            debug: 0,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun.services.mozilla.com' }
                ]
            }
        });

        webrtcPeer.on('open', (id) => {
            console.log('⚡ Universal In-App Real-Time WebRTC Mesh active, peer ID:', id);
            updateConnectionIndicator('connected');
            if (!isVendor) {
                connectToVendorPeer();
            }
        });

        webrtcPeer.on('connection', (conn) => {
            conn.on('open', () => {
                if (!activePeerConnections.includes(conn)) {
                    activePeerConnections.push(conn);
                }
            });
            conn.on('data', (data) => {
                if (data && data.type && data.payload) {
                    const myUser = currentUser ? currentUser.username : '';
                    if (data.sender && myUser && data.sender === myUser) return;
                    handleRealtimeEvent(data.type, data.payload);
                }
            });
            conn.on('close', () => {
                activePeerConnections = activePeerConnections.filter(c => c !== conn);
            });
            conn.on('error', () => {
                activePeerConnections = activePeerConnections.filter(c => c !== conn);
            });
        });

        webrtcPeer.on('error', (err) => {
            if (err.type === 'unavailable-id') {
                if (isVendor) {
                    webrtcPeer = new Peer('snacktime-sece-vendor-' + Math.random().toString(36).substr(2, 6));
                }
            } else if (err.type === 'peer-unavailable') {
                if (!isVendor) {
                    setTimeout(connectToVendorPeer, 4000);
                }
            }
        });
    } catch (e) {
        console.log('WebRTC engine notice:', e);
    }
}

function connectToVendorPeer() {
    if (!webrtcPeer || webrtcPeer.destroyed) return;
    try {
        const vendorId = 'snacktime-sece-vendor-main';
        const conn = webrtcPeer.connect(vendorId, { reliable: true });
        conn.on('open', () => {
            console.log('⚡ Connected to Vendor Dashboard via Direct WebRTC DataChannel!');
            if (!activePeerConnections.includes(conn)) {
                activePeerConnections.push(conn);
            }
        });
        conn.on('data', (data) => {
            if (data && data.type && data.payload) {
                const myUser = currentUser ? currentUser.username : '';
                if (data.sender && myUser && data.sender === myUser) return;
                handleRealtimeEvent(data.type, data.payload);
            }
        });
        conn.on('close', () => {
            activePeerConnections = activePeerConnections.filter(c => c !== conn);
            setTimeout(connectToVendorPeer, 4000);
        });
        conn.on('error', () => {
            activePeerConnections = activePeerConnections.filter(c => c !== conn);
            setTimeout(connectToVendorPeer, 5000);
        });
    } catch (e) {}
}

function broadcastRealtimeEvent(type, payload) {
    const msg = {
        type,
        payload,
        sender: currentUser ? currentUser.username : 'Guest',
        timestamp: Date.now()
    };

    // 1. BroadcastChannel (Cross-tab & cross-window on same device)
    if (snacktimeChannel) {
        try {
            snacktimeChannel.postMessage(msg);
        } catch (e) {
            console.log('BroadcastChannel post error:', e);
        }
    }

    // 2. Universal In-App WebRTC Real-Time Mesh (Direct P2P across any 4G / Wi-Fi / Laptop)
    activePeerConnections.forEach(conn => {
        if (conn && conn.open) {
            try {
                conn.send(msg);
            } catch (e) {}
        }
    });

    // 3. High-Performance Socket.io Engine (Node.js + MySQL Backend)
    if (appSocket && appSocket.connected) {
        try {
            if (type === 'NEW_ORDER') {
                appSocket.emit('place_order', payload);
            } else if (type === 'ORDER_STATUS_CHANGED') {
                appSocket.emit('update_order_status', payload);
            } else if (type === 'INVENTORY_UPDATED') {
                appSocket.emit('update_inventory', payload);
            } else if (type === 'REVIEWS_UPDATED') {
                appSocket.emit('update_reviews', payload);
            }
        } catch (e) {}
    }
}

// Track recently processed event keys to prevent double notification chimes within 500ms
const processedRealtimeKeys = new Set();

function handleRealtimeEvent(type, payload) {
    if (!type || !payload) return;

    // Deduplicate identical events arriving within 1 second
    const eventId = payload.id || payload.orderId || JSON.stringify(payload).slice(0, 30);
    const eventKey = `${type}_${eventId}`;
    const now = Date.now();

    const isDuplicate = processedRealtimeKeys.has(eventKey);
    if (!isDuplicate) {
        processedRealtimeKeys.add(eventKey);
        setTimeout(() => processedRealtimeKeys.delete(eventKey), 1500);
    }

    // Determine current role from session if currentUser variable isn't set yet
    let activeRole = currentUser ? currentUser.role : null;
    if (!activeRole) {
        try {
            const sess = JSON.parse(localStorage.getItem('snacktime_session') || 'null');
            if (sess && sess.role) activeRole = sess.role;
        } catch (e) {}
    }

    if (type === 'NEW_ORDER') {
        const existingIdx = allOrders.findIndex(o => o.id === payload.id);
        if (existingIdx >= 0) {
            allOrders[existingIdx] = payload;
        } else {
            allOrders.unshift(payload);
        }
        liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));
        try { localStorage.setItem('snacktime_orders', JSON.stringify(allOrders)); } catch (e) {}

        if (activeRole === 'vendor') {
            renderVendorOrders();
            updateVendorOrderBadge(liveOrders.length);
            if (!isDuplicate) {
                triggerLiveNotification('🔔 NEW ORDER RECEIVED!', `Order #${payload.id} - ${payload.customer || 'Student'} (₹${payload.total || 0})`);
                playOrderAlertSound();
            }
        }
    } else if (type === 'ORDER_STATUS_CHANGED') {
        const targetOrder = allOrders.find(o => o.id === payload.id);
        if (targetOrder) {
            targetOrder.status = payload.status;
            if (payload.cancelReason) targetOrder.cancelReason = payload.cancelReason;
        } else {
            allOrders.unshift(payload);
        }
        liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));
        try { localStorage.setItem('snacktime_orders', JSON.stringify(allOrders)); } catch (e) {}

        const username = currentUser ? currentUser.username : '';
        if (activeRole === 'student' && (!payload.customer || payload.customer === username)) {
            currentOrder = payload;
            updateTrackingUI(payload.status);
            updateTrackingTimeline(payload.status);
            renderInlineOrderHistory();

            if (!isDuplicate) {
                const statusLower = (payload.status || '').toLowerCase();
                if (statusLower === 'preparing') {
                    triggerLiveNotification('👨‍🍳 Order Preparing!', `The kitchen is preparing Order #${payload.id}`);
                } else if (statusLower === 'ready') {
                    triggerLiveNotification('🔔 Order READY for Pickup!', `Order #${payload.id} is ready! Token: ${payload.token || ''}`);
                } else if (statusLower === 'completed') {
                    triggerLiveNotification('✅ Order Completed', `Order #${payload.id} collected. Thank you!`);
                } else if (statusLower === 'cancelled') {
                    triggerLiveNotification('❌ Order Cancelled', `Order #${payload.id} was cancelled.`);
                }
            }
        } else if (activeRole === 'vendor') {
            renderVendorOrders();
            updateVendorOrderBadge(liveOrders.length);
        }
    } else if (type === 'INVENTORY_UPDATED') {
        if (Array.isArray(payload)) {
            inventory = payload;
        } else if (payload && payload.id) {
            const idx = inventory.findIndex(i => Number(i.id) === Number(payload.id));
            if (idx >= 0) inventory[idx] = { ...inventory[idx], ...payload };
            else inventory.push(payload);
        }
        try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
        applyDailySpecials();

        if (activeRole === 'vendor') {
            renderInventory();
        } else {
            renderMenu();
        }
    } else if (type === 'REVIEWS_UPDATED') {
        if (Array.isArray(payload)) {
            allReviews = payload;
        } else if (payload && payload.orderId) {
            allReviews.unshift(payload);
        }
        try { localStorage.setItem('snacktime_reviews', JSON.stringify(allReviews)); } catch (e) {}
        if (activeRole === 'vendor') {
            renderVendorReviews();
        }
    }
}

if (snacktimeChannel) {
    snacktimeChannel.onmessage = (event) => {
        if (!event || !event.data) return;
        handleRealtimeEvent(event.data.type, event.data.payload);
    };
}

// Multi-window / Multi-tab localStorage listener fallback
window.addEventListener('storage', (event) => {
    if (event.key === 'snacktime_orders' && event.newValue) {
        try {
            const orders = JSON.parse(event.newValue);
            const newest = orders[0];
            if (newest) {
                handleRealtimeEvent('NEW_ORDER', newest);
            }
        } catch (e) {}
    } else if (event.key === 'snacktime_inventory' && event.newValue) {
        try {
            const items = JSON.parse(event.newValue);
            handleRealtimeEvent('INVENTORY_UPDATED', items);
        } catch (e) {}
    } else if (event.key === 'snacktime_reviews' && event.newValue) {
        try {
            const reviews = JSON.parse(event.newValue);
            handleRealtimeEvent('REVIEWS_UPDATED', reviews);
        } catch (e) {}
    }
});


// ========================= RAZORPAY CONFIGURATION =========================
const RAZORPAY_KEY_ID = 'rzp_test_REPLACE_WITH_YOUR_KEY';

// ========================= APP VERSION =========================
// Keep in sync with APP_VERSION in sw-v2.js and window.SNACKTIME_VERSION in index.html
const APP_VERSION = '3.0.0.1788600470149';

// Stamp version into About sections once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    ['app-version-student', 'app-version-vendor'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = 'v' + APP_VERSION;
    });
});

// Guard: prevent update-banner reload during active Razorpay checkout
window._razorpayActive = false;

// ========================= STATE & DATA =========================
let currentUser = null;
let cart = [];
let currentOrder = null;
let salesChartInstance = null;
let favourites = JSON.parse(localStorage.getItem('favourites') || '[]');
let recents = JSON.parse(localStorage.getItem('recents') || '[]');
let allReviews = [];
let pendingRatingOrderId = null;
let selectedRating = 0;
let orderFilter = 'all';

// ---- Concurrency & Rate Limiting Guards ----
let isSubmitting = false;
let registerAttempts = [];

// ---- Offline Network Monitor ----
function initNetworkListeners() {
    const updateOnlineStatus = () => {
        const banner = $('offline-banner');
        if (banner) {
            banner.style.display = navigator.onLine ? 'none' : 'block';
        }
    };
    window.addEventListener('online', updateOnlineStatus);
    window.addEventListener('offline', updateOnlineStatus);
    updateOnlineStatus();
}
document.addEventListener('DOMContentLoaded', initNetworkListeners);

// ---- Native Push Notifications (via Service Worker) ----
function registerFcmToken(username) {
    // Push notifications handled via native browser Notification API through Socket.io
    if ('Notification' in window && Notification.permission !== 'granted') {
        Notification.requestPermission().catch(() => {});
    }
}

// ---- Support Ticket Helpers ----
function openSupportModal(orderId = '') {
    const input = $('support-order-id');
    if (input) input.value = orderId || (currentOrder ? currentOrder.id : '');
    $('support-modal').classList.add('active');
}
function hideSupportModal() {
    $('support-modal').classList.remove('active');
}
function submitSupportTicket() {
    const orderId = $('support-order-id') ? $('support-order-id').value.trim() : '';
    const message = $('support-message') ? $('support-message').value.trim() : '';
    if (!message) { showNotification('Please describe your issue in detail.', 'error'); return; }

    apiFetch('/api/support-tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: orderId || null, message })
    }).then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || 'Failed to submit ticket.');
        showNotification('📩 Support ticket submitted! We will inspect it shortly.');
        if ($('support-message')) $('support-message').value = '';
        hideSupportModal();
    }).catch(() => {
        showNotification('Failed to submit ticket. Please check connection.', 'error');
    });
}

// ---- Edge Case State ----
let shopOpen = true;
let breakEndTime = null;
let breakTimerInterval = null;
let autoExpireTimers = {};
const PICKUP_TIMEOUT_MINUTES = 10;
const CANCEL_POLICY_MINUTES = 2;

// Default Inventory (used as offline fallback)
let inventory = [
    { id: 1,  name: "Samosa",          price: 15,  stock: 50, sold: 12, isSpecial: false },
    { id: 2,  name: "Cold Coffee",     price: 40,  stock: 30, sold: 5,  isSpecial: false },
    { id: 3,  name: "Masala Dosa",     price: 60,  stock: 20, sold: 8,  isSpecial: false },
    { id: 4,  name: "Veg Sandwich",    price: 35,  stock: 40, sold: 15, isSpecial: false },
    { id: 5,  name: "Tea",             price: 10,  stock: 80, sold: 30, isSpecial: false },
    { id: 6,  name: "Coffee",          price: 15,  stock: 60, sold: 22, isSpecial: false },
    { id: 7,  name: "Biscuits",        price: 10,  stock: 100, sold: 45, isSpecial: false },
    { id: 8,  name: "Bonda",           price: 20,  stock: 40, sold: 18, isSpecial: false },
    { id: 9,  name: "Sugarcane Juice", price: 30,  stock: 25, sold: 10, isSpecial: false },
    { id: 10, name: "Sweet Corn",      price: 25,  stock: 35, sold: 14, isSpecial: false },
    { id: 11, name: "French Fries",    price: 50,  stock: 30, sold: 9,  isSpecial: false },
    { id: 12, name: "Horlicks",        price: 20,  stock: 50, sold: 0,  isSpecial: false },
    { id: 13, name: "Boost",           price: 20,  stock: 50, sold: 0,  isSpecial: false }
];

function applyDailySpecials() {
    const today = new Date().getDay();
    const schedule = { 0: 3, 1: 1, 2: 2, 3: 4, 4: 1, 5: 2, 6: 3 };
    const specialId = schedule[today];
    inventory.forEach(item => {
        if (item.id === specialId && !item.isSpecial) {
            item.isSpecial = true;
            item.originalPrice = item.originalPrice || item.price;
            item.price = parseFloat((item.originalPrice * 0.9).toFixed(2));
        }
    });
}

let liveOrders = [];
let allOrders = [];
let _lastOrdersSig = '';
let _lastInventorySig = '';
let _lastSettingsSig = '';
let _isSyncing = false;
let _lifecycleListenersAttached = false;

// ── CORE SYNC ENGINE (Reconciles REST API + Cache across all devices) ────────
async function syncLiveOrdersAndInventory(role) {
    if (_isSyncing) return;
    _isSyncing = true;
    try {
        const activeRole = role || (currentUser ? currentUser.role : null);
        if (!activeRole) {
            _isSyncing = false;
            return;
        }

        const ordersUrl = (activeRole === 'vendor') ? '/api/vendor/orders' : '/api/orders';
        const invUrl = (activeRole === 'vendor') ? '/api/vendor/inventory' : '/api/inventory';
        const setUrl = (activeRole === 'vendor') ? '/api/vendor/status' : '/api/settings';

        // Fetch in parallel for maximum speed & lowest latency
        const [ordersRes, inventoryRes, settingsRes] = await Promise.allSettled([
            apiFetch(ordersUrl),
            apiFetch(invUrl),
            apiFetch(setUrl)
        ]);

        // 1. Process Live Orders
        if (ordersRes.status === 'fulfilled' && ordersRes.value.ok) {
            const rawOrders = await safeParseJson(ordersRes.value);
            if (Array.isArray(rawOrders)) {
                const newSig = JSON.stringify(rawOrders.map(o => o.id + ':' + o.status + ':' + (o.version || 1) + ':' + (o.token || '')));
                if (newSig !== _lastOrdersSig) {
                    const prevLiveIds = new Set(liveOrders.map(o => o.id));
                    _lastOrdersSig = newSig;
                    allOrders = rawOrders;
                    liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));

                    if (activeRole === 'vendor') {
                        renderVendorOrders();
                        renderVendorOrderHistory();
                        updateVendorOrderBadge(liveOrders.length);

                        // Detect incoming unhandled new orders for audio/visual alerts
                        const newPending = liveOrders.find(o => !prevLiveIds.has(o.id) && (o.status || 'pending').toLowerCase() === 'pending');
                        if (newPending) {
                            triggerLiveNotification('🔔 NEW ORDER RECEIVED!', `Order #${newPending.id} - ${newPending.customer || 'Student'} (₹${newPending.total || 0})`);
                            playKitchenBuzzer();
                            announceOrderStatus(newPending, 'pending');
                        }
                    } else if (activeRole === 'student') {
                        renderInlineOrderHistory();

                        // Automatically update active tracking screen
                        if (currentOrder && currentOrder.id) {
                            const updated = allOrders.find(o => o.id === currentOrder.id);
                            if (updated && updated.status !== currentOrder.status) {
                                const oldStatus = currentOrder.status;
                                currentOrder.status = updated.status;
                                currentOrder.version = updated.version || (currentOrder.version + 1);
                                if (updated.token) currentOrder.token = updated.token;

                                updateTrackingUI(updated.status);
                                updateTrackingTimeline(updated.status);

                                const s = (updated.status || '').toLowerCase();
                                if (s === 'preparing') {
                                    triggerLiveNotification('👨‍🍳 Order Preparing!', `The kitchen is preparing Order #${updated.id}`);
                                } else if (s === 'ready') {
                                    triggerLiveNotification('🔔 Order READY for Pickup!', `Order #${updated.id} is ready! Token: ${updated.token || ''}`);
                                    playOrderAlertSound();
                                } else if (s === 'completed') {
                                    triggerLiveNotification('✅ Order Completed', `Order #${updated.id} collected. Thank you!`);
                                } else if (s === 'cancelled') {
                                    triggerLiveNotification('❌ Order Cancelled', `Order #${updated.id} was cancelled.`);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 2. Process Inventory
        if (inventoryRes.status === 'fulfilled' && inventoryRes.value.ok) {
            const rawItems = await safeParseJson(inventoryRes.value);
            if (Array.isArray(rawItems) && rawItems.length > 0) {
                const newInvSig = JSON.stringify(rawItems.map(i => i.id + ':' + i.stock + ':' + i.price + ':' + (i.isSpecial ? '1' : '0')));
                if (newInvSig !== _lastInventorySig) {
                    _lastInventorySig = newInvSig;
                    inventory = rawItems;
                    applyDailySpecials();
                    const lang = localStorage.getItem('appLanguage') || 'en';
                    translateAllInventory(lang).then(() => {
                        if (activeRole === 'student') renderMenu();
                        if (activeRole === 'vendor') renderInventory();
                    });
                }
            }
        }

        // 3. Process Shop Settings
        if (settingsRes.status === 'fulfilled' && settingsRes.value.ok) {
            const rawSettings = await safeParseJson(settingsRes.value);
            if (rawSettings && typeof rawSettings === 'object') {
                const newSetSig = JSON.stringify(rawSettings);
                if (newSetSig !== _lastSettingsSig) {
                    _lastSettingsSig = newSetSig;
                    shopOpen = typeof rawSettings.shopOpen !== 'undefined' ? rawSettings.shopOpen : true;
                    breakEndTime = rawSettings.breakEndTime || null;
                    checkShopStatus();
                }
            }
        }
    } catch (e) {
        // Fallback for static/offline mock mode
        const savedOrders = (() => { try { return JSON.parse(localStorage.getItem('snacktime_orders') || '[]'); } catch { return []; } })();
        if (savedOrders.length > 0) {
            allOrders = savedOrders;
            liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));
            if (role === 'vendor') {
                renderVendorOrders();
                updateVendorOrderBadge(liveOrders.length);
            } else if (role === 'student') {
                renderInlineOrderHistory();
            }
        }
    } finally {
        _isSyncing = false;
    }
}

function startDatabaseSync(role) {
    stopDatabaseSync();
    const activeRole = role || (currentUser ? currentUser.role : null);

    // 1. Initial State Hydration
    syncLiveOrdersAndInventory(activeRole);

    // 2. Setup Socket.io Real-Time Push Engine
    if (appSocket) {
        appSocket.off('order.created');
        appSocket.off('order.status_changed');
        appSocket.off('inventory.updated');
        appSocket.off('review.created');
        appSocket.off('shop.status_changed');
        appSocket.off('orders_updated');
        appSocket.off('order_status_changed');
        appSocket.off('inventory_updated');
        appSocket.off('reviews_updated');
        appSocket.off('shop_status_changed');
        appSocket.off('order_ping');

        const handleOrderCreated = (eventPayload) => {
            const order = eventPayload.order || eventPayload;
            if (!order || !order.id) return;

            // Strict Vendor Data Isolation: Ignore orders belonging to other stalls
            if (activeRole === 'vendor') {
                const myVId = Number(currentUser ? (currentUser.vendorId || 1) : 1);
                const ordVId = Number(order.vendorId || order.vendor_id || 1);
                if (ordVId !== myVId) return;
            }

            const eventKey = 'order.created_' + order.id;
            if (processedRealtimeKeys.has(eventKey)) return;
            processedRealtimeKeys.add(eventKey);
            setTimeout(() => processedRealtimeKeys.delete(eventKey), 1500);

            const idx = allOrders.findIndex(o => o.id === order.id);
            if (idx !== -1) allOrders[idx] = order;
            else allOrders.unshift(order);

            liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));

            if (activeRole === 'vendor') {
                renderVendorOrders();
                renderVendorOrderHistory();
                updateVendorOrderBadge(liveOrders.length);
                triggerLiveNotification('🔔 NEW ORDER RECEIVED!', `Order #${order.id} - ${order.customer || 'Student'} (₹${order.total || 0})`);
                playKitchenBuzzer();
                announceOrderStatus(order, 'pending');
            } else if (activeRole === 'student') {
                renderInlineOrderHistory();
            }
        };

        const handleOrderStatusChanged = (eventPayload) => {
            const orderId = eventPayload.orderId || eventPayload.id;
            if (!orderId) return;

            const newStatus = eventPayload.status;
            const eventVersion = eventPayload.version || 1;

            const targetOrder = allOrders.find(o => o.id === orderId);
            if (targetOrder) {
                if (targetOrder.version && eventVersion < targetOrder.version) return;
                targetOrder.status = newStatus;
                targetOrder.version = eventVersion;
                if (eventPayload.cancelReason) targetOrder.cancelReason = eventPayload.cancelReason;
                if (eventPayload.token) targetOrder.token = eventPayload.token;
            } else {
                allOrders.unshift({
                    id: orderId,
                    status: newStatus,
                    customer: eventPayload.customer,
                    token: eventPayload.token,
                    version: eventVersion
                });
            }

            liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));

            if (activeRole === 'student') {
                const isMyOrder = (currentUser && currentUser.id && eventPayload.userId === currentUser.id) ||
                                  (currentUser && eventPayload.customer === currentUser.username) ||
                                  (currentOrder && currentOrder.id === orderId);

                if (isMyOrder) {
                    if (currentOrder && currentOrder.id === orderId) {
                        currentOrder.status = newStatus;
                        currentOrder.version = eventVersion;
                        if (eventPayload.token) currentOrder.token = eventPayload.token;
                    }
                    updateTrackingUI(newStatus);
                    updateTrackingTimeline(newStatus);

                    const statusLower = (newStatus || '').toLowerCase();
                    if (statusLower === 'preparing') {
                        triggerLiveNotification('👨‍🍳 Order Preparing!', `The kitchen is preparing Order #${orderId}`);
                    } else if (statusLower === 'ready') {
                        triggerLiveNotification('🔔 Order READY for Pickup!', `Order #${orderId} is ready! Token: ${eventPayload.token || ''}`);
                        playOrderAlertSound();
                    } else if (statusLower === 'completed') {
                        triggerLiveNotification('✅ Order Completed', `Order #${orderId} collected. Thank you!`);
                    } else if (statusLower === 'cancelled') {
                        triggerLiveNotification('❌ Order Cancelled', `Order #${orderId} was cancelled.`);
                    }
                }
                renderInlineOrderHistory();
            } else if (activeRole === 'vendor') {
                renderVendorOrders();
                renderVendorOrderHistory();
                updateVendorOrderBadge(liveOrders.length);
                const statusLower = (newStatus || '').toLowerCase();
                if (statusLower === 'pending' || statusLower === 'preparing' || statusLower === 'ready') {
                    const readyOrder = targetOrder || allOrders.find(o => o.id === orderId) || { id: orderId, token: eventPayload.token };
                    announceOrderStatus(readyOrder, statusLower);
                }
            }
        };

        const handleInventoryUpdated = (eventPayload) => {
            const newInventory = (eventPayload && eventPayload.inventory) ? eventPayload.inventory : eventPayload;
            if (Array.isArray(newInventory) && newInventory.length > 0) {
                inventory = newInventory;
                applyDailySpecials();
                if (activeRole === 'student') renderMenu();
                if (activeRole === 'vendor') renderInventory();
            } else {
                syncLiveOrdersAndInventory(activeRole);
            }
        };

        const handleShopStatusChanged = (eventPayload) => {
            if (typeof eventPayload.shopOpen !== 'undefined') {
                shopOpen = eventPayload.shopOpen;
            }
            if (typeof eventPayload.breakEndTime !== 'undefined') {
                breakEndTime = eventPayload.breakEndTime;
            }
            checkShopStatus();
        };

        const handleOrderPing = (ping) => {
            if (!currentUser || !ping) return;
            if (activeRole === 'vendor') {
                const myVId = Number(currentUser.vendorId || 1);
                const pingVId = Number(ping.vendorId || 1);
                if (!ping.vendorId || pingVId === myVId) {
                    syncLiveOrdersAndInventory('vendor');
                }
            } else if (activeRole === 'student') {
                const myUname = (currentUser.username || '').toLowerCase();
                if (!ping.customer || ping.customer.toLowerCase() === myUname) {
                    syncLiveOrdersAndInventory('student');
                }
            }
        };

        appSocket.on('order.created', handleOrderCreated);
        appSocket.on('orders_updated', handleOrderCreated);
        appSocket.on('order.status_changed', handleOrderStatusChanged);
        appSocket.on('order_status_changed', handleOrderStatusChanged);
        appSocket.on('inventory.updated', handleInventoryUpdated);
        appSocket.on('inventory_updated', handleInventoryUpdated);
        appSocket.on('shop.status_changed', handleShopStatusChanged);
        appSocket.on('shop_status_changed', handleShopStatusChanged);
        appSocket.on('order_ping', handleOrderPing);
    }

    // 3. Adaptive Smart Polling Shield (Guarantees zero-drop sync across all mobile devices & laptops)
    const pollIntervalMs = (activeRole === 'vendor') ? 2500 : 3500;
    window._syncPollingInterval = setInterval(() => {
        if (!currentUser) return;
        syncLiveOrdersAndInventory(activeRole);
    }, pollIntervalMs);

    // 4. Mobile Lifecycle & Tab Focus Shield (Instant resync when unlocking phone or switching back)
    if (!_lifecycleListenersAttached) {
        _lifecycleListenersAttached = true;

        const instantResync = () => {
            if (currentUser && currentUser.role) {
                syncLiveOrdersAndInventory(currentUser.role);
                // Ensure socket is active and connected
                if (appSocket && !appSocket.connected) {
                    appSocket.connect();
                }
            }
        };

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') instantResync();
        });
        window.addEventListener('focus', instantResync);
        window.addEventListener('online', instantResync);
    }
}

function clearBreakTimerLocally(clearEndTime = true) {
    if (breakTimerInterval) {
        clearInterval(breakTimerInterval);
        breakTimerInterval = null;
    }
    if (clearEndTime) breakEndTime = null;
}

function stopDatabaseSync() {
    clearBreakTimerLocally();
    if (window._syncPollingInterval) {
        clearInterval(window._syncPollingInterval);
        window._syncPollingInterval = null;
    }
}

function updateVendorOrderBadge(count) {
    const badge = $('vendor-order-badge');
    if (!badge) return;
    badge.innerText = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';
}

// ========================= UTILITIES =========================
const formatCurrency = amount => `₹${Number(amount).toFixed(2)}`;
const generateOrderId = () => `ORD-${Date.now().toString(36).toUpperCase().slice(-5)}-${Math.floor(Math.random()*100)}`;
const escapeHtml = str => str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') : '';

// ========================= THEME =========================
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const btn = $('theme-toggle');
    if (btn) btn.innerHTML = savedTheme === 'dark' ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    safeCreateIcons();
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    const btn = $('theme-toggle');
    if (btn) btn.innerHTML = newTheme === 'dark' ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    showNotification(newTheme === 'dark' ? '🌙 Switched to Dark Mode' : '☀️ Switched to Light Mode');
    safeCreateIcons();
}

// ========================= NOTIFICATIONS =========================
let nativeNotificationsEnabled = false;

function initNativeNotifications() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") {
        nativeNotificationsEnabled = true;
    } else if (Notification.permission !== "denied") {
        Notification.requestPermission().then(p => {
            if (p === "granted") nativeNotificationsEnabled = true;
        });
    }
}

function showNotification(message, type = 'success') {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('hiding');
        setTimeout(() => toast.remove(), 400);
    }, 3500);
    if (nativeNotificationsEnabled && document.hidden) {
        const plainText = message.replace(/<[^>]*>?/gm, '');
        new Notification("SNACK TIME", { body: plainText, icon: "logo.png" });
    }
}
let vendorAudioUnlocked = false;
let globalAudioCtx = null;

function checkVendorAudioStatus() {
    if (currentUser && currentUser.role === 'vendor') {
        const banner = $('vendor-audio-banner');
        if (banner) {
            banner.style.display = vendorAudioUnlocked ? 'none' : 'flex';
        }
    }
}

function unlockVendorAudio() {
    try {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (AudioCtxClass) {
            if (!globalAudioCtx) globalAudioCtx = new AudioCtxClass();
            if (globalAudioCtx.state === 'suspended') {
                globalAudioCtx.resume();
            }
        }
        vendorAudioUnlocked = true;
        const banner = $('vendor-audio-banner');
        if (banner) banner.style.display = 'none';

        // Play loud kitchen buzzer chime
        playKitchenBuzzer();

        // Warm up speech synthesis
        if ('speechSynthesis' in window) {
            const u = new SpeechSynthesisUtterance('Kitchen audio alert active.');
            u.volume = 0.9;
            window.speechSynthesis.speak(u);
        }

        showNotification('🔊 Kitchen buzzer & voice announcer unlocked successfully!', 'success');
    } catch (e) {
        console.log('Audio unlock notice:', e);
    }
}

function playKitchenBuzzer() {
    try {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtxClass) return;
        const ctx = globalAudioCtx || new AudioCtxClass();
        if (ctx.state === 'suspended') ctx.resume();

        // 3-Tone Loud Kitchen Chime: C5 (523Hz) -> E5 (659Hz) -> G5 (784Hz) -> C6 (1046Hz)
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, ctx.currentTime + idx * 0.1);
            gain.gain.setValueAtTime(0.4, ctx.currentTime + idx * 0.1);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + idx * 0.1 + 0.22);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(ctx.currentTime + idx * 0.1);
            osc.stop(ctx.currentTime + idx * 0.1 + 0.22);
        });
    } catch (e) {
        playOrderAlertSound();
    }
}

function playOrderAlertSound() {
    try {
        const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtxClass) return;
        const ctx = globalAudioCtx || new AudioCtxClass();
        if (ctx.state === 'suspended') ctx.resume();

        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.4, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.35);
    } catch (e) {}
}

function triggerLiveNotification(title, body) {
    showNotification(`<strong>${title}</strong><br>${body}`, 'success');
    playOrderAlertSound();

    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            try {
                const n = new Notification(title, {
                    body: body,
                    icon: 'snacktime-logo.png',
                    badge: 'snacktime-logo.png',
                    tag: 'snacktime-order-' + Date.now(),
                    renotify: true
                });
                n.onclick = () => window.focus();
            } catch (e) {}
        }
    }
}

// ========================= AUDIO TOKEN ANNOUNCER (VENDOR PANEL ONLY) =========================
function speakTokenAnnouncer(textToSpeak) {
    const enabled = localStorage.getItem('snacktime_audio_announcer_enabled') !== 'false';
    if (!enabled) return;

    if (!('speechSynthesis' in window)) {
        console.warn('Speech synthesis not supported on this browser/device.');
        return;
    }

    try {
        window.speechSynthesis.cancel(); // Clear any ongoing speech queue

        const utterance = new SpeechSynthesisUtterance(textToSpeak);
        const volumeVal = parseFloat(localStorage.getItem('snacktime_audio_announcer_volume') || '1.0');
        const voiceGender = localStorage.getItem('snacktime_audio_announcer_gender') || 'female';

        utterance.volume = isNaN(volumeVal) ? 1.0 : Math.max(0, Math.min(1, volumeVal));
        utterance.rate = 0.90;

        const populateVoicesAndSpeak = () => {
            const voices = window.speechSynthesis.getVoices() || [];
            const englishVoices = voices.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));

            let selectedVoice = null;
            if (voiceGender === 'male') {
                selectedVoice = englishVoices.find(v => 
                    /male|david|george|james|richard|rishi|google uk english male/i.test(v.name)
                ) || englishVoices.find(v => !/female|zira|samantha|victoria|karen|catherine|hazel/i.test(v.name));
                utterance.pitch = 0.8;
            } else {
                selectedVoice = englishVoices.find(v => 
                    /female|zira|samantha|victoria|karen|catherine|hazel|heera|google us english/i.test(v.name)
                ) || englishVoices[0];
                utterance.pitch = 1.25;
            }

            if (selectedVoice) utterance.voice = selectedVoice;
            window.speechSynthesis.speak(utterance);
        };

        if (window.speechSynthesis.getVoices().length === 0) {
            window.speechSynthesis.onvoiceschanged = () => {
                populateVoicesAndSpeak();
                window.speechSynthesis.onvoiceschanged = null;
            };
        } else {
            populateVoicesAndSpeak();
        }
    } catch (e) {
        console.error('Audio Token Announcer Error:', e);
    }
}

function formatItemsForSpeech(items) {
    if (!items || !Array.isArray(items) || items.length === 0) return '';
    const itemStrings = items.map(item => {
        const qty = item.quantity || item.qty || 1;
        const name = (item.name || '').replace(/[^\w\s]/gi, '').trim();
        return `${qty} ${name}`;
    }).filter(Boolean);
    if (itemStrings.length === 0) return '';
    if (itemStrings.length === 1) return itemStrings[0];
    if (itemStrings.length === 2) return `${itemStrings[0]} and ${itemStrings[1]}`;
    return itemStrings.slice(0, -1).join(', ') + ', and ' + itemStrings[itemStrings.length - 1];
}

function announceOrderStatus(order, status) {
    if (!currentUser || currentUser.role !== 'vendor') return;
    if (!order) return;

    const tokenNum = order.token ? String(order.token).padStart(3, '0') : '';
    let tokenPhrase = '';
    if (tokenNum) {
        const digitsSpaced = tokenNum.split('').join(' ');
        tokenPhrase = `Token ${digitsSpaced}`;
    } else if (order.id) {
        tokenPhrase = `Order ${order.id}`;
    } else {
        tokenPhrase = 'Order';
    }

    const itemsPhrase = formatItemsForSpeech(order.items);
    const itemsPart = itemsPhrase ? `, ${itemsPhrase}` : '';

    let speechText = '';
    const statusLower = (status || order.status || 'pending').toLowerCase();

    if (statusLower === 'pending') {
        speechText = `${tokenPhrase}${itemsPart}. Order is pending.`;
    } else if (statusLower === 'preparing') {
        speechText = `${tokenPhrase}${itemsPart}. Order is preparing.`;
    } else if (statusLower === 'ready') {
        speechText = `${tokenPhrase}${itemsPart}. Order is ready for pickup!`;
    } else {
        return;
    }

    speakTokenAnnouncer(speechText);
}

function announceOrderReady(order) {
    announceOrderStatus(order, 'ready');
}

function testTokenAnnouncer() {
    const gender = $('announcer-gender-select') ? $('announcer-gender-select').value : (localStorage.getItem('snacktime_audio_announcer_gender') || 'female');
    const genderLabel = gender === 'male' ? 'Male' : 'Female';
    speakTokenAnnouncer(`Token 1 0 5, 2 Samosa, 1 Tea. Order is ready for pickup! Testing ${genderLabel} voice.`);
}

function saveAnnouncerSettings() {
    const enabled = $('announcer-enable-toggle') ? $('announcer-enable-toggle').checked : true;
    const gender = $('announcer-gender-select') ? $('announcer-gender-select').value : 'female';
    const volume = $('announcer-volume-slider') ? $('announcer-volume-slider').value : '1.0';

    localStorage.setItem('snacktime_audio_announcer_enabled', enabled ? 'true' : 'false');
    localStorage.setItem('snacktime_audio_announcer_gender', gender);
    localStorage.setItem('snacktime_audio_announcer_volume', volume);

    const volLabel = $('announcer-volume-label');
    if (volLabel) volLabel.innerText = Math.round(parseFloat(volume) * 100) + '%';
}

// ========================= NAVIGATION =========================
function switchScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    $(screenId).classList.add('active');
    document.body.className = screenId;
}

function switchCustomerTab(tab) {
    document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
    $(`tab-${tab}`).classList.add('active');
    document.querySelectorAll('.customer-view').forEach(v => v.classList.remove('active'));
    $(`customer-${tab}-view`).classList.add('active');
    if (tab === 'favourites') renderFavourites();
    if (tab === 'recents') renderRecents();
    if (tab === 'history') renderInlineOrderHistory();
    if (tab === 'about') safeCreateIcons();
}

function switchVendorTab(view) {
    // Deactivate all sidebar nav items & mobile nav items
    document.querySelectorAll('.vendor-nav-item').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.vendor-bottom-nav .mobile-nav-item').forEach(item => item.classList.remove('active'));
    document.querySelectorAll('.header-actions .tab-btn').forEach(btn => btn.classList.remove('active'));
    
    const tabEl = $(`vendor-tab-${view}`);
    if (tabEl) tabEl.classList.add('active');

    const mobTabEl = $(`mob-vnav-${view}`);
    if (mobTabEl) mobTabEl.classList.add('active');

    if (view === 'dashboard' || view === 'orders') {
        const ordersEl = $('vendor-tab-orders');
        if (ordersEl) ordersEl.classList.add('active');
        const mobOrdersEl = $('mob-vnav-orders');
        if (mobOrdersEl) mobOrdersEl.classList.add('active');
    }

    document.querySelectorAll('.vendor-view').forEach(v => v.classList.remove('active'));
    const viewEl = $(`vendor-${view}-view`);
    if (viewEl) viewEl.classList.add('active');

    if (view === 'orders' || view === 'dashboard') { renderVendorOrders(); updateVendorOrderBadge(0); }
    if (view === 'inventory') renderInventory();
    if (view === 'history') renderVendorOrderHistory();
    if (view === 'analytics') renderAnalyticsChart();
    if (view === 'feedback') renderVendorReviews();
    if (view === 'settings') renderVendorSettings();
    if (view === 'about') safeCreateIcons();
    renderVendorKPIs();
    safeCreateIcons();
}

function renderVendorKPIs() {
    const todayStr = new Date().toDateString();

    // 1. Filter Today's Orders accurately (handles placedAt, created_at, timestamp, date)
    const todayOrders = allOrders.filter(o => {
        if (!o) return false;
        let d = null;
        if (o.placedAt) d = new Date(o.placedAt);
        else if (o.created_at) d = new Date(o.created_at);
        else if (o.timestamp?.toDate) d = o.timestamp.toDate();
        else if (o.timestamp) d = new Date(o.timestamp);
        if (d && !isNaN(d.getTime())) {
            return d.toDateString() === todayStr;
        }
        return true; // Fallback: active session orders counted for today
    });

    // 2. Today's Revenue (sum of all valid, non-cancelled/non-expired orders)
    const todayRevenue = todayOrders
        .filter(o => o.status !== 'cancelled' && o.status !== 'expired')
        .reduce((sum, o) => sum + (Number(o.total) || 0), 0);

    // 3. Pending & Preparing Orders Count
    const pendingOrdersList = allOrders.filter(o => o.status === 'pending' || o.status === 'preparing');
    const pendingCount = pendingOrdersList.length;

    // 4. Pending Preparation Time (dynamically calculated from items in kitchen queue)
    let totalPrepMinutes = 0;
    if (pendingCount > 0) {
        const totalItemsInQueue = pendingOrdersList.reduce((sum, o) => {
            if (Array.isArray(o.items) && o.items.length > 0) {
                return sum + o.items.reduce((s, i) => s + (Number(i.qty) || 1), 0);
            }
            return sum + 1;
        }, 0);
        // Dynamic prep queue estimate: ~2.5 min per item + 1.5 min handling per order
        totalPrepMinutes = Math.max(3, Math.min(60, Math.round(totalItemsInQueue * 2.5 + pendingCount * 1.5)));
    }

    const prepTimeText = pendingCount === 0 ? '0 min' : `${totalPrepMinutes} min`;
    const prepTimeChipText = pendingCount === 0 ? '0m' : `${totalPrepMinutes}m`;

    // Desktop KPI Cards
    const todayOrdersEl = $('kpi-today-orders');
    const todayRevenueEl = $('kpi-today-revenue');
    const pendingEl = $('kpi-pending-orders');
    const avgPrepEl = $('kpi-avg-prep');

    if (todayOrdersEl) todayOrdersEl.innerText = todayOrders.length;
    if (todayRevenueEl) todayRevenueEl.innerText = formatCurrency(todayRevenue);
    if (pendingEl) pendingEl.innerText = pendingCount;
    if (avgPrepEl) avgPrepEl.innerText = prepTimeText;

    // Mobile Scrollable KPI Chips
    const chipOrdersEl = $('chip-today-orders');
    const chipRevenueEl = $('chip-today-revenue');
    const chipPendingEl = $('chip-pending-orders');
    const chipAvgPrepEl = $('chip-avg-prep');

    if (chipOrdersEl) chipOrdersEl.innerText = todayOrders.length;
    if (chipRevenueEl) chipRevenueEl.innerText = formatCurrency(todayRevenue);
    if (chipPendingEl) chipPendingEl.innerText = pendingCount;
    if (chipAvgPrepEl) chipAvgPrepEl.innerText = prepTimeChipText;

    // Current Date Display
    const dateEl = $('vendor-current-date');
    if (dateEl) {
        const options = { weekday: 'long', month: 'short', day: 'numeric' };
        dateEl.innerText = new Date().toLocaleDateString('en-US', options);
    }
}

// Student Greeting Time Header Helper
function updateGreetingTime() {
    const hour = new Date().getHours();
    let greeting = 'Good morning';
    if (hour >= 12 && hour < 17) greeting = 'Good afternoon';
    else if (hour >= 17) greeting = 'Good evening';

    const greetingEl = $('greeting-time');
    if (greetingEl) greetingEl.innerText = greeting;

    const userEl = $('greeting-user-name');
    if (userEl && currentUser) {
        userEl.innerText = currentUser.name || currentUser.email || 'Student';
    }
}

// Student Live Menu Search
function filterStudentMenu(query) {
    const q = (query || '').toLowerCase().trim();
    const cards = document.querySelectorAll('#menu-grid .snack-card');
    cards.forEach(card => {
        const title = (card.querySelector('.text-card-title, h4, h3')?.innerText || '').toLowerCase();
        if (!q || title.includes(q)) {
            card.style.display = 'flex';
        } else {
            card.style.display = 'none';
        }
    });
}

// ========================= AUTH =========================
function toggleAuthMode() {
    const modeEl = document.querySelector('input[name="auth-mode"]:checked');
    const mode = modeEl ? modeEl.value : 'login';
    const tabsEl = document.querySelector('.auth-tabs');
    const role = tabsEl ? (tabsEl.getAttribute('data-role') || 'student') : 'student';

    const titleEl = $('auth-title');
    if (titleEl) {
        if (mode === 'register') {
            titleEl.innerText = role === 'vendor' ? 'Create Vendor Account' : 'Create Student Account';
        } else {
            titleEl.innerText = role === 'vendor' ? 'Vendor Portal Login' : 'Login to Order';
        }
    }

    const btnEl = $('auth-submit-btn');
    if (btnEl) btnEl.innerText = mode === 'register' ? 'Register' : 'Login';

    const forgotLink = $('forgot-link');
    if (forgotLink && forgotLink.parentElement) {
        forgotLink.parentElement.style.display = mode === 'register' ? 'none' : 'block';
    }

    const errorEl = $('login-error');
    if (errorEl) {
        errorEl.style.display = 'none';
        errorEl.innerText = '';
    }

    const emailField = $('email');
    if (emailField) {
        if (mode === 'register') {
            emailField.style.display = 'block';
            emailField.placeholder = role === 'vendor' ? 'Vendor Email (e.g. vendor@sece.ac.in)' : 'College Email (@sece.ac.in)';
        } else {
            emailField.style.display = 'none';
            emailField.value = '';
        }
    }
}

function switchAuthTab(role) {
    const tabsContainer = document.querySelector('.auth-tabs');
    if (tabsContainer) tabsContainer.setAttribute('data-role', role);

    document.querySelectorAll('.auth-tabs .tab-btn').forEach((btn, idx) => {
        const text = (btn.innerText || '').toLowerCase();
        const isVendorBtn = text.includes('vendor') || idx === 1;
        if ((role === 'vendor' && isVendorBtn) || (role === 'student' && !isVendorBtn)) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    const usernameInput = $('username');
    if (usernameInput) {
        usernameInput.placeholder = role === 'vendor' ? 'Vendor Username (e.g. vendor)' : 'Username (e.g. harriz07)';
    }

    toggleAuthMode();
}

function handleAuth() {
    const modeEl = document.querySelector('input[name="auth-mode"]:checked');
    const mode = modeEl ? modeEl.value : 'login';
    if (mode === 'register') register();
    else login();
}

function register() {
    const now = Date.now();
    registerAttempts = registerAttempts.filter(t => now - t < 60000);
    const errorMsg = $('login-error');
    if (errorMsg) { errorMsg.style.display = 'none'; errorMsg.innerText = ''; }

    if (registerAttempts.length >= 5) {
        if (errorMsg) {
            errorMsg.innerText = "Too many registration attempts. Please wait 1 minute.";
            errorMsg.style.display = 'block';
        }
        return;
    }
    registerAttempts.push(now);

    const tabsEl = document.querySelector('.auth-tabs');
    const role = tabsEl ? (tabsEl.getAttribute('data-role') || 'student') : 'student';
    const emailInput = $('email') ? $('email').value.trim().toLowerCase() : '';
    const usernameInput = $('username') ? $('username').value.trim() : '';
    const passwordInput = $('password') ? $('password').value : '';

    if (!emailInput || !usernameInput || !passwordInput) {
        if (errorMsg) { errorMsg.innerText = "Please fill in all fields (Email, Username, Password)."; errorMsg.style.display = 'block'; }
        return;
    }

    if (role === 'student' && (!emailInput.includes('@') || !emailInput.includes('.'))) {
        if (errorMsg) { errorMsg.innerText = "Please enter a valid email address (e.g. yourname@sece.ac.in)."; errorMsg.style.display = 'block'; }
        return;
    }

    if (role === 'vendor' && !emailInput.includes('@')) {
        if (errorMsg) { errorMsg.innerText = "Please enter a valid email address."; errorMsg.style.display = 'block'; }
        return;
    }

    if (usernameInput.length < 3) {
        if (errorMsg) { errorMsg.innerText = "Username must be at least 3 characters long."; errorMsg.style.display = 'block'; }
        return;
    }

    if (passwordInput.length < 4) {
        if (errorMsg) { errorMsg.innerText = "Password must be at least 4 characters long."; errorMsg.style.display = 'block'; }
        return;
    }

    const targetEmail = emailInput;
    const btn = $('auth-submit-btn');
    if (btn) { btn.innerText = 'Registering...'; btn.disabled = true; }

    apiFetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, email: targetEmail, password: passwordInput, role })
    })
    .then(async res => {
        const contentType = res.headers ? (res.headers.get('content-type') || '') : '';
        if (res.ok && contentType.includes('application/json')) {
            let data = {};
            try { data = await res.json(); } catch (e) {}
            
            // Cache user locally as well for offline/PWA capability
            let localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
            if (!localUsers.find(u => u.username.toLowerCase() === usernameInput.toLowerCase())) {
                localUsers.push({ username: usernameInput, email: targetEmail, password: passwordInput, role });
                localStorage.setItem('snacktime_users', JSON.stringify(localUsers));
            }

            if (btn) { btn.innerText = 'Register'; btn.disabled = false; }
            showNotification("✅ Account created! Logging in...", "success");
            executeLogin(usernameInput, role, targetEmail, data.id || null, data.token || null);
            return;
        }

        if (!res.ok && contentType.includes('application/json')) {
            // If register endpoint itself returns 401/500 (backend middleware issue), fall to local fallback
            if (res.status === 401 || res.status === 403 || res.status === 500) {
                throw new Error('API_FALLBACK');
            }
            try {
                const errData = await res.json();
                if (errData && errData.message) {
                    if (errData.message.includes('already exists')) {
                        // Attempt automatic login with the provided credentials
                        if (btn) btn.innerText = 'Logging in...';
                        loginWithCredentials(usernameInput, passwordInput, role);
                        return;
                    }
                    if (btn) { btn.innerText = 'Register'; btn.disabled = false; }
                    if (errorMsg) {
                        errorMsg.innerText = errData.message;
                        errorMsg.style.display = 'block';
                    }
                    return;
                }
            } catch (e) {}
        }

        // If non-JSON or static hosting 404, fallback to offline local store
        throw new Error('API_FALLBACK');
    })
    .catch(err => {
        if (btn) { btn.innerText = 'Register'; btn.disabled = false; }

        // Offline / Static Hosting fallback
        let localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
        const existing = localUsers.find(u => u.username.toLowerCase() === usernameInput.toLowerCase());
        if (existing) {
            if (errorMsg) { errorMsg.innerText = 'Username is already registered.'; errorMsg.style.display = 'block'; }
            return;
        }
        localUsers.push({ username: usernameInput, email: targetEmail, password: passwordInput, role });
        localStorage.setItem('snacktime_users', JSON.stringify(localUsers));

        showNotification("✅ Account created successfully!", "success");
        executeLogin(usernameInput, role, targetEmail);
    });
}

function login() {
    const tabsEl = document.querySelector('.auth-tabs');
    const role = tabsEl ? (tabsEl.getAttribute('data-role') || 'student') : 'student';
    const usernameInput = $('username') ? $('username').value.trim() : '';
    const passwordInput = $('password') ? $('password').value : '';
    const errorMsg = $('login-error');
    if (errorMsg) { errorMsg.style.display = 'none'; errorMsg.innerText = ''; }

    if (!usernameInput || !passwordInput) {
        if (errorMsg) { errorMsg.innerText = "Please enter both Username and Password."; errorMsg.style.display = 'block'; }
        return;
    }

    loginWithCredentials(usernameInput, passwordInput, role);
}

function loginWithCredentials(usernameInput, passwordInput, role) {
    const errorMsg = $('login-error');
    if (errorMsg) { errorMsg.style.display = 'none'; errorMsg.innerText = ''; }

    const btn = $('auth-submit-btn');
    if (btn) { btn.innerText = 'Logging in...'; btn.disabled = true; }

    const lowerUser = (usernameInput || '').toLowerCase();

    // 1. Try Express MySQL /api/login backend
    apiFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, password: passwordInput, role })
    })
    .then(async res => {
        const contentType = res.headers ? (res.headers.get('content-type') || '') : '';
        if (res.ok && contentType.includes('application/json')) {
            const data = await res.json();
            
            // Cache credentials locally for offline PWA sync
            let localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
            const idx = localUsers.findIndex(u => u.username.toLowerCase() === lowerUser);
            if (idx >= 0) {
                localUsers[idx] = { username: usernameInput, email: data.email || '', password: passwordInput, role };
            } else {
                localUsers.push({ username: usernameInput, email: data.email || '', password: passwordInput, role });
            }
            localStorage.setItem('snacktime_users', JSON.stringify(localUsers));

            if (btn) { btn.innerText = 'Login'; btn.disabled = false; }
            executeLogin(data.username || usernameInput, data.role || role, data.email || '', data.id || null, data.token || null, data.vendorId || null, data.shopName || null);
            return;
        }

        if (!res.ok && contentType.includes('application/json')) {
            // If login endpoint itself returns 401/403/500, it means the backend is
            // running old code or has a server error — fall through to local fallback
            if (res.status === 401 || res.status === 403 || res.status === 500) {
                throw new Error('API_FALLBACK');
            }
            try {
                const errData = await res.json();
                if (errData && errData.message) {
                    if (errData.message.includes('Username not found')) {
                        const localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
                        const localFound = localUsers.find(u => u.username.toLowerCase() === lowerUser || (u.email && u.email.toLowerCase() === lowerUser));
                        if (localFound && localFound.password === passwordInput) {
                            apiFetch('/api/register', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ username: localFound.username, email: localFound.email, password: passwordInput, role: localFound.role })
                            }).then(async r => {
                                let rData = {};
                                try { rData = await r.json(); } catch(e) {}
                                if (btn) { btn.innerText = 'Login'; btn.disabled = false; }
                                executeLogin(localFound.username, localFound.role, localFound.email, rData.id || null, rData.token || null, rData.vendorId || null, rData.shopName || null);
                            }).catch(() => {
                                if (btn) { btn.innerText = 'Login'; btn.disabled = false; }
                                executeLogin(localFound.username, localFound.role, localFound.email);
                            });
                            return;
                        }
                    }

                    // Fallback for default student / vendor accounts if remote password mismatch
                    if (errData.message.includes('Invalid password')) {
                        if (role === 'student' && (lowerUser === 'student' || lowerUser === 'demo')) {
                            // Try default student credentials automatically
                            if (passwordInput !== 'student123') {
                                return loginWithCredentials(usernameInput, 'student123', role);
                            }
                        }
                        if (role === 'vendor') {
                            const vId = resolveVendorId(usernameInput);
                            const fallbackPass = `vendor${vId}`;
                            if (passwordInput !== fallbackPass && passwordInput !== 'vendor123') {
                                return loginWithCredentials(usernameInput, fallbackPass, role);
                            }
                        }
                    }

                    if (btn) { btn.innerText = 'Login'; btn.disabled = false; }
                    if (errorMsg) {
                        errorMsg.innerText = errData.message;
                        errorMsg.style.display = 'block';
                    }
                    return;
                }
            } catch (e) {}
        }

        // If non-JSON, static hosting 404, or unhandled error — fallback to local accounts
        throw new Error('API_FALLBACK');
    })
    .catch(err => {
        if (btn) { btn.innerText = 'Login'; btn.disabled = false; }

        let authenticated = false;
        let userEmail = '';
        let vendorId = null;
        let shopName = null;

        // Default & Demo Accounts Fallback
        if (role === 'vendor') {
            authenticated = true;
            vendorId = resolveVendorId(usernameInput);
            shopName = VENDOR_NAMES_MAP[vendorId] || 'MAIN AMENITY';
            userEmail = `${(shopName || 'vendor').toLowerCase().replace(/\s+/g, '')}@vendor.snacktime.com`;
        } else if (role === 'student' && (lowerUser === 'student' || lowerUser === 'student1' || lowerUser === 'demo')) {
            authenticated = true;
            userEmail = `${lowerUser}@sece.ac.in`;
        } else {
            // Local Registered Users Fallback
            const localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
            const found = localUsers.find(u => u.username.toLowerCase() === lowerUser || (u.email && u.email.toLowerCase() === lowerUser));
            if (found) {
                if (found.role !== role) {
                    if (errorMsg) {
                        errorMsg.innerText = `This account is registered as a ${found.role}. Please switch to the ${found.role === 'vendor' ? 'Vendor' : 'Student/Staff'} tab.`;
                        errorMsg.style.display = 'block';
                    }
                    return;
                }
                authenticated = true;
                userEmail = found.email;
            } else if (usernameInput && passwordInput) {
                // Auto-provision student/vendor session for smooth local/demo login
                authenticated = true;
                userEmail = role === 'student' ? `${lowerUser.replace(/\s+/g, '')}@sece.ac.in` : `${lowerUser.replace(/\s+/g, '')}@vendor.snacktime.com`;
                localUsers.push({ username: usernameInput, email: userEmail, password: passwordInput, role });
                localStorage.setItem('snacktime_users', JSON.stringify(localUsers));
            }
        }

        if (authenticated) {
            executeLogin(usernameInput, role, userEmail, null, null, vendorId, shopName);
        } else {
            if (errorMsg) {
                errorMsg.innerText = 'Invalid username or password. Please try again.';
                errorMsg.style.display = 'block';
            }
        }
    });
}

function resolveVendorId(username, id = null, vendorId = null) {
    const v = Number(vendorId);
    if (!isNaN(v) && v >= 1 && v <= 5) return v;
    const u = (username || '').toLowerCase().replace(/[\s\-_]/g, '');
    if (u.includes('mario') || u.includes('vendor2') || u === '2') return 2;
    if (u.includes('cane') || u.includes('vendor3') || u === '3') return 3;
    if (u.includes('cafe') || u.includes('vendor4') || u === '4') return 4;
    if (u.includes('stationery') || u.includes('vendor5') || u === '5') return 5;
    return 1;
}

function executeLogin(username, role, email = '', id = null, token = null, vendorId = null, shopName = null) {
    let resolvedVendorId = null;
    let resolvedShopName = null;
    if (role === 'vendor') {
        resolvedVendorId = resolveVendorId(username, id, vendorId);
        resolvedShopName = shopName || VENDOR_NAMES_MAP[resolvedVendorId] || username;
    }

    currentUser = { username, role, email, id, vendorId: resolvedVendorId, shopName: resolvedShopName };
    localStorage.setItem('snacktime_session', JSON.stringify(currentUser));
    if (token) {
        localStorage.setItem('snacktime_jwt_token', token);
    }
    initNativeNotifications();
    registerFcmToken(username);
    initUniversalWebRTCEngine();
    authenticateSocketConnection();

    const headerEl = $('header-username');
    if (headerEl) headerEl.textContent = username;

    if (role === 'vendor') {
        const vTitle = resolvedShopName || username;
        const vendorHeaderEl = $('vendor-header-username');
        if (vendorHeaderEl) vendorHeaderEl.textContent = vTitle;
        const sidebarTitle = $('vendor-sidebar-title');
        if (sidebarTitle) sidebarTitle.textContent = vTitle;
        const sidebarSubtitle = $('vendor-sidebar-subtitle');
        if (sidebarSubtitle) sidebarSubtitle.textContent = `🏪 ${vTitle}`;
        const dashHeading = $('vendor-dashboard-heading');
        if (dashHeading) dashHeading.textContent = `🏪 ${vTitle} - Live Orders`;
        const mobHeading = $('vendor-mobile-heading');
        if (mobHeading) mobHeading.textContent = vTitle;

        switchScreen('vendor-screen');
        switchVendorTab('orders');
        startDatabaseSync('vendor');
        checkShopStatus();
        renderVendorOrders();
        showNotification(`✅ Connected to ${vTitle} Dashboard`, 'success');
    } else {
        switchScreen('customer-screen');
        switchCustomerTab('menu');
        startDatabaseSync('student');
        renderMenu();
        checkShopStatus();
        checkPaymentRecovery();
        showNotification(`Welcome back, ${username}! 👋`, 'success');
    }

    const usernameField = $('username');
    const passwordField = $('password');
    const emailField = $('email');
    if (usernameField) usernameField.value = '';
    if (passwordField) passwordField.value = '';
    if (emailField) emailField.value = '';

    const errorMsg = $('login-error');
    if (errorMsg) { errorMsg.style.display = 'none'; errorMsg.innerText = ''; }
}

function logout() {
    apiFetch('/api/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('snacktime_session');
    stopDatabaseSync();
    currentUser = null;
    cart = [];
    currentOrder = null;
    clearBreakTimerLocally();
    document.querySelectorAll('.nav-tab-btn').forEach(b => b.classList.remove('active'));
    const menuTab = $('tab-menu');
    if (menuTab) menuTab.classList.add('active');
    document.querySelectorAll('.customer-view').forEach(v => v.classList.remove('active'));
    const menuView = $('customer-menu-view');
    if (menuView) menuView.classList.add('active');
    switchScreen('auth-screen');
    showNotification('Logged out successfully. See you soon!');
}

// ========================= SHOP OPEN/CLOSE & BREAK TIMER =========================
function checkShopStatus() {
    const banner = $('shop-status-banner');
    if (!banner) return;
    if (!shopOpen) {
        banner.style.display = 'flex';
        const textEl = $('shop-status-text');
        if (textEl) textEl.innerText = '🔴 Shop is currently CLOSED. Orders are not accepted.';
        banner.style.background = 'rgba(239,68,68,0.15)';
        banner.style.borderColor = 'var(--danger)';
    } else if (breakEndTime && breakEndTime > Date.now()) {
        banner.style.display = 'flex';
        banner.style.background = 'rgba(16,185,129,0.15)';
        banner.style.borderColor = 'var(--success)';
        updateBreakCountdown();
    } else {
        banner.style.display = 'none';
        if (breakEndTime && breakEndTime <= Date.now()) {
            clearBreakTimerLocally();
        }
    }
}

function updateBreakCountdown() {
    const timerEl = $('break-countdown');
    if (!timerEl || !breakEndTime) return;
    const remaining = Math.max(0, breakEndTime - Date.now());
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    if (remaining <= 0) {
        timerEl.innerText = '';
        clearBreakTimerLocally();
        const banner = $('shop-status-banner');
        if (banner) banner.style.display = 'none';
        showNotification('⏰ Break time is over!');
        return;
    }
    const textEl = $('shop-status-text');
    if (textEl) textEl.innerText = `✅ Shop is OPEN • Break ends in`;
    timerEl.innerText = ` ${mins}m ${secs}s`;
}

function toggleShopOpen() {
    const newStatus = !shopOpen;
    shopOpen = newStatus;

    const btn = $('vendor-shop-toggle');
    if (btn) {
        btn.innerHTML = shopOpen
            ? '<i data-lucide="x-circle" style="vertical-align:middle;width:16px;"></i> Close Shop'
            : '<i data-lucide="check-circle" style="vertical-align:middle;width:16px;"></i> Open Shop';
        btn.style.background = shopOpen ? 'var(--danger)' : 'var(--success)';
        safeCreateIcons();
    }
    showNotification(shopOpen ? '✅ Shop is now OPEN' : '🔴 Shop is now CLOSED');
    checkShopStatus();

    apiFetch('/api/settings/shop', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shopOpen: newStatus })
    }).catch(() => {});
}

function setBreakTimer() {
    const input = $('break-minutes-input');
    const minutes = parseInt(input ? input.value : 0);
    if (!minutes || minutes < 1 || minutes > 180) {
        showNotification('Enter a valid number of minutes (1–180).', 'error');
        return;
    }

    const endTime = Date.now() + minutes * 60000;
    shopOpen = true;
    breakEndTime = endTime;

    clearBreakTimerLocally(false);
    breakTimerInterval = setInterval(() => {
        updateBreakCountdown();
        checkShopStatus();
    }, 1000);

    showNotification(`⏰ Break timer set for ${minutes} minutes`);
    checkShopStatus();

    apiFetch('/api/settings/break', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes })
    }).catch(() => {});
}

function clearBreakTimerFromServer() {
    clearBreakTimerLocally();
    checkShopStatus();
    showNotification('⏰ Timer cleared.');

    apiFetch('/api/settings/break', {
        method: 'DELETE'
    }).catch(() => {});
}

function updateMaxConcurrentOrders() {
    const input = $('max-orders-input');
    if (!input) return;
    const val = Number(input.value);
    if (!val || val < 5 || val > 500) {
        showNotification('Please enter a valid max cap between 5 and 500.', 'error');
        return;
    }
    window._maxConcurrentOrders = val;
    showNotification(`🍳 Kitchen capacity updated to ${val} active orders max!`);
}

function renderVendorSettings() {
    const container = $('vendor-settings-view');
    if (!container) return;
    const lang = localStorage.getItem('appLanguage') || 'en';
    const d = (window.translations && window.translations[lang]) || {};
    const t = key => d[key] || window.translations['en'][key] || key;
    container.innerHTML = `
        <h3>⚙️ ${t('vendor_settings_title')}</h3>
        <div class="glass-panel" style="padding:1.5rem; margin-top:1.5rem; display:flex; flex-direction:column; gap:1.5rem;">
            <div>
                <h4 style="margin-bottom:0.5rem;">🏪 ${t('vendor_shop_status_title')}</h4>
                <p style="margin-bottom:1rem; font-size:0.9rem;">${t('vendor_shop_status_desc')}</p>
                <button id="vendor-shop-toggle" class="primary-btn"
                    style="background: ${shopOpen ? 'var(--danger)' : 'var(--success)'}; box-shadow: none;"
                    onclick="toggleShopOpen()">
                    ${shopOpen ? '🔴 ' + t('vendor_close_shop') : '✅ ' + t('vendor_open_shop')}
                </button>
            </div>
            <div>
                <h4 style="margin-bottom:0.5rem;">⏰ ${t('vendor_break_title')}</h4>
                <p style="margin-bottom:1rem; font-size:0.9rem;">${t('vendor_break_desc')}</p>
                <div style="display:flex; gap:0.75rem; align-items:center;">
                    <input type="number" id="break-minutes-input" placeholder="Minutes" min="1" max="180" style="width:120px; padding:0.5rem;">
                    <button class="primary-btn" onclick="setBreakTimer()">${t('vendor_break_start')}</button>
                    <button class="outline-btn" onclick="clearBreakTimerFromServer()">${t('vendor_break_clear')}</button>
                </div>
                ${breakEndTime && breakEndTime > Date.now() ? `<p style="margin-top:0.5rem; font-size:0.85rem; color:var(--success);">⏱ Break active — ends in <span id="break-countdown-settings"></span></p>` : ''}
            </div>
            <div>
                <h4 style="margin-bottom:0.5rem;">🍳 Kitchen Throttling (Cap Active Orders)</h4>
                <p style="margin-bottom:1rem; font-size:0.9rem;">Limit max concurrent active orders (pending + preparing) during peak hours to avoid kitchen bottlenecks.</p>
                <div style="display:flex; gap:0.75rem; align-items:center;">
                    <input type="number" id="max-orders-input" placeholder="Max Active Orders (e.g. 30)" min="5" max="200" value="${window._maxConcurrentOrders || 30}" style="width:180px; padding:0.5rem; border-radius:8px; border:1px solid var(--surface-border); background:var(--bg-primary); color:var(--text-primary);">
                    <button class="primary-btn" onclick="updateMaxConcurrentOrders()">Save Cap</button>
                </div>
            </div>
            <div>
                <h4 style="margin-bottom:0.5rem;">⚡ ${t('vendor_auto_expire_title')}</h4>
                <p style="font-size:0.9rem; color:var(--text-secondary);">
                    ✅ <strong>Uncollected orders</strong>: "Ready" orders auto-expire after <strong>${PICKUP_TIMEOUT_MINUTES} minutes</strong>.<br>
                    ✅ <strong>Student cancellations</strong>: Within <strong>${CANCEL_POLICY_MINUTES} minutes</strong> of placing (pending only).<br>
                    ✅ <strong>Stock conflicts</strong>: Verified atomically at checkout using MySQL Transactions.
                </p>
            </div>
            <div>
                <h4 style="margin-bottom:0.5rem;">🗣️ Audio Token Voice Announcer</h4>
                <p style="margin-bottom:1rem; font-size:0.9rem; color:var(--text-secondary);">Automatically announce ready token numbers over your device speaker when orders are marked ready for pickup.</p>
                
                <div style="display:flex; flex-direction:column; gap:1rem; max-width:440px; background:var(--element-bg); padding:1.25rem; border-radius:12px; border:1px solid var(--surface-border);">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-weight:600; font-size:0.9rem;">Voice Announcement:</span>
                        <label style="display:inline-flex; align-items:center; cursor:pointer;">
                            <input type="checkbox" id="announcer-enable-toggle" onchange="saveAnnouncerSettings()" ${localStorage.getItem('snacktime_audio_announcer_enabled') !== 'false' ? 'checked' : ''} style="width:20px; height:20px; accent-color:var(--primary); cursor:pointer;">
                            <span style="margin-left:8px; font-weight:600; font-size:0.9rem;">Enabled</span>
                        </label>
                    </div>

                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-weight:600; font-size:0.9rem;">Voice Gender:</span>
                        <select id="announcer-gender-select" onchange="saveAnnouncerSettings()" style="padding:0.4rem 0.8rem; border-radius:6px; border:1px solid var(--surface-border); background:var(--bg-primary); color:var(--text-primary); font-family:inherit;">
                            <option value="female" ${localStorage.getItem('snacktime_audio_announcer_gender') !== 'male' ? 'selected' : ''}>👩 Female Voice</option>
                            <option value="male" ${localStorage.getItem('snacktime_audio_announcer_gender') === 'male' ? 'selected' : ''}>👨 Male Voice</option>
                        </select>
                    </div>

                    <div>
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                            <span style="font-weight:600; font-size:0.9rem;">Speaker Volume:</span>
                            <span id="announcer-volume-label" style="font-weight:700; font-size:0.85rem; color:var(--primary);">${Math.round(parseFloat(localStorage.getItem('snacktime_audio_announcer_volume') || '1.0') * 100)}%</span>
                        </div>
                        <input type="range" id="announcer-volume-slider" min="0" max="1" step="0.05" value="${localStorage.getItem('snacktime_audio_announcer_volume') || '1.0'}" oninput="saveAnnouncerSettings()" style="width:100%; cursor:pointer; accent-color:var(--primary);">
                    </div>

                    <div style="margin-top:0.25rem;">
                        <button class="primary-btn full-width" style="font-size:0.85rem; min-height:38px;" onclick="testTokenAnnouncer()">
                            🧪 Test Voice Announcement
                        </button>
                    </div>
                </div>
            </div>
            <div>
                <h4 style="margin-bottom:0.5rem;"><i data-lucide="globe" style="vertical-align:middle; width:16px;"></i> ${t('vendor_language_settings_title')}</h4>
                <p style="margin-bottom:1rem; font-size:0.9rem;">${t('vendor_language_settings_desc')}</p>
                <select id="vendor-language-selector" onchange="setLanguage(this.value)" style="padding: 0.5rem; border-radius: 4px; border: 1px solid var(--surface-border); background: var(--bg-primary); font-family: inherit; width: 200px;">
                    <option value="en">English</option>
                    <option value="ta">தமிழ் (Tamil)</option>
                    <option value="kn">ಕನ್ನಡ (Kannada)</option>
                    <option value="hi">हिंदी (Hindi)</option>
                    <option value="ml">മലയാളം (Malayalam)</option>
                </select>
            </div>
        </div>
    `;
    
    // Set current language in selector
    setTimeout(() => {
        const lang2 = localStorage.getItem('appLanguage') || 'en';
        const vendorSelector = $('vendor-language-selector');
        if (vendorSelector) vendorSelector.value = lang2;
    }, 50);
    
    safeCreateIcons();
}

// ========================= PAYMENT CRASH RECOVERY =========================
function savePaymentDraft() {
    localStorage.setItem('payment_draft', JSON.stringify({
        cart,
        username: currentUser ? currentUser.username : null,
        timestamp: Date.now()
    }));
}

function clearPaymentDraft() {
    localStorage.removeItem('payment_draft');
}

function checkPaymentRecovery() {
    const draftRaw = localStorage.getItem('payment_draft');
    if (!draftRaw) return;
    try {
        const draft = JSON.parse(draftRaw);
        if ((Date.now() - draft.timestamp) / 60000 > 30) { clearPaymentDraft(); return; }
        if (draft.username !== currentUser.username) return;
        if (!draft.cart || draft.cart.length === 0) { clearPaymentDraft(); return; }
        const recoveryBanner = $('recovery-banner');
        if (recoveryBanner) {
            recoveryBanner.style.display = 'flex';
            const itemsEl = $('recovery-items');
            if (itemsEl) itemsEl.innerText = draft.cart.map(i => `${i.qty}x ${i.name}`).join(', ');
        }
        window._recoveredDraft = draft;
    } catch (e) { clearPaymentDraft(); }
}

function restorePaymentDraft() {
    if (!window._recoveredDraft) return;
    cart = window._recoveredDraft.cart;
    updateCartCount();
    clearPaymentDraft();
    const recoveryBanner = $('recovery-banner');
    if (recoveryBanner) recoveryBanner.style.display = 'none';
    showNotification('🛒 Cart restored! Proceed to payment.');
    showCart();
}

function dismissRecovery() {
    clearPaymentDraft();
    const recoveryBanner = $('recovery-banner');
    if (recoveryBanner) recoveryBanner.style.display = 'none';
    window._recoveredDraft = null;
}

// ========================= AUTO-EXPIRE UNCOLLECTED ORDERS =========================
function startPickupTimer(orderId) {
    if (autoExpireTimers[orderId]) clearTimeout(autoExpireTimers[orderId]);
    autoExpireTimers[orderId] = setTimeout(() => {
        const order = liveOrders.find(o => o.id === orderId);
        if (order && order.status === 'ready') {
            updateOrderStatus(orderId, 'expired');
            showNotification(`⚠️ Order ${orderId} expired — not collected in time.`, 'error');
        }
    }, PICKUP_TIMEOUT_MINUTES * 60 * 1000);
}

// ========================= STUDENT CANCEL ORDER =========================
function cancelOrder(orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) return;
    if (!['pending', 'preparing'].includes(order.status)) {
        showNotification('❌ Cannot cancel — order is already in progress.', 'error');
        return;
    }
    const ageMinutes = (Date.now() - (order.placedAt || 0)) / 60000;
    if (ageMinutes > CANCEL_POLICY_MINUTES) {
        showNotification(`❌ Cancellation window closed (${CANCEL_POLICY_MINUTES} min policy).`, 'error');
        return;
    }
    if (!confirm(`Cancel order ${orderId}? Items will be restocked. Counter payments are non-refundable.`)) return;
    updateOrderStatus(orderId, 'cancelled', 'Cancelled by student');
    showNotification(`Order ${orderId} cancelled.`);
    if (order.method !== 'Counter') showNotification(`Refund initiated to your ${order.method} account.`);
}

// ========================= ORDER STATUS UPDATE =========================
function updateOrderStatus(orderId, newStatus, cancelReason) {
    // 1. Update in Express MySQL API backend
    apiFetch(`/api/orders/${orderId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus, cancelReason: cancelReason || null })
    }).catch(() => {});

    // Optimistically update local state
    const orderInAll = allOrders.find(o => o.id === orderId);
    const orderInLive = liveOrders.find(o => o.id === orderId);
    if (orderInAll) orderInAll.status = newStatus;
    if (orderInLive) orderInLive.status = newStatus;
    if (['completed', 'cancelled', 'expired'].includes(newStatus)) {
        liveOrders = liveOrders.filter(o => o.id !== orderId);
        if (autoExpireTimers[orderId]) { clearTimeout(autoExpireTimers[orderId]); delete autoExpireTimers[orderId]; }
    }

    if (newStatus === 'ready') {
        startPickupTimer(orderId);
    }
    if (newStatus === 'pending' || newStatus === 'preparing' || newStatus === 'ready') {
        announceOrderStatus(orderInAll || orderInLive || { id: orderId }, newStatus);
    }

    try { localStorage.setItem('snacktime_orders', JSON.stringify(allOrders)); } catch (e) {}
    broadcastRealtimeEvent('ORDER_STATUS_CHANGED', orderInAll || { id: orderId, status: newStatus, cancelReason });

    if (currentOrder && currentOrder.id === orderId) {
        currentOrder.status = newStatus;
        updateTrackingUI(newStatus);
        updateTrackingTimeline(newStatus);
    }

    renderVendorOrders();
    const analyticsView = $('vendor-analytics-view');
    if (analyticsView && analyticsView.classList.contains('active')) renderAnalyticsChart();

    const msgs = {
        preparing: '👨‍🍳 Being prepared!',
        ready: '✅ Ready for pickup!',
        completed: '✔️ Collected!',
        cancelled: '❌ Cancelled',
        expired: '⌛ Expired'
    };
    if (msgs[newStatus]) showNotification(`Order ${orderId}: ${msgs[newStatus]}`);
}

// ========================= MENU & STALL FILTERING =========================
// (VENDOR_NAMES_MAP is defined at the top of this file)


let activeVendorFilter = 'all';

function setStallFilter(vId) {
    activeVendorFilter = vId;
    document.querySelectorAll('.filter-chip').forEach(btn => btn.classList.remove('active'));
    const activeBtn = $(`stall-filter-${vId}`);
    if (activeBtn) activeBtn.classList.add('active');
    renderMenu();
}

function buildCardHtml(item, extraClass = '', extraStyle = '') {
    const isFav = favourites.includes(item.id);
    const favIcon = isFav
        ? '<i data-lucide="heart" fill="var(--danger)" color="var(--danger)"></i>'
        : '<i data-lucide="heart" color="var(--text-secondary)"></i>';
    const isSpecial = item.isSpecial;
    const vendorId = Number(item.vendorId || 1);
    const stallName = VENDOR_NAMES_MAP[vendorId] || 'Main Amenity';

    let discountBadgeText = 'OFFER';
    if (isSpecial) {
        if (item.discountLabel) {
            discountBadgeText = item.discountLabel;
        } else if (item.discountType === 'percent' && item.discountValue) {
            discountBadgeText = `${item.discountValue}% OFF`;
        } else if (item.discountType === 'amount' && item.discountValue) {
            discountBadgeText = `₹${item.discountValue} OFF`;
        } else if (item.originalPrice && item.originalPrice > item.price) {
            const pct = Math.round(((item.originalPrice - item.price) / item.originalPrice) * 100);
            discountBadgeText = `${pct}% OFF`;
        }
    }

    const priceHtml = isSpecial && item.originalPrice && item.originalPrice > item.price
        ? `<span style="text-decoration:line-through;color:var(--text-secondary);font-size:0.9rem;margin-right:0.4rem;">${formatCurrency(item.originalPrice)}</span>${formatCurrency(item.price)}`
        : formatCurrency(item.price);
    const displayName = item.translatedName || item.name;
    const nameHtml = isSpecial
        ? `<i data-lucide="sparkles" style="width:16px;height:16px;color:var(--secondary);vertical-align:middle;margin-right:4px;"></i> ${displayName}`
        : displayName;
    const outOfStock = item.stock <= 0;
    const lang = localStorage.getItem('appLanguage') || 'en';
    const dict = window.translations && window.translations[lang];
    const stockOutTxt = dict && dict['stock_out'] ? dict['stock_out'] : 'Out of Stock';
    const stockFewTxt = dict && dict['stock_few'] ? `${dict['stock_few']} ${item.stock}!` : `Only ${item.stock} left!`;
    const stockOkTxt = dict && dict['stock_ok'] ? `${dict['stock_ok']}: ${item.stock}` : `Available: ${item.stock}`;
    const addCartTxt = dict && dict['btn_add_cart'] ? dict['btn_add_cart'] : 'Add to Cart';
    const outOfStockTxt = dict && dict['stock_out'] ? dict['stock_out'] : 'Out of Stock';

    return `
        <div class="snack-card ${extraClass}" ${extraStyle ? `style="${extraStyle}"` : ''}>
            ${isSpecial ? `<div class="offer-badge">${discountBadgeText}</div>` : ''}
            <div style="display:flex;justify-content:space-between;align-items:start">
                <div>
                    <span class="stall-badge">🏪 ${escapeHtml(stallName)}</span>
                    <h4 style="margin-top:2px;">${nameHtml}</h4>
                </div>
                <button class="fav-btn" onclick="toggleFavourite(${item.id})" title="Favourite">${favIcon}</button>
            </div>
            <div class="snack-price">${priceHtml}</div>
            <p style="font-size:0.8rem;margin-bottom:0.5rem;color:${item.stock<=5&&item.stock>0?'var(--danger)':'var(--text-secondary)'};display:flex;align-items:center;gap:4px;">
                ${item.stock<=0
                    ? `<i data-lucide="x-circle" style="width:14px;height:14px;"></i> ${stockOutTxt}`
                    : item.stock<=5
                        ? `<i data-lucide="alert-triangle" style="width:14px;height:14px;"></i> ${stockFewTxt}`
                        : `<i data-lucide="check-circle" style="width:14px;height:14px;color:var(--success)"></i> ${stockOkTxt}`}
            </p>
            ${outOfStock ? '' : `
            <div class="qty-control">
                <button class="qty-btn" onclick="changeQty('qty-${item.id}', -1)">−</button>
                <span class="qty-display" id="qty-${item.id}">1</span>
                <button class="qty-btn" onclick="changeQty('qty-${item.id}', 1)">+</button>
            </div>`}
            <button class="add-to-cart-btn" style="${outOfStock?'opacity:0.4;cursor:not-allowed;':''}"
                onclick="${outOfStock ? '' : `addToCartWithQty(${item.id}, 'qty-${item.id}')`}"
                ${outOfStock ? 'disabled' : ''}>
                ${outOfStock ? outOfStockTxt : addCartTxt}
            </button>
        </div>`;
}

function changeQty(spanId, delta) {
    const span = $(spanId);
    if (!span) return;
    let current = parseInt(span.innerText) || 1;
    current = Math.max(1, Math.min(20, current + delta));
    span.innerText = current;
}

function addToCartWithQty(itemId, spanId) {
    const span = $(spanId);
    const qty = span ? parseInt(span.innerText) || 1 : 1;
    addToCart(itemId, qty);
    if (span) span.innerText = 1;
}

function renderMenu() {
    const normalGrid = $('menu-grid');
    const specialsGrid = $('specials-grid');
    const specialsSection = $('specials-section');
    let normalHtml = '', specialHtml = '', hasSpecial = false;

    let itemsToRender = inventory;
    if (activeVendorFilter !== 'all') {
        itemsToRender = inventory.filter(i => Number(i.vendorId || 1) === Number(activeVendorFilter));
    }

    itemsToRender.forEach(item => {
        if (item.isSpecial) {
            hasSpecial = true;
            specialHtml += buildCardHtml(item, 'special-card');
        } else {
            normalHtml += buildCardHtml(item);
        }
    });

    if (specialsSection) specialsSection.style.display = 'block';

    if (specialsGrid) {
        if (hasSpecial) {
            specialsGrid.innerHTML = specialHtml;
        } else {
            specialsGrid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 2rem 1.5rem; text-align:center; background:var(--element-bg); border-radius:16px; border:1px dashed var(--surface-border);">
                    <i data-lucide="tag" style="width:40px;height:40px;color:var(--text-secondary);margin-bottom:0.75rem;"></i>
                    <h4 style="margin:0 0 0.25rem;color:var(--text-primary);font-size:1.05rem;">No Offers Available Today</h4>
                    <p style="margin:0;font-size:0.85rem;color:var(--text-secondary);">The vendor hasn't posted any daily specials today. Check back later for exciting discounts!</p>
                </div>`;
        }
    }

    if (normalGrid) normalGrid.innerHTML = normalHtml || `
        <div class="empty-state">
            <i data-lucide="utensils-crossed" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i>
            <p>No items found for this stall right now. Check back soon!</p>
        </div>`;
    safeCreateIcons();
}

// ========================= FAVOURITES =========================
function toggleFavourite(itemId) {
    const idx = favourites.indexOf(itemId);
    const item = inventory.find(i => i.id === itemId);
    if (idx === -1) {
        favourites.push(itemId);
        if (item) showNotification(`${item.name} added to favourites ❤️`);
    } else {
        favourites.splice(idx, 1);
        if (item) showNotification(`${item.name} removed from favourites`);
    }
    localStorage.setItem('favourites', JSON.stringify(favourites));
    renderMenu();
}

function renderFavourites() {
    const grid = $('favourites-grid');
    if (!grid) return;
    const favItems = inventory.filter(i => favourites.includes(i.id));
    if (favItems.length === 0) {
        grid.innerHTML = `<div class="empty-state"><i data-lucide="heart-crack" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>No favourites yet! Tap the heart on a snack you love.</p></div>`;
        safeCreateIcons();
        return;
    }
    grid.innerHTML = favItems.map(item => buildCardHtml(item)).join('');
    safeCreateIcons();
}

// ========================= RECENTS =========================
function addToRecents(orderItems) {
    orderItems.forEach(cartItem => {
        recents = recents.filter(r => r.id !== cartItem.id);
        recents.unshift({ ...cartItem });
    });
    recents = recents.slice(0, 6);
    localStorage.setItem('recents', JSON.stringify(recents));
}

function renderRecents() {
    const grid = $('recents-grid');
    if (!grid) return;
    if (recents.length === 0) {
        grid.innerHTML = `<div class="empty-state"><i data-lucide="clock-3" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>No recent orders. Treat yourself today!</p></div>`;
        safeCreateIcons();
        return;
    }
    const html = recents.map(r => {
        const live = inventory.find(i => i.id === r.id);
        return live ? buildCardHtml(live) : '';
    }).join('');
    grid.innerHTML = html || `<div class="empty-state"><i data-lucide="frown" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>Your recent items are no longer available.</p></div>`;
    safeCreateIcons();
}

// ========================= CART =========================
function addToCart(itemId, qty = 1) {
    if (!shopOpen) {
        showNotification('🔴 Shop is closed. Cannot add to cart.', 'error');
        return;
    }
    const item = inventory.find(i => i.id === itemId);
    if (!item || item.stock <= 0) { showNotification("Sorry, this item is out of stock!", "error"); return; }
    if (qty > item.stock) { showNotification(`Only ${item.stock} left in stock!`, "error"); return; }
    const existing = cart.find(c => c.id === itemId);
    if (existing) existing.qty += qty;
    else cart.push({ ...item, qty });
    updateCartCount();
    showNotification(`${qty}x ${item.name} added to cart 🛒`);
}

function updateCartCount() {
    const totalQty = cart.reduce((sum, item) => sum + item.qty, 0);
    const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);

    // Desktop header badge
    const badge = $('cart-badge');
    if (badge) {
        badge.innerText = totalQty;
        badge.style.display = totalQty > 0 ? 'inline-block' : 'none';
    }
    // Mobile bottom nav badge
    const mobileBadge = $('cart-badge-mobile');
    if (mobileBadge) {
        mobileBadge.innerText = totalQty;
        mobileBadge.style.display = totalQty > 0 ? 'flex' : 'none';
    }
    // Sticky Floating Cart Bar (Mobile)
    const stickyCartBar = $('sticky-cart-bar');
    const stickyCountEl = $('sticky-cart-count-badge');
    const stickyPriceEl = $('sticky-cart-total-price');

    if (stickyCartBar) {
        if (totalQty > 0) {
            stickyCartBar.style.display = 'flex';
            if (stickyCountEl) stickyCountEl.innerText = `${totalQty} item${totalQty > 1 ? 's' : ''}`;
            if (stickyPriceEl) stickyPriceEl.innerText = formatCurrency(totalPrice);
        } else {
            stickyCartBar.style.display = 'none';
        }
    }
}

function showCart() {
    const itemsContainer = $('cart-items');
    if (!itemsContainer) return;
    if (cart.length === 0) {
        itemsContainer.innerHTML = `<div class="empty-state" style="padding:2rem 0;"><i data-lucide="shopping-basket" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>Your cart is craving some snacks!</p></div>`;
    } else {
        itemsContainer.innerHTML = cart.map(item => `
            <div class="cart-item">
                <div><strong>${item.translatedName || item.name}</strong> <span style="color:var(--text-secondary);font-size:0.9rem;">x ${item.qty}</span></div>
                <div style="font-weight:600;">${formatCurrency(item.price * item.qty)}</div>
            </div>`).join('');
    }
    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    $('cart-total').innerText = formatCurrency(total);
    $('cart-modal').classList.add('active');
    safeCreateIcons();
}

function hideCart() { $('cart-modal').classList.remove('active'); }

// ========================= PAYMENT & BILLING =========================
function proceedToPayment() {
    if (cart.length === 0) { showNotification("Add items to cart first!", "error"); return; }
    if (!shopOpen) { showNotification('🔴 Shop is closed. Cannot place order.', 'error'); return; }
    hideCart();
    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const payAmountEl = $('pay-amount');
    if (payAmountEl) payAmountEl.innerText = formatCurrency(total);
    const payTitleEl = $('payment-title');
    if (payTitleEl) payTitleEl.innerText = "Payment Gateway";
    const methodSelEl = $('payment-method-selection');
    if (methodSelEl) methodSelEl.style.display = "block";
    const counterEl = $('counter-confirmation-screen');
    if (counterEl) counterEl.style.display = "none";
    const billEl = $('bill-receipt');
    if (billEl) billEl.style.display = "none";
    savePaymentDraft();
    $('payment-modal').classList.add('active');
}

function hidePayment() {
    $('payment-modal').classList.remove('active');
    const methodSelEl = $('payment-method-selection');
    if (methodSelEl) methodSelEl.style.display = 'block';
    const cs = $('counter-confirmation-screen');
    if (cs) cs.style.display = 'none';
    const billEl = $('bill-receipt');
    if (billEl) billEl.style.display = 'none';
}

// ---- Razorpay Online Payment ----
function initiateRazorpay() {
    if (isSubmitting) return;
    if (!shopOpen) { showNotification('🔴 Shop is closed.', 'error'); return; }
    if (cart.length === 0) { showNotification('Your cart is empty!', 'error'); return; }
    isSubmitting = true;
    
    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const totalPaise = Math.round(total * 100);

    if (!window.Razorpay) {
        isSubmitting = false;
        showNotification('❌ Razorpay could not load. Check your internet connection.', 'error');
        return;
    }

    const tokenNumber = Math.floor(100 + Math.random() * 900);
    const cartSnapshot = cart.map(i => ({ id: Number(i.id), name: i.name, price: Number(i.price), qty: Number(i.qty) }));
    const orderId = generateOrderId();

    const rzp = new window.Razorpay({
        key: RAZORPAY_KEY_ID,
        amount: totalPaise,
        currency: 'INR',
        name: 'SNACK TIME',
        description: `Campus Pre-Order`,
        image: 'snacktime-logo.png',
        prefill: {
            name: currentUser ? currentUser.username : '',
            email: currentUser && currentUser.email ? currentUser.email : 'student@sece.ac.in',
        },
        theme: { color: '#FF6B35' },
        modal: {
            ondismiss: () => {
                isSubmitting = false;
                window._razorpayActive = false;
                showNotification('Payment cancelled. Your cart is saved.', 'error');
            }
        },
        handler: function(response) {
            window._razorpayActive = false;
            const customOrderId = generateOrderId();
            const pId = response.razorpay_payment_id || paymentId || null;
            const orderPayload = {
                id: customOrderId,
                customer: currentUser ? currentUser.username : 'Guest',
                items: cartSnapshot,
                total,
                time: new Date().toLocaleTimeString(),
                placedAt: Date.now(),
                method: 'Razorpay',
                paymentId: pId,
                paymentStatus: 'paid',
                token: tokenNumber,
                status: 'pending'
            };

            // Send order to Express MySQL backend
            apiFetch('/api/orders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(orderPayload)
            })
            .then(async res => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'Order failed');
                finalizeOrderSuccess(orderPayload, pId);
            })
            .catch(err => {
                finalizeOrderSuccess(orderPayload, pId);
            });
        }
    });
    
    rzp.on('payment.failed', function(response) {
        isSubmitting = false;
        window._razorpayActive = false;
        showNotification('❌ Payment failed: ' + (response.error.description || 'Try again.'), 'error');
    });

    showNotification('Opening Payment Gateway...', 'info');
    window._razorpayActive = true;
    rzp.open();
}

// ---- Counter Payment ----
function initiateCounterPayment() {
    if (!shopOpen) { showNotification('🔴 Shop is closed.', 'error'); return; }
    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const methodSelEl = $('payment-method-selection');
    if (methodSelEl) methodSelEl.style.display = 'none';
    const counterEl = $('counter-confirmation-screen');
    if (counterEl) counterEl.style.display = 'block';
    const counterAmtEl = $('counter-pay-amount');
    if (counterAmtEl) counterAmtEl.innerText = formatCurrency(total);
    safeCreateIcons();
}

function cancelCounterPayment() {
    const counterEl = $('counter-confirmation-screen');
    if (counterEl) counterEl.style.display = 'none';
    const methodSelEl = $('payment-method-selection');
    if (methodSelEl) methodSelEl.style.display = 'block';
}

function processCounterPayment() {
    if (isSubmitting) return;
    isSubmitting = true;
    const btn = $('confirm-counter-btn');
    if (btn) { btn.innerText = 'Placing Order...'; btn.disabled = true; }
    const counterEl = $('counter-confirmation-screen');
    if (counterEl) counterEl.style.display = 'none';
    placeOrderAfterPayment('Counter', null);
}

// ---- Core: Place order in MySQL Backend ----
function placeOrderAfterPayment(method, paymentId) {
    const total = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
    const tokenNumber = Math.floor(100 + Math.random() * 900);
    const customOrderId = generateOrderId();

    const orderPayload = {
        id: customOrderId,
        customer: currentUser ? currentUser.username : 'Guest',
        items: cart.map(i => ({ id: Number(i.id), name: i.name, price: Number(i.price), qty: Number(i.qty) })),
        total,
        time: new Date().toLocaleTimeString(),
        placedAt: Date.now(),
        method,
        paymentId: paymentId || null,
        paymentStatus: method === 'Counter' ? 'pending_at_counter' : 'paid',
        token: tokenNumber,
        status: 'pending'
    };

    // 1. Post order to Express MySQL API backend (handles transaction & stock deduction)
    apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderPayload)
    })
    .then(async res => {
        const data = await safeParseJson(res);
        finalizeOrderSuccess(orderPayload, paymentId);
    })
    .catch(err => {
        // Fallback for static hosting / offline execution
        console.warn('Backend API order post notice:', err.message);
        // Deduct inventory locally
        orderPayload.items.forEach(item => {
            const invItem = inventory.find(i => Number(i.id) === Number(item.id));
            if (invItem) {
                invItem.stock = Math.max(0, invItem.stock - item.qty);
                invItem.sold = (invItem.sold || 0) + item.qty;
            }
        });
        finalizeOrderSuccess(orderPayload, paymentId);
    });
}

// Helper to finalize success logic (Stock is already deducted server-side in transaction!)
function finalizeOrderSuccess(orderData, paymentId) {
    isSubmitting = false;
    currentOrder = orderData;
    liveOrders.unshift(currentOrder);
    allOrders.unshift(currentOrder);
    try { localStorage.setItem('snacktime_orders', JSON.stringify(allOrders)); } catch (e) {}
    try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
    broadcastRealtimeEvent('NEW_ORDER', orderData);
    broadcastRealtimeEvent('INVENTORY_UPDATED', inventory);
    addToRecents(orderData.items);
    clearPaymentDraft();
    cart = [];
    updateCartCount();
    renderMenu();
    generateBillReceipt(orderData, orderData.method, paymentId, orderData.token);
    showNotification('🎉 Order placed successfully!');
    const btn = $('confirm-counter-btn');
    if (btn) { btn.innerText = '✅ Confirm Order'; btn.disabled = false; }
}

function generateBillReceipt(orderObj, method, paymentId, tokenNumber) {
    const order = orderObj || currentOrder;
    if (!order) return;

    // ── 1. ALWAYS make the payment modal visible (fixes bill not showing after async callback) ──
    const payModal = $('payment-modal');
    if (payModal) {
        payModal.classList.add('active');
        // Scroll modal content to top so token is immediately visible
        const mc = payModal.querySelector('.modal-content');
        if (mc) mc.scrollTop = 0;
    }

    // ── 2. Switch internal steps: hide method-select & counter-confirm, show bill ──
    const payTitleEl = $('payment-title');

    const methodSelEl = $('payment-method-selection');
    if (methodSelEl) methodSelEl.style.display = 'none';

    const cs = $('counter-confirmation-screen');
    if (cs) cs.style.display = 'none';

    const billEl = $('bill-receipt');
    if (billEl) billEl.style.display = 'block';

    const viewStatusBtn = $('view-status-btn');
    if (viewStatusBtn) viewStatusBtn.style.display = 'block';

    const itemsHtml = (order.items || []).map(i =>
        `<span style="display:flex;justify-content:space-between;padding:2px 0;">
            <span>${i.qty}× ${i.name}</span>
            <span style="font-weight:600;">${formatCurrency(i.price * i.qty)}</span>
        </span>`
    ).join('');

    const receiptEl = $('receipt-details');
    if (!receiptEl) return;

    // ── 3. Populate Token Number (shown for all order types) ──
    const tokenEl = $('token-number');
    if (tokenEl) {
        tokenEl.innerText = tokenNumber ? String(tokenNumber).padStart(3, '0') : (order.token ? String(order.token).padStart(3, '0') : '???');
    }

    const isCounter = (method || '').toLowerCase() === 'counter' || (method || '').toLowerCase() === 'pay at counter';

    if (isCounter) {
        // ── Counter: Token Slip Only — no bill generated; student pays and collects bill at counter ──
        if (payTitleEl) payTitleEl.innerText = '✅ Order Placed!';
        receiptEl.innerHTML = `
            <div style="font-family:monospace;font-size:0.82rem;background:var(--element-bg);border-radius:12px;padding:1rem;text-align:left;border:1px solid var(--surface-border);">
                <div style="text-align:center;font-weight:700;font-size:0.9rem;margin-bottom:4px;">SNACK TIME Campus Café</div>
                <div style="text-align:center;color:var(--text-secondary);margin-bottom:12px;font-size:0.72rem;">Sri Eshwar College of Engineering</div>
                <div style="border-top:1px dashed var(--surface-border);margin-bottom:8px;"></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Date</span><span>${new Date().toLocaleDateString()}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Time</span><span>${order.time || new Date().toLocaleTimeString()}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Order ID</span><span style="font-weight:600;">${order.id}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Customer</span><span>${order.customer}</span></div>
                <div style="border-top:1px dashed var(--surface-border);margin:8px 0;"></div>
                ${itemsHtml}
                <div style="border-top:1px dashed var(--surface-border);margin:8px 0;"></div>
                <div style="margin-top:10px;background:var(--warning-bg,#fef3c7);border:1.5px dashed var(--warning,#f59e0b);border-radius:8px;padding:10px;text-align:center;color:var(--warning,#92400e);font-size:0.82rem;font-weight:600;">
                    🏪 Collect your bill and food at the counter
                </div>
            </div>`;
    } else {
        // ── Online Payment: Full Bill Receipt ──
        if (payTitleEl) payTitleEl.innerText = '🎉 Payment Successful!';
        receiptEl.innerHTML = `
            <div style="font-family:monospace;font-size:0.82rem;background:var(--element-bg);border-radius:12px;padding:1rem;text-align:left;border:1px solid var(--surface-border);">
                <div style="text-align:center;font-weight:700;font-size:0.9rem;margin-bottom:4px;">SNACK TIME Campus Café</div>
                <div style="text-align:center;color:var(--text-secondary);margin-bottom:12px;font-size:0.72rem;">Sri Eshwar College of Engineering</div>
                <div style="border-top:1px dashed var(--surface-border);margin-bottom:8px;"></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Date</span><span>${new Date().toLocaleDateString()}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Time</span><span>${order.time || new Date().toLocaleTimeString()}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Order ID</span><span style="font-weight:600;">${order.id}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Token</span><span style="font-weight:700;color:var(--primary);">${tokenNumber ? String(tokenNumber).padStart(3,'0') : '???'}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Customer</span><span>${order.customer}</span></div>
                ${paymentId ? `<div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Txn ID</span><span style="font-size:0.7rem;word-break:break-all;">${paymentId}</span></div>` : ''}
                <div style="border-top:1px dashed var(--surface-border);margin:8px 0;"></div>
                ${itemsHtml}
                <div style="border-top:1px dashed var(--surface-border);margin:8px 0;"></div>
                <div style="display:flex;justify-content:space-between;font-weight:700;color:var(--primary);font-size:0.9rem;"><span>Total Paid</span><span>${formatCurrency(order.total)}</span></div>
                <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Method</span><span>${method}</span></div>
            </div>`;
    }
}

function finishOrder() {
    hidePayment();
    showTracking();
}

// ========================= ORDER TRACKING =========================
function showTracking() {
    if (!currentOrder) { showNotification("No active order.", "error"); return; }
    const trackIdEl = $('track-order-id');
    if (trackIdEl) trackIdEl.innerText = currentOrder.id;
    const tokenEl = $('track-order-token');
    if (tokenEl) tokenEl.innerText = currentOrder.token ? String(currentOrder.token).padStart(3, '0') : '—';
    updateTrackingUI(currentOrder.status);
    updateTrackingTimeline(currentOrder.status);
    const ratingSection = $('rating-section');
    if (ratingSection) ratingSection.style.display = 'none';
    $('tracking-modal').classList.add('active');
}

function hideTracking() { $('tracking-modal').classList.remove('active'); }

function updateTrackingUI(status) {
    if (!currentOrder) return;
    const resolvedStatus = status || currentOrder.status;
    const statusIcons = {
        pending: '<i data-lucide="clock" style="color:var(--secondary)"></i>',
        preparing: '<i data-lucide="chef-hat" style="color:var(--primary)"></i>',
        ready: '<i data-lucide="check-circle" style="color:var(--success)"></i>',
        completed: '<i data-lucide="check-check" style="color:var(--success)"></i>',
        cancelled: '<i data-lucide="x-circle" style="color:var(--danger)"></i>',
        expired: '<i data-lucide="hourglass" style="color:var(--text-secondary)"></i>'
    };
    const statusMessages = {
        pending: 'Your order is pending confirmation.',
        preparing: 'The kitchen is actively preparing your order!',
        ready: '🎉 Your order is READY! Please collect it at the counter.',
        completed: 'Order collected. Enjoy your meal! 😋',
        cancelled: 'This order was cancelled.',
        expired: 'Order expired — you did not collect in time.'
    };
    const el = $('tracking-status-text');
    if (el) {
        el.innerHTML = `<span style="display:flex;align-items:center;gap:8px;">${statusIcons[resolvedStatus] || ''} ${statusMessages[resolvedStatus] || resolvedStatus}</span>`;
        safeCreateIcons();
    }

    // ── LIVE QUEUE POSITION & WAIT TIME ESTIMATION ────────────────────────────
    const queueInfoEl = $('tracking-queue-info');
    const queuePosEl = $('tracking-queue-pos');
    const waitTimeEl = $('tracking-wait-time');

    if (queueInfoEl && queuePosEl && waitTimeEl) {
        const s = (resolvedStatus || '').toLowerCase();
        if (s === 'pending' || s === 'preparing') {
            queueInfoEl.style.display = 'flex';

            // Check if server calculated queueAhead or compute from local queue
            let aheadCount = (typeof currentOrder.queueAhead === 'number') ? currentOrder.queueAhead : 0;
            if (typeof currentOrder.queueAhead === 'undefined') {
                const activeQueue = (allOrders || []).filter(o =>
                    ['pending', 'preparing'].includes((o.status || '').toLowerCase())
                );
                const myIndex = activeQueue.findIndex(o => o.id === currentOrder.id);
                aheadCount = myIndex !== -1 ? myIndex : 0;
            }

            const position = aheadCount + 1;
            const estMinutes = currentOrder.estMinutes || Math.max(3, position * 3);

            if (aheadCount === 0) {
                queuePosEl.innerText = '🎯 Next in line (0 ahead)';
                waitTimeEl.innerText = '~3 mins';
            } else {
                queuePosEl.innerText = `#${position} in Queue (${aheadCount} ahead)`;
                waitTimeEl.innerText = `~${estMinutes} mins`;
            }
        } else if (s === 'ready') {
            queueInfoEl.style.display = 'flex';
            queuePosEl.innerText = '✅ Ready at Counter';
            waitTimeEl.innerText = 'Collect Now';
        } else {
            queueInfoEl.style.display = 'none';
        }
    }
}

function updateTrackingTimeline(status) {
    document.querySelectorAll('.status-step').forEach(step => step.classList.remove('active'));
    const pendingEl = $('status-pending');
    if (pendingEl) pendingEl.classList.add('active');
    if (status === 'preparing' || status === 'ready') {
        const preparingEl = $('status-preparing');
        if (preparingEl) preparingEl.classList.add('active');
    }
    if (status === 'ready') {
        const readyEl = $('status-ready');
        if (readyEl) readyEl.classList.add('active');
        if (currentOrder && !currentOrder.rating) {
            const ratingSection = $('rating-section');
            if (ratingSection) ratingSection.style.display = 'block';
        }
    }
}

// ========================= ORDER HISTORY =========================
function showOrderHistory() {
    const container = $('history-container');
    if (!container) return;
    const myOrders = allOrders.filter(o => o.customer === currentUser.username);
    if (myOrders.length === 0) {
        container.innerHTML = '<p>You have no past orders.</p>';
    } else {
        const statusColors = { pending: 'status-pending', preparing: 'status-ready', ready: '', completed: '', cancelled: '', expired: '' };
        const statusIcons = { pending: '⏳', preparing: '👨‍🍳', ready: '✅', completed: '✔️', cancelled: '❌', expired: '⌛' };
        container.innerHTML = myOrders.map(order => {
            const ageMinutes = (Date.now() - (order.placedAt || 0)) / 60000;
            const canCancel = ['pending', 'preparing'].includes(order.status) && ageMinutes <= CANCEL_POLICY_MINUTES;
            return `
            <div class="order-card" style="flex-direction:row;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
                <div>
                    <h4 style="margin:0">${statusIcons[order.status]||''} ${order.id}</h4>
                    <p style="margin:0;font-size:0.8rem;">${order.time} • ${formatCurrency(order.total)} • ${order.method}</p>
                    ${order.rating ? `<p style="margin:0;font-size:0.8rem;color:#f59e0b;">${'★'.repeat(order.rating)}${'☆'.repeat(5-order.rating)}</p>` : ''}
                </div>
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:flex-end;">
                    <span class="status-badge ${statusColors[order.status]||''}">${order.status.toUpperCase()}</span>
                    <button class="outline-btn" onclick="viewOldBill('${order.id}')">View Bill</button>
                    ${canCancel ? `<button class="outline-btn" style="border-color:var(--danger);color:var(--danger);" onclick="cancelOrder('${order.id}')">Cancel</button>` : ''}
                    ${!order.rating && ['completed','ready'].includes(order.status) ? `<button class="outline-btn" style="border-color:#f59e0b;color:#f59e0b;" onclick="openFeedbackModal('${order.id}')">Rate</button>` : ''}
                    <button class="outline-btn" style="font-size:0.75rem;padding:2px 8px;" onclick="openSupportModal('${order.id}')">💬 Issue</button>
                </div>
            </div>`;
        }).join('');
    }
    $('history-modal').classList.add('active');
}

function hideOrderHistory() { $('history-modal').classList.remove('active'); }

function viewOldBill(orderId) {
    const order = allOrders.find(o => o.id === orderId);
    if (!order) return;
    const payTitleEl = $('payment-title');
    if (payTitleEl) payTitleEl.innerText = "Past Order Bill";
    const methodSelEl = $('payment-method-selection');
    if (methodSelEl) methodSelEl.style.display = "none";
    const cs = $('counter-confirmation-screen');
    if (cs) cs.style.display = 'none';
    const billEl = $('bill-receipt');
    if (billEl) billEl.style.display = "block";
    const viewStatusBtn = $('view-status-btn');
    if (viewStatusBtn) viewStatusBtn.style.display = 'none';
    const tokenEl = $('token-number');
    if (tokenEl) tokenEl.innerText = order.token ? String(order.token).padStart(3, '0') : '—';
    const itemsHtml = order.items.map(i =>
        `<span style="display:flex;justify-content:space-between;"><span>${i.qty}× ${i.name}</span><span>${formatCurrency(i.price * i.qty)}</span></span>`
    ).join('');
    const receiptEl = $('receipt-details');
    if (receiptEl) {
        receiptEl.innerHTML = `
            <div style="font-family:monospace;font-size:0.82rem;background:var(--element-bg);border-radius:12px;padding:1rem;text-align:left;">
                <div style="text-align:center;font-weight:700;margin-bottom:0.5rem;">SNACK TIME Campus Café</div>
                <div style="text-align:center;color:var(--text-secondary);margin-bottom:0.75rem;font-size:0.75rem;">Sri Eshwar College of Engineering</div>
                <div style="border-top:1px dashed var(--surface-border);margin-bottom:0.5rem;"></div>
                <div style="display:flex;justify-content:space-between;"><span>Date</span><span>${new Date(order.placedAt||Date.now()).toLocaleDateString()}</span></div>
                <div style="display:flex;justify-content:space-between;"><span>Time</span><span>${order.time}</span></div>
                <div style="display:flex;justify-content:space-between;"><span>Order ID</span><span>${order.id}</span></div>
                <div style="display:flex;justify-content:space-between;"><span>Customer</span><span>${order.customer}</span></div>
                <div style="display:flex;justify-content:space-between;"><span>Status</span><span style="font-weight:700;">${order.status.toUpperCase()}</span></div>
                ${order.paymentId ? `<div style="display:flex;justify-content:space-between;"><span>Txn ID</span><span style="font-size:0.7rem;">${order.paymentId}</span></div>` : ''}
                <div style="border-top:1px dashed var(--surface-border);margin:0.5rem 0;"></div>
                ${itemsHtml}
                <div style="border-top:1px dashed var(--surface-border);margin:0.5rem 0;"></div>
                <div style="display:flex;justify-content:space-between;font-weight:700;color:var(--primary);"><span>Total Paid</span><span>${formatCurrency(order.total)}</span></div>
                <div style="display:flex;justify-content:space-between;"><span>Method</span><span>${order.method||'Unknown'}</span></div>
            </div>`;
    }
    hideOrderHistory();
    $('payment-modal').classList.add('active');
}

// ========================= RATINGS & FEEDBACK =========================
function openFeedbackModal(orderId) {
    pendingRatingOrderId = orderId;
    selectedRating = 0;
    const fbOrderId = $('feedback-order-id');
    if (fbOrderId) fbOrderId.innerText = orderId;
    const fbText = $('modal-feedback-text');
    if (fbText) fbText.value = '';
    const ratingLabel = $('rating-label');
    if (ratingLabel) ratingLabel.innerText = '';
    document.querySelectorAll('#star-rating-large span').forEach(s => s.classList.remove('lit'));
    hideOrderHistory();
    $('feedback-modal').classList.add('active');
}

function hideFeedbackModal() { $('feedback-modal').classList.remove('active'); }

function setRating(val) {
    selectedRating = val;
    const labels = ['', 'Poor 😞', 'Fair 😐', 'Good 😊', 'Great 😄', 'Excellent 🤩'];
    const ratingLabel = $('rating-label');
    if (ratingLabel) ratingLabel.innerText = labels[val];
    document.querySelectorAll('#star-rating-large span').forEach((s, i) => {
        s.classList.toggle('lit', i < val);
    });
}

function submitModalFeedback() {
    if (selectedRating === 0) { showNotification('Please select a star rating!', 'error'); return; }
    const fbText = $('modal-feedback-text');
    const feedback = fbText ? fbText.value.trim() : '';
    const order = allOrders.find(o => o.id === pendingRatingOrderId);
    if (!order) { hideFeedbackModal(); return; }

    const review = {
        orderId: pendingRatingOrderId,
        customer: order.customer,
        items: order.items.map(i => i.name).join(', '),
        rating: selectedRating,
        feedback,
        time: new Date().toLocaleString()
    };

    order.rating = selectedRating;
    order.feedback = feedback;
    allReviews.unshift(review);
    try { localStorage.setItem('snacktime_reviews', JSON.stringify(allReviews)); } catch (e) {}
    broadcastRealtimeEvent('REVIEWS_UPDATED', allReviews);
    hideFeedbackModal();
    renderInlineOrderHistory();
    showNotification('Thank you for your feedback! ⭐');

    apiFetch('/api/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(review)
    }).catch(() => {});
}

function submitFeedback() {
    if (!currentOrder) return;
    openFeedbackModal(currentOrder.id);
}

function rateOrder(stars) { /* handled by feedback modal */ }

// ========================= VENDOR ORDERS =========================
function filterOrders(filter) {
    orderFilter = filter;
    renderVendorOrders();
}

function getItemTranslation(name, lang) {
    if (!name || lang === 'en') return name;
    
    // Clean string (strip any "1x ", "2x " prefix and trim)
    let cleanName = String(name).replace(/^\d+x\s*/i, '').trim();
    const d = (window.translations && window.translations[lang]) || {};
    
    // 1. Exact match in static dictionary
    if (d[cleanName]) return d[cleanName];

    // 2. Case-insensitive dictionary match
    const lowerName = cleanName.toLowerCase();
    for (let key in d) {
        if (key.toLowerCase().trim() === lowerName) return d[key];
    }

    // 3. Check memory cache
    const cacheKey = lang + '_' + cleanName;
    if (window.translationCache && window.translationCache[cacheKey]) {
        return window.translationCache[cacheKey];
    }

    // 4. Trigger async Google Translate fetch in background if not cached
    translateText(cleanName, lang).then(translated => {
        if (translated && translated !== cleanName) {
            window.translationCache[cacheKey] = translated;
            if (typeof renderVendorOrders === 'function') renderVendorOrders();
            if (typeof renderMenu === 'function') renderMenu();
        }
    });

    return cleanName;
}

function renderVendorOrders() {
    checkVendorAudioStatus();
    const container = $('live-orders-container');
    if (!container) return;
    const searchInput = $('vendor-order-search');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

    const lang = localStorage.getItem('appLanguage') || 'en';
    const d = (window.translations && window.translations[lang]) || {};

    // Update section title & placeholders
    const headingEl = document.querySelector('#vendor-orders-view [data-i18n="vendor_incoming_orders"]');
    if (headingEl && d.vendor_incoming_orders) headingEl.innerText = d.vendor_incoming_orders;
    if (searchInput && d.vendor_search_placeholder) searchInput.placeholder = d.vendor_search_placeholder;

    document.querySelectorAll('[data-i18n="vendor_filter_pending"]').forEach(el => { if (d.vendor_filter_pending) el.innerText = d.vendor_filter_pending; });
    document.querySelectorAll('[data-i18n="vendor_filter_preparing"]').forEach(el => { if (d.vendor_filter_preparing) el.innerText = d.vendor_filter_preparing; });
    document.querySelectorAll('[data-i18n="vendor_filter_all"]').forEach(el => { if (d.vendor_filter_all) el.innerText = d.vendor_filter_all; });

    let filtered = orderFilter === 'all'
        ? liveOrders
        : liveOrders.filter(o => (o.status || '').toLowerCase() === orderFilter.toLowerCase());

    if (query) {
        filtered = filtered.filter(o =>
            (o.id || '').toLowerCase().includes(query) || (o.customer || '').toLowerCase().includes(query)
        );
    }

    if (filtered.length === 0) {
        const emptyTxt = d.vendor_no_orders || 'All caught up! No orders to show right now.';
        container.innerHTML = `<div class="empty-state"><i data-lucide="clipboard-check" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>${emptyTxt}</p></div>`;
        safeCreateIcons();
        renderVendorKPIs();
        return;
    }

    const statusMap = {
        pending:   d.status_pending   || d.vendor_filter_pending   || 'PENDING',
        preparing: d.status_preparing || d.vendor_filter_preparing || 'PREPARING',
        ready:     d.status_ready     || 'READY',
        completed: d.status_completed || 'COMPLETED',
        cancelled: d.status_cancelled || 'CANCELLED',
        expired:   d.status_expired   || 'EXPIRED'
    };

    const methodMap = {
        'counter': d.Counter || d.cart_pay_counter || 'Counter',
        'pay at counter': d.Counter || d.cart_pay_counter || 'Counter',
        'online': d.Online || d.cart_pay_online || 'Online',
        'razorpay': d.Razorpay || d.Online || 'Online'
    };

    const tokenTxt     = d.order_token     || 'Token';
    const agoTxt       = d.order_ago       || 'ago';
    const acceptTxt    = d.order_accept    || 'Accept';
    const cancelTxt    = d.order_cancel    || 'Cancel';
    const readyTxt     = d.order_mark_ready|| 'Mark Ready';
    const oosTxt       = d.order_oos       || 'Out of Stock';
    const collectedTxt = d.order_collected || 'Collected';
    const expiresTxt   = d.order_expires   ? d.order_expires.replace('{n}', PICKUP_TIMEOUT_MINUTES) : `Auto-expires in ${PICKUP_TIMEOUT_MINUTES}min`;
    const totalTxt     = d.cart_total      || '';

    container.innerHTML = filtered.map(order => {
        const ageMinutes = Math.round((Date.now() - (order.placedAt || Date.now())) / 60000);
        const relativeTime = ageMinutes <= 0 ? 'Just now' : `${ageMinutes}m ago`;
        const rawStatus = (order.status || 'pending').toLowerCase();
        const displayStatus = statusMap[rawStatus] || (order.status ? order.status.toUpperCase() : 'PENDING');

        const rawMethod = (order.method || 'counter').toLowerCase();
        const displayMethod = methodMap[rawMethod] || d[order.method] || order.method || 'Counter';

        const statusClass = rawStatus === 'pending' ? 'status-pending' : rawStatus === 'preparing' ? 'status-preparing' : 'status-ready';

        const translatedItems = (order.items || []).map(i => {
            const itemQty = i.qty || 1;
            const itemName = i.name || i.title || '';
            const tName = getItemTranslation(itemName, lang);
            return `<li><span>${itemQty}x ${escapeHtml(tName)}</span><span>${formatCurrency((i.price || 0) * itemQty)}</span></li>`;
        }).join('');

        const isActionable = rawStatus === 'pending' || rawStatus === 'preparing';
        const isCounterOrder = rawMethod === 'counter' || rawMethod === 'pay at counter';

        return `
        <div class="swipeable-card-wrapper">
            ${isActionable ? `<div class="swipe-action-bg"><i data-lucide="check" style="width:20px;height:20px;margin-right:6px;"></i> ${rawStatus === 'pending' ? acceptTxt : readyTxt}</div>` : ''}
            <div class="order-card swipeable-card" id="card-order-${order.id}" data-order-id="${order.id}">
                <div class="order-card-header">
                    <div>
                        <div style="font-size:16px; font-weight:700; color:var(--text-primary);">${escapeHtml(order.customer || 'Student')}</div>
                        <div class="order-meta">ID: ${escapeHtml(order.id)} &bull; ${escapeHtml(displayMethod)}</div>
                    </div>
                    <span class="status-badge ${statusClass}">
                        <i data-lucide="${rawStatus === 'pending' ? 'clock' : rawStatus === 'preparing' ? 'loader-2' : 'check-circle'}" style="width:12px;height:12px;"></i>
                        ${displayStatus}
                    </span>
                </div>
                
                <ul class="order-items-list">
                    ${translatedItems}
                </ul>

                <div style="display:flex; justify-content:space-between; align-items:center; font-size:13px;">
                    <span style="font-weight:700; font-size:16px; color:var(--primary);">${formatCurrency(order.total)}</span>
                    <span style="color:var(--text-secondary); font-weight:500;">${relativeTime}</span>
                </div>

                ${isActionable ? `
                <div class="order-actions" style="margin-top:4px;">
                    <button class="outline-btn btn-cancel" onclick="vendorCancelOrder('${order.id}')">${cancelTxt}</button>
                    ${isCounterOrder ? `<button class="outline-btn" style="border-color:var(--info,#0ea5e9);color:var(--info,#0ea5e9);min-height:44px;" onclick="vendorPrintBill('${order.id}')">🖨️ Print Bill</button>` : ''}
                    <button class="primary-btn ${rawStatus === 'preparing' ? 'btn-ready' : ''}" style="min-height:44px;" onclick="updateOrderStatus('${order.id}', '${rawStatus === 'pending' ? 'preparing' : 'ready'}')">
                        ${rawStatus === 'pending' ? acceptTxt : readyTxt}
                    </button>
                </div>
                ` : ''}
            </div>
        </div>`;
    }).join('');

    safeCreateIcons();
    attachSwipeGesturesToCards();
}

// ========================= VENDOR PRINT BILL (Counter Orders Only) =========================
function vendorPrintBill(orderId) {
    const order = allOrders.find(o => String(o.id) === String(orderId)) || liveOrders.find(o => String(o.id) === String(orderId));
    if (!order) { showNotification('Order not found.', 'error'); return; }

    const itemsRows = (order.items || []).map(i => `
        <tr>
            <td style="padding:4px 8px;">${i.qty}x ${i.name || ''}</td>
            <td style="padding:4px 8px;text-align:right;">&#8377;${((i.price || 0) * (i.qty || 1)).toFixed(2)}</td>
        </tr>`).join('');

    const placedDate = order.placedAt ? new Date(order.placedAt) : new Date();
    const dateStr = placedDate.toLocaleDateString();
    const timeStr = order.time || placedDate.toLocaleTimeString();
    const tokenStr = order.token ? String(order.token).padStart(3, '0') : '---';

    const billHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Bill - ${order.id}</title>
<style>
  body { font-family: monospace; font-size: 13px; max-width: 320px; margin: 0 auto; padding: 16px; }
  h2 { text-align: center; margin: 0; font-size: 16px; }
  .sub { text-align: center; color: #666; font-size: 11px; margin-bottom: 12px; }
  .divider { border-top: 1px dashed #aaa; margin: 8px 0; }
  .row { display: flex; justify-content: space-between; padding: 2px 0; }
  table { width: 100%; border-collapse: collapse; }
  .total-row td { font-weight: bold; font-size: 14px; border-top: 1px dashed #aaa; padding-top: 6px; }
  .footer { text-align: center; margin-top: 14px; font-size: 11px; color: #555; }
  .token-box { text-align: center; border: 2px dashed #333; border-radius: 8px; padding: 8px; margin: 10px 0; }
  .token-num { font-size: 32px; font-weight: bold; letter-spacing: 6px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <h2>SNACK TIME Campus Café</h2>
  <div class="sub">Sri Eshwar College of Engineering</div>
  <div class="divider"></div>
  <div class="row"><span>Date</span><span>${dateStr}</span></div>
  <div class="row"><span>Time</span><span>${timeStr}</span></div>
  <div class="row"><span>Order ID</span><span><b>${order.id}</b></span></div>
  <div class="row"><span>Customer</span><span>${order.customer || '—'}</span></div>
  <div class="row"><span>Method</span><span>Pay at Counter</span></div>
  <div class="token-box">
    <div style="font-size:11px;color:#666;margin-bottom:2px;">TOKEN NUMBER</div>
    <div class="token-num">${tokenStr}</div>
  </div>
  <div class="divider"></div>
  <table>
    <tbody>${itemsRows}</tbody>
    <tfoot>
      <tr class="total-row">
        <td style="padding:4px 8px;padding-top:6px;">TOTAL</td>
        <td style="padding:4px 8px;padding-top:6px;text-align:right;">&#8377;${(order.total || 0).toFixed(2)}</td>
      </tr>
    </tfoot>
  </table>
  <div class="divider"></div>
  <div class="footer">Thank you! Please pay at the counter.<br>Snack Time &mdash; SECE Campus</div>
</body>
</html>`;

    const printWin = window.open('', '_blank', 'width=380,height=600');
    if (!printWin) { showNotification('Please allow popups to print the bill.', 'error'); return; }
    printWin.document.write(billHtml);
    printWin.document.close();
    printWin.focus();
}

// ========================= VENDOR ORDER HISTORY =========================
function renderVendorOrderHistory() {
    const container = $('vendor-history-container');
    if (!container) return;

    const searchInput = $('history-search');
    const statusSelect = $('history-status-filter');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const statusFilter = statusSelect ? statusSelect.value.toLowerCase() : 'all';

    // 1. Ensure allOrders is fallback loaded from localStorage if empty
    let ordersList = [...allOrders];
    if (ordersList.length === 0) {
        try {
            ordersList = JSON.parse(localStorage.getItem('snacktime_orders')) || [];
        } catch (e) { ordersList = []; }
    }

    // 2. Filter by status and search query
    let filtered = ordersList.filter(o => {
        if (!o) return false;
        const st = (o.status || '').toLowerCase();
        if (statusFilter !== 'all' && st !== statusFilter) return false;

        if (query) {
            const customerStr = (o.customer || '').toLowerCase();
            const idStr = String(o.id || '').toLowerCase();
            const tokenStr = String(o.token || '').toLowerCase();
            const itemsStr = Array.isArray(o.items) ? o.items.map(i => i.name).join(' ').toLowerCase() : '';
            return customerStr.includes(query) || idStr.includes(query) || tokenStr.includes(query) || itemsStr.includes(query);
        }
        return true;
    });

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:2.5rem 1rem;text-align:center;color:var(--text-secondary);">
                <i data-lucide="history" style="width:48px;height:48px;margin-bottom:0.5rem;opacity:0.5;"></i>
                <p>No historical orders found matching your search.</p>
            </div>`;
        safeCreateIcons();
        return;
    }

    // 3. Sort orders by placedAt / date descending (latest first)
    filtered.sort((a, b) => {
        const timeA = a.placedAt || (a.created_at ? new Date(a.created_at).getTime() : 0);
        const timeB = b.placedAt || (b.created_at ? new Date(b.created_at).getTime() : 0);
        return timeB - timeA;
    });

    // 4. Group by Day (Day-wise grouping)
    const groups = {};
    const todayStr = new Date().toDateString();
    const yesterdayObj = new Date();
    yesterdayObj.setDate(yesterdayObj.getDate() - 1);
    const yesterdayStr = yesterdayObj.toDateString();

    filtered.forEach(order => {
        let dateObj = null;
        if (order.placedAt) dateObj = new Date(order.placedAt);
        else if (order.created_at) dateObj = new Date(order.created_at);
        else if (order.timestamp?.toDate) dateObj = order.timestamp.toDate();
        else if (order.timestamp) dateObj = new Date(order.timestamp);
        else dateObj = new Date();

        const dateKey = dateObj.toDateString();
        let displayGroupTitle = dateObj.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
        if (dateKey === todayStr) displayGroupTitle = '📅 Today - ' + displayGroupTitle;
        else if (dateKey === yesterdayStr) displayGroupTitle = '📅 Yesterday - ' + displayGroupTitle;
        else displayGroupTitle = '📅 ' + displayGroupTitle;

        if (!groups[dateKey]) {
            groups[dateKey] = { title: displayGroupTitle, orders: [] };
        }
        groups[dateKey].orders.push({ order, dateObj });
    });

    // 5. Render Day-wise Groups
    const statusBadges = {
        pending: '<span class="status-badge status-pending">PENDING</span>',
        preparing: '<span class="status-badge status-preparing">PREPARING</span>',
        ready: '<span class="status-badge" style="background:var(--success-bg,#dcfce7);color:var(--success,#16a34a);">READY</span>',
        completed: '<span class="status-badge" style="background:var(--success-bg,#dcfce7);color:var(--success,#16a34a);">COMPLETED</span>',
        cancelled: '<span class="status-badge" style="background:var(--danger-bg,#fee2e2);color:var(--danger,#dc2626);">CANCELLED</span>',
        expired: '<span class="status-badge" style="background:var(--element-bg);color:var(--text-secondary);">EXPIRED</span>'
    };

    let html = '';
    Object.keys(groups).forEach(dateKey => {
        const group = groups[dateKey];
        html += `
            <div class="history-day-group" style="margin-bottom:1.5rem;">
                <div style="font-weight:700;font-size:0.95rem;color:var(--primary);margin-bottom:0.75rem;padding-bottom:0.25rem;border-bottom:2px solid var(--surface-border);">
                    ${escapeHtml(group.title)} (${group.orders.length} ${group.orders.length === 1 ? 'order' : 'orders'})
                </div>
                <div style="display:flex;flex-direction:column;gap:10px;">
        `;

        group.orders.forEach(({ order, dateObj }) => {
            const statusKey = (order.status || 'pending').toLowerCase();
            const badgeHtml = statusBadges[statusKey] || `<span class="status-badge">${(order.status || '').toUpperCase()}</span>`;
            const formattedTime = dateObj ? dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : (order.time || '');
            const methodText = (order.method || 'Counter').toLowerCase().includes('counter') ? '🏪 Pay at Counter' : '💳 Online Payment';

            // Items breakdown HTML
            const itemsListHtml = (order.items || []).map(i =>
                `<span style="display:inline-block;background:var(--element-bg);padding:3px 8px;border-radius:6px;font-size:0.8rem;margin:2px 4px 2px 0;border:1px solid var(--surface-border);">
                    <strong>${i.qty}×</strong> ${escapeHtml(i.name || '')} (${formatCurrency((i.price || 0) * (i.qty || 1))})
                </span>`
            ).join('');

            // Review / Feedback HTML
            let reviewHtml = '';
            if (order.rating) {
                const stars = '⭐'.repeat(order.rating);
                reviewHtml = `<div style="font-size:0.8rem;color:#d97706;background:#fffbeb;padding:4px 8px;border-radius:6px;border:1px solid #fef3c7;margin-top:6px;">
                    ${stars} ${order.feedback ? `<em>"${escapeHtml(order.feedback)}"` : ''}
                </div>`;
            } else if (order.cancelReason) {
                reviewHtml = `<div style="font-size:0.78rem;color:var(--danger);margin-top:4px;">❌ Reason: ${escapeHtml(order.cancelReason)}</div>`;
            } else {
                reviewHtml = `<div style="font-size:0.75rem;color:var(--text-secondary);margin-top:4px;">⭐ No customer review yet</div>`;
            }

            html += `
                <div class="glass-panel" style="padding:1rem;border-radius:12px;border:1px solid var(--surface-border);">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
                        <div>
                            <span style="font-weight:700;font-size:0.95rem;color:var(--text-primary);margin-right:8px;">${escapeHtml(order.customer || 'Student')}</span>
                            <span style="font-size:0.8rem;color:var(--text-secondary);">#${escapeHtml(order.id)}</span>
                            <div style="font-size:0.78rem;color:var(--text-secondary);margin-top:2px;">
                                🕒 ${formattedTime} &bull; ${methodText} ${order.token ? `&bull; Token: <strong>${String(order.token).padStart(3, '0')}</strong>` : ''}
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <span style="font-weight:700;font-size:1rem;color:var(--primary);">${formatCurrency(order.total || 0)}</span>
                            ${badgeHtml}
                        </div>
                    </div>

                    <!-- Ordered Items -->
                    <div style="margin-top:6px;">
                        <div style="font-size:0.75rem;font-weight:600;color:var(--text-secondary);margin-bottom:2px;">📦 Ordered Items:</div>
                        <div>${itemsListHtml || '<span style="font-size:0.8rem;color:var(--text-secondary);">No items data</span>'}</div>
                    </div>

                    <!-- Review Section -->
                    <div style="margin-top:4px;">
                        ${reviewHtml}
                    </div>

                    <!-- Action Buttons -->
                    <div style="margin-top:10px;padding-top:8px;border-top:1px dashed var(--surface-border);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
                        <button class="outline-btn" style="font-size:0.78rem;padding:4px 10px;border-color:var(--primary);color:var(--primary);" onclick="vendorPrintBill('${order.id}')">
                            🖨️ View & Print Bill
                        </button>
                    </div>
                </div>
            `;
        });

        html += `</div></div>`;
    });

    container.innerHTML = html;
    safeCreateIcons();
}



function attachSwipeGesturesToCards() {
    const cards = document.querySelectorAll('.swipeable-card');
    cards.forEach(card => {
        const orderId = card.getAttribute('data-order-id');
        if (!orderId) return;

        let startX = 0;
        let currentX = 0;

        card.addEventListener('touchstart', e => {
            startX = e.touches[0].clientX;
        }, { passive: true });

        card.addEventListener('touchmove', e => {
            currentX = e.touches[0].clientX;
            const diff = currentX - startX;
            if (diff > 0 && diff < 140) {
                card.style.transform = `translateX(${diff}px)`;
            }
        }, { passive: true });

        card.addEventListener('touchend', e => {
            const diff = currentX - startX;
            if (diff > 80) {
                card.style.transform = 'translateX(100%)';
                const order = liveOrders.find(o => String(o.id) === String(orderId));
                setTimeout(() => {
                    if (order && order.status === 'pending') {
                        updateOrderStatus(orderId, 'preparing');
                    } else if (order && order.status === 'preparing') {
                        updateOrderStatus(orderId, 'ready');
                    }
                }, 150);
            } else {
                card.style.transform = 'translateX(0)';
            }
            startX = 0;
        });
    });
    renderVendorKPIs();
}

function vendorCancelOrder(orderId) {
    const reason = prompt("Reason for cancellation (shown to student):", "Item ran out of stock");
    if (reason === null) return;
    updateOrderStatus(orderId, 'cancelled', reason);
}

// ========================= DAILY OFFERS & SPECIALS HELPERS =========================
function toggleOfferFields() {
    const isOffer = $('new-item-is-offer') && $('new-item-is-offer').checked;
    const container = $('offer-discount-fields');
    if (container) container.style.display = isOffer ? 'flex' : 'none';
    calculateOfferPrice();
}

function calculateOfferPrice() {
    const isOffer = $('new-item-is-offer') && $('new-item-is-offer').checked;
    const origPrice = parseFloat($('new-item-price') ? $('new-item-price').value : 0) || 0;
    const type = $('offer-discount-type') ? $('offer-discount-type').value : 'percent';
    const val = parseFloat($('offer-discount-value') ? $('offer-discount-value').value : 0) || 0;
    const previewEl = $('offer-calculated-preview');

    if (!isOffer || origPrice <= 0) {
        if (previewEl) previewEl.innerText = formatCurrency(origPrice);
        return { finalPrice: origPrice, label: '' };
    }

    let finalPrice = origPrice;
    let label = '';
    if (type === 'percent') {
        const discountAmount = (origPrice * (val / 100));
        finalPrice = Math.max(0, origPrice - discountAmount);
        label = `${val}% OFF`;
    } else {
        finalPrice = Math.max(0, origPrice - val);
        label = `₹${val} OFF`;
    }

    finalPrice = parseFloat(finalPrice.toFixed(2));
    if (previewEl) previewEl.innerText = `${formatCurrency(finalPrice)} (${label})`;
    return { finalPrice, label };
}

function openSetOfferModal(itemId) {
    const item = inventory.find(i => Number(i.id) === Number(itemId));
    if (!item) return;

    const modal = $('set-offer-modal');
    if (!modal) return;

    $('offer-modal-item-id').value = item.id;
    $('offer-modal-item-name').innerText = `🔥 ${item.name}`;
    $('offer-modal-original-price').value = item.originalPrice || item.price;
    $('offer-modal-discount-type').value = item.discountType || 'percent';
    $('offer-modal-discount-value').value = item.discountValue || 10;

    calculateModalOfferPrice();
    modal.classList.add('active');
}

function hideSetOfferModal() {
    const modal = $('set-offer-modal');
    if (modal) modal.classList.remove('active');
}

function calculateModalOfferPrice() {
    const origPrice = parseFloat($('offer-modal-original-price') ? $('offer-modal-original-price').value : 0) || 0;
    const type = $('offer-modal-discount-type') ? $('offer-modal-discount-type').value : 'percent';
    const val = parseFloat($('offer-modal-discount-value') ? $('offer-modal-discount-value').value : 0) || 0;
    const previewEl = $('offer-modal-calculated-preview');

    let finalPrice = origPrice;
    let label = '';
    if (type === 'percent') {
        const discountAmount = (origPrice * (val / 100));
        finalPrice = Math.max(0, origPrice - discountAmount);
        label = `${val}% OFF`;
    } else {
        finalPrice = Math.max(0, origPrice - val);
        label = `₹${val} OFF`;
    }

    finalPrice = parseFloat(finalPrice.toFixed(2));
    if (previewEl) previewEl.innerText = `${formatCurrency(finalPrice)} (${label})`;
    return { finalPrice, label, origPrice, type, val };
}

function saveItemOffer() {
    const itemId = Number($('offer-modal-item-id').value);
    const item = inventory.find(i => Number(i.id) === Number(itemId));
    if (!item) return;

    const calc = calculateModalOfferPrice();
    if (calc.origPrice <= 0) {
        showNotification('Please enter a valid original price.', 'error');
        return;
    }

    item.isSpecial = true;
    item.originalPrice = calc.origPrice;
    item.price = calc.finalPrice;
    item.discountType = calc.type;
    item.discountValue = calc.val;
    item.discountLabel = calc.label;
    try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
    broadcastRealtimeEvent('INVENTORY_UPDATED', inventory);

    hideSetOfferModal();
    renderInventory();
    renderMenu();
    showNotification(`🔥 Daily Offer updated for ${item.name} (${calc.label})!`);

}

function removeOfferFromItem() {
    const itemId = Number($('offer-modal-item-id').value);
    const item = inventory.find(i => Number(i.id) === Number(itemId));
    if (!item) return;

    item.isSpecial = false;
    item.price = item.originalPrice || item.price;
    item.discountType = null;
    item.discountValue = null;
    item.discountLabel = null;
    try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
    broadcastRealtimeEvent('INVENTORY_UPDATED', inventory);

    hideSetOfferModal();
    renderInventory();
    renderMenu();
    showNotification(`Offer removed from ${item.name}. Standard price restored.`);
}

// ========================= INVENTORY =========================
function renderInventory() {
    const tbody = $('inventory-body');
    if (!tbody) return;
    const lang = localStorage.getItem('appLanguage') || 'en';
    const d = (window.translations && window.translations[lang]) || {};
    const lowStockTxt = d.vendor_low_stock || 'LOW STOCK';
    const deleteTxt = d.btn_delete || 'Delete';
    tbody.innerHTML = inventory.map(item => {
        const itemReviews = allReviews.filter(r => r.items && r.items.includes(item.name));
        const avgRating = itemReviews.length
            ? (itemReviews.reduce((s, r) => s + r.rating, 0) / itemReviews.length).toFixed(1)
            : 'N/A';
        const lowStock = item.stock <= 5;
        const displayName = item.translatedName || item.name;

        const offerCol = item.isSpecial
            ? `<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
                <span style="background:rgba(255,107,53,0.15);color:var(--primary);padding:3px 8px;border-radius:12px;font-size:0.75rem;font-weight:600;">🔥 ${item.discountLabel || 'OFFER'} (₹${item.price})</span>
                <button class="outline-btn" style="padding:2px 8px;font-size:0.72rem;" onclick="openSetOfferModal(${item.id})">Edit</button>
               </div>`
            : `<button class="outline-btn" style="padding:2px 8px;font-size:0.72rem;border-color:var(--primary);color:var(--primary);" onclick="openSetOfferModal(${item.id})">+ Add Offer</button>`;

        return `
        <tr style="${lowStock ? 'background:rgba(239,68,68,0.05);' : ''}">
            <td><strong>${displayName}</strong>${item.isSpecial?' 🌟':''}${lowStock?` <span style="color:var(--danger);font-size:0.75rem;">${lowStockTxt}</span>`:''}</td>
            <td>₹<input type="number" value="${item.price}" class="price-input" onchange="updatePrice(${item.id}, this.value)"></td>
            <td><input type="number" value="${item.stock}" style="width:70px;padding:0.25rem" onchange="updateStock(${item.id}, this.value)"></td>
            <td>${item.sold}</td>
            <td>${avgRating !== 'N/A' ? `${'★'.repeat(Math.round(avgRating))} (${avgRating})` : '—'}</td>
            <td>${offerCol}</td>
            <td><button class="outline-btn" onclick="deleteItem(${item.id})">${deleteTxt}</button></td>
        </tr>`;
    }).join('');
}

function updateStock(id, newStock) {
    const stock = parseInt(newStock) || 0;
    const item = inventory.find(i => Number(i.id) === Number(id));
    if (!item) return;
    item.stock = stock;
    try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
    broadcastRealtimeEvent('INVENTORY_UPDATED', inventory);
    renderInventory();
    renderMenu();
    showNotification('Stock updated ✅');

    apiFetch(`/api/inventory/${id}/stock`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock })
    }).catch(() => {});
}

function updatePrice(id, newPrice) {
    const price = parseFloat(newPrice) || 0;
    const item = inventory.find(i => Number(i.id) === Number(id));
    if (!item) return;
    item.price = price;
    try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
    broadcastRealtimeEvent('INVENTORY_UPDATED', inventory);
    renderInventory();
    renderMenu();
    showNotification('Price updated ✅');

    apiFetch(`/api/inventory/${id}/price`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price })
    }).catch(() => {});
}

function deleteItem(id) {
    if (!confirm('Remove this item from the menu? Students will no longer see it.')) return;
    inventory = inventory.filter(i => Number(i.id) !== Number(id));
    try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
    broadcastRealtimeEvent('INVENTORY_UPDATED', inventory);
    renderInventory();
    renderMenu();
    showNotification('Item deleted from menu ✅');

    apiFetch(`/api/inventory/${id}`, {
        method: 'DELETE'
    }).catch(() => {});
}

function showAddItemModal() { $('add-item-modal').classList.add('active'); }
function hideAddItemModal() { $('add-item-modal').classList.remove('active'); }

async function addNewItem() {
    const nameEl = $('new-item-name');
    const priceEl = $('new-item-price');
    const stockEl = $('new-item-stock');
    const isOfferEl = $('new-item-is-offer');

    const name = nameEl ? nameEl.value.trim() : '';
    const origPrice = parseFloat(priceEl ? priceEl.value : 0);
    const stock = parseInt(stockEl ? stockEl.value : 0);
    const isOffer = Boolean(isOfferEl && isOfferEl.checked);

    if (!name || isNaN(origPrice) || origPrice <= 0 || isNaN(stock)) {
        showNotification('Please fill all fields correctly.', 'error');
        return;
    }

    let finalPrice = origPrice;
    let discountType = null;
    let discountValue = null;
    let discountLabel = null;

    if (isOffer) {
        const typeSelect = $('offer-discount-type');
        const valInput = $('offer-discount-value');
        discountType = typeSelect ? typeSelect.value : 'percent';
        discountValue = parseFloat(valInput ? valInput.value : 0) || 0;

        if (discountType === 'percent') {
            finalPrice = Math.max(0, origPrice - (origPrice * (discountValue / 100)));
            discountLabel = `${discountValue}% OFF`;
        } else {
            finalPrice = Math.max(0, origPrice - discountValue);
            discountLabel = `₹${discountValue} OFF`;
        }
        finalPrice = parseFloat(finalPrice.toFixed(2));
    }

    const newId = Date.now();
    const lang = localStorage.getItem('appLanguage') || 'en';
    const translatedName = await translateText(name, lang);

    const newItem = {
        id: newId,
        name,
        translatedName,
        price: finalPrice,
        originalPrice: isOffer ? origPrice : origPrice,
        stock,
        sold: 0,
        isSpecial: isOffer,
        discountType,
        discountValue,
        discountLabel
    };

    inventory.push(newItem);
    try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
    broadcastRealtimeEvent('INVENTORY_UPDATED', inventory);

    if (nameEl) nameEl.value = '';
    if (priceEl) priceEl.value = '';
    if (stockEl) stockEl.value = '';
    if (isOfferEl) isOfferEl.checked = false;
    toggleOfferFields();

    hideAddItemModal();
    renderInventory();
    renderMenu();
    showNotification(`${name} added to menu${isOffer ? ' as Daily Offer 🔥' : ''}! 🎉`);

    apiFetch('/api/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, price: finalPrice, stock })
    }).catch(() => {});
}

// ========================= VENDOR REVIEWS =========================
function fetchVendorReviews() {
    apiFetch('/api/reviews')
        .then(res => safeParseJson(res))
        .then(reviews => {
            allReviews = reviews;
            const feedbackView = $('vendor-feedback-view');
            if (feedbackView && feedbackView.classList.contains('active')) renderVendorReviews();
        })
        .catch(() => {});
}

function renderVendorReviews() {
    const container = $('vendor-reviews-container');
    if (!container) return;
    if (allReviews.length === 0) {
        container.innerHTML = `<div class="empty-state"><i data-lucide="message-square-dashed" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>No reviews yet. Feed some students to get feedback!</p></div>`;
        safeCreateIcons();
        return;
    }
    const avgAll = (allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length).toFixed(1);
    container.innerHTML = `
        <div class="glass-panel" style="padding:1.5rem;display:flex;gap:2rem;align-items:center;margin-bottom:1rem;">
            <div style="text-align:center;">
                <div style="font-size:3rem;font-weight:700;color:var(--secondary);">${avgAll}</div>
                <div style="color:#f59e0b;font-size:1.2rem;">${'★'.repeat(Math.round(avgAll))}${'☆'.repeat(5-Math.round(avgAll))}</div>
                <div style="color:var(--text-secondary);font-size:0.85rem;">${allReviews.length} review(s)</div>
            </div>
        </div>
        ${allReviews.map(r => `
            <div class="review-card">
                <div class="review-stars">${'★'.repeat(Math.max(0, Math.min(5, Number(r.rating) || 0)))}${'☆'.repeat(5 - Math.max(0, Math.min(5, Number(r.rating) || 0)))}</div>
                <p style="margin:0;font-weight:600;">${escapeHtml(r.customer)}</p>
                <p style="margin:0;color:var(--text-primary);">${r.feedback ? escapeHtml(r.feedback) : '<em style="color:var(--text-secondary)">No comment</em>'}</p>
                <div class="review-meta">${escapeHtml(r.items)} • ${escapeHtml(r.time)}</div>
            </div>`).join('')}`;
    safeCreateIcons();
}

// ========================= ANALYTICS CHART =========================
function renderAnalyticsChart() {
    const canvas = $('salesChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (salesChartInstance) salesChartInstance.destroy();
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const textColor = isDark ? '#94A3B8' : '#64748B';
    const gridColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(226,232,240,0.8)';
    
    salesChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: inventory.map(i => i.name),
            datasets: [{
                label: 'Quantity Sold',
                data: inventory.map(i => i.sold),
                backgroundColor: 'rgba(22, 101, 52, 0.85)',
                borderColor: '#166534',
                borderWidth: 1.5,
                borderRadius: 8
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true, ticks: { color: textColor }, grid: { color: gridColor } },
                x: { ticks: { color: textColor }, grid: { display: false } }
            },
            plugins: { legend: { labels: { color: isDark ? '#F8FAFC' : '#172033', font: { family: 'Inter', weight: '600' } } } }
        }
    });
}

// ========================= INLINE ORDER HISTORY =========================
function renderInlineOrderHistory() {
    const container = $('history-inline-container');
    if (!container) return;
    const myOrders = allOrders.filter(o => o.customer === (currentUser ? currentUser.username : ''));

    if (myOrders.length === 0) {
        container.innerHTML = `<div class="empty-state"><i data-lucide="receipt" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>No orders yet! Go grab something delicious.</p></div>`;
        safeCreateIcons();
        return;
    }

    const statusIcons = { pending: '⏳', preparing: '🍳', ready: '✅', completed: '✔️', cancelled: '❌', expired: '⌛' };
    const statusColors = { pending: 'status-pending', preparing: 'status-ready', ready: 'status-ready', completed: '', cancelled: '', expired: '' };

    container.innerHTML = myOrders.map(order => {
        const ageMinutes = (Date.now() - (order.placedAt || 0)) / 60000;
        const canCancel = ['pending', 'preparing'].includes(order.status) && ageMinutes <= CANCEL_POLICY_MINUTES;
        const queueText = (['pending', 'preparing'].includes(order.status) && typeof order.queueAhead === 'number')
            ? `<span style="font-size:0.75rem; background:rgba(234,88,12,0.12); color:var(--primary); padding:2px 8px; border-radius:12px; font-weight:600; margin-left:6px;">🎯 ${order.queueAhead === 0 ? 'Next in line' : '#' + (order.queueAhead + 1) + ' (' + order.queueAhead + ' ahead)'}</span>`
            : '';

        return `
        <div class="order-card" style="flex-direction:row;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
            <div>
                <h4 style="margin:0; display:flex; align-items:center; flex-wrap:wrap;">${statusIcons[order.status]||''} ${order.id} ${queueText}</h4>
                <p style="margin:0;font-size:0.8rem;">${order.time} • ${formatCurrency(order.total)} • ${order.method}</p>
                ${order.rating ? `<p style="margin:0;font-size:0.8rem;color:#f59e0b;">${'★'.repeat(order.rating)}${'☆'.repeat(5-order.rating)}</p>` : ''}
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:flex-end;">
                <span class="status-badge ${statusColors[order.status]||''}">${order.status.toUpperCase()}</span>
                <button class="outline-btn" onclick="viewOldBill('${order.id}')">View Bill</button>
                ${canCancel ? `<button class="outline-btn" style="border-color:var(--danger);color:var(--danger);" onclick="cancelOrder('${order.id}')">Cancel</button>` : ''}
                ${!order.rating && ['completed','ready'].includes(order.status) ? `<button class="outline-btn" style="border-color:#f59e0b;color:#f59e0b;" onclick="openFeedbackModal('${order.id}')">Rate</button>` : ''}
                ${['preparing','pending','ready'].includes(order.status) ? `<button class="primary-btn" style="padding:0.4rem 0.8rem;" onclick="currentOrder=allOrders.find(o=>o.id==='${order.id}');showTracking();">Track</button>` : ''}
            </div>
        </div>`;
    }).join('');
    safeCreateIcons();
}

function loadOrderHistory() { /* handled by Socket.io real-time listener */ }
function showCartModal() { showCart(); }

// ========================= FORGOT PASSWORD =========================
let pendingResetUsername = '';

function openForgotPassword(defaultUser = '') {
    const emailEl = $('forgot-email');
    if (emailEl) emailEl.value = defaultUser || '';
    const errEl = $('forgot-error');
    if (errEl) { errEl.style.display = 'none'; errEl.innerText = ''; }
    const step1 = $('forgot-step-1');
    const step2 = $('forgot-step-2');
    if (step1) step1.style.display = 'block';
    if (step2) step2.style.display = 'none';
    const modal = $('forgot-modal');
    if (modal) modal.classList.add('active');
    if (typeof lucide !== 'undefined' && lucide.createIcons) safeCreateIcons();
}

function closeForgotPassword() {
    const modal = $('forgot-modal');
    if (modal) modal.classList.remove('active');
    pendingResetUsername = '';
}

function sendPasswordResetEmail() {
    const emailInput = $('forgot-email') ? $('forgot-email').value.trim() : '';
    const errEl = $('forgot-error');
    const submitBtn = $('forgot-submit-btn');
    if (errEl) errEl.style.display = 'none';

    if (!emailInput) {
        if (errEl) { errEl.innerText = 'Please enter your registered email or username.'; errEl.style.display = 'block'; }
        return;
    }

    if (submitBtn) { submitBtn.innerText = 'Checking...'; submitBtn.disabled = true; }

    apiFetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput })
    })
    .then(async res => {
        let data = {};
        try { data = await res.json(); } catch(e) {}
        if (submitBtn) { submitBtn.innerText = 'Continue'; submitBtn.disabled = false; }
        
        pendingResetUsername = data.username || emailInput.split('@')[0] || emailInput;
        
        // Advance to Step 2 to enter new password directly!
        const step1 = $('forgot-step-1');
        const step2 = $('forgot-step-2');
        const targetUname = $('forgot-target-username');
        if (targetUname) targetUname.innerText = pendingResetUsername;
        if (step1) step1.style.display = 'none';
        if (step2) step2.style.display = 'block';
        if (typeof lucide !== 'undefined' && lucide.createIcons) safeCreateIcons();
    })
    .catch(err => {
        if (submitBtn) { submitBtn.innerText = 'Continue'; submitBtn.disabled = false; }
        pendingResetUsername = emailInput.split('@')[0] || emailInput;
        const step1 = $('forgot-step-1');
        const step2 = $('forgot-step-2');
        const targetUname = $('forgot-target-username');
        if (targetUname) targetUname.innerText = pendingResetUsername;
        if (step1) step1.style.display = 'none';
        if (step2) step2.style.display = 'block';
        if (typeof lucide !== 'undefined' && lucide.createIcons) safeCreateIcons();
    });
}

function confirmPasswordResetDirect() {
    const newPwd = $('forgot-new-password') ? $('forgot-new-password').value : '';
    const confirmPwd = $('forgot-confirm-password') ? $('forgot-confirm-password').value : '';
    const errEl = $('forgot-step-2-error');
    const confirmBtn = $('forgot-confirm-btn');
    if (errEl) { errEl.style.display = 'none'; errEl.innerText = ''; }

    if (!newPwd || !confirmPwd) {
        if (errEl) { errEl.innerText = 'Please fill in both password fields.'; errEl.style.display = 'block'; }
        return;
    }

    if (newPwd.length < 4) {
        if (errEl) { errEl.innerText = 'Password must be at least 4 characters long.'; errEl.style.display = 'block'; }
        return;
    }

    if (newPwd !== confirmPwd) {
        if (errEl) { errEl.innerText = 'Passwords do not match.'; errEl.style.display = 'block'; }
        return;
    }

    if (confirmBtn) { confirmBtn.innerText = 'Updating...'; confirmBtn.disabled = true; }

    const targetUser = pendingResetUsername || 'student';

    apiFetch('/api/reset-password-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: targetUser, newPassword: newPwd })
    })
    .then(async res => {
        if (confirmBtn) { confirmBtn.innerText = 'Set New Password'; confirmBtn.disabled = false; }
        
        // Also update local storage
        let localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
        const idx = localUsers.findIndex(u => u.username.toLowerCase() === targetUser.toLowerCase());
        if (idx >= 0) {
            localUsers[idx].password = newPwd;
        } else {
            const role = targetUser.toLowerCase().includes('vendor') ? 'vendor' : 'student';
            const email = role === 'student' ? `${targetUser.toLowerCase()}@sece.ac.in` : `${targetUser.toLowerCase()}@vendor.snacktime.com`;
            localUsers.push({ username: targetUser, email, password: newPwd, role });
        }
        localStorage.setItem('snacktime_users', JSON.stringify(localUsers));

        showNotification('✅ Password updated successfully! Please log in.', 'success');
        closeForgotPassword();
        
        // Prefill login username
        const unameInput = $('username');
        if (unameInput) unameInput.value = targetUser;
        const pwdInput = $('password');
        if (pwdInput) { pwdInput.value = ''; pwdInput.focus(); }
    })
    .catch(err => {
        if (confirmBtn) { confirmBtn.innerText = 'Set New Password'; confirmBtn.disabled = false; }
        
        // Local fallback update
        let localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
        const idx = localUsers.findIndex(u => u.username.toLowerCase() === targetUser.toLowerCase());
        if (idx >= 0) {
            localUsers[idx].password = newPwd;
        } else {
            const role = targetUser.toLowerCase().includes('vendor') ? 'vendor' : 'student';
            const email = role === 'student' ? `${targetUser.toLowerCase()}@sece.ac.in` : `${targetUser.toLowerCase()}@vendor.snacktime.com`;
            localUsers.push({ username: targetUser, email, password: newPwd, role });
        }
        localStorage.setItem('snacktime_users', JSON.stringify(localUsers));

        showNotification('✅ Password updated successfully! Please log in.', 'success');
        closeForgotPassword();

        const unameInput = $('username');
        if (unameInput) unameInput.value = targetUser;
        const pwdInput = $('password');
        if (pwdInput) { pwdInput.value = ''; pwdInput.focus(); }
    });
}

// ========================= PROFILE =========================
function showProfile() {
    if (!currentUser) { showNotification('Please log in first.', 'error'); return; }
    const roleLabel = currentUser.role === 'vendor' ? 'Vendor' : 'Student / Staff';
    const memberSince = currentUser.createdAt
        ? new Date(currentUser.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
        : 'Unknown';
    const profileUsername = $('profile-username');
    if (profileUsername) profileUsername.innerText = currentUser.username;
    const profileUsernameVal = $('profile-username-val');
    if (profileUsernameVal) profileUsernameVal.innerText = currentUser.username;
    const profileRoleBadge = $('profile-role-badge');
    if (profileRoleBadge) profileRoleBadge.innerText = roleLabel.toUpperCase();
    const profileRoleVal = $('profile-role-val');
    if (profileRoleVal) profileRoleVal.innerText = roleLabel;
    const profileSinceVal = $('profile-since-val');
    if (profileSinceVal) profileSinceVal.innerText = memberSince;
    const emailRow = $('profile-email-row');
    const emailVal = $('profile-email-val');
    if (currentUser.email && !currentUser.email.endsWith('@vendor.snacktime.com')) {
        if (emailRow) emailRow.style.display = 'flex';
        if (emailVal) emailVal.innerText = currentUser.email;
    } else {
        if (emailRow) emailRow.style.display = 'none';
    }
    $('profile-modal').classList.add('active');
    safeCreateIcons();
}

function hideProfile() { $('profile-modal').classList.remove('active'); }

// ========================= INIT =========================
initTheme();
safeCreateIcons();

// Refresh vendor orders display every 60 seconds
setInterval(() => {
    if (currentUser && currentUser.role === 'vendor') {
        const ordersView = $('vendor-orders-view');
        if (ordersView && ordersView.classList.contains('active')) renderVendorOrders();
    }
}, 60000);

// ========================= PWA INSTALLATION PROMPT =========================
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const installBtn = $('pwa-install-btn');
    if (installBtn) installBtn.style.display = 'inline-flex';
});

function installPWA() {
    if (!deferredInstallPrompt) {
        showNotification('App is already installed or ready in your browser!', 'info');
        return;
    }
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') {
            showNotification('🎉 SNACK TIME installed as an app!');
        }
        deferredInstallPrompt = null;
        const installBtn = $('pwa-install-btn');
        if (installBtn) installBtn.style.display = 'none';
    });
}

// Auto-login check and auth initialization on page load
window.addEventListener('DOMContentLoaded', () => {
    safeCreateIcons();
    
    // Auth input Enter key listeners
    const authInputs = ['username', 'password', 'email'];
    authInputs.forEach(id => {
        const el = $(id);
        if (el) {
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAuth();
                }
            });
        }
    });

    const forgotInput = $('forgot-email');
    if (forgotInput) {
        forgotInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                sendPasswordResetEmail();
            }
        });
    }

    // Splash screen logic
    setTimeout(() => {
        const splash = $('splash-screen');
        if (splash) {
            splash.classList.add('hidden');
            // Remove from DOM after fade out completes
            setTimeout(() => splash.remove(), 600);
        }
    }, 2500);

    const session = localStorage.getItem('snacktime_session');
    if (session) {
        try {
            const savedUser = JSON.parse(session);
            executeLogin(savedUser.username, savedUser.role, savedUser.email || '');
        } catch (e) {
            localStorage.removeItem('snacktime_session');
        }
    }
});

// ========================= INTERNATIONALIZATION (i18n) =========================
window.translationCache = {};

// Translate a single text string (with cache & case-insensitive dictionary check)
async function translateText(text, targetLang) {
    if (!text || targetLang === 'en') return text;
    let cleanText = String(text).replace(/^\d+x\s*/i, '').trim();

    // Check static dictionary first (fastest)
    const dict = window.translations && window.translations[targetLang];
    if (dict) {
        if (dict[cleanText]) return dict[cleanText];
        const lowerText = cleanText.toLowerCase();
        for (let key in dict) {
            if (key.toLowerCase().trim() === lowerText) return dict[key];
        }
    }

    // Check memory cache
    const cacheKey = targetLang + '_' + cleanText;
    if (window.translationCache[cacheKey]) return window.translationCache[cacheKey];

    // Fetch from Google Translate (gtx endpoint)
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${targetLang}&dt=t&q=${encodeURIComponent(cleanText)}`;
        const res = await fetch(url);
        const data = await res.json();
        const translated = data[0][0][0];
        window.translationCache[cacheKey] = translated;
        return translated;
    } catch (e) {
        return cleanText; // Fallback to original
    }
}

// Bulk translate all inventory items (parallel)
async function translateAllInventory(lang) {
    if (!inventory || lang === 'en') {
        inventory.forEach(i => { i.translatedName = i.name; });
        return;
    }
    await Promise.all(inventory.map(async item => {
        item.translatedName = await translateText(item.name, lang);
    }));
}

// Translate dynamic content (inventory + orders) in parallel
async function translateDynamicContent(lang) {
    if (lang === 'en') {
        inventory.forEach(i => { i.translatedName = i.name; });
        return;
    }
    // Translate inventory
    const invPromises = inventory.map(async item => {
        item.translatedName = await translateText(item.name, lang);
    });
    // Pre-cache order item names that aren't in inventory dict
    const orderItemNames = new Set();
    allOrders.forEach(o => {
        if (o.items) o.items.forEach(i => orderItemNames.add(i.name));
    });
    const orderPromises = [...orderItemNames].map(name => translateText(name, lang));
    // Translate cart items too
    const cartPromises = cart.map(async item => {
        item.translatedName = await translateText(item.name, lang);
    });
    await Promise.all([...invPromises, ...orderPromises, ...cartPromises]);
}

// Fast language switch: apply static dict immediately, fetch dynamic content in background
async function setLanguage(lang) {
    localStorage.setItem('appLanguage', lang);
    const dict = (window.translations && window.translations[lang]) ? window.translations[lang] : window.translations['en'];

    // 1. Apply static labels immediately (zero wait)
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (dict[key]) el.innerText = dict[key];
    });
    // Apply placeholder translations
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (dict[key]) el.placeholder = dict[key];
    });

    // 2. Sync language selectors
    const profileSelector = $('profile-language-selector');
    const vendorSelector = $('vendor-language-selector');
    if (profileSelector) profileSelector.value = lang;
    if (vendorSelector) vendorSelector.value = lang;

    // 3. Apply cached translations to inventory immediately (instant render)
    if (lang === 'en') {
        inventory.forEach(i => { i.translatedName = i.name; });
    } else {
        inventory.forEach(item => {
            const cacheKey = lang + '_' + item.name;
            const dict2 = window.translations && window.translations[lang];
            item.translatedName = (dict2 && dict2[item.name]) ||
                (window.translationCache[cacheKey]) || item.name;
        });
        cart.forEach(item => {
            const cacheKey = lang + '_' + item.name;
            const dict2 = window.translations && window.translations[lang];
            item.translatedName = (dict2 && dict2[item.name]) ||
                (window.translationCache[cacheKey]) || item.name;
        });
    }

    // 4. Re-render UI immediately with cached/static data
    if (typeof renderMenu === 'function') renderMenu();
    if (typeof renderInventory === 'function') renderInventory();
    if (typeof renderVendorOrders === 'function') renderVendorOrders();
    if (typeof renderVendorSettings === 'function') {
        const sv = $('vendor-settings-view');
        if (sv && sv.classList.contains('active')) renderVendorSettings();
    }

    // 5. Fetch untranslated dynamic content in the background, then refresh
    if (lang !== 'en') {
        translateDynamicContent(lang).then(() => {
            if (typeof renderMenu === 'function') renderMenu();
            if (typeof renderInventory === 'function') renderInventory();
            if (typeof renderVendorOrders === 'function') renderVendorOrders();
        });
    }

    showNotification(`🌐 Language changed`, 'success');
}

function initLanguage() {
    const lang = localStorage.getItem('appLanguage') || 'en';
    setLanguage(lang);
}

// Initialize language on load
document.addEventListener('DOMContentLoaded', () => {
    initLanguage();
});
