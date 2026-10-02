import { request } from 'node:http';

// Keep the public Host allowlist intact; only the TCP destination is loopback.
const publicUrl = new URL(process.env.PUBLIC_BASE_URL || 'http://localhost:3000');
const req = request({ hostname: '127.0.0.1', port: Number(process.env.PORT || 3000), path: '/health',
  headers: { Host: publicUrl.host }, timeout: 4000 }, response => {
  response.resume();
  response.on('end', () => process.exit(response.statusCode === 200 ? 0 : 1));
});
req.on('timeout', () => req.destroy(new Error('Health check timed out.')));
req.on('error', () => process.exit(1));
req.end();
