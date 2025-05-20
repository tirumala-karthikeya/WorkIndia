const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { auth } = require('../middleware/auth');
const { body, validationResult, query } = require('express-validator');

// Book a seat
router.post('/',
    auth,
    [
        body('train_id').isInt(),
        body('from_station_id').isInt(),
        body('to_station_id').isInt(),
        body('booking_date').isDate(),
        body('selected_seats').isArray().notEmpty(),
        body('selected_seats.*').isInt()
    ],
    async (req, res) => {
        const connection = await pool.getConnection();
        await connection.beginTransaction();

        try {
            const { train_id, from_station_id, to_station_id, booking_date, selected_seats } = req.body;
            const user_id = req.user.id;

            // Lock only the selected seats for the given date
            const [seats] = await connection.query(`
                SELECT s.*, sb.id as booking_id
                FROM seats s
                LEFT JOIN seat_bookings sb ON s.id = sb.seat_id 
                    AND sb.booking_date = ? 
                    AND sb.status = 'booked'
                WHERE s.train_id = ? 
                AND s.id IN (?)
                FOR UPDATE
            `, [booking_date, train_id, selected_seats]);

            // Check if any of the selected seats are already booked
            const alreadyBookedSeats = seats.filter(seat => seat.booking_id !== null);
            if (alreadyBookedSeats.length > 0) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: `Seats ${alreadyBookedSeats.map(s => s.seat_number).join(', ')} are already booked`
                });
            }

            // Get train details for fare calculation
            const [train] = await connection.query(
                'SELECT * FROM trains WHERE id = ?',
                [train_id]
            );

            // Calculate total fare
            const total_fare = train[0].fare * selected_seats.length;

            // Create the main booking
            const [bookingResult] = await connection.query(
                'INSERT INTO bookings (user_id, train_id, from_station_id, to_station_id, booking_date, booking_status, total_fare) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [user_id, train_id, from_station_id, to_station_id, booking_date, 'confirmed', total_fare]
            );

            const bookingId = bookingResult.insertId;

            // Book each selected seat
            for (const seatId of selected_seats) {
                await connection.query(
                    'INSERT INTO seat_bookings (booking_id, seat_id, booking_date) VALUES (?, ?, ?)',
                    [bookingId, seatId, booking_date]
                );
            }

            await connection.commit();

            res.status(201).json({
                success: true,
                message: 'Booking successful',
                booking_id: bookingId,
                seats_booked: selected_seats.length,
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

// Get seat availability
router.get('/seats/availability',
    auth,
    [
        query('train_id').isInt(),
        query('booking_date').isDate()
    ],
    async (req, res) => {
        try {
            const { train_id, booking_date } = req.query;

            const [seats] = await pool.query(`
                SELECT 
                    s.id,
                    s.seat_number,
                    s.seat_type,
                    CASE 
                        WHEN sb.id IS NOT NULL THEN 'booked'
                        ELSE 'available'
                    END as status
                FROM seats s
                LEFT JOIN seat_bookings sb ON s.id = sb.seat_id 
                    AND sb.booking_date = ? 
                    AND sb.status = 'booked'
                WHERE s.train_id = ?
                ORDER BY CAST(SUBSTRING(s.seat_number, 2) AS UNSIGNED)
            `, [booking_date, train_id]);

            res.json({
                success: true,
                seats: seats
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                message: 'Error fetching seat availability'
            });
        }
    }
);

module.exports = router; 