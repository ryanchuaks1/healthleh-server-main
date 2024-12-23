const express = require("express");
const bodyParser = require("body-parser");
const sql = require("mssql");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(bodyParser.json());

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
        encrypt: true, // For Azure
        trustServerCertificate: false, // Change to true for local dev/testing
    },
};

app.get("/", (req, res) => {
    res.send("Server is running!");
});

// Test endpoint
app.get("/test-connection", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().query("SELECT TOP 1 * FROM users");
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("SQL Error:", error);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
