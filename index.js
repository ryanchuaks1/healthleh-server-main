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

console.log("Environment Variables:");
console.log("DB_USER:", process.env.DB_USER);
console.log("DB_SERVER:", process.env.DB_SERVER);
console.log("DB_NAME:", process.env.DB_NAME);

// Root endpoint
app.get("/", (req, res) => {
    res.send("Server is running!");
});

// Create a new user
app.post("/api/users", async (req, res) => {
    const { phoneNumber, firstName, lastName, height, weight, weightGoal } =
        req.body;
    try {
        const pool = await sql.connect(config);
        await pool
            .request()
            .input("phoneNumber", sql.VarChar, phoneNumber)
            .input("firstName", sql.VarChar, firstName)
            .input("lastName", sql.VarChar, lastName)
            .input("height", sql.Float, height)
            .input("weight", sql.Float, weight)
            .input("weightGoal", sql.Float, weightGoal).query(`
          INSERT INTO Users (PhoneNumber, FirstName, LastName, Height, Weight, WeightGoal)
          VALUES (@phoneNumber, @firstName, @lastName, @height, @weight, @weightGoal)
        `);
        res.status(200).send({ message: "User added successfully!" });
    } catch (error) {
        console.error("Error adding user:", error);
        res.status(500).send({ error: error.message });
    }
});

// Get a user by Phone Number
app.get("/api/users/:phoneNumber", async (req, res) => {
    const { phoneNumber } = req.params;
    try {
        const pool = await sql.connect(config);
        const result = await pool
            .request()
            .input("phoneNumber", sql.VarChar, phoneNumber)
            .query("SELECT * FROM Users WHERE PhoneNumber = @phoneNumber");
        if (result.recordset.length > 0) {
            res.status(200).json(result.recordset[0]);
        } else {
            res.status(404).send({ message: "User not found" });
        }
    } catch (error) {
        console.error("Error fetching user:", error);
        res.status(500).send({ error: error.message });
    }
});

// Delete a user by Phone Number
app.delete("/api/users/:phoneNumber", async (req, res) => {
    const { phoneNumber } = req.params;
    try {
        const pool = await sql.connect(config);
        const result = await pool
            .request()
            .input("phoneNumber", sql.VarChar, phoneNumber)
            .query("DELETE FROM Users WHERE PhoneNumber = @phoneNumber");
        if (result.rowsAffected[0] > 0) {
            res.status(200).send({ message: "User deleted successfully!" });
        } else {
            res.status(404).send({ message: "User not found" });
        }
    } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).send({ error: error.message });
    }
});

app.get("/test-connection", async (req, res) => {
    try {
        const pool = await sql.connect(config);
        console.log("Database connection successful.");
        res.send("Connected to the database!");
    } catch (error) {
        console.error("Database connection failed:", error);
        res.status(500).send({ error: error.message });
    }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
