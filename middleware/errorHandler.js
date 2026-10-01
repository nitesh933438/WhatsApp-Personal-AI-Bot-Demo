module.exports = (err, req, res, next) => {
    console.error(err);

    if (
        err.name === 'MongooseError' ||
        err.name === 'MongoNetworkError' ||
        err.name === 'MongoServerSelectionError' ||
        (err.message && err.message.includes('buffering timed out'))
    ) {
        console.warn('[AI Studio] Database offline — returning mock fallback response');
        if (req.method === 'GET') {
            return res.json({
                success: true,
                data: req.path.endsWith('s') || req.path.endsWith('s/') ? [] : {},
                offline: true
            });
        }
        return res.status(503).json({
            success: false,
            message: 'Service temporarily unavailable (database offline)'
        });
    }

    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error"
    });
};