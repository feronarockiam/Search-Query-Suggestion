const express = require('express');
const path = require('path');
const { query } = require('./queryEngine');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Suggestion API Endpoint
app.get('/api/suggest', async (req, res) => {
    try {
        const q = req.query.q || '';
        const result = await query(q);
        res.json(result);
    } catch (error) {
        console.error('Search API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.listen(PORT, async () => {
    console.log(`[ACS UI] Server running at http://localhost:${PORT}`);
});
