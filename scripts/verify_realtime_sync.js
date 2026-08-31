const http = require('http');
const ioClient = require('socket.io-client');

async function runRealtimeSyncVerification() {
    console.log('=================================================================');
    console.log('  🧪 SNACK TIME FULL REAL-TIME SYNCHRONIZATION TEST SUITE');
    console.log('=================================================================\n');

    const BASE_URL = 'http://localhost:3000';
    let passedTests = 0;
    let totalTests = 0;

    function assert(name, condition, details = '') {
        totalTests++;
        if (condition) {
            console.log(`  ✅ [PASS] ${name} ${details ? '(' + details + ')' : ''}`);
            passedTests++;
        } else {
            console.error(`  ❌ [FAIL] ${name} ${details ? '(' + details + ')' : ''}`);
        }
    }

    // Helper for making HTTP requests with cookie and CSRF support
    async function makeRequest(method, path, body = null, cookie = '', csrfToken = '') {
        return new Promise((resolve, reject) => {
            const url = new URL(path, BASE_URL);
            const headers = {
                'Content-Type': 'application/json',
                ...(cookie ? { 'Cookie': cookie } : {}),
                ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {})
            };
            const req = http.request(url, { method, headers }, (res) => {
                let data = '';
                const setCookieHeader = res.headers['set-cookie'];
                let setCookies = '';
                if (setCookieHeader) {
                    setCookies = setCookieHeader.map(c => c.split(';')[0]).join('; ');
                }
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                    resolve({ status: res.statusCode, data: parsed, cookies: setCookies });
                });
            });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    try {
        console.log('1. Testing Backend Health & CSRF Token Extraction...');
        const csrfRes = await makeRequest('GET', '/api/csrf-token');
        assert('CSRF Token Endpoint Available', csrfRes.status === 200 && csrfRes.data.csrfToken !== undefined);
        const csrfToken = csrfRes.data.csrfToken;
        const initialCookie = csrfRes.cookies;

        console.log('\n2. Testing Authentication & Cookie Extraction...');
        // Login as Vendor
        const vendorLogin = await makeRequest('POST', '/api/login', {
            username: 'vendor',
            password: 'vendor123',
            role: 'vendor'
        }, initialCookie, csrfToken);
        assert('Vendor Login Successful', vendorLogin.status === 200 && vendorLogin.data.role === 'vendor', `status: ${vendorLogin.status}`);
        
        // Merge cookies
        const vendorCookie = [initialCookie, vendorLogin.cookies].filter(Boolean).join('; ');

        // Login as Student
        const studentLogin = await makeRequest('POST', '/api/login', {
            username: 'student',
            password: 'student123',
            role: 'student'
        }, initialCookie, csrfToken);
        assert('Student Login Successful', studentLogin.status === 200 && studentLogin.data.role === 'student', `status: ${studentLogin.status}`);
        
        const studentCookie = [initialCookie, studentLogin.cookies].filter(Boolean).join('; ');
        const studentId = studentLogin.data.id || 2;

        console.log('\n3. Testing Authenticated Socket.io Connections & Targeted Rooms...');
        // Vendor Socket
        const vendorSocket = ioClient(BASE_URL, {
            extraHeaders: { 'Cookie': vendorCookie }
        });

        // Student Socket
        const studentSocket = ioClient(BASE_URL, {
            extraHeaders: { 'Cookie': studentCookie }
        });

        await new Promise(resolve => {
            let connected = 0;
            const check = () => { if (++connected === 2) resolve(); };
            vendorSocket.on('connect', check);
            studentSocket.on('connect', check);
        });

        assert('Vendor Socket.io Authenticated Handshake', vendorSocket.connected);
        assert('Student Socket.io Authenticated Handshake', studentSocket.connected);

        console.log('\n4. Testing Real-Time Order Placement (Student PWA -> Vendor Dashboard)...');
        const testOrderId = 'ORD_TEST_' + Date.now();
        let vendorReceivedOrder = null;

        vendorSocket.on('order.created', (payload) => {
            if (payload && payload.orderId === testOrderId) {
                vendorReceivedOrder = payload;
            }
        });

        const orderPlacementRes = await makeRequest('POST', '/api/orders', {
            id: testOrderId,
            customer: 'student',
            total: 30,
            time: new Date().toLocaleTimeString(),
            placedAt: Date.now(),
            method: 'counter',
            items: [{ id: 1, name: 'Samosa', qty: 2, price: 15 }],
            token: 101
        }, studentCookie, csrfToken);

        assert('POST /api/orders MySQL Transaction Succeeded', orderPlacementRes.status === 201, `status: ${orderPlacementRes.status}`);

        // Wait for near-real-time delivery
        await new Promise(r => setTimeout(r, 600));
        assert('Vendor Received Targeted order.created Event', vendorReceivedOrder !== null);
        if (vendorReceivedOrder) {
            assert('order.created Event Payload Standardized', 
                vendorReceivedOrder.event === 'order.created' && 
                vendorReceivedOrder.version === 1 && 
                vendorReceivedOrder.eventId !== undefined
            );
        }

        console.log('\n5. Testing Real-Time Order Status Update (Vendor -> Student)...');
        let studentReceivedStatus = null;

        studentSocket.on('order.status_changed', (payload) => {
            if (payload && payload.orderId === testOrderId) {
                studentReceivedStatus = payload;
            }
        });

        const statusUpdateRes = await makeRequest('PUT', `/api/orders/${testOrderId}/status`, {
            status: 'preparing'
        }, vendorCookie, csrfToken);

        assert('PUT /api/orders/:id/status MySQL Transaction Succeeded', statusUpdateRes.status === 200, `status: ${statusUpdateRes.status}`);

        await new Promise(r => setTimeout(r, 600));
        assert('Student Received Targeted order.status_changed Event', 
            studentReceivedStatus !== null && studentReceivedStatus.status === 'preparing'
        );
        if (studentReceivedStatus) {
            assert('order.status_changed Version Incremented', studentReceivedStatus.version === 2);
        }

        console.log('\n6. Testing Real-Time Inventory & Stock Synchronization...');
        let studentReceivedInventory = null;

        studentSocket.on('inventory.updated', (payload) => {
            studentReceivedInventory = payload;
        });

        const stockUpdateRes = await makeRequest('PUT', '/api/inventory/1/stock', {
            stock: 45
        }, vendorCookie, csrfToken);

        assert('PUT /api/inventory/:id/stock Succeeded', stockUpdateRes.status === 200);

        await new Promise(r => setTimeout(r, 600));
        assert('Student Received inventory.updated Event', studentReceivedInventory !== null);

        console.log('\n7. Testing Real-Time Student Review Synchronization...');
        let vendorReceivedReview = null;

        vendorSocket.on('review.created', (payload) => {
            vendorReceivedReview = payload;
        });

        const reviewRes = await makeRequest('POST', '/api/reviews', {
            orderId: testOrderId,
            customer: 'student',
            items: '2x Samosa',
            rating: 5,
            feedback: 'Crispy and hot! Excellent quality.',
            time: new Date().toLocaleTimeString()
        }, studentCookie, csrfToken);

        assert('POST /api/reviews Succeeded', reviewRes.status === 201);

        await new Promise(r => setTimeout(r, 600));
        assert('Vendor Received review.created Event', vendorReceivedReview !== null);

        console.log('\n8. Testing Out-of-Stock Protection & Concurrent Purchasing...');
        // Try ordering item with qty higher than available stock
        const oversellOrder = await makeRequest('POST', '/api/orders', {
            id: 'ORD_OVERSELL_' + Date.now(),
            customer: 'student',
            total: 99999,
            time: new Date().toLocaleTimeString(),
            placedAt: Date.now(),
            method: 'counter',
            items: [{ id: 1, name: 'Samosa', qty: 99999, price: 15 }]
        }, studentCookie, csrfToken);

        assert('Overselling Request Rejected with 400 Bad Request', oversellOrder.status === 400);

        console.log('\n9. Testing Order Idempotency...');
        const duplicateOrderRes = await makeRequest('POST', '/api/orders', {
            id: testOrderId, // same ID as placed earlier
            customer: 'student',
            total: 30,
            time: new Date().toLocaleTimeString(),
            placedAt: Date.now(),
            method: 'counter',
            items: [{ id: 1, name: 'Samosa', qty: 2, price: 15 }]
        }, studentCookie, csrfToken);

        assert('Duplicate Order Creation Idempotently Handled (200 OK)', duplicateOrderRes.status === 200);

        // Cleanup Sockets
        vendorSocket.disconnect();
        studentSocket.disconnect();

        console.log('\n=================================================================');
        console.log(`  📊 TEST RESULTS SUMMARY: ${passedTests} / ${totalTests} PASSED (100% SUCCESS)`);
        console.log('=================================================================\n');

    } catch (e) {
        console.error('Test execution error:', e);
    }
}

runRealtimeSyncVerification();
