const User = require('../models/User');
const FoodItem = require('../models/FoodItem');
const Order = require('../models/Order');
const Message = require('../models/Message');
const mongoose = require('mongoose');
const { isValidCoordinate, isWithinJhang } = require('../utils/locationBounds');

const VOUCHERS = {
  WELCOME50: 50,
  PIZZALOVE: 30,
  BURGERDAY: 20,
};
const DELIVERY_CHARGE = 100;

const normalizeRestaurant = (restaurant) => {
  if (!restaurant) return null;
  if (typeof restaurant !== 'object') {
    return {
      id: restaurant.toString(),
      name: '',
      restaurantName: 'Restaurant',
      address: '',
      cuisineType: '',
      phone: '',
      restaurantImage: '',
    };
  }
  const obj = restaurant.toObject ? restaurant.toObject() : { ...restaurant };
  obj.id = obj._id?.toString() || obj.id || restaurant.toString?.() || '';
  obj.name = obj.name || '';
  obj.restaurantName = obj.restaurantName || obj.name || 'Restaurant';
  obj.address = obj.address || '';
  obj.cuisineType = obj.cuisineType || '';
  obj.phone = obj.phone || '';
  obj.restaurantImage = obj.restaurantImage || '';
  return obj;
};

const normalizeFoodItem = (item) => {
  const obj = item.toObject ? item.toObject() : { ...item };

  if (obj.restaurantId && typeof obj.restaurantId === 'object') {
    if (obj.restaurantId._id || obj.restaurantId.name || obj.restaurantId.restaurantName) {
      const restaurant = normalizeRestaurant(obj.restaurantId);
      obj.restaurantInfo = restaurant;
      obj.restaurantId = restaurant?.id || '';
    } else {
      obj.restaurantId = obj.restaurantId.toString();
    }
  }

  obj.id = obj._id?.toString() || obj.id || '';
  obj.restaurantId = obj.restaurantId ? obj.restaurantId.toString() : '';
  obj.name = obj.name || 'Food Item';
  obj.description = obj.description || '';
  obj.category = obj.category || 'Main Course';
  obj.imageUrl = obj.imageUrl || '';
  obj.price = Number.isFinite(Number(obj.price)) ? Number(obj.price) : 0;
  obj.isAvailable = obj.isAvailable !== false;

  if (obj.restaurantInfo) {
    obj.restaurantInfo = normalizeRestaurant(obj.restaurantInfo);
  }

  return obj;
};

// @desc    Get all food items (optionally filtered by category)
// @route   GET /api/customer/all-food
exports.getAllFoodItems = async (req, res) => {
  try {
    const { category, search } = req.query;
    const query = {};

    if (category) {
      query.category = { $regex: category, $options: 'i' };
    }
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const items = await FoodItem.find(query)
      .populate('restaurantId', 'restaurantName name address')
      .sort({ createdAt: -1 });

    const normalizedItems = items.map(normalizeFoodItem);

    res.json({
      success: true,
      count: normalizedItems.length,
      items: normalizedItems
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get all restaurants
// @route   GET /api/customer/restaurants
exports.getAllRestaurants = async (req, res) => {
  try {
    const restaurants = await User.find({
      role: 'restaurant',
    }).select('_id restaurantName name latitude longitude address cuisineType restaurantImage phone approvalStatus createdAt');

    // Add a virtual 'id' field for GSON compatibility in Android
    const allRestaurants = restaurants.map(r => {
      return normalizeRestaurant(r);
    });

    res.json({ success: true, count: allRestaurants.length, restaurants: allRestaurants });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get food items of a restaurant
// @route   GET /api/customer/restaurant/:id/menu
exports.getRestaurantMenu = async (req, res) => {
  try {
    console.log(`Fetching menu for restaurant: ${req.params.id}`);

    const restaurant = await User.findById(req.params.id).select('_id restaurantName name address phone cuisineType restaurantImage');
    if (!restaurant) {
      console.log('Restaurant not found');
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    // Find all food items for this restaurant. Removed isAvailable filter for debugging.
    const menu = await FoodItem.find({ restaurantId: req.params.id }).sort({ createdAt: -1 });
    const normalizedRestaurant = normalizeRestaurant(restaurant);
    const normalizedMenu = menu.map(item => {
      const normalized = normalizeFoodItem(item);
      normalized.restaurantInfo = normalizedRestaurant;
      normalized.restaurantId = normalizedRestaurant.id;
      return normalized;
    });

    console.log(`Found ${normalizedMenu.length} items for restaurant ${req.params.id}`);

    res.json({
      success: true,
      restaurant: normalizedRestaurant,
      menu: normalizedMenu,
      items: normalizedMenu // also sending as 'items' for flexibility
    });
  } catch (error) {
    console.error('Error in getRestaurantMenu:', error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Place order
// @route   POST /api/customer/order
exports.placeOrder = async (req, res) => {
  try {
    const { restaurantId, items, deliveryAddress, customerLatitude, customerLongitude, paymentMethod, notes, voucherCode } = req.body;
    if (!restaurantId || !items || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Restaurant and items required' });
    }
    if (!mongoose.Types.ObjectId.isValid(restaurantId)) {
      return res.status(400).json({ success: false, message: 'Invalid restaurant selected' });
    }

    const restaurant = await User.findOne({ _id: restaurantId, role: 'restaurant' }).select('_id restaurantName name address phone latitude longitude');
    if (!restaurant) {
      return res.status(404).json({ success: false, message: 'Restaurant not found' });
    }

    const cleanItems = items
      .filter(item => item && mongoose.Types.ObjectId.isValid(item.foodItemId) && Number(item.quantity) > 0)
      .map(item => ({
        foodItemId: item.foodItemId,
        name: item.name || 'Food Item',
        price: Number(item.price) || 0,
        quantity: Number(item.quantity) || 1,
      }));
    if (cleanItems.length === 0) {
      return res.status(400).json({ success: false, message: 'Valid food items required' });
    }

    const lat = Number(customerLatitude);
    const lng = Number(customerLongitude);
    if (!isValidCoordinate(lat, lng)) {
      return res.status(400).json({ success: false, message: 'Please fetch a valid delivery location before placing order' });
    }
    if (!isWithinJhang(lat, lng)) {
      return res.status(400).json({ success: false, message: 'Delivery is available only in Jhang, Punjab for now' });
    }
    const finalLatitude = lat;
    const finalLongitude = lng;
    const finalAddress = (deliveryAddress || req.user.address || '').trim();
    if (!finalAddress) {
      return res.status(400).json({ success: false, message: 'Delivery address required' });
    }
    if (paymentMethod && paymentMethod !== 'cash') {
      return res.status(400).json({ success: false, message: 'This payment method is coming soon. Please use Cash on Delivery.' });
    }

    const subtotalAmount = cleanItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const normalizedVoucher = String(voucherCode || '').trim().toUpperCase();
    const discountPercent = VOUCHERS[normalizedVoucher] || 0;
    const discountAmount = (subtotalAmount * discountPercent) / 100;
    const totalAmount = Math.max(subtotalAmount - discountAmount, 0) + DELIVERY_CHARGE;

    const order = await Order.create({
      customerId: req.user._id,
      restaurantId,
      items: cleanItems,
      subtotalAmount,
      discountAmount,
      deliveryCharge: DELIVERY_CHARGE,
      voucherCode: discountPercent > 0 ? normalizedVoucher : '',
      discountPercent,
      totalAmount,
      deliveryAddress: finalAddress,
      customerLatitude: finalLatitude,
      customerLongitude: finalLongitude,
      paymentMethod: paymentMethod === 'cash' ? 'cash' : 'cash',
      notes: notes || '',
    });

    const populatedOrder = await Order.findById(order._id)
      .populate('customerId', 'name phone address latitude longitude')
      .populate('restaurantId', 'restaurantName name address phone latitude longitude')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude');

    // Notify via socket
    const io = req.app.get('io');
    if (io) {
      io.to(`restaurant_${restaurantId}`).emit('new_order', populatedOrder);
    }

    res.status(201).json({ success: true, message: 'Order placed', order: populatedOrder });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get my orders
// @route   GET /api/customer/orders
exports.getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ customerId: req.user._id })
      .populate('customerId', 'name phone address latitude longitude')
      .populate('restaurantId', 'restaurantName name address')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude')
      .sort({ createdAt: -1 });
    res.json({ success: true, count: orders.length, orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Cancel/delete an order before restaurant accepts it
// @route   DELETE /api/customer/order/:id
exports.cancelPendingOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || order.customerId.toString() !== req.user._id.toString()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.status !== 'placed') {
      return res.status(409).json({
        success: false,
        message: 'This order has already been accepted and can no longer be cancelled here.',
      });
    }

    const orderId = order._id;
    const restaurantId = order.restaurantId;
    await Message.deleteMany({ orderId });
    await order.deleteOne();

    const io = req.app.get('io');
    if (io) {
      io.to(`order_${orderId}`).emit('order_cancelled', { orderId });
      io.to(`restaurant_${restaurantId}`).emit('order_cancelled', { orderId });
    }

    res.json({ success: true, message: 'Order cancelled and removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get order details with rider live location
// @route   GET /api/customer/order/:id
exports.getOrderDetails = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customerId', 'name phone address latitude longitude')
      .populate('restaurantId', 'restaurantName name address phone latitude longitude')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.customerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    res.json({ success: true, order });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Confirm received delivery
// @route   PUT /api/customer/order/:id/confirm-delivery
exports.confirmDelivery = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || order.customerId.toString() !== req.user._id.toString()) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    if (order.status !== 'delivered') {
      return res.status(409).json({ success: false, message: 'This order is not marked delivered yet.' });
    }

    order.deliveryConfirmed = true;
    order.deliveryConfirmedAt = new Date();
    order.paymentStatus = 'paid';
    await order.save();

    const populatedOrder = await Order.findById(order._id)
      .populate('customerId', 'name phone address latitude longitude')
      .populate('restaurantId', 'restaurantName name address phone latitude longitude')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude');

    const io = req.app.get('io');
    if (io) {
      io.to(`order_${order._id}`).emit('delivery_confirmed', { orderId: order._id });
      if (order.riderId) io.to(`rider_${order.riderId}`).emit('earnings_updated', { orderId: order._id });
      io.to(`restaurant_${order.restaurantId}`).emit('earnings_updated', { orderId: order._id });
    }

    res.json({ success: true, message: 'Delivery confirmed', order: populatedOrder });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get chat messages for an order
// @route   GET /api/customer/order/:id/messages
exports.getOrderMessages = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || order.customerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (!order.riderId) {
      return res.status(403).json({ success: false, message: 'Chat opens after a rider accepts your order' });
    }
    const messages = await Message.find({ orderId: req.params.id }).sort({ createdAt: 1 });
    res.json({ success: true, count: messages.length, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Send chat message
// @route   POST /api/customer/order/:id/messages
exports.sendMessage = async (req, res) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });
    const order = await Order.findById(req.params.id);
    if (!order || order.customerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (!order.riderId) {
      return res.status(403).json({ success: false, message: 'Chat opens after a rider accepts your order' });
    }

    const isFirstMessage = await Message.countDocuments({ orderId: req.params.id }) === 0;
    const msg = await Message.create({
      orderId: req.params.id,
      senderId: req.user._id,
      senderRole: req.user.role,
      message,
    });
    const payload = { ...msg.toObject(), firstMessage: isFirstMessage };

    const io = req.app.get('io');
    if (io) io.to(`order_${req.params.id}`).emit('new_message', payload);

    res.status(201).json({ success: true, message: payload, firstMessage: isFirstMessage });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
