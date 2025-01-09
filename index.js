const express = require("express");
const bodyParser = require("body-parser");
const sql = require("mssql");
const dotenv = require("dotenv");
const cors = require("cors");
const { Registry } = require("azure-iothub");

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(
    cors({
        origin: "*", // Relaxed for native apps
        methods: ["GET", "POST", "PUT", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
    })
);

const config = {
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
        encrypt: true, 
        trustServerCertificate: false,
    },
};

// IoT Hub Registry
const registry = Registry.fromConnectionString(process.env.IOT_HUB_CONNECTION_STRING);

// Root endpoint
app.get("/", (req, res) => {
    res.send("Server is running!");
});

// Create a new user
app.post("/api/users", async (req, res) => {
    const { phoneNumber, firstName, lastName, height, weight, weightGoal } = req.body;
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

// Route to add a device to IoT Hub and the database
app.post("/api/devices", async (req, res) => {
    const { deviceName, phoneNumber, deviceType, mode } = req.body;
    const deviceId = `device-${Date.now()}`;

    try {
        // Create the device in IoT Hub
        console.log("Creating device in IoT Hub...");
        const device = { deviceId };
        await registry.create(device);

        // Retrieve the connection string for the created device
        console.log("Fetching connection string for the device...");
        const result = await registry.get(deviceId);
        const { hostName } = connectionString.split(";")[0].split("=")[1];
        const generatedConnectionString = `HostName=${hostName};DeviceId=${deviceId};SharedAccessKey=${result.responseBody.authentication.symmetricKey.primaryKey}`;

        if (!hostName || !result.authentication.symmetricKey.primaryKey) {
            throw new Error("Failed to retrieve connection string for the device.");
        }

        // Insert into the database
        console.log("Inserting device into the database...");
        const pool = await sql.connect(config);
        await pool
            .request()
            .input("deviceId", sql.VarChar, deviceId)
            .input("deviceName", sql.VarChar, deviceName)
            .input("connectionString", sql.VarChar, generatedConnectionString)
            .input("deviceType", sql.VarChar, deviceType)
            .input("mode", sql.VarChar, mode)
            .input("phoneNumber", sql.VarChar, phoneNumber)
            .query(`
                INSERT INTO Devices (DeviceId, DeviceName, ConnectionString, DeviceType, Mode, PhoneNumber)
                VALUES (@deviceId, @deviceName, @connectionString, @deviceType, @mode, @phoneNumber)
            `);

        // Return the device details including the connection string
        console.log("Device successfully created.");
        res.status(201).json({
            message: "Device created successfully!",
            deviceId,
            connectionString: generatedConnectionString,
        });
    } catch (error) {
        console.error("Error creating device:", error);
        res.status(500).json({ error: "An error occurred while creating the device." });
    }
});


// Route to fetch all devices for a user
app.get("/api/devices/:phoneNumber", async (req, res) => {
    const { phoneNumber } = req.params;

    try {
        const pool = await sql.connect(config);
        const result = await pool
            .request()
            .input("phoneNumber", sql.VarChar, phoneNumber)
            .query("SELECT * FROM Devices WHERE PhoneNumber = @phoneNumber");

        res.status(200).json(result.recordset);
    } catch (error) {
        console.error("Error fetching devices:", error);
        res.status(500).json({ error: error.message });
    }
});

// Route to update a device's mode
app.put("/api/devices/:deviceId", async (req, res) => {
    const { deviceId } = req.params;
    const { mode } = req.body;

    if (!mode) {
        return res.status(400).json({ error: "Mode is required." });
    }

    try {
        const pool = await sql.connect(config);
        const result = await pool
            .request()
            .input("deviceId", sql.VarChar, deviceId)
            .input("mode", sql.VarChar, mode)
            .query(`
                UPDATE Devices
                SET mode = @mode
                WHERE deviceId = @deviceId
            `);

        if (result.rowsAffected[0] > 0) {
            res.status(200).json({ message: "Device mode updated successfully." });
        } else {
            res.status(404).json({ error: "Device not found." });
        }
    } catch (error) {
        console.error("Error updating device mode:", error);
        res.status(500).json({ error: "An error occurred while updating the device mode." });
    }
});

// Route to delete a device from IoT Hub and the database
app.delete("/api/devices/:deviceId", async (req, res) => {
    const { deviceId } = req.params;

    try {
        await registry.delete(deviceId);

        const pool = await sql.connect(config);
        const result = await pool
            .request()
            .input("deviceId", sql.VarChar, deviceId)
            .query("DELETE FROM Devices WHERE DeviceId = @deviceId");

        if (result.rowsAffected[0] > 0) {
            res.status(200).json({ message: "Device deleted successfully!" });
        } else {
            res.status(404).json({ message: "Device not found" });
        }
    } catch (error) {
        console.error("Error deleting device:", error);
        res.status(500).json({ error: error.message });
    }
});

// Route to test the database connection
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
