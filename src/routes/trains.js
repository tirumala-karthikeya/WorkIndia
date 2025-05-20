const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { adminAuth, auth } = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// Add new train (Admin only)
router.post('/',
    adminAuth,
    [
        body('train_number').notEmpty(),
        body('train_name').notEmpty(),
        body('total_seats').isInt({ min: 1 }),
        body('stations').isArray({ min: 2 }),
        body('base_fare').isFloat({ min: 0 }).optional(),
        body('journey_date').isISO8601().toDate()
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { train_number, train_name, total_seats, stations, base_fare = 100, journey_date } = req.body;

            // Start transaction
            const connection = await pool.getConnection();
            await connection.beginTransaction();

            try {
                // Insert train with base fare and journey_date
                const [trainResult] = await connection.query(
                    'INSERT INTO trains (train_number, train_name, total_seats, fare, journey_date) VALUES (?, ?, ?, ?, ?)',
                    [train_number, train_name, total_seats, base_fare, journey_date]
                );

                const trainId = trainResult.insertId;

                // Generate seat data (example: 10 seats, alternating window/aisle)
                const seatTypes = ['window', 'aisle'];
                const seatInserts = [];
                for (let i = 1; i <= total_seats; i++) {
                    const seatNumber = `A${i}`;
                    const seatType = seatTypes[i % 2];
                    seatInserts.push([trainId, seatNumber, seatType]);
                }

                // Bulk insert seats
                await connection.query(
                    'INSERT INTO seats (train_id, seat_number, seat_type) VALUES ?',
                    [seatInserts]
                );

                // Insert stations and routes
                for (let i = 0; i < stations.length; i++) {
                    const station = stations[i];
                    
                    // Insert station if not exists
                    const [stationResult] = await connection.query(
                        'INSERT IGNORE INTO stations (station_name, station_code) VALUES (?, ?)',
                        [station.name, station.code]
                    );

                    const stationId = stationResult.insertId || 
                        (await connection.query('SELECT id FROM stations WHERE station_code = ?', [station.code]))[0][0].id;

                    // Insert route
                    await connection.query(
                        'INSERT INTO train_routes (train_id, station_id, sequence_number, arrival_time, departure_time) VALUES (?, ?, ?, ?, ?)',
                        [trainId, stationId, i + 1, station.arrival_time, station.departure_time]
                    );
                }

                await connection.commit();
                res.status(201).json({
                    success: true,
                    message: 'Train added successfully',
                    train_id: trainId,
                    base_fare: base_fare,
                    journey_date: journey_date
                });
            } catch (err) {
                await connection.rollback();
                throw err;
            } finally {
                connection.release();
            }
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                message: 'Error adding train'
            });
        }
    }
);

// Get trains between stations using station IDs and correct route order
router.get('/search', async (req, res) => {
    console.log('Query params:', req.query);
    try {
        const { from_station_id, to_station_id, date } = req.query;

        if (!from_station_id || !to_station_id || !date) {
            return res.status(400).json({
                success: false,
                message: 'Missing required parameters'
            });
        }

        // Find trains that have both from_station_id and to_station_id in their route, with correct order
        const [trains] = await pool.query(`
            SELECT 
                t.id,
                t.train_number,
                t.train_name,
                t.total_seats,
                t.fare,
                s1.station_name as from_station,
                s2.station_name as to_station,
                tr1.departure_time as departure_time,
                tr2.arrival_time as arrival_time,
                (
                    SELECT COUNT(*)
                    FROM bookings b
                    WHERE b.train_id = t.id
                    AND b.booking_date = ?
                    AND b.booking_status = 'confirmed'
                    AND b.from_station_id = ?
                    AND b.to_station_id = ?
                ) as booked_seats
            FROM trains t
            JOIN train_routes tr1 ON t.id = tr1.train_id AND tr1.station_id = ?
            JOIN train_routes tr2 ON t.id = tr2.train_id AND tr2.station_id = ?
            JOIN stations s1 ON tr1.station_id = s1.id
            JOIN stations s2 ON tr2.station_id = s2.id
            WHERE tr1.sequence_number < tr2.sequence_number
            GROUP BY t.id, t.train_number, t.train_name, t.total_seats, t.fare,
                     s1.station_name, s2.station_name, tr1.departure_time, tr2.arrival_time
            HAVING (t.total_seats - booked_seats) > 0
        `, [date, from_station_id, to_station_id, from_station_id, to_station_id]);

        const trainsWithAvailability = trains.map(train => ({
            ...train,
            available_seats: train.total_seats - (train.booked_seats || 0)
        }));

        res.json({
            success: true,
            trains: trainsWithAvailability
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Error searching trains'
        });
    }
});

// Update train seats (Admin only)
router.patch('/:trainId/seats',
    adminAuth,
    [
        body('total_seats').isInt({ min: 1 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { trainId } = req.params;
            const { total_seats } = req.body;

            const [result] = await pool.query(
                'UPDATE trains SET total_seats = ? WHERE id = ?',
                [total_seats, trainId]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Train not found'
                });
            }

            res.json({
                success: true,
                message: 'Train seats updated successfully'
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                message: 'Error updating train seats'
            });
        }
    }
);

// Update train fare (Admin only)
router.patch('/:trainId/fare',
    adminAuth,
    [
        body('fare').isFloat({ min: 0 })
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { trainId } = req.params;
            const { fare } = req.body;

            const [result] = await pool.query(
                'UPDATE trains SET fare = ? WHERE id = ?',
                [fare, trainId]
            );

            if (result.affectedRows === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Train not found'
                });
            }

            res.json({
                success: true,
                message: 'Train fare updated successfully'
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({
                success: false,
                message: 'Error updating train fare'
            });
        }
    }
);

// Get all trains (Admin only)
router.get('/',
    adminAuth,
    async (req, res) => {
        try {
            const [trains] = await pool.query(`
                WITH FirstLastStations AS (
                    SELECT 
                        t.id,
                        t.train_number,
                        t.train_name,
                        t.total_seats,
                        t.fare,
                        t.created_at,
                        MIN(tr.sequence_number) as first_seq,
                        MAX(tr.sequence_number) as last_seq
                    FROM trains t
                    JOIN train_routes tr ON t.id = tr.train_id
                    GROUP BY t.id
                )
                SELECT 
                    f.*,
                    s1.station_name as from_station,
                    s1.station_code as from_station_code,
                    tr1.departure_time,
                    s2.station_name as to_station,
                    s2.station_code as to_station_code,
                    tr2.arrival_time,
                    (
                        SELECT GROUP_CONCAT(
                            CONCAT(s.station_name, ' (', s.station_code, ')')
                            ORDER BY tr.sequence_number
                            SEPARATOR ' -> '
                        )
                        FROM train_routes tr
                        JOIN stations s ON tr.station_id = s.id
                        WHERE tr.train_id = f.id
                    ) as route,
                    (
                        SELECT COUNT(*)
                        FROM bookings b
                        WHERE b.train_id = f.id
                        AND b.booking_status = 'confirmed'
                    ) as booked_seats
                FROM FirstLastStations f
                JOIN train_routes tr1 ON f.id = tr1.train_id AND tr1.sequence_number = f.first_seq
                JOIN stations s1 ON tr1.station_id = s1.id
                JOIN train_routes tr2 ON f.id = tr2.train_id AND tr2.sequence_number = f.last_seq
                JOIN stations s2 ON tr2.station_id = s2.id
            `);

            const trainsWithAvailability = trains.map(train => ({
                ...train,
                available_seats: train.total_seats - (train.booked_seats || 0)
            }));

            res.json({ 
                success: true, 
                trains: trainsWithAvailability 
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ 
                success: false, 
                message: 'Error fetching trains',
                error: err.message 
            });
        }
    }
);

// Get train by ID
router.get('/:trainId', async (req, res) => {
    try {
        const { trainId } = req.params;

        const [trains] = await pool.query(`
            SELECT 
                t.*,
                GROUP_CONCAT(
                    CONCAT(s.station_name, ' (', s.station_code, ')')
                    ORDER BY tr.sequence_number
                    SEPARATOR ' -> '
                ) as route
            FROM trains t
            LEFT JOIN train_routes tr ON t.id = tr.train_id
            LEFT JOIN stations s ON tr.station_id = s.id
            WHERE t.id = ?
            GROUP BY t.id
        `, [trainId]);

        if (trains.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Train not found'
            });
        }

        res.json({
            success: true,
            train: trains[0]
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Error fetching train details'
        });
    }
});

// Get train by train number
router.get('/number/:trainNumber', async (req, res) => {
    try {
        const { trainNumber } = req.params;
        console.log('Searching for train number:', trainNumber);

        // First get the train details with first and last stations
        const [trains] = await pool.query(`
            WITH FirstLastStations AS (
                SELECT 
                    t.id,
                    t.train_number,
                    t.train_name,
                    t.total_seats,
                    t.fare,
                    t.created_at,
                    MIN(tr.sequence_number) as first_seq,
                    MAX(tr.sequence_number) as last_seq
                FROM trains t
                JOIN train_routes tr ON t.id = tr.train_id
                WHERE t.train_number = ?
                GROUP BY t.id
            )
            SELECT 
                f.*,
                s1.station_name as from_station,
                s1.station_code as from_station_code,
                tr1.departure_time,
                s2.station_name as to_station,
                s2.station_code as to_station_code,
                tr2.arrival_time,
                (
                    SELECT GROUP_CONCAT(
                        CONCAT(s.station_name, ' (', s.station_code, ')')
                        ORDER BY tr.sequence_number
                        SEPARATOR ' -> '
                    )
                    FROM train_routes tr
                    JOIN stations s ON tr.station_id = s.id
                    WHERE tr.train_id = f.id
                ) as route,
                (
                    SELECT COUNT(*)
                    FROM bookings b
                    WHERE b.train_id = f.id
                    AND b.booking_status = 'confirmed'
                ) as booked_seats
            FROM FirstLastStations f
            JOIN train_routes tr1 ON f.id = tr1.train_id AND tr1.sequence_number = f.first_seq
            JOIN stations s1 ON tr1.station_id = s1.id
            JOIN train_routes tr2 ON f.id = tr2.train_id AND tr2.sequence_number = f.last_seq
            JOIN stations s2 ON tr2.station_id = s2.id
        `, [trainNumber]);

        if (trains.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Train not found',
                searchedNumber: trainNumber
            });
        }

        const train = {
            ...trains[0],
            available_seats: trains[0].total_seats - (trains[0].booked_seats || 0)
        };

        res.json({
            success: true,
            train
        });
    } catch (err) {
        console.error('Error in train number search:', err);
        res.status(500).json({
            success: false,
            message: 'Error fetching train details',
            error: err.message
        });
    }
});

// Get all stations
router.get('/stations', async (req, res) => {
    try {
        const [stations] = await pool.query('SELECT id, station_name, station_code FROM stations');
        res.json({
            success: true,
            stations
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Error fetching stations'
        });
    }
});

// Get train routes
router.get('/routes', async (req, res) => {
    console.log("GET /api/trains/routes called");
    try {
        const [trains] = await pool.query(`
            SELECT 
                t.id,
                t.train_number,
                t.train_name,
                t.total_seats,
                t.fare,
                s1.station_name as from_station,
                s1.station_code as from_station_code,
                tr1.departure_time as from_departure_time,
                s2.station_name as to_station,
                s2.station_code as to_station_code,
                tr2.arrival_time as to_arrival_time,
                (
                    SELECT GROUP_CONCAT(
                        CONCAT(s.station_name, ' (', s.station_code, ')')
                        ORDER BY tr.sequence_number
                        SEPARATOR ' -> '
                    )
                    FROM train_routes tr
                    JOIN stations s ON tr.station_id = s.id
                    WHERE tr.train_id = t.id
                ) as route
            FROM trains t
            JOIN train_routes tr1 ON t.id = tr1.train_id
            JOIN train_routes tr2 ON t.id = tr2.train_id
            JOIN stations s1 ON tr1.station_id = s1.id
            JOIN stations s2 ON tr2.station_id = s2.id
            WHERE tr1.sequence_number = (
                SELECT MIN(sequence_number) FROM train_routes WHERE train_id = t.id
            )
            AND tr2.sequence_number = (
                SELECT MAX(sequence_number) FROM train_routes WHERE train_id = t.id
            )
            GROUP BY t.id
        `);

        res.json({
            success: true,
            trains
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({
            success: false,
            message: 'Error fetching train routes'
        });
    }
});

module.exports = router; 