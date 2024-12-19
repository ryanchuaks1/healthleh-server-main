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

app.post("/api/users", async (req, res) => {
    const { username, email } = req.body;
    try {
        const pool = await sql.connect(config);
        const result = await pool
            .request()
            .input("username", sql.VarChar, username)
            .input("email", sql.VarChar, email)
            .query("INSERT INTO Users (Username, Email) VALUES (@username, @email)");
        res.status(200).send({ message: "User added successfully!", result });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
