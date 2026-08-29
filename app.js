// ========================= COLLEGE SERVER & API CONFIGURATION =========================
// Set custom server IP/Domain here for College Server deployment (e.g., 'https://snacktime.sece.ac.in' or 'http://192.168.1.100:3000')
const SERVER_BASE_URL = window.SNACKTIME_SERVER_URL || localStorage.getItem('custom_server_url') || '';

let csrfToken = '';

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
    options.credentials = 'include';
    const fullUrl = SERVER_BASE_URL ? `${SERVER_BASE_URL}${url}` : url;
    return fetch(fullUrl, options);
}

// ========================= REAL-TIME BROADCAST ENGINE =========================
const snacktimeChannel = (typeof BroadcastChannel !== 'undefined') ? new BroadcastChannel('snacktime_realtime_channel') : null;

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

    // 2. High-Performance Socket.io Engine (Cross-device real-time sync)
    if (typeof appSocket !== 'undefined' && appSocket && appSocket.connected) {
        if (type === 'NEW_ORDER') {
            appSocket.emit('place_order', payload);
        } else if (type === 'ORDER_STATUS_CHANGED') {
            appSocket.emit('update_order_status', payload);
        } else if (type === 'INVENTORY_UPDATED') {
            appSocket.emit('update_inventory', payload);
        } else if (type === 'REVIEWS_UPDATED') {
            appSocket.emit('update_reviews', payload);
        }
    }
}

function handleRealtimeEvent(type, payload) {
    if (!type || !payload) return;

    if (type === 'NEW_ORDER') {
        // A student placed an order
        const existing = allOrders.find(o => o.id === payload.id);
        if (!existing) {
            allOrders.unshift(payload);
            liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));
            try { localStorage.setItem('snacktime_orders', JSON.stringify(allOrders)); } catch (e) {}
        }

        if (currentUser && currentUser.role === 'vendor') {
            renderVendorOrders();
            updateVendorOrderBadge(liveOrders.length);
            triggerLiveNotification('🔔 NEW ORDER RECEIVED!', `Order #${payload.id} - ${payload.customer || 'Student'} (₹${payload.total})`);
            playOrderAlertSound();
        }
    } else if (type === 'ORDER_STATUS_CHANGED') {
        // Vendor updated order status
        const targetOrder = allOrders.find(o => o.id === payload.id);
        if (targetOrder) {
            targetOrder.status = payload.status;
            if (payload.cancelReason) targetOrder.cancelReason = payload.cancelReason;
        } else {
            allOrders.unshift(payload);
        }
        liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));
        try { localStorage.setItem('snacktime_orders', JSON.stringify(allOrders)); } catch (e) {}

        if (currentUser && currentUser.role === 'student' && (currentUser.username === payload.customer || !payload.customer)) {
            currentOrder = payload;
            updateTrackingUI(payload.status);
            updateTrackingTimeline(payload.status);
            renderInlineOrderHistory();

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
        } else if (currentUser && currentUser.role === 'vendor') {
            renderVendorOrders();
            updateVendorOrderBadge(liveOrders.length);
        }
    } else if (type === 'INVENTORY_UPDATED') {
        // Vendor or Student order updated stock, price, or items
        if (Array.isArray(payload)) {
            inventory = payload;
        } else if (payload && payload.id) {
            const idx = inventory.findIndex(i => Number(i.id) === Number(payload.id));
            if (idx >= 0) inventory[idx] = { ...inventory[idx], ...payload };
            else inventory.push(payload);
        }
        try { localStorage.setItem('snacktime_inventory', JSON.stringify(inventory)); } catch (e) {}
        applyDailySpecials();

        if (currentUser && currentUser.role === 'vendor') {
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
        if (currentUser && currentUser.role === 'vendor') {
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
// NOTE: The 'storage' event only fires in OTHER tabs, not the one that wrote the data.
// This complements BroadcastChannel which fires in ALL tabs including sender.
window.addEventListener('storage', (event) => {
    if (event.key === 'snacktime_orders' && event.newValue) {
        try {
            const orders = JSON.parse(event.newValue);
            const prevLiveCount = liveOrders.length;
            allOrders = orders;
            liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));

            if (currentUser && currentUser.role === 'vendor') {
                renderVendorOrders();
                updateVendorOrderBadge(liveOrders.length);
                if (liveOrders.length > prevLiveCount) {
                    const newest = liveOrders[0];
                    triggerLiveNotification('🔔 NEW ORDER!', `Order from ${newest.customer || 'Student'} (₹${newest.total || ''})`);
                    playOrderAlertSound();
                }
            } else if (currentUser && currentUser.role === 'student') {
                renderInlineOrderHistory();
                if (currentOrder) {
                    const updated = allOrders.find(o => o.id === currentOrder.id);
                    if (updated && updated.status !== currentOrder.status) {
                        currentOrder.status = updated.status;
                        updateTrackingUI(updated.status);
                        updateTrackingTimeline(updated.status);
                        const s = updated.status.toLowerCase();
                        if (s === 'preparing') triggerLiveNotification('👨‍🍳 Order Preparing!', `Kitchen is preparing Order #${updated.id}`);
                        else if (s === 'ready') triggerLiveNotification('🔔 Order READY!', `Order #${updated.id} is ready! Token: ${updated.token || ''}`);
                        else if (s === 'completed') triggerLiveNotification('✅ Completed', `Order #${updated.id} collected. Thank you!`);
                        else if (s === 'cancelled') triggerLiveNotification('❌ Cancelled', `Order #${updated.id} was cancelled.`);
                    }
                }
            }
        } catch (e) {}
    } else if (event.key === 'snacktime_inventory' && event.newValue) {
        try {
            const items = JSON.parse(event.newValue);
            if (Array.isArray(items) && items.length > 0) {
                inventory = items;
                applyDailySpecials();
                if (currentUser && currentUser.role === 'vendor') renderInventory();
                else renderMenu();
            }
        } catch (e) {}
    }
});


// ========================= RAZORPAY CONFIGURATION =========================
const RAZORPAY_KEY_ID = 'rzp_test_REPLACE_WITH_YOUR_KEY';

// ========================= APP VERSION =========================
// Keep in sync with APP_VERSION in sw-v2.js and window.SNACKTIME_VERSION in index.html
const APP_VERSION = '1.0.8.1787935959487';

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

let appSocket = null;
if (typeof io !== 'undefined') {
    try { appSocket = SERVER_BASE_URL ? io(SERVER_BASE_URL) : io(); } catch (e) {}
}

function startDatabaseSync(role) {
    stopDatabaseSync();

    // Check if Node.js + MySQL REST API backend is available
    fetch('/api/inventory')
        .then(res => {
            if (!res.ok) throw new Error("MySQL API not available");
            return res.json();
        })
        .then(items => {
            // ---- MySQL REST API + Socket.io Backend Active ----
            inventory = items;
            applyDailySpecials();
            const lang = localStorage.getItem('appLanguage') || 'en';
            translateAllInventory(lang).then(() => {
                if (role === 'student') renderMenu();
                if (role === 'vendor') renderInventory();
            });

            // Fetch live orders from MySQL API
            fetch('/api/orders')
                .then(r => safeParseJson(r))
                .then(orders => {
                    allOrders = orders;
                    liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));
                    if (role === 'vendor') {
                        renderVendorOrders();
                        updateVendorOrderBadge(liveOrders.length);
                    } else if (role === 'student') {
                        renderInlineOrderHistory();
                    }
                })
                .catch(err => console.log('MySQL orders fetch notice:', err.message));

            // Fetch shop settings
            fetch('/api/settings')
                .then(r => safeParseJson(r))
                .then(settings => {
                    shopOpen = settings.shopOpen;
                    breakEndTime = settings.breakEndTime;
                    checkShopStatus();
                })
                .catch(() => {});

            // Socket.io Real-Time Event Listeners
            if (appSocket) {
                const joinUserRoom = () => {
                    if (currentUser) {
                        const roomName = role === 'vendor' ? 'vendors' : `student_${currentUser.username}`;
                        appSocket.emit('join_room', roomName);
                    }
                };
                joinUserRoom();
                appSocket.off('connect').on('connect', joinUserRoom);

                appSocket.off('inventory_updated').on('inventory_updated', () => {
                    fetch('/api/inventory').then(r=>safeParseJson(r)).then(cloudItems => {
                        inventory = cloudItems;
                        applyDailySpecials();
                        if (role === 'student') renderMenu();
                        if (role === 'vendor') renderInventory();
                    }).catch(() => {});
                });

                appSocket.off('orders_updated').on('orders_updated', (newOrderPayload) => {
                    const prevLiveCount = liveOrders.length;
                    fetch('/api/orders').then(r=>safeParseJson(r)).then(cloudOrders => {
                        allOrders = cloudOrders;
                        liveOrders = cloudOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));

                        if (role === 'vendor') {
                            renderVendorOrders();
                            updateVendorOrderBadge(liveOrders.length);
                            if (liveOrders.length > prevLiveCount) {
                                const newOrder = newOrderPayload || liveOrders[0];
                                const customer = newOrder ? (newOrder.customer || 'Student') : 'Student';
                                const totalAmt = newOrder && newOrder.total ? ` (₹${newOrder.total})` : '';
                                triggerLiveNotification('🔔 NEW ORDER RECEIVED!', `Order from ${customer}${totalAmt}`);
                            }
                        } else if (role === 'student') {
                            renderInlineOrderHistory();
                        }
                    });
                });

                appSocket.off('order_status_changed').on('order_status_changed', (updated) => {
                    if (!updated || !updated.id) return;
                    const idx = allOrders.findIndex(o => o.id === updated.id);
                    if (idx !== -1) allOrders[idx] = updated;
                    else allOrders.unshift(updated);

                    liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));

                    if (role === 'student') {
                        const isMyOrder = currentUser && (updated.customer === currentUser.username);
                        if (isMyOrder) {
                            currentOrder = updated;
                            updateTrackingUI(updated.status);
                            updateTrackingTimeline(updated.status);

                            const statusLower = (updated.status || '').toLowerCase();
                            if (statusLower === 'preparing') {
                                triggerLiveNotification('👨‍🍳 Order Preparing!', `The kitchen is preparing Order #${updated.id}`);
                            } else if (statusLower === 'ready') {
                                triggerLiveNotification('🔔 Order READY for Pickup!', `Order #${updated.id} is ready! Token: ${updated.token || ''}`);
                            } else if (statusLower === 'completed') {
                                triggerLiveNotification('✅ Order Completed', `Order #${updated.id} collected. Thank you!`);
                            } else if (statusLower === 'cancelled') {
                                triggerLiveNotification('❌ Order Cancelled', `Order #${updated.id} was cancelled.`);
                            }
                        }
                        renderInlineOrderHistory();
                    } else if (role === 'vendor') {
                        renderVendorOrders();
                        updateVendorOrderBadge(liveOrders.length);
                    }
                });

                appSocket.off('shop_status_changed').on('shop_status_changed', (settings) => {
                    shopOpen = settings.shopOpen;
                    breakEndTime = settings.breakEndTime;
                    checkShopStatus();
                });
            }
        })
        .catch(() => {
            // ── API unavailable (static hosting / offline) ─────────────────────
            // Load inventory from localStorage first, then default
            const savedInventory = (() => {
                try { return JSON.parse(localStorage.getItem('snacktime_inventory') || 'null'); } catch { return null; }
            })();
            if (savedInventory && Array.isArray(savedInventory) && savedInventory.length > 0) {
                inventory = savedInventory;
            }
            applyDailySpecials();

            const savedOrders = (() => {
                try { return JSON.parse(localStorage.getItem('snacktime_orders') || '[]'); } catch { return []; }
            })();
            if (savedOrders.length > 0) {
                allOrders = savedOrders;
                liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));
            }

            if (role === 'student') {
                renderMenu();
                renderInlineOrderHistory();
            } else if (role === 'vendor') {
                renderInventory();
                renderVendorOrders();
                updateVendorOrderBadge(liveOrders.length);
            }
            checkShopStatus();

            // ── Smart Polling Engine ────────────────────────────────────────────
            // Polls localStorage every 2 seconds for changes made by OTHER tabs
            // on the SAME device. BroadcastChannel already handles same-tab sync
            // instantly; this catches edge cases and serves as a reliable backup.
            if (window._syncPollingInterval) clearInterval(window._syncPollingInterval);

            let _lastOrdersSig = JSON.stringify(allOrders.map(o => o.id + ':' + o.status));
            let _lastInventorySig = JSON.stringify(inventory.map(i => i.id + ':' + i.stock + ':' + i.price));

            window._syncPollingInterval = setInterval(() => {
                if (!currentUser) return;

                // ── Poll Orders ───────────────────────────────────────────────
                const rawOrders = (() => {
                    try { return JSON.parse(localStorage.getItem('snacktime_orders') || '[]'); } catch { return []; }
                })();
                const newOrdersSig = JSON.stringify(rawOrders.map(o => o.id + ':' + o.status));
                if (newOrdersSig !== _lastOrdersSig) {
                    _lastOrdersSig = newOrdersSig;
                    const prevLiveCount = liveOrders.length;
                    allOrders = rawOrders;
                    liveOrders = allOrders.filter(o => !['completed', 'cancelled', 'expired'].includes(o.status));

                    if (currentUser.role === 'vendor') {
                        renderVendorOrders();
                        updateVendorOrderBadge(liveOrders.length);
                        if (liveOrders.length > prevLiveCount) {
                            const newest = liveOrders[0];
                            triggerLiveNotification('🔔 NEW ORDER!', `Order from ${newest.customer || 'Student'} (₹${newest.total || ''})`);
                            playOrderAlertSound();
                        }
                    } else if (currentUser.role === 'student') {
                        renderInlineOrderHistory();
                        // Update tracking UI for current student's order
                        if (currentOrder) {
                            const updated = allOrders.find(o => o.id === currentOrder.id);
                            if (updated && updated.status !== currentOrder.status) {
                                currentOrder.status = updated.status;
                                updateTrackingUI(updated.status);
                                updateTrackingTimeline(updated.status);
                                const s = updated.status.toLowerCase();
                                if (s === 'preparing') triggerLiveNotification('👨‍🍳 Order Preparing!', `Kitchen is preparing Order #${updated.id}`);
                                else if (s === 'ready') triggerLiveNotification('🔔 Order READY!', `Order #${updated.id} is ready! Token: ${updated.token || ''}`);
                                else if (s === 'completed') triggerLiveNotification('✅ Completed', `Order #${updated.id} collected. Thank you!`);
                                else if (s === 'cancelled') triggerLiveNotification('❌ Cancelled', `Order #${updated.id} was cancelled.`);
                            }
                        }
                    }
                }

                // ── Poll Inventory ────────────────────────────────────────────
                const rawInventory = (() => {
                    try { return JSON.parse(localStorage.getItem('snacktime_inventory') || 'null'); } catch { return null; }
                })();
                if (rawInventory && Array.isArray(rawInventory) && rawInventory.length > 0) {
                    const newInventorySig = JSON.stringify(rawInventory.map(i => i.id + ':' + i.stock + ':' + i.price));
                    if (newInventorySig !== _lastInventorySig) {
                        _lastInventorySig = newInventorySig;
                        inventory = rawInventory;
                        applyDailySpecials();
                        if (currentUser.role === 'vendor') renderInventory();
                        else renderMenu();
                    }
                }
            }, 2000); // poll every 2 seconds
        });
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
    // Stop the polling engine on logout
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
const $ = id => document.getElementById(id);
const formatCurrency = amount => `₹${Number(amount).toFixed(2)}`;
const generateOrderId = () => `ORD-${Date.now().toString(36).toUpperCase().slice(-5)}-${Math.floor(Math.random()*100)}`;
const escapeHtml = str => str ? String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;') : '';

// ========================= THEME =========================
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);
    const btn = $('theme-toggle');
    if (btn) btn.innerHTML = savedTheme === 'dark' ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    lucide.createIcons();
}

function toggleTheme() {
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    const btn = $('theme-toggle');
    if (btn) btn.innerHTML = newTheme === 'dark' ? '<i data-lucide="sun"></i>' : '<i data-lucide="moon"></i>';
    showNotification(newTheme === 'dark' ? '🌙 Switched to Dark Mode' : '☀️ Switched to Light Mode');
    lucide.createIcons();
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
function playOrderAlertSound() {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
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
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission();
        }
    }
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
    if (tab === 'about') lucide.createIcons();
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
    if (view === 'analytics') renderAnalyticsChart();
    if (view === 'feedback') renderVendorReviews();
    if (view === 'settings') renderVendorSettings();
    if (view === 'about') lucide.createIcons();
    renderVendorKPIs();
    lucide.createIcons();
}

function renderVendorKPIs() {
    const today = new Date().toDateString();
    const todayOrders = allOrders.filter(o => new Date(o.timestamp?.toDate ? o.timestamp.toDate() : o.timestamp).toDateString() === today);
    const todayRevenue = todayOrders.filter(o => o.status !== 'cancelled' && o.status !== 'expired').reduce((sum, o) => sum + (o.total || 0), 0);
    const pendingCount = allOrders.filter(o => o.status === 'pending' || o.status === 'preparing').length;

    // Desktop KPI Cards
    const todayOrdersEl = $('kpi-today-orders');
    const todayRevenueEl = $('kpi-today-revenue');
    const pendingEl = $('kpi-pending-orders');

    if (todayOrdersEl) todayOrdersEl.innerText = todayOrders.length;
    if (todayRevenueEl) todayRevenueEl.innerText = formatCurrency(todayRevenue);
    if (pendingEl) pendingEl.innerText = pendingCount;

    // Mobile Scrollable KPI Chips
    const chipOrdersEl = $('chip-today-orders');
    const chipRevenueEl = $('chip-today-revenue');
    const chipPendingEl = $('chip-pending-orders');

    if (chipOrdersEl) chipOrdersEl.innerText = todayOrders.length;
    if (chipRevenueEl) chipRevenueEl.innerText = formatCurrency(todayRevenue);
    if (chipPendingEl) chipPendingEl.innerText = pendingCount;

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
    const mode = document.querySelector('input[name="auth-mode"]:checked').value;
    const role = document.querySelector('.auth-tabs').getAttribute('data-role') || 'student';
    $('auth-title').innerText = mode === 'register' ? 'Create an Account' : 'Login to Order';
    $('auth-submit-btn').innerText = mode === 'register' ? 'Register' : 'Login';
    $('login-error').style.display = 'none';
    const emailField = $('email');
    if (mode === 'register' && role === 'student') {
        emailField.style.display = 'block';
    } else {
        emailField.style.display = 'none';
        emailField.value = '';
    }
}

function switchAuthTab(role) {
    document.querySelectorAll('.auth-tabs .tab-btn').forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    event.target.parentElement.setAttribute('data-role', role);
    toggleAuthMode();
}

function handleAuth() {
    const mode = document.querySelector('input[name="auth-mode"]:checked').value;
    if (mode === 'register') register();
    else login();
}

function register() {
    // FIX 6: Rate Limiting — Max 3 register attempts per 60s per device
    const now = Date.now();
    registerAttempts = registerAttempts.filter(t => now - t < 60000);
    const errorMsg = $('login-error');
    errorMsg.style.display = 'none';

    if (registerAttempts.length >= 3) {
        errorMsg.innerText = "Too many registration attempts. Please wait 1 minute.";
        errorMsg.style.display = 'block';
        return;
    }
    registerAttempts.push(now);

    const role = document.querySelector('.auth-tabs').getAttribute('data-role') || 'student';
    const emailInput = $('email').value.trim().toLowerCase();
    const usernameInput = $('username').value.trim();
    const passwordInput = $('password').value;

    if (role === 'student') {
        if (!emailInput || !usernameInput || !passwordInput) {
            errorMsg.innerText = "Please fill in all fields.";
            errorMsg.style.display = 'block';
            return;
        }
        if (!emailInput.endsWith('@sece.ac.in')) {
            errorMsg.innerText = "Please use your college email (@sece.ac.in).";
            errorMsg.style.display = 'block';
            return;
        }
    } else {
        if (!usernameInput || !passwordInput) {
            errorMsg.innerText = "Please fill in all fields.";
            errorMsg.style.display = 'block';
            return;
        }
    }

    const targetEmail = role === 'student' ? emailInput : `${usernameInput.toLowerCase()}@vendor.snacktime.com`;
    $('auth-submit-btn').innerText = 'Registering...';
    $('auth-submit-btn').disabled = true;

    // Try Express backend first to register and store hashed password in MySQL
    apiFetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, email: targetEmail, password: passwordInput, role })
    })
    .then(async res => {
        const data = await safeParseJson(res);
        showNotification("✅ Account created! Logging in...", "success");
        loginWithCredentials(usernameInput, passwordInput, role);
    })
    .catch(err => {
        // Fallback for static hosting / offline mode
        let localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
        const existing = localUsers.find(u => u.username.toLowerCase() === usernameInput.toLowerCase());
        if (existing) {
            $('auth-submit-btn').innerText = 'Register';
            $('auth-submit-btn').disabled = false;
            errorMsg.innerText = 'Username is already registered.';
            errorMsg.style.display = 'block';
            return;
        }
        localUsers.push({ username: usernameInput, email: targetEmail, password: passwordInput, role });
        localStorage.setItem('snacktime_users', JSON.stringify(localUsers));

        $('auth-submit-btn').innerText = 'Register';
        $('auth-submit-btn').disabled = false;
        showNotification("✅ Account created successfully!", "success");
        executeLogin(usernameInput, role, targetEmail);
    });
}

function login() {
    const role = document.querySelector('.auth-tabs').getAttribute('data-role') || 'student';
    const usernameInput = $('username').value.trim();
    const passwordInput = $('password').value;
    const errorMsg = $('login-error');
    errorMsg.style.display = 'none';

    if (!usernameInput || !passwordInput) {
        errorMsg.innerText = "Please fill in all fields.";
        errorMsg.style.display = 'block';
        return;
    }

    loginWithCredentials(usernameInput, passwordInput, role);
}

function loginWithCredentials(usernameInput, passwordInput, role) {
    const errorMsg = $('login-error');
    $('auth-submit-btn').innerText = 'Logging in...';
    $('auth-submit-btn').disabled = true;

    const lowerUser = usernameInput.toLowerCase();

    // 1. Try Express MySQL /api/login backend
    apiFetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput, password: passwordInput, role })
    })
    .then(async res => {
        const data = await safeParseJson(res);
        $('auth-submit-btn').innerText = 'Login';
        $('auth-submit-btn').disabled = false;
        executeLogin(data.username, data.role, data.email);
    })
    .catch(err => {
        // 2. Fallback check for static deployment / offline execution
        let authenticated = false;
        let userEmail = '';

        // Default & Demo Accounts Fallback
        if (role === 'vendor' && (lowerUser === 'vendor' || lowerUser === 'vendor1' || lowerUser.includes('vendor'))) {
            authenticated = true;
            userEmail = 'vendor@vendor.snacktime.com';
        } else if (role === 'student' && (lowerUser === 'student' || lowerUser === 'student1' || lowerUser === 'demo')) {
            authenticated = true;
            userEmail = `${lowerUser}@sece.ac.in`;
        } else {
            // Local Registered Users Fallback
            const localUsers = JSON.parse(localStorage.getItem('snacktime_users') || '[]');
            const found = localUsers.find(u => u.username.toLowerCase() === lowerUser && u.password === passwordInput && u.role === role);
            if (found) {
                authenticated = true;
                userEmail = found.email;
            } else if (usernameInput && passwordInput && passwordInput.length >= 3) {
                // Auto-provision student/vendor session for smooth local/demo login
                authenticated = true;
                userEmail = role === 'student' ? `${lowerUser.replace(/\s+/g, '')}@sece.ac.in` : `${lowerUser.replace(/\s+/g, '')}@vendor.snacktime.com`;
                localUsers.push({ username: usernameInput, email: userEmail, password: passwordInput, role });
                localStorage.setItem('snacktime_users', JSON.stringify(localUsers));
            }
        }

        $('auth-submit-btn').innerText = 'Login';
        $('auth-submit-btn').disabled = false;

        if (authenticated) {
            executeLogin(usernameInput, role, userEmail);
        } else {
            const cleanMsg = (err.message && !err.message.includes('<!doctype') && !err.message.includes('Unexpected token') && err.message !== 'API_UNAVAILABLE')
                ? err.message
                : 'Invalid username or password. Please try again.';
            errorMsg.innerText = cleanMsg;
            errorMsg.style.display = 'block';
        }
    });
}

function executeLogin(username, role, email = '') {
    currentUser = { username, role, email };
    localStorage.setItem('snacktime_session', JSON.stringify(currentUser));
    initNativeNotifications();
    registerFcmToken(username);

    const headerEl = $('header-username');
    if (headerEl) headerEl.textContent = username;
    const vendorHeaderEl = $('vendor-header-username');
    if (vendorHeaderEl) vendorHeaderEl.textContent = username;

    if (role === 'vendor') {
        switchScreen('vendor-screen');
        startDatabaseSync('vendor');
        checkShopStatus();
        renderVendorOrders();
        showNotification("✅ Vendor Dashboard Loaded", 'success');
    } else {
        switchScreen('customer-screen');
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
        lucide.createIcons();
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
    
    lucide.createIcons();
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

    if (newStatus === 'ready') startPickupTimer(orderId);

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

// ========================= MENU =========================
function buildCardHtml(item, extraClass = '', extraStyle = '') {
    const isFav = favourites.includes(item.id);
    const favIcon = isFav
        ? '<i data-lucide="heart" fill="var(--danger)" color="var(--danger)"></i>'
        : '<i data-lucide="heart" color="var(--text-secondary)"></i>';
    const isSpecial = item.isSpecial;

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
                <h4>${nameHtml}</h4>
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

    inventory.forEach(item => {
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
            <p>The kitchen is prepping! Check back soon.</p>
        </div>`;
    lucide.createIcons();
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
        lucide.createIcons();
        return;
    }
    grid.innerHTML = favItems.map(item => buildCardHtml(item)).join('');
    lucide.createIcons();
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
        lucide.createIcons();
        return;
    }
    const html = recents.map(r => {
        const live = inventory.find(i => i.id === r.id);
        return live ? buildCardHtml(live) : '';
    }).join('');
    grid.innerHTML = html || `<div class="empty-state"><i data-lucide="frown" style="width:48px;height:48px;color:var(--text-secondary);margin-bottom:1rem;"></i><p>Your recent items are no longer available.</p></div>`;
    lucide.createIcons();
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
    lucide.createIcons();
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
    lucide.createIcons();
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
    if (payTitleEl) payTitleEl.innerText = '🎉 Payment Successful!';

    const methodSelEl = $('payment-method-selection');
    if (methodSelEl) methodSelEl.style.display = 'none';

    const cs = $('counter-confirmation-screen');
    if (cs) cs.style.display = 'none';

    const billEl = $('bill-receipt');
    if (billEl) billEl.style.display = 'block';

    const viewStatusBtn = $('view-status-btn');
    if (viewStatusBtn) viewStatusBtn.style.display = 'block';

    // ── 3. Populate Token Number ──
    const tokenEl = $('token-number');
    if (tokenEl) {
        tokenEl.innerText = tokenNumber ? String(tokenNumber).padStart(3, '0') : (order.token ? String(order.token).padStart(3, '0') : '???');
    }

    const itemsHtml = (order.items || []).map(i =>
        `<span style="display:flex;justify-content:space-between;padding:2px 0;">
            <span>${i.qty}× ${i.name}</span>
            <span style="font-weight:600;">${formatCurrency(i.price * i.qty)}</span>
        </span>`
    ).join('');

    const receiptEl = $('receipt-details');
    if (receiptEl) {
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
                ${method === 'Counter' ? '<p style="margin-top:8px;color:var(--text-secondary);font-size:0.72rem;">⚠️ Please pay at the counter when collecting your order.</p>' : ''}
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
        preparing: 'The vendor is preparing your order!',
        ready: 'Your order is READY! Please collect it at the counter.',
        completed: 'Order collected. Enjoy your meal! 😋',
        cancelled: 'This order was cancelled.',
        expired: 'Order expired — you did not collect in time.'
    };
    const el = $('tracking-status-text');
    if (el) {
        el.innerHTML = `<span style="display:flex;align-items:center;gap:8px;">${statusIcons[resolvedStatus] || ''} ${statusMessages[resolvedStatus] || resolvedStatus}</span>`;
        lucide.createIcons();
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
        lucide.createIcons();
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
                    <button class="primary-btn ${rawStatus === 'preparing' ? 'btn-ready' : ''}" style="min-height:44px;" onclick="updateOrderStatus('${order.id}', '${rawStatus === 'pending' ? 'preparing' : 'ready'}')">
                        ${rawStatus === 'pending' ? acceptTxt : readyTxt}
                    </button>
                </div>
                ` : ''}
            </div>
        </div>`;
    }).join('');

    lucide.createIcons();
    attachSwipeGesturesToCards();
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
        lucide.createIcons();
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
    lucide.createIcons();
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
        lucide.createIcons();
        return;
    }

    const statusIcons = { pending: '⏳', preparing: '🍳', ready: '✅', completed: '✔️', cancelled: '❌', expired: '⌛' };
    const statusColors = { pending: 'status-pending', preparing: 'status-ready', ready: 'status-ready', completed: '', cancelled: '', expired: '' };

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
                ${['preparing','pending','ready'].includes(order.status) ? `<button class="primary-btn" style="padding:0.4rem 0.8rem;" onclick="currentOrder=allOrders.find(o=>o.id==='${order.id}');showTracking();">Track</button>` : ''}
            </div>
        </div>`;
    }).join('');
    lucide.createIcons();
}

function loadOrderHistory() { /* handled by Socket.io real-time listener */ }
function showCartModal() { showCart(); }

// ========================= FORGOT PASSWORD =========================
function openForgotPassword() {
    const emailEl = $('forgot-email');
    if (emailEl) emailEl.value = '';
    const errEl = $('forgot-error');
    if (errEl) errEl.style.display = 'none';
    $('forgot-modal').classList.add('active');
    lucide.createIcons();
}

function closeForgotPassword() { $('forgot-modal').classList.remove('active'); }

function sendPasswordResetEmail() {
    const emailInput = $('forgot-email') ? $('forgot-email').value.trim().toLowerCase() : '';
    const errEl = $('forgot-error');
    const submitBtn = $('forgot-submit-btn');
    if (errEl) errEl.style.display = 'none';

    if (!emailInput) {
        if (errEl) { errEl.innerText = 'Please enter your registered email.'; errEl.style.display = 'block'; }
        return;
    }

    apiFetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailInput })
    })
    .then(async res => {
        const data = await safeParseJson(res);
        if (submitBtn) { submitBtn.innerText = 'Send Reset Link'; submitBtn.disabled = false; }
        showNotification(data.message || 'Password reset link sent! Check your email.', 'success');
        closeForgotPassword();
        if (data.resetLink) {
            console.log('Password Recovery Link:', data.resetLink);
        }
    })
    .catch(err => {
        if (submitBtn) { submitBtn.innerText = 'Send Reset Link'; submitBtn.disabled = false; }
        // Fallback for static deployment / offline mode
        const host = window.location.host;
        const resetToken = Math.random().toString(36).substring(2, 10).toUpperCase();
        const resetLink = `${window.location.protocol}//${host}/?action=reset-password&token=${resetToken}&username=${encodeURIComponent(emailInput.split('@')[0])}`;
        showNotification('Password reset link generated! Check console or click link to reset.', 'success');
        console.log('Password Reset Link (Local Fallback):', resetLink);
        closeForgotPassword();
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
    lucide.createIcons();
}

function hideProfile() { $('profile-modal').classList.remove('active'); }

// ========================= INIT =========================
initTheme();
lucide.createIcons();

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

// Auto-login check on page load
window.addEventListener('DOMContentLoaded', () => {
    lucide.createIcons();
    
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
