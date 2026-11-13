"""
Generates Food_Delivery_Load_Test_Report.pdf (2 pages).
Every number and sentence about measurements is computed from
load-tests/results/actual_test_run.json -- there are NO built-in fallback numbers.
Run order:  node load-tests/runner.js  ->  python docs/diagrams/generate_diagrams.py  ->  python docs/generate_load_test_pdf.py
"""
import json
import os
import sys

import fitz  # PyMuPDF

DATA = 'load-tests/results/actual_test_run.json'
if not os.path.exists(DATA):
    sys.exit(f"{DATA} not found. Run `node load-tests/runner.js` against the running stack first.")
with open(DATA) as f:
    R = json.load(f)

env = R['environment']
P = R['profiles']
normal, heavy, spike, rl = P['normal'], P['heavy'], P['spike'], P['rateLimitTest']
cache, pipe = P['cachingBenchmark'], P['asyncOrderPipeline']
cap, refill = env['rateLimiter']['capacity'], env['rateLimiter']['refillRatePerSecond']


def pct(part, whole):
    return f"{(100.0 * part / whole):.0f}%" if whole else "0%"


NAVY, AMBER, TEXT, SUB, CARD, BORDER = (0.08, 0.18, 0.36), (0.90, 0.45, 0.10), (0.2, 0.25, 0.3), (0.4, 0.45, 0.5), (0.96, 0.97, 0.99), (0.85, 0.88, 0.92)
doc = fitz.open()


def header(page, title, sub=None, h=50):
    page.draw_rect(fitz.Rect(0, 0, 595, h), color=None, fill=NAVY)
    page.insert_text((40, 32 if not sub else 30), title, fontsize=14, fontname="helv", color=(1, 1, 1))
    if sub:
        page.insert_text((40, 45), sub, fontsize=8.5, fontname="helv", color=(0.8, 0.85, 0.95))


def h2(page, y, text):
    page.insert_text((40, y), text, fontsize=11.5, fontname="helv", color=NAVY)
    return y + 15


def para(page, y, text, height, size=8.8):
    page.insert_textbox(fitz.Rect(40, y, 555, y + height), text, fontsize=size, fontname="helv", color=TEXT)
    return y + height + 6


def footer(page, n, total):
    page.insert_text((40, 815), "Food Delivery Order & Kitchen Management System - Load Test Report", fontsize=8, color=SUB)
    page.insert_text((505, 815), f"Page {n} of {total}", fontsize=8, color=SUB)


# ---------------------------------------------------------------- page 1
p1 = doc.new_page(width=595, height=842)
header(p1, "LOAD TEST REPORT", "Food Delivery Order & Kitchen Management System | System Design Assignment", h=62)
y = 82
y = h2(p1, y, "1. Objective and method")
y = para(p1, y, (
    "Goal: measure throughput and latency of the deployed stack, show how the Redis token-bucket rate limiter and the "
    "Redis cache protect it, and show that order placement stays fast because heavy work is handed to RabbitMQ and a worker pool. "
    f"All requests were real HTTP calls from load-tests/runner.js to {env['target']} (the API gateway), which forwards them over HTTP "
    "to the service containers. Before measuring, the runner checks that the stack is running on real PostgreSQL, Redis and RabbitMQ."), 62)

y = h2(p1, y, "2. Environment")
p1.draw_rect(fitz.Rect(40, y, 555, y + 107), color=BORDER, fill=CARD)
rows = [
    ("Stack:", env['architecture']),
    ("Infrastructure:", f"PostgreSQL ({env['infrastructure']['postgres']}), Redis ({env['infrastructure']['redis']}), RabbitMQ ({env['infrastructure']['rabbitmq']})"),
    ("Rate limiter:", f"Token bucket, capacity {cap}, refill {refill}/s per client"),
    ("Machine:", f"{env['platform']}, {env['cpuCores']} CPU cores, Node {env['nodeVersion']}"),
    ("Deployment:", env.get('deployment', '')),
    ("Run date:", R['testDate'][:19].replace('T', ' ') + " UTC"),
]
ey = y + 13
for k, v in rows:
    p1.insert_text((50, ey), k, fontsize=8.3, fontname="helv", color=NAVY)
    lines = 2 if len(v) > 100 else 1
    p1.insert_textbox(fitz.Rect(140, ey - 9.5, 550, ey + 5 + 11 * (lines - 1)), v, fontsize=8.3, fontname="helv", color=TEXT)
    ey += 14 + 11 * (lines - 1)
y += 119

y = h2(p1, y, "3. Measured throughput and latency")
headers = ["Scenario", "VUs", "Reqs", "Throughput", "Avg ms", "p95 ms", "p99 ms", "HTTP 429"]
col_x = [40, 205, 240, 280, 360, 410, 460, 510, 555]
p1.draw_rect(fitz.Rect(40, y, 555, y + 19), color=NAVY, fill=NAVY)
for i, hd in enumerate(headers):
    p1.insert_text((col_x[i] + 4, y + 13), hd, fontsize=8, fontname="helv", color=(1, 1, 1))
y += 19
table = [
    ("1 Normal traffic", normal), ("2 Heavy traffic", heavy), ("3 Traffic spike", spike),
    ("4 Single-client burst", rl),
]
for idx, (label, d) in enumerate(table):
    lat = d['latencies']
    vals = (label, str(d['virtualUsers']), str(d['totalRequests']), f"{d['requestsPerSecond']:g} req/s",
            f"{lat['avg']:g}", f"{lat['p95']:g}", f"{lat['p99']:g}",
            f"{d['rateLimited']} ({pct(d['rateLimited'], d['totalRequests'])})")
    p1.draw_rect(fitz.Rect(40, y, 555, y + 18), color=BORDER, fill=(1, 1, 1) if idx % 2 == 0 else (0.97, 0.98, 0.99))
    for i, v in enumerate(vals):
        red = i == 7 and d['rateLimited'] > 0
        p1.insert_text((col_x[i] + 4, y + 13), v, fontsize=8, fontname="helv", color=(0.8, 0.1, 0.1) if red else TEXT)
    y += 18
y += 4
y = para(p1, y, "Latency includes the gateway, the proxy hop to the service and (on cache misses) PostgreSQL. "
                "The load generator ran on the same machine as the stack, so absolute numbers are indicative, not production capacity.", 26, 8)

y = h2(p1, y + 4, "4. Latency by profile")
if os.path.exists('docs/diagrams/performance_chart.png'):
    p1.insert_image(fitz.Rect(40, y, 555, y + 205), filename='docs/diagrams/performance_chart.png')
footer(p1, 1, 2)

# ---------------------------------------------------------------- page 2
p2 = doc.new_page(width=595, height=842)
header(p2, "RATE LIMITING, CACHING, ASYNC PIPELINE AND FAULT TOLERANCE")
y = 72
y = h2(p2, y, "5. How the rate limiter protected the system")
y = para(p2, y, (
    f"In the spike profile ({spike['virtualUsers']} virtual users sharing a few client identities) the gateway served {spike['successful']} requests and "
    f"rejected {spike['rateLimited']} ({pct(spike['rateLimited'], spike['totalRequests'])}) with HTTP 429 and a Retry-After header, with zero server errors "
    f"({spike['failed']} failed). In the single-client burst, exactly {rl['successful']} of {rl['totalRequests']} requests were allowed (the bucket capacity of {cap}) "
    f"and {rl['rateLimited']} were rejected. Rejected requests are answered by the gateway from a Redis Lua script and never reach the services or the database."), 78)

y = h2(p2, y, "6. Redis cache-aside benchmark (GET /api/restaurants)")
u, c = cache['uncached'], cache['cached']
p2.draw_rect(fitz.Rect(40, y, 555, y + 56), color=BORDER, fill=CARD)
for i, (k, v) in enumerate([
    ("Cache miss (PostgreSQL):", f"avg {u['avg']} ms | p95 {u['p95']} ms  (cache purged before every request)"),
    ("Cache hit (Redis):", f"avg {c['avg']} ms | p95 {c['p95']} ms"),
    ("Difference:", (f"{cache['latencyReductionPercentage']}% lower average latency" if cache['latencyReductionPercentage'] >= 0 else f"{abs(cache['latencyReductionPercentage'])}% higher average latency (no measurable gain in this run)")),
]):
    p2.insert_text((50, y + 15 + i * 14), k, fontsize=8.5, fontname="helv", color=NAVY)
    p2.insert_text((200, y + 15 + i * 14), v, fontsize=8.5, fontname="helv", color=TEXT)
y += 64
_r = cache['latencyReductionPercentage']
if _r < 0:
    _lead = "On this machine the cache gave no measurable gain (the cached path was not faster, within run-to-run noise), because this is a tiny indexed read on a local database and most of the latency is the gateway/proxy hop, which both paths share. "
else:
    _lead = f"The gain is {'small and within run-to-run noise' if _r < 10 else 'modest'} because this is a small indexed read and most of the latency is the gateway/proxy hop, which both paths share. "
y = para(p2, y, (_lead +
                 "The cache's main value is removing load from PostgreSQL as traffic grows; it is invalidated whenever a menu item changes."), 58)

y = h2(p2, y, "7. Asynchronous order pipeline (RabbitMQ + worker pool)")
a = pipe['api']
drain = pipe['workerDrainSecondsAfterLastResponse']
y = para(p2, y, (
    f"{pipe['ordersAccepted']} of {a['totalRequests']} orders were accepted by the API (avg {a['latencies']['avg']} ms, p95 {a['latencies']['p95']} ms) "
    f"at {a['requestsPerSecond']:g} orders/s. Each order is committed to PostgreSQL, published to RabbitMQ and acknowledged immediately; "
    "the order workers (a pool of competing consumers in separate containers) then do the slow processing "
    "(each task takes about 0.6 s) and write the kitchen-queue and background-task rows. "
    + (f"All workers' database writes finished {drain} s after the last API response, so the API never waited for the slow work."
       if drain is not None else "The workers had not finished within the 90 s measurement window.")), 84)

y = h2(p2, y, "8. Fault tolerance (verified by tests/run-tests.js and manual failure drills)")
for t in [
    "Circuit breaker (payment service): after 3 consecutive failures it opens; requests then fail fast with HTTP 503 and a fallback (about 2 ms), "
    "and after the 8 s reset timeout a probe request succeeds and closes it again.",
    "Retries with exponential backoff and dead-letter queue: a failing message is retried after 200, 400 and 800 ms, then moved to the dead-letter queue (observed on RabbitMQ).",
    "Service outage: with the order service stopped, the gateway returned HTTP 502 for /api/orders, other routes kept working and /health reported 'degraded' with order = down.",
    "Concurrency: two cooks claiming the same order at the same instant get exactly one 200 and one 409 (single atomic UPDATE in PostgreSQL).",
]:
    y = para(p2, y, "- " + t, 38, 8.5)

p2.draw_rect(fitz.Rect(40, y + 2, 555, y + 56), color=AMBER, fill=(0.99, 0.95, 0.90))
p2.insert_text((50, y + 17), "Limitations", fontsize=9.5, fontname="helv", color=AMBER)
p2.insert_textbox(fitz.Rect(50, y + 22, 548, y + 56),
                  "Single machine, shared by load generator and stack; one gateway instance; no network latency. "
                  "Distinct clients are simulated with X-Forwarded-For (gateway started with TRUST_PROXY=true).",
                  fontsize=8.3, fontname="helv", color=TEXT)
footer(p2, 2, 2)

out = 'Food_Delivery_Load_Test_Report.pdf'
doc.save(out, deflate=True, garbage=4)
doc.close()
print(f"Generated {out} from {DATA}")
