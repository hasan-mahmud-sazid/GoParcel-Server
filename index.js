require("dotenv").config();
const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");
const admin = require("firebase-admin");

// Firebase Admin Setup
const serviceAccount = require("./go-parcel-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const port = process.env.PORT || 3000;

// HTTP Server for Socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://localhost:5174",
      process.env.SITE_DOMAIN,
    ],
    methods: ["GET", "POST"],
  },
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.zrfyfih.mongodb.net/?appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// --- HELPER FUNCTIONS ---
function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}

// --- MIDDLEWARES ---

// 1. Verify Firebase Token (For Authentication)
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) return res.status(401).send({ message: "unauthorized access" });

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// 2. Verify Admin (For Authorization)
const verifyAdmin = async (req, res, next) => {
  const email = req.decoded_email;
  const db = client.db("go_parcel_db");
  const user = await db.collection("users").findOne({ email });
  if (!user || user.role !== "admin") {
    return res.status(403).send({ message: "forbidden access" });
  }
  next();
};

async function run() {
  try {
    // await client.connect();
    const db = client.db("go_parcel_db");
    const userCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const ridersCollection = db.collection("riders");
    const notificationsCollection = db.collection("notifications");

    // Socket.io Connection
    io.on("connection", (socket) => {
      console.log("A user connected:", socket.id);
      socket.on("disconnect", () => console.log("User disconnected"));
    });

    // -----------------------
    // USERS API
    // -----------------------
    app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
      const searchText = req.query.searchText;
      let query = {};
      if (searchText) {
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      const result = await userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || "user" });
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) return res.send({ message: "user already exists" });

      user.role = user.role || "user";
      user.createdAt = new Date();
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // -----------------------
    // PARCEL API
    // -----------------------
    app.get("/parcels", verifyFBToken, async (req, res) => {
      const { email, deliveryStatus } = req.query;
      let query = {};
      if (email) query.senderEmail = email;
      if (deliveryStatus) query.deliveryStatus = deliveryStatus;

      const result = await parcelsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    app.post("/parcels", verifyFBToken, async (req, res) => {
      const parcelData = req.body;
      parcelData.deliveryStatus = "pending";
      parcelData.paymentStatus = "unpaid";
      parcelData.createdAt = new Date();
      const result = await parcelsCollection.insertOne(parcelData);
      res.send(result);
    });

    app.patch(
      "/parcels/assign/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { riderId, riderName, riderEmail } = req.body;
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              deliveryStatus: "driver_assigned",
              riderId: new ObjectId(riderId),
              riderEmail,
              riderName,
            },
          },
        );
        // Update rider status
        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { workStatus: "in_delivery" } },
        );
        res.send(result);
      },
    );

    app.delete("/parcels/:id", verifyFBToken, async (req, res) => {
      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      res.send(result);
    });

    // -----------------------
    // PAYMENT (STRIPE) API
    // -----------------------
    app.post("/create-checkout-session", verifyFBToken, async (req, res) => {
      const { cost, parcelName, senderEmail, parcelId } = req.body;
      const amount = Math.round(parseFloat(cost) * 100);

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: { name: `Parcel: ${parcelName}` },
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
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status === "paid") {
        const transactionId = session.payment_intent;
        const parcelId = session.metadata.parcelId;
        const trackingId = generateTrackingId();

        // 1. Update Parcel Status
        await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          {
            $set: {
              paymentStatus: "paid",
              deliveryStatus: "pending-pickup",
              trackingId,
            },
          },
        );

        // 2. Save Payment History
        const payment = {
          amount: session.amount_total / 100,
          customerEmail: session.customer_email,
          parcelId,
          parcelName: session.metadata.parcelName,
          transactionId,
          trackingId,
          paidAt: new Date(),
        };
        const result = await paymentCollection.insertOne(payment);
        res.send({ success: true, trackingId, transactionId });
      } else {
        res.send({ success: false });
      }
    });

    app.get("/payments", verifyFBToken, async (req, res) => {
      const email = req.query.email;
      if (email !== req.decoded_email)
        return res.status(403).send({ message: "forbidden access" });

      const result = await paymentCollection
        .find({ customerEmail: email })
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    // -----------------------
    // ADMIN STATS
    // -----------------------
    app.get("/admin-stats", verifyFBToken, verifyAdmin, async (req, res) => {
      const users = await userCollection.estimatedDocumentCount();
      const parcels = await parcelsCollection.estimatedDocumentCount();
      const payments = await paymentCollection.find().toArray();
      const revenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
      res.send({ users, parcels, revenue });
    });

    console.log("Successfully connected to MongoDB!");
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => res.send("Go Parcel Server is Running!"));
server.listen(port, () => console.log(`Server running on port ${port}`));
