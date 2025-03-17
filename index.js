const express = require("express");
const bodyParser = require("body-parser");
const sql = require("mssql");
const dotenv = require("dotenv");
const azure = require("azure-sb");
const cors = require("cors");
const { Registry } = require("azure-iothub");
const { createClientContext, createOrUpdateInstallation, sendNotification } = require("@azure/notification-hubs/api");
const { createBrowserInstallation, createBrowserNotification } = require("@azure/notification-hubs");

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

const notificationHubService = azure.createNotificationHubService(process.env.NOTIFICATION_HUB_NAME, process.env.NOTIFICATION_HUB_CONNECTION_STRING);

// IoT Hub Registry
const registry = Registry.fromConnectionString(process.env.IOT_HUB_CONNECTION_STRING);
const hostName = process.env.IOT_HUB_HOSTNAME; // Use IoT Hub's hostname from env

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

// Add a tracked activity
app.post("/api/tracked-activities", async (req, res) => {
  const { phoneNumber, steps, cumulativeStepsToday, distanceKm, caloriesBurned, distanceFromHome } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("phoneNumber", sql.VarChar, phoneNumber)
      .input("steps", sql.Int, steps)
      .input("cumulativeStepsToday", sql.Int, cumulativeStepsToday)
      .input("distanceKm", sql.Decimal(5, 2), distanceKm)
      .input("caloriesBurned", sql.Int, caloriesBurned)
      .input("distanceFromHome", sql.Decimal(6, 2), distanceFromHome)
      .query(
        "INSERT INTO TrackedActivities (phoneNumber, steps, cumulativeStepsToday, distanceKm, caloriesBurned, distanceFromHome) VALUES (@phoneNumber, @steps, @cumulativeStepsToday, @distanceKm, @caloriesBurned, @distanceFromHome)"
      );
    res.status(200).send({ message: "Tracked activity added successfully!" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Get all tracked activities for a user
app.get("/api/tracked-activities/:phoneNumber", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    const result = await pool
      .request()
      .input("phoneNumber", sql.VarChar, req.params.phoneNumber)
      .query("SELECT * FROM TrackedActivities WHERE phoneNumber = @phoneNumber");
    res.status(200).json(result.recordset);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Update a tracked activity
app.put("/api/tracked-activities/:id", async (req, res) => {
  const { steps, cumulativeStepsToday, distanceKm, caloriesBurned, distanceFromHome } = req.body;
  try {
    const pool = await sql.connect(config);
    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .input("steps", sql.Int, steps)
      .input("cumulativeStepsToday", sql.Int, cumulativeStepsToday)
      .input("distanceKm", sql.Decimal(5, 2), distanceKm)
      .input("caloriesBurned", sql.Int, caloriesBurned)
      .input("distanceFromHome", sql.Decimal(6, 2), distanceFromHome)
      .query(
        "UPDATE TrackedActivities SET steps = @steps, cumulativeStepsToday = @cumulativeStepsToday, distanceKm = @distanceKm, caloriesBurned = @caloriesBurned, distanceFromHome = @distanceFromHome WHERE id = @id"
      );
    res.status(200).send({ message: "Tracked activity updated successfully!" });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});
// Delete a tracked activity
app.delete("/api/tracked-activities/:id", async (req, res) => {
  try {
    const pool = await sql.connect(config);
    await pool.request().input("id", sql.Int, req.params.id).query("DELETE FROM TrackedActivities WHERE id = @id");
    res.status(200).send({ message: "Tracked activity deleted successfully!" });
  } catch (error) {
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

// Push notifications registration endpoint
app.post("/api/registerPush", async (req, res) => {
  const { pushToken, userId, platform } = req.body;

  if (!pushToken || !userId) {
    return res.status(400).send({ error: "Missing pushToken or userId" });
  }

  // Log the tag that will be used for registration
  console.log("Registering push token with tag (userId):", userId);

  // For web push notifications, use the new SDK and the Installation API
  if (platform && platform.toLowerCase() === "web") {
    if (typeof pushToken !== "object" || !pushToken.endpoint || !pushToken.keys || !pushToken.keys.p256dh || !pushToken.keys.auth) {
      return res.status(400).send({ error: "Invalid web push subscription object" });
    }
    try {
      const context = createClientContext(process.env.NOTIFICATION_HUB_CONNECTION_STRING, process.env.NOTIFICATION_HUB_NAME);
      const installation = createBrowserInstallation({
        installationId: userId, // Using userId as installationId
        pushChannel: {
          endpoint: String(pushToken.endpoint),
          p256dh: String(pushToken.keys.p256dh),
          auth: String(pushToken.keys.auth),
        },
        tags: [userId],
      });
      console.log("Installation object:", installation);
      const result = await createOrUpdateInstallation(context, installation);
      console.log("Web push registration result:", result);
      return res.status(200).send({ message: "Web push token registered successfully", result });
    } catch (error) {
      console.error("Error registering web push token:", error);
      return res.status(500).send({ error: error.message });
    }
  }
  // For iOS, use APNS registration with azure-sb
  else if (platform && platform.toLowerCase() === "ios") {
    notificationHubService.apns.createAppleNativeRegistration(pushToken, { tags: [userId] }, (error, response) => {
      if (error) {
        console.error("Error registering APNS token:", error);
        return res.status(500).send({ error: error.message });
      }
      console.log("APNS registration response:", response);
      res.status(200).send({ message: "APNS push token registered successfully", registrationId: response });
    });
  }
  // Default to Android (GCM/FCM) registration with azure-sb
  else {
    notificationHubService.gcm.createNativeRegistration(pushToken, { tags: [userId] }, (error, response) => {
      if (error) {
        console.error("Error registering GCM token:", error);
        return res.status(500).send({ error: error.message });
      }
      console.log("GCM registration response:", response);
      res.status(200).send({ message: "GCM push token registered successfully", registrationId: response });
    });
  }
});

// Endpoint to send a notification to a specific user (using phone number as tag)
app.post("/api/sendNotificationToUser", async (req, res) => {
  const { phoneNumber, payload, platform } = req.body;
  if (!phoneNumber || !payload || !payload.title || !payload.body) {
    return res.status(400).send({ error: "Missing required fields: phoneNumber, payload.title, and payload.body" });
  }

  // If platform is "web", use the new SDK for browser notifications.
  if (platform && platform.toLowerCase() === "web") {
    try {
      const context = createClientContext(process.env.NOTIFICATION_HUB_CONNECTION_STRING, process.env.NOTIFICATION_HUB_NAME);
      const notificationContent = {
        title: payload.title,
        body: payload.body,
        icon: payload.icon || "/icon.png",
      };
      const notification = createBrowserNotification(JSON.stringify(notificationContent));
      const result = await sendNotification(context, notification, { tagExpression: phoneNumber });
      console.log("Web notification send result:", result);
      return res.status(200).send({ message: "Web notification sent", result });
    } catch (error) {
      console.error("Error sending web notification:", error);
      return res.status(500).send({ error: error.message });
    }
  }
  // Otherwise, assume native (Android/iOS) and use azure-sb for sending.
  else {
    // Build a native JSON payload for FCM (Android) notifications.
    // For FCM, the payload is typically placed under a "data" property.
    const nativePayload = JSON.stringify({
      data: {
        title: payload.title,
        body: payload.body,
      },
    });

    // Create a valid tag expression by wrapping the phone number in parentheses and single quotes.
    console.log("Sending native notification to tag expression:", phoneNumber);
    notificationHubService.send(nativePayload, phoneNumber, (error, response) => {
      if (error) {
        console.error("Error sending native notification:", error);
        return res.status(500).send({ error: error.message });
      }
      console.log("Native notification send response:", response);
      res.status(200).send({ message: "Native notification sent", response });
    });
  }
});

// Start the server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
