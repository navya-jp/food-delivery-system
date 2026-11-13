/**
 * Database Seed Script - Populates Realistic Demo Dataset
 */

import { db } from '../db.js';
import { ROLES, ORDER_STATUS } from '../../shared/constants.js';
import { hashPassword } from '../../shared/auth.js';
import { isMain } from '../../shared/bootstrap.js';

export async function seedDatabase({ reset = true } = {}) {
  if (reset) await db.truncateAll();
  // 1. Roles
  const rolesList = [
    { id: 'role_admin', name: ROLES.ADMIN, description: 'System Administrator' },
    { id: 'role_customer', name: ROLES.CUSTOMER, description: 'App Customer' },
    { id: 'role_owner', name: ROLES.RESTAURANT_OWNER, description: 'Restaurant Manager/Owner' },
    { id: 'role_kitchen', name: ROLES.KITCHEN_STAFF, description: 'Kitchen Chef / Line Cook' },
    { id: 'role_rider', name: ROLES.DELIVERY_PARTNER, description: 'Delivery Partner Rider' }
  ];
  for (const r of rolesList) await db.insert('roles', r);

  // 2. Users (Plain password for demo hash: demo123)
  const usersList = [
    {
      id: 'usr_admin_1',
      name: 'System Admin',
      email: 'admin@fooddelivery.com',
      password_hash: hashPassword('admin123'),
      phone: '+91 98765 00001'
    },
    {
      id: 'usr_customer_1',
      name: 'John Doe',
      email: 'customer@fooddelivery.com',
      password_hash: hashPassword('customer123'),
      phone: '+91 98765 11111'
    },
    {
      id: 'usr_owner_1',
      name: 'Mario Rossi',
      email: 'owner@fooddelivery.com',
      password_hash: hashPassword('owner123'),
      phone: '+91 98765 22222'
    },
    {
      id: 'usr_kitchen_1',
      name: 'Chef Gordon',
      email: 'kitchen@fooddelivery.com',
      password_hash: hashPassword('chef123'),
      phone: '+91 98765 33333'
    },
    {
      id: 'usr_rider_1',
      name: 'Alex Rider',
      email: 'rider@fooddelivery.com',
      password_hash: hashPassword('rider123'),
      phone: '+91 98765 44444'
    }
  ];
  for (const u of usersList) await db.insert('users', u);

  // User Roles mapping
  await db.insert('user_roles', { user_id: 'usr_admin_1', role_id: 'role_admin' });
  await db.insert('user_roles', { user_id: 'usr_customer_1', role_id: 'role_customer' });
  await db.insert('user_roles', { user_id: 'usr_owner_1', role_id: 'role_owner' });
  await db.insert('user_roles', { user_id: 'usr_kitchen_1', role_id: 'role_kitchen' });
  await db.insert('user_roles', { user_id: 'usr_rider_1', role_id: 'role_rider' });

  // 3. Customer Delivery Addresses
  const address1 = await db.insert('addresses', {
    id: 'addr_cust_1',
    user_id: 'usr_customer_1',
    title: 'Apartment 4B',
    street: 'Sector 21, Gandhinagar Highway',
    city: 'Ahmedabad',
    postal_code: '382421',
    latitude: 23.1293,
    longitude: 72.5448,
    is_default: true
  });
  await db.insert('addresses', {
    id: 'addr_cust_2',
    user_id: 'usr_customer_1',
    title: 'Tech Park Office',
    street: 'Nirma University Road',
    city: 'Ahmedabad',
    postal_code: '382481',
    latitude: 23.1287,
    longitude: 72.5435,
    is_default: false
  });

  // 4. Restaurants
  const restaurantsList = [
    {
      id: 'rest_burger_1',
      name: 'The Gourmet Burger Co.',
      description: 'Handcrafted smash burgers, brioche buns, and seasoned truffle fries.',
      cuisine: 'American / Fast Food',
      address: 'Shop 12, High Street Galleria',
      latitude: 23.1250,
      longitude: 72.5400,
      rating: 4.85,
      is_active: true,
      is_open: true,
      opening_time: '11:00',
      closing_time: '23:30'
    },
    {
      id: 'rest_pizza_2',
      name: 'Bella Napoli Pizzeria',
      description: 'Neapolitan style wood-fired pizzas made with Italian San Marzano tomatoes.',
      cuisine: 'Italian',
      address: 'Corner Block 4, Heritage Arcade',
      latitude: 23.1320,
      longitude: 72.5460,
      rating: 4.90,
      is_active: true,
      is_open: true,
      opening_time: '12:00',
      closing_time: '23:00'
    },
    {
      id: 'rest_curry_3',
      name: 'Spice Symphony',
      description: 'Authentic royal Biryanis, rich buttery curries, and clay-oven tandoor delights.',
      cuisine: 'Indian',
      address: 'Grand Avenue Mall, 2nd Floor',
      latitude: 23.1275,
      longitude: 72.5415,
      rating: 4.75,
      is_active: true,
      is_open: true,
      opening_time: '11:30',
      closing_time: '23:00'
    },
    {
      id: 'rest_sushi_4',
      name: 'Tokyo Sushi Express',
      description: 'Fresh salmon nigiri, dragon rolls, steaming miso soup, and tonkotsu ramen.',
      cuisine: 'Japanese',
      address: 'Cyber Hub Food Plaza',
      latitude: 23.1350,
      longitude: 72.5480,
      rating: 4.65,
      is_active: true,
      is_open: true,
      opening_time: '12:00',
      closing_time: '22:30'
    }
  ];
  for (const r of restaurantsList) await db.insert('restaurants', r);

  // 5. Kitchens
  for (const r of restaurantsList) {
    await db.insert('kitchens', {
      id: `kitchen_${r.id}`,
      restaurant_id: r.id,
      capacity: 12,
      current_active_orders: 1,
      is_accepting_orders: true
    });
  }

  // 6. Menu Categories and Items
  // Burger Co Menu
  const catBurger1 = await db.insert('menu_categories', {
    id: 'cat_b1',
    restaurant_id: 'rest_burger_1',
    name: 'Signature Burgers',
    display_order: 1
  });
  const catBurger2 = await db.insert('menu_categories', {
    id: 'cat_b2',
    restaurant_id: 'rest_burger_1',
    name: 'Sides & Shakes',
    display_order: 2
  });

  const burgerItems = [
    {
      id: 'item_b1',
      restaurant_id: 'rest_burger_1',
      category_id: catBurger1.id,
      name: 'Truffle Angus Burger',
      description: 'Double Angus beef patty, truffle aioli, aged cheddar, caramelized onions.',
      price: 349.00,
      is_available: true,
      is_veg: false,
      prep_time_minutes: 15,
      image_url: 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500'
    },
    {
      id: 'item_b2',
      restaurant_id: 'rest_burger_1',
      category_id: catBurger1.id,
      name: 'Crispy Paneer Royale',
      description: 'Spiced cottage cheese patty, chipotle slaw, pickled jalapeños on brioche.',
      price: 279.00,
      is_available: true,
      is_veg: true,
      prep_time_minutes: 12,
      image_url: 'https://images.unsplash.com/photo-1550547660-d9450f859349?w=500'
    },
    {
      id: 'item_b3',
      restaurant_id: 'rest_burger_1',
      category_id: catBurger2.id,
      name: 'Loaded Truffle Parmesan Fries',
      description: 'Crispy skin-on potato fries tossed with black truffle oil and parmesan.',
      price: 189.00,
      is_available: true,
      is_veg: true,
      prep_time_minutes: 8,
      image_url: 'https://images.unsplash.com/photo-1576107232684-1279f3908594?w=500'
    },
    {
      id: 'item_b4',
      restaurant_id: 'rest_burger_1',
      category_id: catBurger2.id,
      name: 'Belgian Chocolate Thickshake',
      description: 'Rich dark Belgian cocoa blended with whole milk and vanilla ice cream.',
      price: 199.00,
      is_available: true,
      is_veg: true,
      prep_time_minutes: 5,
      image_url: 'https://images.unsplash.com/photo-1572490122747-3968b75cc699?w=500'
    }
  ];
  for (const item of burgerItems) await db.insert('menu_items', item);

  // Pizza Menu
  const catPizza1 = await db.insert('menu_categories', {
    id: 'cat_p1',
    restaurant_id: 'rest_pizza_2',
    name: 'Wood-Fired Pizzas',
    display_order: 1
  });
  const pizzaItems = [
    {
      id: 'item_p1',
      restaurant_id: 'rest_pizza_2',
      category_id: catPizza1.id,
      name: 'Margherita D.O.P.',
      description: 'San Marzano tomatoes, fresh buffalo mozzarella, fresh basil, extra virgin olive oil.',
      price: 429.00,
      is_available: true,
      is_veg: true,
      prep_time_minutes: 14,
      image_url: 'https://images.unsplash.com/photo-1604382355076-af4b0eb60143?w=500'
    },
    {
      id: 'item_p2',
      restaurant_id: 'rest_pizza_2',
      category_id: catPizza1.id,
      name: 'Quattro Formaggi',
      description: 'Mozzarella, Gorgonzola dolce, Fontina, and Parmigiano-Reggiano on garlic herb crust.',
      price: 499.00,
      is_available: true,
      is_veg: true,
      prep_time_minutes: 16,
      image_url: 'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=500'
    }
  ];
  for (const item of pizzaItems) await db.insert('menu_items', item);

  // Indian Spice Symphony Menu
  const catIndian1 = await db.insert('menu_categories', {
    id: 'cat_i1',
    restaurant_id: 'rest_curry_3',
    name: 'Biryanis & Curries',
    display_order: 1
  });
  const indianItems = [
    {
      id: 'item_i1',
      restaurant_id: 'rest_curry_3',
      category_id: catIndian1.id,
      name: 'Hyderabadi Dum Biryani (Paneer)',
      description: 'Slow-cooked fragrant basmati rice with marinated paneer, saffron, and mint.',
      price: 320.00,
      is_available: true,
      is_veg: true,
      prep_time_minutes: 18,
      image_url: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=500'
    },
    {
      id: 'item_i2',
      restaurant_id: 'rest_curry_3',
      category_id: catIndian1.id,
      name: 'Butter Chicken Masala',
      description: 'Tender chicken tikka simmered in silky tomato, cashew, and makhani gravy.',
      price: 380.00,
      is_available: true,
      is_veg: false,
      prep_time_minutes: 20,
      image_url: 'https://images.unsplash.com/photo-1588166524941-3bf61a9c41db?w=500'
    }
  ];
  for (const item of indianItems) await db.insert('menu_items', item);

  // 7. Delivery Partners
  await db.insert('delivery_partners', {
    id: 'rider_alex_1',
    user_id: 'usr_rider_1',
    vehicle_type: 'MOTORCYCLE',
    is_available: true,
    current_latitude: 23.1260,
    current_longitude: 72.5420,
    rating: 4.88,
    active_deliveries: 0
  });

  // 8. Sample Seed Order demonstrating the full state machine and logs
  const sampleOrder = await db.insert('orders', {
    id: 'ord_demo_1001',
    idempotency_key: 'idem_seed_demo_order',
    user_id: 'usr_customer_1',
    restaurant_id: 'rest_burger_1',
    delivery_address_id: address1.id,
    subtotal: 538.00,
    tax: 26.90,
    delivery_fee: 40.00,
    discount: 0.00,
    total_amount: 604.90,
    payment_method: 'ONLINE_SIMULATED',
    status: ORDER_STATUS.PREPARING,
    estimated_prep_time: 15,
    special_instructions: 'Please ring bell upon delivery'
  });

  await db.insert('order_items', {
    id: 'item_ord_1',
    order_id: sampleOrder.id,
    menu_item_id: 'item_b1',
    item_name: 'Truffle Angus Burger',
    quantity: 1,
    unit_price: 349.00,
    total_price: 349.00
  });

  await db.insert('order_items', {
    id: 'item_ord_2',
    order_id: sampleOrder.id,
    menu_item_id: 'item_b3',
    item_name: 'Loaded Truffle Parmesan Fries',
    quantity: 1,
    unit_price: 189.00,
    total_price: 189.00
  });

  // Status transitions history
  await db.insert('order_status_history', {
    id: 'hist_1',
    order_id: sampleOrder.id,
    from_status: null,
    to_status: ORDER_STATUS.CREATED,
    changed_by: 'usr_customer_1',
    comments: 'Customer initialized order checkout'
  });
  await db.insert('order_status_history', {
    id: 'hist_2',
    order_id: sampleOrder.id,
    from_status: ORDER_STATUS.CREATED,
    to_status: ORDER_STATUS.PAYMENT_CONFIRMED,
    changed_by: 'payment_gateway',
    comments: 'Online payment simulation completed successfully'
  });
  await db.insert('order_status_history', {
    id: 'hist_3',
    order_id: sampleOrder.id,
    from_status: ORDER_STATUS.PAYMENT_CONFIRMED,
    to_status: ORDER_STATUS.PLACED,
    changed_by: 'order_service',
    comments: 'Order routed to kitchen queue'
  });
  await db.insert('order_status_history', {
    id: 'hist_4',
    order_id: sampleOrder.id,
    from_status: ORDER_STATUS.PLACED,
    to_status: ORDER_STATUS.RESTAURANT_ACCEPTED,
    changed_by: 'kitchen_manager',
    comments: 'Kitchen accepted order'
  });
  await db.insert('order_status_history', {
    id: 'hist_5',
    order_id: sampleOrder.id,
    from_status: ORDER_STATUS.RESTAURANT_ACCEPTED,
    to_status: ORDER_STATUS.PREPARING,
    changed_by: 'usr_kitchen_1',
    comments: 'Cook Gordon started preparation'
  });

  // Kitchen queue entry for sample order
  await db.insert('kitchen_queues', {
    id: 'kq_demo_1',
    kitchen_id: 'kitchen_rest_burger_1',
    order_id: sampleOrder.id,
    priority: 2,
    progress_percentage: 65,
    assigned_cook: 'Chef Gordon',
    status: 'PREPARING',
    locked_by: 'usr_kitchen_1',
    started_at: new Date(Date.now() - 8 * 60 * 1000).toISOString()
  });

  // Simulated Payment record
  await db.insert('payments', {
    id: 'pay_demo_1001',
    order_id: sampleOrder.id,
    idempotency_key: 'idem_pay_1001',
    amount: 604.90,
    currency: 'INR',
    method: 'ONLINE_SIMULATED',
    status: 'COMPLETED',
    transaction_reference: 'TXN_SIM_20261113_99412'
  });

  console.log('✅ Database seeded successfully with demo restaurants, menus, users, and orders.');
}

// CLI: `node database/seed/seed.js [--force]`  (used by the one-shot `db-seed` container)
// Seeds only an EMPTY database unless --force is given, so restarts never wipe live data.
if (isMain(import.meta.url)) {
  (async () => {
    try {
      await db.connect();
      const users = await db.findMany('users', {}, { limit: 1 });
      if (users.length > 0 && !process.argv.includes('--force')) {
        console.log('Database already seeded; nothing to do (use --force to reset).');
      } else {
        await seedDatabase();
      }
      await db.close();
      process.exit(0);
    } catch (err) {
      console.error('Seeding failed:', err.message);
      process.exit(1);
    }
  })();
}
