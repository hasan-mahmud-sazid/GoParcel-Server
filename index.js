require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const port = process.env.PORT || 3000;

// **HTTP Server for Socket.io**
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173", "http://localhost:5174"],
    methods: ["GET", "POST"],
  },
});

// **MIDDLEWARE**
app.use(cors());
app.use(express.json());

// **Global Collection Variables**
let usersCollection;
let parcelsCollection;
let paymentCollection;

// **JWT Verify Token Middleware**
const verifyToken = (req, res, next) => {
  if (!req.headers.authorization) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = req.headers.authorization.split(" ")[1];

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.decoded = decoded;
    next();
  });
};

// **Admin Verify Middleware**
const verifyAdmin = async (req, res, next) => {
  const email = req.decoded.email;
  const query = { email: email };
  const user = await usersCollection.findOne(query);
  const isAdmin = user?.role === "admin";
  if (!isAdmin) {
    return res.status(403).send({ message: "forbidden access" });
  }
  next();
};

// **TRACKING ID GENERATOR**
function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@goparcel.o5leubt.mongodb.net/?appName=GoParcel`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// **Socket.io Connection**
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);
  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});

async function run() {
  try {
    // await client.connect();
    const db = client.db("go_parcel_db");

    usersCollection = db.collection("users");
    parcelsCollection = db.collection("parcels");
    paymentCollection = db.collection("payments");

    // --- 1. POST: SAVE NEW PARCEL (FIXED 404) ---
    app.post("/parcels", async (req, res) => {
      const parcelData = req.body;
      // ডিফল্ট স্ট্যাটাস সেট করা
      parcelData.deliveryStatus = "pending";
      parcelData.paymentStatus = "unpaid";
      parcelData.bookingDate = new Date();

      try {
        const result = await parcelsCollection.insertOne(parcelData);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to save parcel", error });
      }
    });

    // --- 2. GET: PARCELS BY USER EMAIL ---
    app.get("/parcels", async (req, res) => {
      const email = req.query.email;
      if (!email) {
        return res.status(400).send({ message: "Email is required" });
      }
      const query = { senderEmail: email };
      try {
        const result = await parcelsCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching parcels", error });
      }
    });

    // --- 3. DELETE: REMOVE A PARCEL ---
    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      try {
        const result = await parcelsCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error deleting parcel", error });
      }
    });

    // --- USERS API (POST) ---
    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await usersCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: "user already exists", insertedId: null });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // --- AUTH/JWT API ---
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });
      res.send({ token });
    });

    // --- ADMIN STATS API ---
    app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      const users = await usersCollection.estimatedDocumentCount();
      const parcels = await parcelsCollection.estimatedDocumentCount();
      const payments = await paymentCollection.find().toArray();
      const revenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);

      res.send({ users, parcels, revenue });
    });

    // --- GET ALL USERS ---
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // --- USER ROLE API ---
    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // --- STRIPE PAYMENT API ---
    app.post("/create-checkout-session", async (req, res) => {
      const { cost, parcelName, senderEmail, parcelId } = req.body;
      try {
        const amount = Math.round(parseFloat(cost) * 100);
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: [
            {
              price_data: {
                currency: "usd",
                product_data: { name: `Parcel: ${parcelName}` },
                unit_amount: amount,
              },
              quantity: 1,
            },
          ],
          mode: "payment",
          customer_email: senderEmail,
          metadata: { parcelId, parcelName },
          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
        });
        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    app.patch(
      "/users/admin/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: "admin",
          },
        };
        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      },
    );
    // --- PARCEL ASSIGN API ---
    app.patch(
      "/parcels/assign/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { riderId } = req.body;
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              riderId: new ObjectId(riderId),
              deliveryStatus: "On The Way",
            },
          },
        );
        res.send(result);
      },
    );

    // --- PAYMENT SUCCESS PATCH ---
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // স্ট্রাইপ মেটাডাটা থেকে পার্সেলের নাম নিয়ে আসা
      const parcelName = session.metadata.parcelName;
      const parcelId = session.metadata.parcelId;

      const payment = {
        amount: session.amount_total / 100,
        customerEmail: session.customer_email,
        parcelId,
        parcelName, // **এই নতুন লাইনটি যোগ করুন**
        transactionId: session.payment_intent,
        paidAt: new Date(),
        trackingId: generateTrackingId(),
      };

      const result = await paymentCollection.insertOne(payment);
      res.send({ success: true, parcelName });
    });

    // --- GET: PAYMENT HISTORY BY EMAIL ---
    // server.js এর ভেতর
    app.get("/payments", verifyToken, async (req, res) => {
      const email = req.query.email;

      if (req.decoded.email !== email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      try {
        const result = await paymentCollection
          .aggregate([
            {
              $match: { customerEmail: email }, // প্রথমে ইউজারের পেমেন্টগুলো ফিল্টার করবে
            },
            {
              $addFields: {
                parcelObjectId: { $toObjectId: "$parcelId" }, // string ID কে ObjectId তে কনভার্ট করবে
              },
            },
            {
              $lookup: {
                from: "parcels", // যে কালেকশন থেকে ডাটা আসবে
                localField: "parcelObjectId", // payments কালেকশনের ফিল্ড
                foreignField: "_id", // parcels কালেকশনের ফিল্ড
                as: "parcelDetails", // যে নামে ডাটা আসবে
              },
            },
            {
              $unwind: "$parcelDetails", // অ্যারে থেকে অবজেক্টে রূপান্তর করবে
            },
            {
              $project: {
                _id: 1,
                amount: 1,
                transactionId: 1,
                paidAt: 1,
                parcelName: "$parcelDetails.parcelName", // সরাসরি নামটা নিয়ে আসা
              },
            },
          ])
          .toArray();

        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Error fetching payment history" });
      }
    });

    // --- GET: ALL PARCELS (Admin Only) ---
    app.get("/all-parcels", verifyToken, verifyAdmin, async (req, res) => {
      try {
        const result = await parcelsCollection.find().toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Error fetching all parcels" });
      }
    });

    // --- UPDATE DELIVERY DATE (Admin Only) ---
    app.patch(
      "/parcels/update-date/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { deliveryDate } = req.body;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            deliveryDate: deliveryDate,
          },
        };
        const result = await parcelsCollection.updateOne(filter, updatedDoc);
        res.send(result);
      },
    );

    // Delivery Date Update API
    app.patch(
      "/parcels/update-date/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { deliveryDate, userEmail, parcelName } = req.body; // ফ্রন্টএন্ড থেকে এই ডাটাগুলো পাঠাতে হবে

        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: { deliveryDate: deliveryDate },
        };

        try {
          const result = await parcelsCollection.updateOne(filter, updatedDoc);

          if (result.modifiedCount > 0) {
            // --- নোটিফিকেশন তৈরি ---
            const notification = {
              userEmail: userEmail,
              message: `Your parcel '${parcelName}' delivery date has been set to ${deliveryDate}.`,
              date: new Date(),
              isRead: false,
            };
            await notificationsCollection.insertOne(notification);

            res.send(result);
          }
        } catch (error) {
          res
            .status(500)
            .send({ message: "Error updating date and notification" });
        }
      },
    );
    console.log("MongoDB Connected & Server Ready!");
  } catch (error) {
    console.error("Database Connection Error:", error);
  }
}
run().catch(console.dir);

app.get("/", (req, res) => res.send("Go Parcel Server is Running!"));

server.listen(port, () => console.log(`Server running on port ${port}`));
