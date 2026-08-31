const { spawn } = require('child_process');

console.log('===========================================================');
console.log('🚀 STARTING SECURE PUBLIC HTTPS TUNNEL FOR SNACK TIME');
console.log('===========================================================');

function launchTunnel() {
    const ssh = spawn('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'ServerAliveInterval=30',
        '-R', '80:localhost:3000',
        'nokey@localhost.run'
    ]);

    ssh.stdout.on('data', (data) => {
        const str = data.toString();
        const match = str.match(/https:\/\/[a-z0-9]+\.lhr\.life/i) || str.match(/https:\/\/[a-z0-9]+\.lhrtunnel\.link/i);
        if (match) {
            console.log('');
            console.log('🌐 PUBLIC HTTPS URL (FOR MOBILE 4G/5G & ANY LAPTOP):');
            console.log('👉 ' + match[0]);
            console.log('');
            console.log('📱 INSTANT USAGE INSTRUCTIONS:');
            console.log('1. Open on Mobile Phone (4G/5G/Any Wi-Fi) -> Login as Student (student / student123)');
            console.log('2. Open on Laptop -> Login as Vendor (vendor / vendor123)');
            console.log('3. Place order from phone -> Laptop receives chime & live order in real-time!');
            console.log('===========================================================');
        }
    });

    ssh.stderr.on('data', (d) => {
        // Silent system keepalive
    });

    ssh.on('close', () => {
        console.log('Tunnel disconnected. Reconnecting in 3 seconds...');
        setTimeout(launchTunnel, 3000);
    });
}

launchTunnel();