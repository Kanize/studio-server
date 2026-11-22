
import express from "express";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import cors from "cors";

// --------------------------------------------------
// APP CONFIGURATION
// --------------------------------------------------

const app = express();
const PORT = process.env.PORT || 8000;

const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:3000"
)
  .trim()
  .replace(/\/+$/, "");

const BETTER_AUTH_URL = (
  process.env.BETTER_AUTH_URL || "http://localhost:3000"
)
  .trim()
  .replace(/\/+$/, "");

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI is missing from environment variables.");
}

// --------------------------------------------------
// MIDDLEWARE
// --------------------------------------------------

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "2mb" }));

// --------------------------------------------------
// DATABASE
// --------------------------------------------------

const client = new MongoClient(process.env.MONGODB_URI);

await client.connect();

console.log("MongoDB connected successfully!");

const db = client.db("studio-space");

const studiosCollection = db.collection("studios");
const bookingsCollection = db.collection("bookings");

// --------------------------------------------------
// AUTHENTICATION
// --------------------------------------------------

async function authenticateUser(req, res, next) {
  try {
    const cookie = req.headers.cookie;

    if (!cookie) {
      return res.status(401).json({
        success: false,
        message: "Please log in to continue.",
      });
    }

    const response = await fetch(
      `${BETTER_AUTH_URL}/api/auth/get-session`,
      {
        method: "GET",
        headers: {
          cookie,
        },
        cache: "no-store",
      }
    );

    if (!response.ok) {
      return res.status(401).json({
        success: false,
        message: "Unable to verify your session. Please log in again.",
      });
    }

    const sessionData = await response.json();

    if (
      !sessionData?.user?.id ||
      !sessionData?.user?.email
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid or expired session.",
      });
    }

    req.user = {
      id: sessionData.user.id,
      name: sessionData.user.name || "",
      email: sessionData.user.email.trim().toLowerCase(),
    };

    return next();
  } catch (error) {
    console.error("Authentication Error:", error);

    return res.status(503).json({
      success: false,
      message: "Authentication service is unavailable.",
    });
  }
}

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function isValidObjectId(id) {
  return (
    typeof id === "string" &&
    /^[a-fA-F0-9]{24}$/.test(id)
  );
}

function isValidDate(date) {
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    return false;
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);

  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date
  );
}

function isValidTime(time) {
  return (
    typeof time === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
  );
}

function calculateEndTime(startTime, hours) {
  const [hour, minute] = startTime.split(":").map(Number);

  const totalMinutes = hour * 60 + minute + hours * 60;

  if (totalMinutes > 24 * 60) {
    return null;
  }

  const endHour = Math.floor(totalMinutes / 60);
  const endMinute = totalMinutes % 60;

  return `${String(endHour).padStart(2, "0")}:${String(
    endMinute
  ).padStart(2, "0")}`;
}

// Only these fields can be updated in a studio document.
const allowedStudioFields = [
  "title",
  "category",
  "hourlyRate",
  "securityDeposit",
  "maxCapacity",
  "location",
  "imageUrl",
  "images",
  "amenities",
  "overview",
];

// Ownership filter:
// New documents use hostId.
// Legacy documents without hostId use hostEmail.
function getStudioOwnerFilter(user) {
  return {
    $or: [
      { hostId: user.id },
      {
        hostId: { $exists: false },
        hostEmail: user.email,
      },
    ],
  };
}

function sendServerError(res, message) {
  return res.status(500).json({
    success: false,
    message,
  });
}

// --------------------------------------------------
// HOME
// --------------------------------------------------

app.get("/", (req, res) => {
  return res.status(200).json({
    success: true,
    message: "StudioSpace server is running!",
  });
});

// --------------------------------------------------
// ADD STUDIO
// --------------------------------------------------

app.post("/add-studio", authenticateUser, async (req, res) => {
  try {
    const {
      title,
      category,
      hourlyRate,
      securityDeposit,
      maxCapacity,
      location,
      imageUrl,
      images,
      amenities,
      overview,
    } = req.body;

    // Required text validation
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.trim().length > 100 ||
      typeof category !== "string" ||
      !category.trim() ||
      typeof location !== "string" ||
      !location.trim() ||
      location.trim().length > 250 ||
      typeof overview !== "string" ||
      !overview.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid studio details.",
      });
    }

    // Numeric validation
    const hourlyRateNumber = Number(hourlyRate);
    const depositNumber = Number(securityDeposit);
    const capacityNumber = Number(maxCapacity);

    if (
      !Number.isFinite(hourlyRateNumber) ||
      hourlyRateNumber <= 0 ||
      !Number.isFinite(depositNumber) ||
      depositNumber < 0 ||
      !Number.isInteger(capacityNumber) ||
      capacityNumber < 1
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid pricing and capacity.",
      });
    }

    // Amenities validation
    if (
      amenities !== undefined &&
      (
        !Array.isArray(amenities) ||
        !amenities.every((item) => typeof item === "string")
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid amenities.",
      });
    }

    // Images validation
    if (
      images !== undefined &&
      (
        !Array.isArray(images) ||
        !images.every((item) => typeof item === "string")
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid images.",
      });
    }

    if (
      imageUrl !== undefined &&
      typeof imageUrl !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid image URL.",
      });
    }

    const newStudio = {
      title: title.trim(),
      category: category.trim(),

      hourlyRate: hourlyRateNumber,
      securityDeposit: depositNumber,
      maxCapacity: capacityNumber,

      location: location.trim(),

      imageUrl: typeof imageUrl === "string"
        ? imageUrl.trim()
        : "",

      images: Array.isArray(images) ? images : [],
      amenities: Array.isArray(amenities) ? amenities : [],

      overview: overview.trim(),

      // Host identity comes from verified Better Auth session.
      hostId: req.user.id,
      hostName: req.user.name,
      hostEmail: req.user.email,

      rating: 0,
      status: "active",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await studiosCollection.insertOne(newStudio);

    return res.status(201).json({
      success: true,
      message: "Studio added successfully!",
      studioId: result.insertedId,
    });
  } catch (error) {
    console.error("Add Studio Error:", error);

    return sendServerError(res, "Failed to add studio.");
  }
});

// --------------------------------------------------
// GET ALL STUDIOS
// --------------------------------------------------

app.get("/studios", async (req, res) => {
  try {
    const studios = await studiosCollection
      .find({ status: "active" })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json(studios);
  } catch (error) {
    console.error("Get Studios Error:", error);

    return sendServerError(res, "Error fetching studios.");
  }
});

// --------------------------------------------------
// GET MY STUDIO LISTINGS
// --------------------------------------------------

app.get("/my-listings", authenticateUser, async (req, res) => {
  try {
    const studios = await studiosCollection
      .find(getStudioOwnerFilter(req.user))
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      studios,
    });
  } catch (error) {
    console.error("My Listings Error:", error);

    return sendServerError(
      res,
      "Failed to fetch your studio listings."
    );
  }
});

// --------------------------------------------------
// GET FEATURED STUDIOS
// --------------------------------------------------

app.get("/featured-studios", async (req, res) => {
  try {
    const studios = await studiosCollection
      .find({ status: "active" })
      .sort({
        rating: -1,
        createdAt: -1,
        _id: -1,
      })
      .limit(6)
      .toArray();

    return res.status(200).json({
      success: true,
      studios,
    });
  } catch (error) {
    console.error("Featured Studios Error:", error);

    return sendServerError(
      res,
      "Failed to fetch featured studios."
    );
  }
});

// --------------------------------------------------
// GET SINGLE STUDIO
// --------------------------------------------------

app.get("/studios/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid studio ID.",
      });
    }

    const studio = await studiosCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!studio) {
      return res.status(404).json({
        success: false,
        message: "Studio not found.",
      });
    }

    return res.status(200).json({
      success: true,
      studio,
    });
  } catch (error) {
    console.error("Get Studio Error:", error);

    return sendServerError(res, "Failed to fetch studio.");
  }
});

// --------------------------------------------------
// UPDATE STUDIO
// --------------------------------------------------

app.patch("/studios/:id", authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid studio ID.",
      });
    }

    const updates = {};

    // Allow only approved fields.
    for (const field of allowedStudioFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid fields provided for update.",
      });
    }

    // Title validation
    if (updates.title !== undefined) {
      if (
        typeof updates.title !== "string" ||
        !updates.title.trim() ||
        updates.title.trim().length > 100
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid studio title.",
        });
      }

      updates.title = updates.title.trim();
    }

    // Text field validation
    for (const field of ["category", "location", "overview"]) {
      if (updates[field] !== undefined) {
        if (
          typeof updates[field] !== "string" ||
          !updates[field].trim()
        ) {
          return res.status(400).json({
            success: false,
            message: `Invalid ${field}.`,
          });
        }

        updates[field] = updates[field].trim();
      }
    }

    // Image URL validation
    if (updates.imageUrl !== undefined) {
      if (typeof updates.imageUrl !== "string") {
        return res.status(400).json({
          success: false,
          message: "Invalid image URL.",
        });
      }

      updates.imageUrl = updates.imageUrl.trim();
    }

    // Hourly rate validation
    if (updates.hourlyRate !== undefined) {
      updates.hourlyRate = Number(updates.hourlyRate);

      if (
        !Number.isFinite(updates.hourlyRate) ||
        updates.hourlyRate <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid hourly rate.",
        });
      }
    }

    // Security deposit validation
    if (updates.securityDeposit !== undefined) {
      updates.securityDeposit = Number(updates.securityDeposit);

      if (
        !Number.isFinite(updates.securityDeposit) ||
        updates.securityDeposit < 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid security deposit.",
        });
      }
    }

    // Maximum capacity validation
    if (updates.maxCapacity !== undefined) {
      updates.maxCapacity = Number(updates.maxCapacity);

      if (
        !Number.isInteger(updates.maxCapacity) ||
        updates.maxCapacity < 1
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid maximum capacity.",
        });
      }
    }

    // Amenities validation
    if (
      updates.amenities !== undefined &&
      (
        !Array.isArray(updates.amenities) ||
        !updates.amenities.every(
          (item) => typeof item === "string"
        )
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid amenities.",
      });
    }

    // Images validation
    if (
      updates.images !== undefined &&
      (
        !Array.isArray(updates.images) ||
        !updates.images.every(
          (item) => typeof item === "string"
        )
      )
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid images.",
      });
    }

    // Only the authenticated owner can update this studio.
    const result = await studiosCollection.updateOne(
      {
        _id: new ObjectId(id),
        ...getStudioOwnerFilter(req.user),
      },
      {
        $set: {
          ...updates,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Studio not found or you are not authorized to update it.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Studio updated successfully!",
    });
  } catch (error) {
    console.error("Update Studio Error:", error);

    return sendServerError(res, "Failed to update studio.");
  }
});

// --------------------------------------------------
// DELETE STUDIO
// --------------------------------------------------

app.delete("/studios/:id", authenticateUser, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid studio ID.",
      });
    }

    // Only the authenticated owner can delete this studio.
    const result = await studiosCollection.deleteOne({
      _id: new ObjectId(id),
      ...getStudioOwnerFilter(req.user),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Studio not found or you are not authorized to delete it.",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Studio deleted successfully!",
    });
  } catch (error) {
    console.error("Delete Studio Error:", error);

    return sendServerError(res, "Failed to delete studio.");
  }
});

// --------------------------------------------------
// CREATE BOOKING
// --------------------------------------------------

app.post("/bookings", authenticateUser, async (req, res) => {
  try {
    const {
      studioId,
      bookingDate,
      startTime,
      hours,
    } = req.body;

    const duration = Number(hours);

    // Validate booking details
    if (
      !isValidObjectId(studioId) ||
      !isValidDate(bookingDate) ||
      !isValidTime(startTime) ||
      !Number.isInteger(duration) ||
      duration < 1 ||
      duration > 12
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide valid booking details.",
      });
    }

    const endTime = calculateEndTime(startTime, duration);

    if (!endTime || endTime === startTime) {
      return res.status(400).json({
        success: false,
        message: "Booking must end before midnight.",
      });
    }

    // Find active studio
    const studio = await studiosCollection.findOne({
      _id: new ObjectId(studioId),
      status: "active",
    });

    if (!studio) {
      return res.status(404).json({
        success: false,
        message: "Studio not found or unavailable.",
      });
    }

    // Prevent owner from booking their own studio.
    if (
      studio.hostId === req.user.id ||
      studio.hostEmail?.trim().toLowerCase() === req.user.email
    ) {
      return res.status(403).json({
        success: false,
        message: "You cannot book your own studio.",
      });
    }

    // Check overlapping Pending or Confirmed bookings.
    const conflictingBooking = await bookingsCollection.findOne({
      studioId: new ObjectId(studioId),
      bookingDate,
      status: {
        $in: ["Pending", "Confirmed"],
      },
      startTime: {
        $lt: endTime,
      },
      endTime: {
        $gt: startTime,
      },
    });

    if (conflictingBooking) {
      return res.status(409).json({
        success: false,
        message: "This time slot is already reserved.",
      });
    }

    // Calculate all prices on the server.
    const hourlyRate = Number(studio.hourlyRate);
    const securityDeposit = Number(studio.securityDeposit) || 0;

    if (
      !Number.isFinite(hourlyRate) ||
      hourlyRate <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Studio pricing is invalid.",
      });
    }

    const subtotal = hourlyRate * duration;
    const totalPrice = subtotal + securityDeposit;

    const newBooking = {
      studioId: new ObjectId(studioId),

      studioName: studio.title,
      studioImage: studio.imageUrl || "",
      studioLocation: studio.location || "",

      userId: req.user.id,
      userName: req.user.name,
      userEmail: req.user.email,

      hostId: studio.hostId || "",
      hostEmail: studio.hostEmail || "",

      bookingDate,
      startTime,
      endTime,
      hours: duration,

      hourlyRate,
      securityDeposit,
      subtotal,
      totalPrice,

      status: "Pending",

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(newBooking);

    return res.status(201).json({
      success: true,
      message: "Booking request submitted successfully!",
      bookingId: result.insertedId,
      booking: {
        ...newBooking,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    console.error("Create Booking Error:", error);

    return sendServerError(res, "Failed to create booking.");
  }
});

// --------------------------------------------------
// GET MY BOOKINGS
// --------------------------------------------------

app.get("/my-bookings", authenticateUser, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find({
        userId: req.user.id,
      })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      bookings,
    });
  } catch (error) {
    console.error("My Bookings Error:", error);

    return sendServerError(res, "Failed to fetch your bookings.");
  }
});

// --------------------------------------------------
// CANCEL PENDING BOOKING
// --------------------------------------------------

app.patch(
  "/bookings/:id/cancel",
  authenticateUser,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return res.status(400).json({
          success: false,
          message: "Invalid booking ID.",
        });
      }

      const result = await bookingsCollection.updateOne(
        {
          _id: new ObjectId(id),
          userId: req.user.id,
          status: "Pending",
        },
        {
          $set: {
            status: "Cancelled",
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message:
            "Booking not found, or only Pending bookings can be cancelled.",
        });
      }

      return res.status(200).json({
        success: true,
        message: "Booking cancelled successfully!",
      });
    } catch (error) {
      console.error("Cancel Booking Error:", error);

      return sendServerError(res, "Failed to cancel booking.");
    }
  }
);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`StudioSpace server running on port ${PORT}`);
});

// --------------------------------------------------
// GRACEFUL SHUTDOWN
// --------------------------------------------------

async function shutdown() {
  console.log("Shutting down StudioSpace server...");

  try {
    await client.close();
    process.exit(0);
  } catch (error) {
    console.error("MongoDB shutdown error:", error);
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
