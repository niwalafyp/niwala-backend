const Order = require('../models/Order');
const User = require('../models/User');
const Message = require('../models/Message');
const { isValidCoordinate, isWithinJhang } = require('../utils/locationBounds');

const RIDER_DELIVERY_FEE = 100;
const RIDER_ADMIN_COMMISSION_RATE = 0.03;
const RIDER_NET_RATE = 1 - RIDER_ADMIN_COMMISSION_RATE;

// @desc    Rider Dashboard
// @route   GET /api/rider/dashboard
exports.getDashboard = async (req, res) => {
  try {
    const riderId = req.user._id;
    const totalDeliveries = await Order.countDocuments({ riderId, status: 'delivered' });
    const activeOrders = await Order.find({
      riderId,
      status: { $in: ['accepted', 'preparing', 'ready', 'picked_up', 'on_the_way'] },
    }).sort({ updatedAt: -1 });
    const incomingOrders = await Order.countDocuments({
      riderId: null,
      declinedRiderIds: { $ne: riderId },
      status: { $in: ['accepted', 'preparing', 'ready'] },
    });

    const earnings = await Order.aggregate([
      { $match: { riderId: req.user._id, status: 'delivered' } },
      {
        $group: {
          _id: null,
          total: {
            $sum: {
              $multiply: [
                { $ifNull: ['$deliveryCharge', RIDER_DELIVERY_FEE] },
                RIDER_NET_RATE,
              ],
            },
          },
        },
      },
    ]);

    res.json({
      success: true,
      stats: {
        totalDeliveries,
        hasActiveOrder: activeOrders.length > 0,
        activeOrderId: activeOrders[0]?._id,
        activeOrders: activeOrders.length,
        incomingOrders,
        totalEarnings: earnings[0]?.total || (totalDeliveries * RIDER_DELIVERY_FEE * RIDER_NET_RATE),
        deliveryFee: RIDER_DELIVERY_FEE,
        isOnline: req.user.isOnline,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Toggle online status
// @route   PUT /api/rider/online
exports.toggleOnline = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.isOnline = !user.isOnline;
    await user.save();
    res.json({ success: true, isOnline: user.isOnline });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get incoming orders available to this rider
// @route   GET /api/rider/orders/incoming
exports.getIncomingOrders = async (req, res) => {
  try {
    const orders = await Order.find({
      riderId: null,
      declinedRiderIds: { $ne: req.user._id },
      status: { $in: ['ready', 'preparing', 'accepted'] },
    })
      .populate('restaurantId', 'restaurantName name address latitude longitude phone')
      .sort({ createdAt: -1 });

    // Hide customer personal info - only show delivery address & coords
    const sanitized = orders.map(o => {
      const obj = o.toObject();
      delete obj.customerId; // hide customer ID
      return obj;
    });

    res.json({ success: true, count: sanitized.length, orders: sanitized });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Accept an available order
// @route   PUT /api/rider/order/:id/accept
exports.acceptOrder = async (req, res) => {
  try {
    const riderId = req.user._id;
    const existing = await Order.findById(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Order not found' });
    if (existing.riderId?.toString() === riderId.toString()) {
      const assignedOrder = await Order.findById(existing._id)
        .populate('restaurantId', 'restaurantName name address latitude longitude phone')
        .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude');
      const obj = assignedOrder.toObject();
      delete obj.customerId;
      return res.json({ success: true, order: obj });
    }

    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        riderId: null,
        declinedRiderIds: { $ne: riderId },
        status: { $in: ['accepted', 'preparing', 'ready'] },
      },
      { $set: { riderId } },
      { new: true }
    )
      .populate('restaurantId', 'restaurantName name address latitude longitude phone')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude');

    if (!order) {
      return res.status(409).json({ success: false, message: 'Order is no longer available' });
    }

    const io = req.app.get('io');
    if (io) {
      io.to(`order_${order._id}`).emit('rider_assigned', { orderId: order._id, riderId });
      io.to(`order_${order._id}`).emit('order_status_update', { orderId: order._id, status: order.status });
      io.to(`rider_${riderId}`).emit('new_order_assigned', order);
    }

    const obj = order.toObject();
    delete obj.customerId;
    res.json({ success: true, order: obj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Decline an available order for this rider
// @route   PUT /api/rider/order/:id/decline
exports.declineOrder = async (req, res) => {
  try {
    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, riderId: null, status: { $in: ['accepted', 'preparing', 'ready'] } },
      { $addToSet: { declinedRiderIds: req.user._id } },
      { new: true }
    );
    if (!order) return res.status(404).json({ success: false, message: 'Order not available' });
    res.json({ success: true, message: 'Order declined' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get my active orders
// @route   GET /api/rider/orders/active
exports.getActiveOrder = async (req, res) => {
  try {
    const orders = await Order.find({
      riderId: req.user._id,
      status: { $in: ['accepted', 'preparing', 'ready', 'picked_up', 'on_the_way'] },
    })
      .populate('restaurantId', 'restaurantName name address latitude longitude phone')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude')
      .sort({ updatedAt: -1 });

    if (!orders.length) return res.json({ success: true, count: 0, order: null, orders: [] });

    // Hide customer info - only show delivery point
    const sanitized = orders.map(o => {
      const obj = o.toObject();
      delete obj.customerId;
      return obj;
    });
    res.json({ success: true, count: sanitized.length, order: sanitized[0], orders: sanitized });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get order history
// @route   GET /api/rider/orders/history
exports.getOrderHistory = async (req, res) => {
  try {
    const orders = await Order.find({
      riderId: req.user._id,
      status: { $in: ['delivered', 'cancelled'] },
    })
      .populate('restaurantId', 'restaurantName name address')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude')
      .sort({ updatedAt: -1 })
      .limit(50);

    const sanitized = orders.map(o => {
      const obj = o.toObject();
      delete obj.customerId;
      return obj;
    });

    res.json({ success: true, count: sanitized.length, orders: sanitized });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Get specific order details (for tracking screen)
// @route   GET /api/rider/order/:id
exports.getOrderDetails = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('restaurantId', 'restaurantName name address latitude longitude phone')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude');
    if (!order) return res.status(404).json({ success: false, message: 'Not found' });
    if (order.riderId?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    const obj = order.toObject();
    delete obj.customerId; // privacy
    res.json({ success: true, order: obj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update order status (pick up, deliver)
// @route   PUT /api/rider/order/:id/status
exports.updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['picked_up', 'on_the_way', 'delivered'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.riderId?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    order.status = status;
    await order.save();

    const populatedOrder = await Order.findById(order._id)
      .populate('restaurantId', 'restaurantName name address latitude longitude phone')
      .populate('riderId', 'name phone vehicleNumber currentLatitude currentLongitude');

    const io = req.app.get('io');
    if (io) {
      io.to(`order_${order._id}`).emit('order_status_update', {
        orderId: order._id,
        status,
        deliveryConfirmed: order.deliveryConfirmed,
      });
      if (status === 'delivered') {
        io.to(`customer_${order.customerId}`).emit('delivery_confirmation_required', {
          orderId: order._id,
          title: 'Niwala Admin',
          message: 'Your rider marked this order as delivered. Did you receive your order?',
        });
      }
    }

    const obj = populatedOrder.toObject();
    delete obj.customerId;
    res.json({ success: true, order: obj });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Update rider live location (called every few seconds)
// @route   PUT /api/rider/location
exports.updateLocation = async (req, res) => {
  try {
    const { latitude, longitude, orderId } = req.body;
    if (!isValidCoordinate(latitude, longitude)) {
      return res.status(400).json({ success: false, message: 'Valid rider location required' });
    }
    if (!isWithinJhang(latitude, longitude)) {
      return res.status(400).json({ success: false, message: 'Live tracking is available only in Jhang, Punjab for now' });
    }

    const rider = await User.findById(req.user._id);
    rider.currentLatitude = latitude;
    rider.currentLongitude = longitude;
    await rider.save();

    if (orderId) {
      const order = await Order.findById(orderId);
      if (order && order.riderId?.toString() === req.user._id.toString()) {
        order.riderCurrentLat = latitude;
        order.riderCurrentLng = longitude;
        await order.save();

        const io = req.app.get('io');
        if (io) {
          io.to(`order_${orderId}`).emit('rider_location_update', {
            orderId, latitude, longitude,
          });
        }
      }
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Send chat message (rider to customer)
// @route   POST /api/rider/order/:id/messages
exports.sendMessage = async (req, res) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ success: false, message: 'Message required' });

    const order = await Order.findById(req.params.id);
    if (!order || order.riderId?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Chat opens after you accept this order' });
    }
    const isFirstMessage = await Message.countDocuments({ orderId: req.params.id }) === 0;
    const msg = await Message.create({
      orderId: req.params.id,
      senderId: req.user._id,
      senderRole: 'rider',
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

// @desc    Get chat messages
// @route   GET /api/rider/order/:id/messages
exports.getMessages = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || order.riderId?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Chat opens after you accept this order' });
    }
    const messages = await Message.find({ orderId: req.params.id }).sort({ createdAt: 1 });
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
