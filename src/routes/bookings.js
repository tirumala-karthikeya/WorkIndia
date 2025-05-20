const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { auth } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// Book a seat
router.post('/',
    auth,
    [
        body('train_id').isInt(),
        body('from_station_id').isInt(),
        body('to_station_id').isInt(),
        body('booking_date').isDate()
    ],
    async (req, res) => {
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { train_id, from_station_id, to_station_id, booking_date } = req.body;
            const user_id = req.user.id;

            // Get train details including fare
            const [train] = await connection.query(
                'SELECT * FROM trains WHERE id = ? FOR UPDATE',
                [train_id]
            );

            if (train.length === 0) {
                await connection.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Train not found'
                });
            }

            // Check user's existing bookings for this train
            const [userBookings] = await connection.query(`
                SELECT id, seats_booked
                FROM bookings
                WHERE train_id = ?
                AND booking_date = ?
                AND booking_status = 'confirmed'
                AND user_id = ?
                AND from_station_id = ?
                AND to_station_id = ?
            `, [train_id, booking_date, user_id, from_station_id, to_station_id]);

            // Calculate seats booked by this user
            const userSeatsBooked = userBookings.length > 0 ? userBookings[0].seats_booked : 0;
            const newSeatsBooked = userSeatsBooked + 1;

            // Check total seat availability
            const [totalBookings] = await connection.query(`
                SELECT COUNT(*) as booked_seats
                FROM bookings
                WHERE train_id = ?
                AND booking_date = ?
                AND booking_status = 'confirmed'
                AND from_station_id = ?
                AND to_station_id = ?
            `, [train_id, booking_date, from_station_id, to_station_id]);

            const availableSeats = train[0].total_seats - totalBookings[0].booked_seats;

            if (availableSeats <= 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'No seats available'
                });
            }

            // Calculate total fare
            const total_fare = train[0].fare * newSeatsBooked;
            let bookingId;

            if (userBookings.length > 0) {
                // Update existing booking
                bookingId = userBookings[0].id;
                await connection.query(
                    'UPDATE bookings SET seats_booked = ?, total_fare = ? WHERE id = ?',
                    [newSeatsBooked, total_fare, bookingId]
                );
            } else {
                // Create new booking
                const [bookingResult] = await connection.query(
                    'INSERT INTO bookings (user_id, train_id, from_station_id, to_station_id, booking_date, booking_status, seats_booked, total_fare) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [user_id, train_id, from_station_id, to_station_id, booking_date, 'confirmed', newSeatsBooked, total_fare]
                );
                bookingId = bookingResult.insertId;
            }

            await connection.commit();

            res.status(201).json({
                success: true,
                message: 'Booking successful',
                booking_id: bookingId,
                seats_booked: newSeatsBooked,
                fare: train[0].fare,
                total_fare: total_fare
            });
        } catch (err) {
            await connection.rollback();
            console.error(err);
            res.status(500).json({
                success: false,
                message: 'Error creating booking'
            });
        } finally {
            connection.release();
        }
    }
);

// Get booking details
router.get('/:bookingId',
    auth,
    async (req, res) => {
        try {
            const { bookingId } = req.params;
            const userId = req.user.id;

            const [bookings] = await pool.query(`
                SELECT 
                    b.*,
                    t.train_number,
                    t.train_name,
                    t.fare as train_fare,
                    s1.station_name as from_station,
                    s2.station_name as to_station,
                    s1.station_code as from_station_code,
                    s2.station_code as to_station_code
                FROM bookings b
                JOIN trains t ON b.train_id = t.id
                JOIN stations s1 ON b.from_station_id = s1.id
                JOIN stations s2 ON b.to_station_id = s2.id
                WHERE b.id = ? AND b.user_id = ?
            `, [bookingId, userId]);

            if (bookings.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Booking not found'
                });
            }

            const booking = bookings[0];

            // Format the response
            const formattedBooking = {
                id: booking.id,
                train: {
                    id: booking.train_id,
                    number: booking.train_number,
                    name: booking.train_name,
                    fare: booking.train_fare
                },
                from_station: {
                    id: booking.from_station_id,
                    name: booking.from_station,
                    code: booking.from_station_code
                },
                to_station: {
                    id: booking.to_station_id,
                    name: booking.to_station,
                    code: booking.to_station_code
                },
                booking_date: booking.booking_date,
                seats_booked: booking.seats_booked,
                total_fare: booking.total_fare,
                booking_status: booking.booking_status,
                created_at: booking.created_at
            };

            res.json({
                success: true,
                booking: formattedBooking
            });
        } catch (err) {
            console.error('Error fetching booking details:', err);
            res.status(500).json({
                success: false,
                message: 'Error fetching booking details'
            });
        }
    }
);

// Get user's bookings
router.get('/user/bookings',
    auth,
    async (req, res) => {
        try {
            const userId = req.user.id;

            const [bookings] = await pool.query(`
                SELECT 
                    b.*,
                    t.train_number,
                    t.train_name,
                    t.fare as train_fare,
                    s1.station_name as from_station,
                    s2.station_name as to_station
                FROM bookings b
                JOIN trains t ON b.train_id = t.id
                JOIN stations s1 ON b.from_station_id = s1.id
                JOIN stations s2 ON b.to_station_id = s2.id
                WHERE b.user_id = ?
                ORDER BY b.booking_date DESC
            `, [userId]);

            // Update existing bookings with correct seats
            const updatedBookings = await Promise.all(bookings.map(async (booking) => {
                if (!booking.seats_booked || booking.seats_booked === 0) {
                    // Update the booking with correct seats_booked
                    await pool.query(
                        'UPDATE bookings SET seats_booked = ? WHERE id = ?',
                        [1, booking.id]
                    );
                }
                return {
                    ...booking,
                    seats_booked: booking.seats_booked || 1
                };
            }));

            res.json({
                success: true,
                bookings: updatedBookings
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                message: 'Error fetching bookings'
            });
        }
    }
);

// Cancel a booking
router.patch('/:bookingId/cancel',
    auth,
    [
        body('seats_to_cancel').optional().isInt({ min: 1 })
    ],
    async (req, res) => {
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                await connection.rollback();
                return res.status(400).json({ errors: errors.array() });
            }

            const { bookingId } = req.params;
            const userId = req.user.id;
            const seatsToCancel = req.body.seats_to_cancel || 1; // Default to 1 if not specified

            console.log('BookingId:', bookingId, 'UserId:', userId);

            // Check if booking exists and belongs to user
            const [bookings] = await connection.query(`
                SELECT b.*, t.fare
                FROM bookings b
                JOIN trains t ON b.train_id = t.id
                WHERE b.id = ? AND b.user_id = ? AND b.booking_status = 'confirmed'
            `, [bookingId, userId]);

            if (bookings.length === 0) {
                await connection.rollback();
                return res.status(404).json({
                    success: false,
                    message: 'Booking not found or already cancelled'
                });
            }

            const booking = bookings[0];
            const bookingDate = new Date(booking.booking_date);
            const now = new Date();

            // Check if booking can be cancelled (at least 24 hours before booking date)
            const hoursUntilBooking = (bookingDate - now) / (1000 * 60 * 60);
            if (hoursUntilBooking < 24) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Bookings can only be cancelled at least 24 hours before booking date'
                });
            }

            // Check if trying to cancel more seats than booked
            if (seatsToCancel > booking.seats_booked) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Cannot cancel more seats than booked. You have ${booking.seats_booked} seats booked.`
                });
            }

            const remainingSeats = booking.seats_booked - seatsToCancel;
            const refundAmount = seatsToCancel * booking.fare;

            if (remainingSeats === 0) {
                // If all seats are being cancelled, update booking status to cancelled
                await connection.query(
                    'UPDATE bookings SET booking_status = ? WHERE id = ?',
                    ['cancelled', bookingId]
                );
            } else {
                // Update the booking with remaining seats and new total fare
                await connection.query(
                    'UPDATE bookings SET seats_booked = ?, total_fare = ? WHERE id = ?',
                    [remainingSeats, remainingSeats * booking.fare, bookingId]
                );
            }

            await connection.commit();

            res.json({
                success: true,
                message: seatsToCancel === booking.seats_booked ? 
                    'Booking cancelled successfully' : 
                    `${seatsToCancel} seat(s) cancelled successfully`,
                booking_id: bookingId,
                remaining_seats: remainingSeats,
                refund_amount: refundAmount
            });
        } catch (err) {
            await connection.rollback();
            console.error(err);
            res.status(500).json({
                success: false,
                message: 'Error cancelling booking'
            });
        } finally {
            connection.release();
        }
    }
);

module.exports = router; 