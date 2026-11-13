/**
 * Restaurant and Menu Microservice
 * Implements Cache-Aside Pattern with Redis, Cache Invalidation,
 * Restaurant Ranking & Search Algorithms
 */

import express from '../../../shared/expressAdapter.js';
import cors from '../../../shared/corsAdapter.js';
import { db } from '../../../database/db.js';
import { redisManager } from '../../../shared/redisClient.js';
import { createLogger } from '../../../shared/logger.js';
import { startService } from '../../../shared/bootstrap.js';

const log = createLogger('restaurant-service');
const app = express();
const PORT = process.env.PORT_RESTAURANT || 4002;

app.use(cors());
app.use(express.json());

// Health Check Endpoint
app.get('/health', async (req, res) => {
  const dbOk = await db.isHealthy();
  const redisOk = await redisManager.isHealthy();
  res.status(200).json({
    service: 'restaurant-service',
    status: dbOk && redisOk ? 'healthy' : 'degraded',
    database: dbOk ? 'healthy' : 'down',
    cache: redisOk ? 'healthy' : 'down',
    timestamp: new Date().toISOString()
  });
});

/**
 * ALGORITHM 3: Restaurant Ranking Algorithm
 * Score = w1 * NormalizedRating + w2 * NormalizedDistance + w3 * AvailabilityBonus
 */
function rankRestaurants(restaurants, userLat = 23.1293, userLon = 72.5448) {
  const w1 = 0.50; // Rating weight
  const w2 = 0.35; // Proximity weight
  const w3 = 0.15; // Operational status weight

  return restaurants.map(r => {
    // Haversine distance formula approximation
    const dLat = (r.latitude - userLat) * 111.0;
    const dLon = (r.longitude - userLon) * 102.0;
    const distanceKm = Math.sqrt(dLat * dLat + dLon * dLon);

    const normRating = Math.min(1.0, (Number(r.rating) || 4.0) / 5.0);
    const normProximity = Math.max(0, 1.0 - (distanceKm / 20.0)); // 20km max delivery radius
    const openBonus = (r.is_active && r.is_open) ? 1.0 : 0.0;

    const rankScore = (w1 * normRating) + (w2 * normProximity) + (w3 * openBonus);

    return {
      ...r,
      distanceKm: Number(distanceKm.toFixed(2)),
      estimatedDeliveryTimeMin: Math.round(15 + distanceKm * 3.5),
      rankingScore: Number(rankScore.toFixed(4))
    };
  }).sort((a, b) => b.rankingScore - a.rankingScore);
}

/**
 * ALGORITHM 4: Restaurant Search & Inverted Substring Match
 */
function searchRestaurants(restaurants, query) {
  if (!query) return restaurants;
  const q = query.toLowerCase().trim();
  return restaurants.filter(r => {
    const nameMatch = r.name.toLowerCase().includes(q);
    const cuisineMatch = r.cuisine.toLowerCase().includes(q);
    const descMatch = (r.description || '').toLowerCase().includes(q);
    return nameMatch || cuisineMatch || descMatch;
  });
}

// GET all restaurants (Cache-Aside with Redis)
app.get('/api/restaurants', async (req, res) => {
  const startTime = Date.now();
  const { search, cuisine, userLat, userLon } = req.query;
  const cacheKey = `cache:restaurants:all:${cuisine || 'all'}:${search || 'none'}`;

  try {
    // 1. Check Redis Cache
    const cachedData = await redisManager.get(cacheKey);
    if (cachedData) {
      log.info('Cache HIT for restaurants query', { cacheKey, latencyMs: Date.now() - startTime });
      return res.status(200).json({
        success: true,
        source: 'CACHE_HIT',
        cacheLatencyMs: Date.now() - startTime,
        data: cachedData
      });
    }

    // 2. Cache MISS: Query PostgreSQL database
    log.info('Cache MISS for restaurants query. Reading from database', { cacheKey });
    let restaurants = await db.findMany('restaurants', r => r.is_active);

    if (cuisine) {
      restaurants = restaurants.filter(r => r.cuisine.toLowerCase().includes(cuisine.toLowerCase()));
    }

    if (search) {
      restaurants = searchRestaurants(restaurants, search);
    }

    // Apply Ranking Algorithm
    const ranked = rankRestaurants(restaurants, Number(userLat) || 23.1293, Number(userLon) || 72.5448);

    // 3. Update Redis Cache (TTL = 180 seconds)
    await redisManager.set(cacheKey, ranked, 180);

    res.status(200).json({
      success: true,
      source: 'CACHE_MISS (DB)',
      queryLatencyMs: Date.now() - startTime,
      data: ranked
    });
  } catch (err) {
    log.error('Failed to fetch restaurants:', { error: err.message });
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET Restaurant details with full menu (Cache-Aside)
app.get('/api/restaurants/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `cache:restaurant:${id}`;
  const startTime = Date.now();

  try {
    const cached = await redisManager.get(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        source: 'CACHE_HIT',
        latencyMs: Date.now() - startTime,
        data: cached
      });
    }

    const restaurant = await db.findById('restaurants', id);
    if (!restaurant) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    const categories = await db.findMany('menu_categories', { restaurant_id: id });
    const menuItems = await db.findMany('menu_items', { restaurant_id: id });

    // Group items into categories
    const categoriesWithItems = categories.map(cat => ({
      ...cat,
      items: menuItems.filter(item => item.category_id === cat.id)
    }));

    const result = {
      ...restaurant,
      categories: categoriesWithItems,
      totalMenuItems: menuItems.length
    };

    // Cache with TTL 300s
    await redisManager.set(cacheKey, result, 300);

    res.json({
      success: true,
      source: 'CACHE_MISS (DB)',
      latencyMs: Date.now() - startTime,
      data: result
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update Restaurant / Menu Item (Triggers Cache Invalidation)
app.put('/api/restaurants/:id/menu/:itemId', async (req, res) => {
  const { id, itemId } = req.params;
  const { price, is_available, name } = req.body;

  try {
    const updated = await db.update('menu_items', itemId, {
      ...(price !== undefined && { price: Number(price) }),
      ...(is_available !== undefined && { is_available: Boolean(is_available) }),
      ...(name && { name })
    });

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Menu item not found' });
    }

    // Invalidate Redis Caches
    await redisManager.invalidate(`cache:restaurant:${id}`);
    await redisManager.invalidate('cache:restaurants:*');
    log.info('Cache invalidated after menu item update', { restaurantId: id, itemId });

    res.json({
      success: true,
      message: 'Menu item updated and related caches invalidated',
      data: updated
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cache Metrics Endpoint for Live Demo & Performance Reporting
app.get('/api/restaurants/cache/stats', (req, res) => {
  const metrics = redisManager.getMetrics();
  res.json({
    success: true,
    cachePolicy: 'Cache-Aside (Lazy Loading)',
    metrics
  });
});

// Cache purge endpoint for live demo
app.post('/api/restaurants/cache/purge', async (req, res) => {
  await redisManager.invalidate('cache:*');
  res.json({
    success: true,
    message: 'All restaurant and menu caches purged from Redis'
  });
});

export default app;

if (process.env.STANDALONE_SERVICE === 'true') {
  startService({ name: 'restaurant-service', app, port: PORT, needs: { postgres: true, redis: true } });
}
