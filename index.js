const express = require("express");
const bodyParser = require("body-parser");
const sql = require("mssql");
const dotenv = require("dotenv");
const cors = require("cors");
const axios = require("axios");
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

// In-memory store for native Expo push tokens keyed by phone number
const expoPushTokens = {};
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: {
    encrypt: true,
    trustServerCertificate: false,
    columnEncryptionSetting: true,
  },
};


// IoT Hub Registry
const registry = Registry.fromConnectionString(process.env.IOT_HUB_CONNECTION_STRING);
const hostName = process.env.IOT_HUB_HOSTNAME; // Use IoT Hub's hostname from env

// Root endpoint
app.get("/", (req, res) => {
  res.send("Server is running!");
});

// Create a new user
app.post("/api/users", async (req, res) => {
  const { phoneNumber, firstName, lastName, height, weight, latitude, longitude, pushToken } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("firstName", sql.VarChar, firstName)
      .input("lastName", sql.VarChar, lastName)
      .input("height", sql.Float, height)
      .input("weight", sql.Float, weight)
      .input("latitude", sql.Float, latitude)
      .input("longitude", sql.Float, longitude)
      .input("pushToken", sql.VarChar, pushToken).query(`
        INSERT INTO Users (PhoneNumber, FirstName, LastName, Height, Weight, Latitude, Longitude, PushToken)
        VALUES (@phoneNumber, @firstName, @lastName, @height, @weight, @latitude, @longitude, @pushToken)
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
      console.log("User found:", result.recordset[0]);
      res.status(200).json(result.recordset[0]);
    } else {
      res.status(404).send({ message: "User not found" });
    }
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).send({ error: error.message });
  }
});
// Update a user by Phone Number, including pushToken if provided
app.put("/api/users/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;
  const { firstName, lastName, height, weight, latitude, longitude, pushToken } = req.body;
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("firstName", sql.VarChar, firstName)
      .input("lastName", sql.VarChar, lastName)
      .input("height", sql.Float, height)
      .input("weight", sql.Float, weight)
      .input("latitude", sql.Float, latitude)
      .input("longitude", sql.Float, longitude)
      .input("pushToken", sql.VarChar, pushToken)
      .query(`
        UPDATE Users
        SET FirstName = @firstName,
            LastName = @lastName,
            Height = @height,
            Weight = @weight,
            Latitude = @latitude,
            Longitude = @longitude,
            PushToken = CASE WHEN @pushToken IS NULL THEN PushToken ELSE @pushToken END
        WHERE PhoneNumber = @phoneNumber
      `);
    if (result.rowsAffected[0] > 0) {
      res.status(200).send({ message: "User updated successfully!" });
    } else {
      res.status(404).send({ message: "User not found" });
    }
  } catch (error) {
    console.error("Error updating user:", error);
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
// Route to update a device's mode and name
app.put("/api/devices/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const { mode, deviceName } = req.body;

  if (!mode || !deviceName) {
    return res.status(400).json({ error: "Both mode and deviceName are required." });
  }

  try {
    const pool = await sql.connect(config);
    const result = await pool.request().input("deviceId", sql.VarChar, deviceId).input("mode", sql.VarChar, mode).input("deviceName", sql.VarChar, deviceName)
      .query(`
        UPDATE Devices
        SET mode = @mode, deviceName = @deviceName
        WHERE deviceId = @deviceId
      `);

    if (result.rowsAffected[0] > 0) {
      res.status(200).json({ message: "Device updated successfully." });
    } else {
      res.status(404).json({ error: "Device not found." });
    }
  } catch (error) {
    console.error("Error updating device:", error);
    res.status(500).json({ error: "An error occurred while updating the device." });
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

// Route to add a goal
app.post("/api/goals", async (req, res) => {
  const { phoneNumber, goalType, goal } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool.request().input("phoneNumber", sql.VarChar, phoneNumber).input("goalType", sql.VarChar, goalType).input("goal", sql.VarChar, goal).query(`
          INSERT INTO Goals (PhoneNumber, GoalType, Goal)
          VALUES (@phoneNumber, @goalType, @goal)
        `);
    res.status(201).send({ message: "Goal added successfully!" });
  } catch (error) {
    console.error("Error adding goal:", error);
    res.status(500).send({ error: error.message });
  }
});
// Get all goals for a user
app.get("/api/goals/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().input("phoneNumber", sql.VarChar, phoneNumber).query("SELECT * FROM Goals WHERE PhoneNumber = @phoneNumber");
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("Error fetching goals:", error);
    res.status(500).send({ error: error.message });
  }
});
// Delete a goal by ID
app.delete("/api/goals/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().input("id", sql.Int, id).query("DELETE FROM Goals WHERE Id = @id");
    if (result.rowsAffected[0] > 0) {
      res.status(200).send({ message: "Goal deleted successfully!" });
    } else {
      res.status(404).send({ message: "Goal not found" });
    }
  } catch (error) {
    console.error("Error deleting goal:", error);
    res.status(500).send({ error: error.message });
  }
});
// Edit a goal by ID
app.put("/api/goals/:id", async (req, res) => {
  const { id } = req.params;
  const { phoneNumber, goalType, goal } = req.body;
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("goalType", sql.VarChar, goalType)
      .input("goal", sql.VarChar, goal).query(`
          UPDATE Goals
          SET PhoneNumber = @phoneNumber, GoalType = @goalType, Goal = @goal
          WHERE Id = @id
        `);
    if (result.rowsAffected[0] > 0) {
      res.status(200).send({ message: "Goal updated successfully!" });
    } else {
      res.status(404).send({ message: "Goal not found" });
    }
  } catch (error) {
    console.error("Error updating goal:", error);
    res.status(500).send({ error: error.message });
  }
});

// Add a user exercise
app.post("/api/user-exercises", async (req, res) => {
  const { phoneNumber, exerciseType, durationMinutes, caloriesBurned, intensity, rating, distanceFromHome } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("exerciseType", sql.VarChar, exerciseType)
      .input("durationMinutes", sql.Int, durationMinutes)
      .input("caloriesBurned", sql.Int, caloriesBurned)
      .input("intensity", sql.Int, intensity)
      .input("rating", sql.Int, rating)
      .input("distanceFromHome", sql.Decimal(6, 2), distanceFromHome)
      .query(
        "INSERT INTO UserExercises (phoneNumber, exerciseType, durationMinutes, caloriesBurned, intensity, rating, distanceFromHome) VALUES (@phoneNumber, @exerciseType, @durationMinutes, @caloriesBurned, @intensity, @rating, @distanceFromHome)"
      );
    res.status(200).send({ message: "User exercise added successfully!" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Get all user exercises for a user, ordered by the latest exerciseDate first
app.get("/api/user-exercises/:phoneNumber", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("phoneNumber", sql.VarChar, req.params.phoneNumber)
      .query("SELECT * FROM UserExercises WHERE phoneNumber = @phoneNumber ORDER BY exerciseDate DESC");
    res.status(200).json(result.recordset);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Get the user's last 14 activities
app.get("/api/user-exercises/last/:phoneNumber", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("phoneNumber", sql.VarChar, req.params.phoneNumber)
      .query("SELECT TOP 14 * FROM UserExercises WHERE phoneNumber = @phoneNumber ORDER BY exerciseDate DESC");
    res.status(200).json(result.recordset);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Get a user exercise by id
app.get("/api/user-exercises/id/:id", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool.request().input("id", sql.Int, req.params.id).query("SELECT * FROM UserExercises WHERE id = @id");
    if (result.recordset.length === 0) {
      return res.status(404).send({ message: "User exercise not found" });
    }
    res.status(200).json(result.recordset[0]);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Update a user exercise
app.put("/api/user-exercises/:id", async (req, res) => {
  const { exerciseType, durationMinutes, caloriesBurned, intensity, rating, distanceFromHome } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .input("exerciseType", sql.VarChar, exerciseType)
      .input("durationMinutes", sql.Int, durationMinutes)
      .input("caloriesBurned", sql.Int, caloriesBurned)
      .input("intensity", sql.Int, intensity)
      .input("rating", sql.Int, rating)
      .input("distanceFromHome", sql.Decimal(6, 2), distanceFromHome)
      .query(
        "UPDATE UserExercises SET exerciseType = @exerciseType, durationMinutes = @durationMinutes, caloriesBurned = @caloriesBurned, intensity = @intensity, rating = @rating, distanceFromHome = @distanceFromHome WHERE id = @id"
      );
    res.status(200).send({ message: "User exercise updated successfully!" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Delete a user exercise
app.delete("/api/user-exercises/:id", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    await pool.request().input("id", sql.Int, req.params.id).query("DELETE FROM UserExercises WHERE id = @id");
    res.status(200).send({ message: "User exercise deleted successfully!" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Create a new daily record
app.post("/api/dailyrecords", async (req, res) => {
  const { phoneNumber, recordDate, totalSteps, totalCaloriesBurned, exerciseDurationMinutes, weight } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("recordDate", sql.Date, recordDate)
      .input("totalSteps", sql.Int, totalSteps)
      .input("totalCaloriesBurned", sql.Decimal(10, 2), totalCaloriesBurned)
      .input("exerciseDurationMinutes", sql.Int, exerciseDurationMinutes)
      .input("weight", sql.Decimal(5, 2), weight).query(`
        INSERT INTO dailyrecords (phoneNumber, recordDate, totalSteps, totalCaloriesBurned, exerciseDurationMinutes, weight)
        VALUES (@phoneNumber, @recordDate, @totalSteps, @totalCaloriesBurned, @exerciseDurationMinutes, @weight)
      `);
    res.status(201).send({ message: "Daily record created successfully!" });
  } catch (error) {
    console.error("Error creating daily record:", error);
    res.status(500).send({ error: error.message });
  }
});
// Get all daily records for a user
app.get("/api/dailyrecords/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .query("SELECT * FROM dailyrecords WHERE phoneNumber = @phoneNumber ORDER BY recordDate DESC");
    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("Error fetching daily records:", error);
    res.status(500).send({ error: error.message });
  }
});
// Get a specific daily record for a user by recordDate
app.get("/api/dailyrecords/:phoneNumber/:recordDate", async (req, res) => {
  const { phoneNumber, recordDate } = req.params;
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("recordDate", sql.Date, recordDate)
      .query("SELECT * FROM dailyrecords WHERE phoneNumber = @phoneNumber AND recordDate = @recordDate");
    if (result.recordset.length > 0) {
      res.status(200).json(result.recordset[0]);
    } else {
      res.status(404).send({ message: "Daily record not found" });
    }
  } catch (error) {
    console.error("Error fetching daily record:", error);
    res.status(500).send({ error: error.message });
  }
});
// Update a daily record for a user by recordDate
app.put("/api/dailyrecords/:phoneNumber/:recordDate", async (req, res) => {
  const { phoneNumber, recordDate } = req.params;
  const { totalSteps, totalCaloriesBurned, exerciseDurationMinutes, weight } = req.body;
  try {
    const pool = await sql.connect(config);

    // Retrieve the existing record
    const selectResult = await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("recordDate", sql.Date, recordDate)
      .query("SELECT * FROM dailyrecords WHERE phoneNumber = @phoneNumber AND recordDate = @recordDate");

    if (selectResult.recordset.length === 0) {
      return res.status(404).send({ message: "Daily record not found" });
    }

    const currentRecord = selectResult.recordset[0];

    // Merge: if a new value is provided, use it; otherwise keep the current value.
    const updatedTotalSteps = totalSteps !== undefined ? totalSteps : currentRecord.totalSteps;
    const updatedTotalCaloriesBurned = totalCaloriesBurned !== undefined ? totalCaloriesBurned : currentRecord.totalCaloriesBurned;
    const updatedExerciseDurationMinutes = exerciseDurationMinutes !== undefined ? exerciseDurationMinutes : currentRecord.exerciseDurationMinutes;
    const updatedWeight = weight !== undefined ? weight : currentRecord.weight;

    // Update the record with merged values
    const updateResult = await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("recordDate", sql.Date, recordDate)
      .input("totalSteps", sql.Int, updatedTotalSteps)
      .input("totalCaloriesBurned", sql.Decimal(10, 2), updatedTotalCaloriesBurned)
      .input("exerciseDurationMinutes", sql.Int, updatedExerciseDurationMinutes)
      .input("weight", sql.Decimal(5, 2), updatedWeight).query(`
        UPDATE dailyrecords
        SET totalSteps = @totalSteps,
            totalCaloriesBurned = @totalCaloriesBurned,
            exerciseDurationMinutes = @exerciseDurationMinutes,
            weight = @weight
        WHERE phoneNumber = @phoneNumber AND recordDate = @recordDate
      `);

    if (updateResult.rowsAffected[0] > 0) {
      res.status(200).send({ message: "Daily record updated successfully!" });
    } else {
      res.status(404).send({ message: "Daily record not found" });
    }
  } catch (error) {
    console.error("Error updating daily record:", error);
    res.status(500).send({ error: error.message });
  }
});
// Delete a daily record for a user by recordDate
app.delete("/api/dailyrecords/:phoneNumber/:recordDate", async (req, res) => {
  const { phoneNumber, recordDate } = req.params;
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("recordDate", sql.Date, recordDate)
      .query("DELETE FROM dailyrecords WHERE phoneNumber = @phoneNumber AND recordDate = @recordDate");
    if (result.rowsAffected[0] > 0) {
      res.status(200).send({ message: "Daily record deleted successfully!" });
    } else {
      res.status(404).send({ message: "Daily record not found" });
    }
  } catch (error) {
    console.error("Error deleting daily record:", error);
    res.status(500).send({ error: error.message });
  }
});

// Insert a new activity (location) into the Activities table
app.post("/api/activities", async (req, res) => {
  const { phoneNumber, activityDate, latitude, longitude } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("activityDate", sql.DateTime, activityDate)
      .input("latitude", sql.Decimal(9, 6), latitude)
      .input("longitude", sql.Decimal(9, 6), longitude)
      .query(
        `INSERT INTO Activities (phoneNumber, activityDate, latitude, longitude) 
         VALUES (@phoneNumber, @activityDate, @latitude, @longitude)`
      );
    res.status(200).send({ message: "Activity added successfully!" });
  } catch (error) {
    console.error(error);
    res.status(500).send({ error: error.message });
  }
});
// Get today's activities for a user (using UTC+8 day boundaries)
app.get("/api/activities/today/:phoneNumber", async (req, res) => {
  const { phoneNumber } = req.params;

  // Compute today's boundaries for UTC+8.
  // 'en-CA' locale produces a YYYY-MM-DD string.
  const now = new Date();
  const singaporeDateStr = now.toLocaleDateString("en-CA", {
    timeZone: "Asia/Singapore"
  });

  // Create start and end boundaries for the day in UTC+8.
  const startOfDay = new Date(singaporeDateStr + "T00:00:00+08:00");
  const endOfDay = new Date(singaporeDateStr + "T00:00:00+08:00");
  endOfDay.setDate(endOfDay.getDate() + 1);

  try {
    const pool = await sql.connect(config);
    const result = await pool.request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("startOfDay", sql.DateTime, startOfDay)
      .input("endOfDay", sql.DateTime, endOfDay)
      .query(`
        SELECT [id],
               [phoneNumber],
               [cumulativeStepsToday],
               [caloriesBurned],
               [activityDate],
               [latitude],
               [longitude]
          FROM [dbo].[Activities]
         WHERE phoneNumber = @phoneNumber
           AND activityDate >= @startOfDay
           AND activityDate < @endOfDay
         ORDER BY activityDate DESC
      `);

    res.status(200).json(result.recordset);
  } catch (error) {
    console.error("Error fetching today's activities:", error);
    res.status(500).json({ error: error.message });
  }
});

// Push notifications registration endpoint using Expo push service, storing push token in the database
app.post("/api/registerPush", async (req, res) => {
  const { pushToken, userId, platform } = req.body;
  if (!pushToken || !userId) {
    return res.status(400).send({ error: "Missing pushToken or userId" });
  }
  console.log("Registering push token for user:", userId);

  // Only support native platforms (iOS, Android) with Expo push tokens
  if (platform && (platform.toLowerCase() === "ios" || platform.toLowerCase() === "android")) {
    try {
      const pool = await sql.connect(config);
      const result = await pool.request().input("userId", sql.VarChar, userId).input("pushToken", sql.VarChar, pushToken).query(`
          UPDATE Users
          SET PushToken = @pushToken
          WHERE PhoneNumber = @userId
        `);

      if (result.rowsAffected[0] > 0) {
        console.log("Stored native Expo push token in database for user:", userId, pushToken);
        return res.status(200).send({ message: "Native push token registered successfully", token: pushToken });
      } else {
        return res.status(404).send({ error: "User not found" });
      }
    } catch (error) {
      console.error("Error updating push token in database:", error);
      return res.status(500).send({ error: error.message });
    }
  } else if (platform && platform.toLowerCase() === "web") {
    console.log("Push notifications on web are not supported with Expo push service");
    return res.status(400).send({ error: "Push notifications on web are not supported with Expo push service" });
  } else {
    return res.status(400).send({ error: "Unsupported platform" });
  }
});
// Endpoint to send a notification to a specific user (using phone number as tag)
app.post("/api/sendNotificationToUser", async (req, res) => {
  const { phoneNumber, payload, platform } = req.body;
  if (!phoneNumber || !payload || !payload.title || !payload.body) {
    return res.status(400).send({ error: "Missing required fields: phoneNumber, payload.title, and payload.body" });
  }
  // Only support native platforms via Expo push service
  if (platform && (platform.toLowerCase() === "ios" || platform.toLowerCase() === "android")) {
    try {
      // Query the database for the user's push token
      const pool = await sql.connect(config);
      const result = await pool
        .request()
        .input("phoneNumber", sql.VarChar, phoneNumber)
        .query("SELECT PushToken FROM Users WHERE PhoneNumber = @phoneNumber");

      if (!result.recordset || result.recordset.length === 0) {
        return res.status(404).send({ error: "User not found" });
      }
      
      const pushToken = result.recordset[0].PushToken;
      if (!pushToken) {
        return res.status(404).send({ error: "No push token found for this user" });
      }
      
      // Build the notification message object.
      const expoMessage = {
        to: pushToken,
        title: payload.title,
        body: payload.body,
        data: payload.data || {}
      };

      // Check for image in the top-level field first, then in the payload
      const imageUrl = req.body.image || payload.image;
      if (imageUrl) {
        expoMessage.image = imageUrl;
      }
      
      // Send notification via Expo push service
      const response = await axios.post("https://exp.host/--/api/v2/push/send", expoMessage, {
        headers: { "Content-Type": "application/json" },
      });
      console.log("Expo push send response:", response.data);
      return res.status(200).send({ message: "Native notification sent", response: response.data });
    } catch (error) {
      console.error("Error sending native notification via Expo push service:", error.response?.data || error.message);
      return res.status(500).send({ error: error.response?.data || error.message });
    }
  } else if (platform && platform.toLowerCase() === "web") {
    return res.status(400).send({ error: "Sending web notifications via Expo push service is not supported" });
  } else {
    return res.status(400).send({ error: "Unsupported platform" });
  }
});



// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
