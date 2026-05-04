const Message = require('../models/Message');
const Order = require('../models/Order');
const User = require('../models/User');
const { isValidCoordinate, isWithinJhang } = require('../utils/locationBounds');

const setupSocket = (io) => {
  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // Join order-specific room (for chat & tracking)
    socket.on('join_order', (orderId) => {
      socket.join(`order_${orderId}`);
      console.log(`Socket ${socket.id} joined order_${orderId}`);
    });

    // Join role-specific room (for notifications)
    socket.on('join_role', ({ role, userId }) => {
      socket.join(`${role}_${userId}`);
      console.log(`Socket ${socket.id} joined ${role}_${userId}`);
    });

    // Real-time chat message
    socket.on('send_message', async (data) => {
      try {
        const { orderId, senderId, senderRole } = data;
        const message = String(data.message || '').trim();
        if (!orderId || !senderId || !senderRole || !message) return;

        const isFirstMessage = await Message.countDocuments({ orderId }) === 0;
        const msg = await Message.create({ orderId, senderId, senderRole, message });
        io.to(`order_${orderId}`).emit('new_message', {
          ...msg.toObject(),
          firstMessage: isFirstMessage,
        });
      } catch (err) {
        console.error('Socket message error:', err);
      }
    });

    // Real-time location update from rider
    socket.on('rider_location', async (data) => {
      try {
        const { orderId, riderId, latitude, longitude } = data;
        if (!isValidCoordinate(latitude, longitude) || !isWithinJhang(latitude, longitude)) {
          return;
        }
        await User.findByIdAndUpdate(riderId, {
          currentLatitude: latitude,
          currentLongitude: longitude,
        });
        if (orderId) {
          await Order.findByIdAndUpdate(orderId, {
            riderCurrentLat: latitude,
            riderCurrentLng: longitude,
          });
          io.to(`order_${orderId}`).emit('rider_location_update', {
            orderId, latitude, longitude,
          });
        }
      } catch (err) {
        console.error('Socket location error:', err);
      }
    });

    // Order status broadcast
    socket.on('status_update', (data) => {
      io.to(`order_${data.orderId}`).emit('order_status_update', data);
    });

    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.id}`);
    });
  });
};

module.exports = setupSocket;
