const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

// Serve static files from the root directory
app.use(express.static(__dirname));

// Serve data_catalog_gemini.html as the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'data_catalog_gemini.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
