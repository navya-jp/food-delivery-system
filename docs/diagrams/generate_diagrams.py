"""
Generate Architecture and System Design Diagrams
Creates high-resolution visual PNG diagrams for documentation and report:
1. System Architecture Diagram (Microservices, Gateway, Redis, RabbitMQ, PostgreSQL)
2. Data Flow Diagram (Order Lifecycle from Client -> Gateway -> Queue -> Worker -> DB)
3. Circuit Breaker State Transition Diagram (Closed -> Open -> Half-Open)
4. Load Testing Performance Comparison Chart
"""

import os
import matplotlib.pyplot as plt
import matplotlib.patches as patches

os.makedirs('docs/diagrams', exist_ok=True)

# 1. System Architecture Diagram
def generate_architecture_diagram():
    """Architecture + data-flow diagram that matches docker-compose.yml."""
    from matplotlib.patches import FancyBboxPatch

    fig, ax = plt.subplots(figsize=(12, 8.4))
    ax.set_xlim(0, 120)
    ax.set_ylim(-7, 82)
    ax.axis('off')

    def box(x, y, w, h, title, sub=None, fc='#F1F5F9', ec='#64748B', tc='#0F172A'):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.4,rounding_size=1.2', fc=fc, ec=ec, lw=1.6))
        if sub:
            ax.text(x + w / 2, y + h * 0.68, title, ha='center', va='center', fontsize=9, fontweight='bold', color=tc)
            ax.text(x + w / 2, y + h * 0.30, sub, ha='center', va='center', fontsize=7.3, color=tc, linespacing=1.35)
        else:
            ax.text(x + w / 2, y + h / 2, title, ha='center', va='center', fontsize=9, fontweight='bold', color=tc)

    def arrow(x1, y1, x2, y2, color='#475569', style='-|>', ls='-', lw=1.5):
        ax.annotate('', xy=(x2, y2), xytext=(x1, y1),
                    arrowprops=dict(arrowstyle=style, color=color, lw=lw, linestyle=ls, shrinkA=0, shrinkB=0))

    ax.text(60, 79, 'Food Delivery Order & Kitchen Management System - Architecture and Data Flow',
            ha='center', fontsize=13, fontweight='bold', color='#0F172A')

    # Clients + gateway
    box(35, 68, 50, 7, 'Clients', 'Browser UI (nginx :3000)  |  curl  |  k6 / load-test runner', '#F1F5F9', '#94A3B8')
    arrow(60, 68, 60, 63.6)
    box(22, 54, 76, 9, 'API Gateway :8080  (only public API entry point)',
        'HTTP reverse proxy  |  Redis token-bucket rate limiter (429)  |  composite /health  |  X-Request-Id tracing',
        '#FEF3C7', '#F59E0B', '#78350F')

    # Services row
    services = [('Auth', 'JWT, roles'), ('Restaurant', 'menu + cache'), ('Order', 'lifecycle'),
                ('Kitchen', 'atomic lock'), ('Payment', 'circuit breaker'), ('Delivery', 'assignment'),
                ('Notification', 'in-app / SMS')]
    colors = ['#DBEAFE', '#DCFCE7', '#FCE7F3', '#FFEDD5', '#EDE9FE', '#E0F2FE', '#FEF9C3']
    edges = ['#2563EB', '#16A34A', '#DB2777', '#EA580C', '#7C3AED', '#0284C7', '#CA8A04']
    sw, gap, x0, y_s = 14.6, 2.3, 2.0, 37
    centers = []
    ax.plot([x0 + sw / 2, x0 + 6 * (sw + gap) + sw / 2], [49, 49], color='#475569', lw=1.5)
    ax.plot([60, 60], [53.6, 49], color='#475569', lw=1.5)
    for i, (n, d) in enumerate(services):
        x = x0 + i * (sw + gap)
        cx = x + sw / 2
        centers.append(cx)
        box(x, y_s, sw, 7.5, n, d, colors[i], edges[i])
        arrow(cx, 49, cx, y_s + 7.9)
    ax.text(x0, 50.2, 'HTTP over the internal Docker network (service ports are not published)', fontsize=7.3, color='#475569')
    ax.text(60, 34.0, 'Microservices - one container each', ha='center', fontsize=7.8, color='#334155', fontweight='bold')

    # Infrastructure
    box(4, 8, 30, 11, 'PostgreSQL 16', 'source of truth for all services:\n23 tables, ACID transactions,\natomic compare-and-set locks', '#C7D2FE', '#4338CA')
    box(45, 8, 30, 11, 'Redis 7', 'gateway rate limiter (Lua token bucket)\n+ restaurant cache-aside (TTL)', '#FECDD3', '#E11D48')
    box(86, 8, 30, 11, 'RabbitMQ 3.13', 'order / kitchen / payment / delivery publish;\nretry with backoff + dead-letter queue', '#FED7AA', '#C2410C')

    # services -> infrastructure
    arrow(centers[0], y_s, 12, 19.6, '#4338CA')          # auth -> postgres
    arrow(centers[2] - 2, y_s, 24, 19.6, '#4338CA')      # order -> postgres
    arrow(centers[1], y_s, 52, 19.6, '#E11D48')          # restaurant -> redis
    arrow(centers[2] + 2, y_s, 92, 19.6, '#C2410C')      # order -> rabbitmq
    arrow(centers[4], y_s, 108, 19.6, '#C2410C')         # payment -> rabbitmq
    # gateway -> Redis along the right margin (dashed)
    ax.plot([98, 119, 119, 66], [58.5, 58.5, 28, 28], color='#E11D48', lw=1.5, ls='--')
    arrow(66, 28, 66, 19.6, '#E11D48', ls='--')
    ax.text(100, 29.2, 'rate-limit check on every request', fontsize=7.3, color='#E11D48')

    # Worker pool
    box(36, -4.5, 48, 7.5, 'Worker pool (separate containers)', 'order-worker x2  |  notification-worker', '#DCFCE7', '#15803D', '#14532D')
    arrow(101, 8, 84.5, 1.5, '#C2410C')
    arrow(36, -0.5, 19, 7.6, '#4338CA')
    ax.text(97, 2.2, 'consume', fontsize=7.5, color='#C2410C')
    ax.text(9, -0.8, 'write results', fontsize=7.5, color='#4338CA')

    plt.savefig('docs/diagrams/architecture_diagram.png', dpi=150, bbox_inches='tight')
    plt.close(fig)
    print("Created docs/diagrams/architecture_diagram.png")

def generate_performance_chart():
    import json
    with open('load-tests/results/actual_test_run.json') as f:
        prof = json.load(f)['profiles']
    keys = [('normal', 'Normal'), ('heavy', 'Heavy'), ('spike', 'Spike')]
    scenarios = [f"{label} ({prof[k]['virtualUsers']} VU)" for k, label in keys]
    avg_latency = [prof[k]['latencies']['avg'] for k, _ in keys]
    p95_latency = [prof[k]['latencies']['p95'] for k, _ in keys]
    p99_latency = [prof[k]['latencies']['p99'] for k, _ in keys]

    fig, ax = plt.subplots(figsize=(8, 3.6))
    x = list(range(len(scenarios)))
    width = 0.26
    ax.bar([i - width for i in x], avg_latency, width, label='Average (ms)', color='#3B82F6')
    ax.bar(x, p95_latency, width, label='p95 (ms)', color='#F59E0B')
    ax.bar([i + width for i in x], p99_latency, width, label='p99 (ms)', color='#EF4444')
    for i in x:
        for off, v in ((-width, avg_latency[i]), (0, p95_latency[i]), (width, p99_latency[i])):
            ax.text(i + off, v + max(p99_latency) * 0.015, f"{v:g}", ha='center', fontsize=7.5)
    ax.set_xticks(x)
    ax.set_xticklabels(scenarios)
    ax.set_ylabel('Latency (ms), measured over real HTTP')
    ax.set_title('Gateway latency by load profile (GET /api/restaurants)')
    ax.legend(frameon=False)
    ax.spines[['top', 'right']].set_visible(False)
    plt.tight_layout()
    plt.savefig('docs/diagrams/performance_chart.png', dpi=150)
    plt.close(fig)
    print("Created docs/diagrams/performance_chart.png")

if __name__ == '__main__':
    generate_architecture_diagram()
    generate_performance_chart()
