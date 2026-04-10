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
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

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
app.use(
  cors({
    origin: ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
  }),
);
app.use(express.json());

// --- HELPER FUNCTIONS ---
function generateTrackingId() {
  const prefix = "PRCL";
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}-${date}-${random}`;
}

// --- MIDDLEWARES ---

// ১. টোকেন ভেরিফিকেশন (Firebase ID Token)
const verifyToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.decoded_email = decodedToken.email;
    next();
  } catch (error) {
    console.error("Firebase Auth Error:", error.message);
    return res.status(401).send({ message: "Invalid or Expired Token" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@goparcel.o5leubt.mongodb.net/?appName=GoParcel`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("go_parcel_db");
    const userCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const notificationsCollection = db.collection("notifications");
    const ridersCollection = db.collection("riders");
    const parcelCollection = client.db("go_parcel_db").collection("parcels");

    // ২. অ্যাডমিন ভেরিফিকেশন মিডলওয়্যার
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await userCollection.findOne({ email });
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }
      next();
    };

    // --- SOCKET.IO CONNECTION ---
    io.on("connection", (socket) => {
      socket.on("join", (email) => {
        socket.join(email);
      });
    });

    // -----------------------
    // USERS API
    // -----------------------

    // সব ইউজার ম্যানেজমেন্ট (অ্যাডমিনের জন্য)
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const searchText = req.query.searchText || "";
      let query = {};
      if (searchText) {
        query = {
          $or: [
            { displayName: { $regex: searchText, $options: "i" } },
            { email: { $regex: searchText, $options: "i" } },
          ],
        };
      }
      const result = await userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // ইউজারের রোল চেক করা
    app.get("/users/role/:email", async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      res.send({ role: user?.role || "user" });
    });

    // ইউজার রোল আপডেট করা (Admin, Rider, User)
    app.patch("/users/role/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { role } = req.body;
      const result = await userCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { role: role } },
      );
      res.send(result);
    });

    // ইউজার সেভ করা (Login/Registration এর সময়)
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
    // RIDER MANAGEMENT API
    // -----------------------
    // --- RIDER MANAGEMENT APIs ---

    // ১. রাইডার লিস্ট দেখার এপিআই (riders কালেকশন থেকে)
    app.get("/admin/riders", verifyToken, verifyAdmin, async (req, res) => {
      const ridersCollection = db.collection("riders");
      const result = await ridersCollection.find().toArray();
      res.send(result);
    });

    // ২. রাইডার এপ্রুভ করার এপিআই
    // app.patch(
    //   "/admin/riders/accept/:id",
    //   verifyToken,
    //   verifyAdmin,
    //   async (req, res) => {
    //     const id = req.params.id;
    //     const ridersCollection = db.collection("riders");
    //     const filter = { _id: new ObjectId(id) };

    //     // riders কালেকশনে স্ট্যাটাস আপডেট
    //     const result = await ridersCollection.updateOne(filter, {
    //       $set: { riderStatus: "verified" },
    //     });

    //     // ঐ ইউজারকে 'users' কালেকশনেও 'rider' রোল দেওয়া
    //     const riderInfo = await ridersCollection.findOne(filter);
    //     if (riderInfo) {
    //       await userCollection.updateOne(
    //         { email: riderInfo.email },
    //         { $set: { role: "rider" } },
    //       );
    //     }
    //     res.send(result);
    //   },
    // );

    // রাইডার স্ট্যাটাস এবং ইউজার রোল আপডেট করার এপিআই
    app.patch("/riders/:id", verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const { status, email } = req.body; // ফ্রন্টএন্ড থেকে স্ট্যাটাস এবং ইমেইল আসছে

      const filter = { _id: new ObjectId(id) };
      const riderUpdate = {
        $set: { status: status },
      };

      // ১. রাইডার কালেকশন আপডেট
      const result = await ridersCollection.updateOne(filter, riderUpdate);

      // ২. যদি স্ট্যাটাস 'approved' হয়, তবে ইউজার কালেকশনে রোল আপডেট করুন
      if (status === "approved") {
        await userCollection.updateOne(
          { email: email },
          { $set: { role: "rider" } },
        );
      }

      // যদি রিজেক্ট করা হয়, তবে রোল 'user' ই থাকবে (অথবা আপনার প্রয়োজন অনুযায়ী পরিবর্তন করতে পারেন)
      if (status === "rejected") {
        await userCollection.updateOne(
          { email: email },
          { $set: { role: "user" } },
        );
      }

      res.send(result);
    });

    // ৩. রাইডার ব্যান করার এপিআই
    app.patch(
      "/admin/riders/ban/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const ridersCollection = db.collection("riders");
        const filter = { _id: new ObjectId(id) };

        const result = await ridersCollection.updateOne(filter, {
          $set: { riderStatus: "banned" },
        });

        // ব্যান করলে ইউজারের রোল আবার 'user' করে দেওয়া
        const riderInfo = await ridersCollection.findOne(filter);
        if (riderInfo) {
          await userCollection.updateOne(
            { email: riderInfo.email },
            { $set: { role: "user" } },
          );
        }
        res.send(result);
      },
    );

    // Riders Api
    app.post("/riders", verifyToken, async (req, res) => {
      try {
        const application = req.body;
        const email = req.decoded_email;

        // ১. riders কালেকশনে নতুন ডাটা ইনসার্ট করা
        const applicationData = {
          ...application,
          email: email, // নিশ্চিত করার জন্য ইমেইলটি আবার সেট করা হলো
          riderStatus: "pending",
          appliedAt: new Date(),
        };

        const ridersCollection = client.db("go_parcel_db").collection("riders");
        const insertResult = await ridersCollection.insertOne(applicationData);

        // ২. userCollection-এ ইউজারের স্ট্যাটাস 'pending' করা (ঐচ্ছিক কিন্তু ভালো)
        const filter = { email: email };
        const updatedDoc = {
          $set: {
            riderStatus: "pending",
            applicationId: insertResult.insertedId, // রেফারেন্সের জন্য আইডি রাখা
          },
        };
        await client
          .db("go_parcel_db")
          .collection("users")
          .updateOne(filter, updatedDoc);

        // সব শেষে একবারই রেসপন্স পাঠানো
        res.send(insertResult);
      } catch (error) {
        console.error("Error applying for rider:", error);
        res.status(500).send({ message: "Application failed!" });
      }
    });
    // -----------------------
    // PARCEL API
    // -----------------------

    // ইউজারের নিজের পার্সেল লিস্ট
    app.get("/parcels", verifyToken, async (req, res) => {
      const { email } = req.query;
      if (!email) return res.status(400).send({ message: "Email required" });
      const result = await parcelsCollection
        .find({ senderEmail: email })
        .toArray();
      res.send(result);
    });

    // সব পার্সেল লিস্ট (Admin এর জন্য)
    app.get("/all-parcels", verifyToken, verifyAdmin, async (req, res) => {
      const result = await parcelsCollection
        .find()
        .sort({ bookingDate: -1 })
        .toArray();
      res.send(result);
    });

    // পার্সেল বুকিং করা
    app.post("/parcels", verifyToken, async (req, res) => {
      const parcelData = req.body;
      parcelData.deliveryStatus = "pending";
      parcelData.paymentStatus = "unpaid";
      parcelData.bookingDate = new Date();
      const result = await parcelsCollection.insertOne(parcelData);
      res.send(result);
    });

    // ডেলিভারি ডেট আপডেট করা
    app.patch(
      "/parcels/update-date/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const { deliveryDate } = req.body;
        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
          { $set: { deliveryDate, deliveryStatus: "on-the-way" } },
        );
        res.send(result);
      },
    );

    app.patch("/parcels/assign/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const info = req.body;

        // ১. চেক করা আইডিটি কি আদৌ ভ্যালিড?
        if (!id || id === "undefined" || id.length !== 24) {
          return res.status(400).send({ message: "Invalid or missing ID" });
        }

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            riderEmail: info.riderEmail,
            approximateDeliveryDate: info.approximateDeliveryDate,
            deliveryStatus: info.deliveryStatus,
          },
        };

        const result = await parcelCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        // ২. এরর হলে সার্ভার ক্র্যাশ না করে কনসোলে দেখাবে
        console.error("Assign Error:", error.message);
        res
          .status(500)
          .send({ message: "Internal Server Error", error: error.message });
      }
    });

    // রাইডার যখন পার্সেল একসেপ্ট করবে বা স্ট্যাটাস আপডেট করবে
    app.patch("/parcels/:id/status", async (req, res) => {
      try {
        const id = req.params.id;
        const { deliveryStatus } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid ID format" });
        }

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: { deliveryStatus: deliveryStatus },
        };

        // আপনার কোডে কালেকশনের নাম 'parcelCollection' ব্যবহার করা হয়েছে
        const result = await parcelCollection.updateOne(filter, updateDoc);

        if (result.modifiedCount > 0) {
          res.send(result);
        } else {
          res
            .status(404)
            .send({ message: "Parcel not found or no changes made" });
        }
      } catch (error) {
        console.error("Status Update Error:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // রাইডার দ্বারা পার্সেল রিজেক্ট করার রুট
    app.patch("/parcels/reject/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };

        // আপডেট ডাটা: স্ট্যাটাস পেন্ডিং হবে এবং রাইডারের তথ্য রিমুভ হবে
        const updateDoc = {
          $set: {
            deliveryStatus: "pending",
            riderEmail: null,
            approximateDeliveryDate: null,
          },
          // যদি আপনি হিস্ট্রি রাখতে চান তবে $unset ব্যবহার করতে পারেন
          // অথবা শুধু null সেট করলেই রাইডার ড্যাশবোর্ড থেকে এটি চলে যাবে
        };

        const result = await parcelCollection.updateOne(filter, updateDoc);

        if (result.modifiedCount > 0) {
          res.send(result);
        } else {
          res
            .status(404)
            .send({ message: "Parcel not found or no changes made" });
        }
      } catch (error) {
        console.error("Reject Error:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });
    // -----------------------
    // PAYMENT (STRIPE) API
    // -----------------------
    app.post("/create-checkout-session", verifyToken, async (req, res) => {
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
        metadata: { parcelId, senderEmail, parcelName },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        if (session.payment_status === "paid") {
          const existingPayment = await paymentCollection.findOne({
            transactionId: session.payment_intent,
          });

          if (existingPayment) {
            return res.send({ success: true, message: "Already processed" });
          }
          const { parcelId, senderEmail, parcelName } = session.metadata; // মেটাডাটা থেকে নাম নিলেন
          const trackingId = generateTrackingId();

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

          const payment = {
            amount: session.amount_total / 100,
            customerEmail: session.metadata.senderEmail,
            parcelName: session.metadata.parcelName,
            transactionId: session.payment_intent,
            trackingId,
            paidAt: new Date(),
          };
          await paymentCollection.insertOne(payment);
          res.send({ success: true, trackingId });
        }
      } catch (err) {
        res.status(500).send({ message: "Payment processing failed" });
      }
    });

    // -----------------------
    // ADMIN STATS
    // -----------------------
    app.get("/admin-stats", verifyToken, verifyAdmin, async (req, res) => {
      const users = await userCollection.estimatedDocumentCount();
      const parcels = await parcelsCollection.estimatedDocumentCount();
      const payments = await paymentCollection.find().toArray();
      const revenue = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
      res.send({ users, parcels, revenue });
    });

    // ২. রাইডার লিস্ট দেখার এপিআই আপডেট করুন
    app.get("/admin/riders", verifyToken, verifyAdmin, async (req, res) => {
      const result = await ridersCollection.find().toArray();
      res.send(result);
    });

    app.patch(
      "/admin/riders/accept/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };

        // রাইডার কালেকশনে স্ট্যাটাস আপডেট
        const result = await ridersCollection.updateOne(filter, {
          $set: { riderStatus: "verified" },
        });

        // ঐ ইউজারকে 'users' কালেকশনেও 'rider' রোল দিয়ে আপডেট করতে হবে
        const riderInfo = await ridersCollection.findOne(filter);
        if (riderInfo) {
          await userCollection.updateOne(
            { email: riderInfo.email },
            { $set: { role: "rider" } },
          );
        }

        res.send(result);
      },
    );

    // payments gets api
    app.get("/payments", verifyToken, async (req, res) => {
      const email = req.query.email;

      // টোকেন এর ইমেইল আর কুয়েরি ইমেইল এক কিনা তা চেক করা (Security)
      if (req.decoded_email !== email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const query = { customerEmail: email };
      const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    // রাইডারের ইমেইল এবং স্ট্যাটাস অনুযায়ী পার্সেল খুঁজে বের করার রুট
    app.get("/parcels/rider", async (req, res) => {
      const email = req.query.riderEmail;
      const status = req.query.deliveryStatus;

      if (!email) {
        return res.status(400).send({ message: "Rider email is required" });
      }

      const query = { riderEmail: email };
      // যদি স্ট্যাটাস পাঠানো হয়, তবেই কুয়েরিতে যোগ হবে
      if (status) {
        query.deliveryStatus = status;
      }

      const result = await parcelCollection.find(query).toArray();
      res.send(result);
    });

    // ব্যাকএন্ডে রাইডারদের লিস্ট পাওয়ার রুট
    app.get("/users/riders", async (req, res) => {
      const query = { role: "rider" };
      const result = await userCollection.find(query).toArray();
      res.send(result);
    });

    console.log("Connected to MongoDB & Ready!");
  } finally {
  }
}
run().catch(console.dir);

app.get("/", (req, res) => res.send("Go Parcel Server is Running!"));
server.listen(port, () => console.log(`Server running on port ${port}`));
