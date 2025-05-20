const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'No authentication token, access denied'
            });
        }

        const verified = jwt.verify(token, process.env.JWT_SECRET);
        req.user = verified;
        next();
    } catch (err) {
        res.status(401).json({
            success: false,
            message: 'Token verification failed, authorization denied'
        });
    }
};

const adminAuth = (req, res, next) => {
    try {
        const apiKey = req.header('X-Admin-API-Key');
        
        if (!apiKey || apiKey !== process.env.ADMIN_API_KEY) {
            return res.status(401).json({
                success: false,
                message: 'Invalid admin API key'
            });
        }
        
        next();
    } catch (err) {
        res.status(401).json({
            success: false,
            message: 'Admin authentication failed'
        });
    }
};

module.exports = { auth, adminAuth }; 