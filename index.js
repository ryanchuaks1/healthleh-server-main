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
    const result = await pool.request().input("phoneNumber", sql.VarChar, phoneNumber).query("SELECT * FROM Users WHERE PhoneNumber = @phoneNumber");
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
    const result = await pool.request().input("phoneNumber", sql.VarChar, phoneNumber).query("DELETE FROM Users WHERE PhoneNumber = @phoneNumber");
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
  const { deviceName, phoneNumber, deviceType, deviceId: originalDeviceId, mode } = req.body; // Using phoneNumber
  const deviceId = `${originalDeviceId}`; // Generate a unique device ID

  try {
    // Add device to IoT Hub
    const device = { deviceId };
    await registry.create(device);

    // Retrieve the connection string for the created device
    const result = await registry.get(deviceId); // Fetch the created device

    const hostName = process.env.IOT_HUB_HOSTNAME; // Use IoT Hub's hostname from env
    const primaryKey = result.responseBody.authentication.symmetricKey.primaryKey;

    if (!hostName || !primaryKey) {
      throw new Error("Failed to retrieve connection string for the device.");
    }

    const generatedConnectionString = `HostName=${hostName};DeviceId=${deviceId};SharedAccessKey=${primaryKey}`;

    // Save device to the database
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("deviceId", sql.VarChar, deviceId)
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("deviceName", sql.VarChar, deviceName)
      .input("deviceType", sql.VarChar, deviceType)
      .input("connectionString", sql.VarChar, generatedConnectionString)
      .input("mode", sql.VarChar, mode || "Input").query(`
                INSERT INTO Devices (deviceId, phoneNumber, deviceName, deviceType, connectionString, mode)
                VALUES (@deviceId, @phoneNumber, @deviceName, @deviceType, @connectionString, @mode)
            `);

    res.status(201).json({ message: "Device added successfully!", deviceId });
  } catch (error) {
    console.error("Error adding device:", error);
    res.status(500).json({ error: error.message });
  }
});

// Route to fetch all devices for a user
app.get("/api/devices/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().input("phoneNumber", sql.VarChar, phoneNumber).query("SELECT * FROM Devices WHERE phoneNumber = @phoneNumber");

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
    const result = await pool.request().input("deviceId", sql.VarChar, deviceId).input("mode", sql.VarChar, mode).query(`
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
    // Remove device from IoT Hub
    await registry.delete(deviceId);

    // Remove device from the database
    const pool = await sql.connect(config);
    const result = await pool.request().input("deviceId", sql.VarChar, deviceId).query("DELETE FROM Devices WHERE deviceId = @deviceId");

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
