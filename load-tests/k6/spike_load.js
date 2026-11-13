import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '5s', target: 10 },
    { duration: '10s', target: 100 }, // Sudden spike to 100 VUs
    { duration: '15s', target: 100 },
    { duration: '5s', target: 0 }
  ]
};

const BASE_URL = __ENV.GATEWAY_URL || 'http://localhost:8080';

export default function () {
  const clientIp = `10.0.2.${__VU % 25}`; // Concentrated client IPs to test Token Bucket rate limiter
  const res = http.get(`${BASE_URL}/api/restaurants`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': clientIp
    }
  });

  check(res, {
    'status is 200 or 429': (r) => r.status === 200 || r.status === 429
  });

  sleep(0.1);
}
