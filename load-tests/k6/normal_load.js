import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 10 }, // Ramp up to 10 VUs
    { duration: '30s', target: 10 }, // Stay at 10 VUs
    { duration: '5s', target: 0 }    // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<150'], // 95% of requests must complete below 150ms
    http_req_failed: ['rate<0.01']     // Failure rate under 1%
  }
};

const BASE_URL = __ENV.GATEWAY_URL || 'http://localhost:8080';

export default function () {
  const res = http.get(`${BASE_URL}/api/restaurants`, {
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `10.0.1.${__VU}`
    }
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has restaurants': (r) => JSON.parse(r.body).data.length > 0
  });

  sleep(0.5);
}
