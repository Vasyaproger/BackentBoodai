const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const axios = require("axios");
const admin = require("firebase-admin");
const redis = require("redis");
const sharp = require("sharp");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
});
app.use("/api/", limiter);

// Constants
const JWT_SECRET = "your_jwt_secret_key";
const S3_BUCKET = "4eeafbc6-4af2cd44-4c23-4530-a2bf-750889dfdf75";
const TELEGRAM_BOT_TOKEN = "7858016810:AAELHxlmZORP7iHEIWdqYKw-rHl-q3aB8yY";

// Redis client
const redisClient = redis.createClient({
  url: "redis://localhost:6379",
});
redisClient.on("error", (err) => console.error("Redis error:", err));
redisClient.connect();

// Firebase Admin SDK
const serviceAccount = require("./boodai-pizza-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const firestore = admin.firestore();

// S3 Client
const s3Client = new S3Client({
  credentials: {
    accessKeyId: "DN1NLZTORA2L6NZ529JJ",
    secretAccessKey: "iGg3syd3UiWzhoYbYlEEDSVX1HHVmWUptrBt81Y8",
  },
  endpoint: "https://s3.twcstorage.ru",
  region: "ru-1",
  forcePathStyle: true,
});

// Multer setup
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
}).single("image");

// Database setup
const db = mysql.createPool({
  host: "vh438.timeweb.ru",
  user: "ch79145_boodai",
  password: "16162007",
  database: "ch79145_boodai",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// S3 Functions
const uploadToS3 = async (file, isImage = true) => {
  const key = `boody-images/${Date.now()}${path.extname(file.originalname)}`;
  let buffer = file.buffer;
  if (isImage) {
    buffer = await sharp(file.buffer)
      .resize({ width: 800, height: 800, fit: "contain" })
      .jpeg({ quality: 80 })
      .toBuffer();
  }
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: isImage ? "image/jpeg" : file.mimetype,
  };
  const upload = new Upload({ client: s3Client, params });
  await upload.done();
  return key;
};

const getFromS3 = async (key) => {
  const params = { Bucket: S3_BUCKET, Key: key };
  const command = new GetObjectCommand(params);
  return await s3Client.send(command);
};

const deleteFromS3 = async (key) => {
  const params = { Bucket: S3_BUCKET, Key: key };
  const command = new DeleteObjectCommand(params);
  await s3Client.send(command);
};

// Middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Token missing" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
};

const optionalAuthenticateToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (token) {
    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (!err) req.user = user;
      next();
    });
  } else {
    next();
  }
};

// Cache middleware
const cache = (duration) => async (req, res, next) => {
  const key = `cache:${req.originalUrl}`;
  const cached = await redisClient.get(key);
  if (cached) {
    return res.json(JSON.parse(cached));
  }
  res.sendResponse = res.json;
  res.json = (body) => {
    redisClient.setEx(key, duration, JSON.stringify(body));
    res.sendResponse(body);
  };
  next();
};

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err.stack);
  res.status(500).json({ error: "Internal server error" });
});

// Database initialization
const initializeDatabase = async () => {
  const connection = await db.getConnection();
  try {
    // Create tables with indexes
    await connection.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address VARCHAR(255),
        phone VARCHAR(20),
        telegram_chat_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_name (name)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        price_small DECIMAL(10,2),
        price_medium DECIMAL(10,2),
        price_large DECIMAL(10,2),
        price_single DECIMAL(10,2),
        branch_id INT,
        category_id INT,
        sub_category_id INT,
        image VARCHAR(255),
        mini_recipe TEXT,
        is_pizza BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        INDEX idx_branch_id (branch_id),
        INDEX idx_category_id (category_id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        INDEX idx_name (name)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS subcategories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category_id INT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
        INDEX idx_category_id (category_id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        discount_percent INT NOT NULL,
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_code (code)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        branch_id INT NOT NULL,
        total DECIMAL(10,2) NOT NULL,
        status ENUM('pending', 'processing', 'completed', 'cancelled') DEFAULT 'pending',
        order_details JSON,
        delivery_details JSON,
        cart_items JSON,
        discount INT DEFAULT 0,
        promo_code VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        INDEX idx_branch_id (branch_id),
        INDEX idx_status (status)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        image VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS discounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        discount_percent INT NOT NULL,
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        INDEX idx_product_id (product_id)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS banners (
        id INT AUTO_INCREMENT PRIMARY KEY,
        image VARCHAR(255) NOT NULL,
        title VARCHAR(255),
        description TEXT,
        button_text VARCHAR(100),
        promo_code_id INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_email (email)
      )
    `);

    // Seed admin user
    const [users] = await connection.query("SELECT * FROM users WHERE email = ?", ["admin@boodaypizza.com"]);
    if (users.length === 0) {
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await connection.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", ["Admin", "admin@boodaypizza.com", hashedPassword]);
    }

    // Seed branches
    const [branches] = await connection.query("SELECT * FROM branches");
    if (branches.length === 0) {
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["BOODAI PIZZA", "-1002311447135"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Район", "-1002638475628"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Араванский", "-1002311447135"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Ошский район", "-1002638475628"]);
    }
  } finally {
    connection.release();
  }
};

// Routes
app.get("/", (req, res) => res.send("Booday Pizza API"));

app.get("/api/public/branches", cache(300), async (req, res) => {
  const [branches] = await db.query("SELECT id, name, address, telegram_chat_id FROM branches");
  res.json(branches);
});

app.get("/api/public/branches/:branchId/products", cache(300), async (req, res) => {
  const { branchId } = req.params;
  const [products] = await db.query(`
    SELECT p.id, p.name, p.description, p.price_small, p.price_medium, p.price_large, 
           p.price_single AS price, p.image AS image_url, c.name AS category,
           d.discount_percent, d.expires_at
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
    WHERE p.branch_id = ?
  `, [branchId]);
  res.json(products);
});

app.get("/api/public/branches/:branchId/orders", async (req, res) => {
  const { branchId } = req.params;
  const [orders] = await db.query(`
    SELECT id, total, created_at, status
    FROM orders
    WHERE branch_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `, [branchId]);
  res.json(orders);
});

app.get("/api/public/stories", cache(300), async (req, res) => {
  const [stories] = await db.query("SELECT * FROM stories");
  const storiesWithUrls = stories.map(story => ({
    ...story,
    image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`
  }));
  res.json(storiesWithUrls);
});

app.get("/api/public/banners", cache(300), async (req, res) => {
  const [banners] = await db.query("SELECT * FROM banners");
  const bannersWithUrls = banners.map(banner => ({
    ...banner,
    image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`
  }));
  res.json(bannersWithUrls);
});

app.get("/api/public/banners/:id", async (req, res) => {
  const { id } = req.params;
  const [banners] = await db.query("SELECT * FROM banners WHERE id = ?", [id]);
  if (banners.length === 0) {
    return res.status(404).json({ error: "Banner not found" });
  }
  const banner = banners[0];
  res.json({
    ...banner,
    image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`
  });
});

app.post("/api/public/validate-promo", async (req, res) => {
  const { promoCode } = req.body;
  const [promo] = await db.query("SELECT discount_percent AS discount FROM promo_codes WHERE code = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())", [promoCode]);
  if (promo.length === 0) {
    return res.status(400).json({ message: "Invalid promo code" });
  }
  res.json({ discount: promo[0].discount });
});

app.post("/api/public/send-order", async (req, res) => {
  const { orderDetails, deliveryDetails, cartItems, discount, promoCode, branchId, userId, boodaiCoinsUsed } = req.body;
  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: "Cart is empty or invalid" });
  }
  if (!branchId) {
    return res.status(400).json({ error: "Branch ID is required" });
  }

  const total = cartItems.reduce((sum, item) => sum + (Number(item.originalPrice) || 0) * item.quantity, 0);
  const discountedTotal = total * (1 - (discount || 0) / 100);
  let finalTotal = discountedTotal;
  let coinsUsed = Number(boodaiCoinsUsed) || 0;
  let coinsEarned = total * 0.05;

  const escapeMarkdown = (text) => (text ? text.replace(/([_*[\]()~`>#+-.!])/g, "\\$1") : "None");
  const orderText = `
📦 *New Order:*
🏪 Branch: ${escapeMarkdown((await db.query("SELECT name FROM branches WHERE id = ?", [branchId]))[0][0]?.name || "Unknown")}
👤 Name: ${escapeMarkdown(orderDetails.name || deliveryDetails.name)}
📞 Phone: ${escapeMarkdown(orderDetails.phone || deliveryDetails.phone)}
📝 Comments: ${escapeMarkdown(orderDetails.comments || deliveryDetails.comments || "None")}
📍 Address: ${escapeMarkdown(deliveryDetails.address || "Pickup")}

🛒 *Items:*
${cartItems.map((item) => `- ${escapeMarkdown(item.name)} (${item.quantity} x ${item.originalPrice} KGS)`).join("\n")}

💰 Total: ${total.toFixed(2)} KGS
${promoCode ? `💸 Discount (${discount}%): ${discountedTotal.toFixed(2)} KGS` : "💸 No discount"}
${coinsUsed > 0 ? `📉 Used Boodai Coins: ${coinsUsed.toFixed(2)}` : ""}
💰 Final Total: ${finalTotal.toFixed(2)} KGS
  `;

  const [result] = await db.query(
    `INSERT INTO orders (branch_id, total, status, order_details, delivery_details, cart_items, discount, promo_code)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      branchId,
      finalTotal,
      JSON.stringify(orderDetails),
      JSON.stringify(deliveryDetails),
      JSON.stringify(cartItems),
      discount || 0,
      promoCode || null,
    ]
  );

  const [branch] = await db.query("SELECT name, telegram_chat_id FROM branches WHERE id = ?", [branchId]);
  if (branch.length === 0) {
    return res.status(400).json({ error: `Branch with id ${branchId} not found` });
  }

  const chatId = branch[0].telegram_chat_id;
  if (!chatId) {
    return res.status(500).json({ error: `Telegram chat ID not set for branch "${branch[0].name}"` });
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: orderText,
      parse_mode: "Markdown",
    });
  } catch (telegramError) {
    if (telegramError.response?.data?.error_code === 403) {
      return res.status(500).json({ error: `Bot lacks permissions in chat (chat_id: ${chatId})` });
    }
    return res.status(500).json({ error: `Failed to send to Telegram: ${telegramError.message}` });
  }

  let newBalance = 0;
  if (userId) {
    try {
      const userRef = firestore.collection("users").doc(userId);
      const userDoc = await userRef.get();
      if (!userDoc.exists) {
        console.warn(`User ${userId} not found in Firestore`);
      } else {
        const userData = userDoc.data();
        const currentCoins = Number(userData.boodaiCoins) || 0;
        if (coinsUsed > currentCoins) {
          return res.status(400).json({ error: `Insufficient Boodai Coins: ${currentCoins.toFixed(2)} available` });
        }
        newBalance = currentCoins - coinsUsed + coinsEarned;
        finalTotal = Math.max(0, discountedTotal - coinsUsed);
        await userRef.update({ boodaiCoins: newBalance });
        await firestore.collection("transactions").add({
          userId,
          type: "order",
          amount: coinsEarned,
          coinsUsed,
          orderTotal: total,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    } catch (firestoreError) {
      console.error("Firestore error:", firestoreError.message);
    }
  }

  res.status(200).json({ message: "Order sent", orderId: result.insertId, boodaiCoins: newBalance });
});

app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
  if (users.length === 0) return res.status(401).json({ error: "Invalid credentials" });

  const user = users[0];
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.get("/branches", authenticateToken, async (req, res) => {
  const [branches] = await db.query("SELECT * FROM branches");
  res.json(branches);
});

app.get("/products", authenticateToken, async (req, res) => {
  const [products] = await db.query(`
    SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name,
           d.discount_percent, d.expires_at, d.is_active as discount_active
    FROM products p
    LEFT JOIN branches b ON p.branch_id = b.id
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN subcategories s ON p.sub_category_id = s.id
    LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
  `);
  res.json(products);
});

app.get("/discounts", authenticateToken, async (req, res) => {
  const [discounts] = await db.query(`
    SELECT d.*, p.name as product_name 
    FROM discounts d
    JOIN products p ON d.product_id = p.id
    WHERE d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
  `);
  res.json(discounts);
});

app.get("/stories", authenticateToken, async (req, res) => {
  const [stories] = await db.query("SELECT * FROM stories");
  const storiesWithUrls = stories.map(story => ({
    ...story,
    image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`
  }));
  res.json(storiesWithUrls);
});

app.get("/banners", authenticateToken, async (req, res) => {
  const [banners] = await db.query(`
    SELECT b.*, pc.code AS promo_code, pc.discount_percent
    FROM banners b
    LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
  `);
  const bannersWithUrls = banners.map(banner => ({
    ...banner,
    image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
    promo_code: banner.promo_code ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 } : null
  }));
  res.json(bannersWithUrls);
});

app.get("/banners/:id", async (req, res) => {
  const { id } = req.params;
  const [banners] = await db.query(`
    SELECT b.*, pc.code AS promo_code, pc.discount_percent
    FROM banners b
    LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
    WHERE b.id = ?
  `, [id]);
  if (banners.length === 0) {
    return res.status(404).json({ error: "Banner not found" });
  }
  const banner = banners[0];
  res.json({
    ...banner,
    image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
    promo_code: banner.promo_code ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 } : null
  });
});

app.post("/banners", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload failed: " + err.message });
    const { title, description, button_text, promo_code_id } = req.body;
    if (!req.file) return res.status(400).json({ error: "Image required" });

    let imageKey;
    try {
      imageKey = await uploadToS3(req.file);
      const [result] = await db.query(
        "INSERT INTO banners (image, title, description, button_text, promo_code_id) VALUES (?, ?, ?, ?, ?)",
        [imageKey, title || null, description || null, button_text || null, promo_code_id || null]
      );
      const [newBanner] = await db.query(`
        SELECT b.*, pc.code AS promo_code, pc.discount_percent
        FROM banners b
        LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
        WHERE b.id = ?
      `, [result.insertId]);
      const banner = newBanner[0];
      res.status(201).json({
        id: result.insertId,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
        title,
        description,
        button_text,
        promo_code_id,
        promo_code: banner.promo_code ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 } : null
      });
    } catch (err) {
      res.status(500).json({ error: "Server error: " + err.message });
    }
  });
});

app.put("/banners/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload failed: " + err.message });
    const { id } = req.params;
    const { title, description, button_text, promo_code_id } = req.body;
    let imageKey;
    try {
      const [existing] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Banner not found" });
      imageKey = req.file ? await uploadToS3(req.file) : existing[0].image;
      if (req.file && existing[0].image) await deleteFromS3(existing[0].image);
      await db.query(
        "UPDATE banners SET image = ?, title = ?, description = ?, button_text = ?, promo_code_id = ? WHERE id = ?",
        [imageKey, title || null, description || null, button_text || null, promo_code_id || null, id]
      );
      const [updatedBanner] = await db.query(`
        SELECT b.*, pc.code AS promo_code, pc.discount_percent
        FROM banners b
        LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
        WHERE b.id = ?
      `, [id]);
      const banner = updatedBanner[0];
      res.json({
        id,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
        title,
        description,
        button_text,
        promo_code_id,
        promo_code: banner.promo_code ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 } : null
      });
    } catch (err) {
      res.status(500).json({ error: "Server error: " + err.message });
    }
  });
});

app.delete("/banners/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const [banner] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
  if (banner.length === 0) return res.status(404).json({ error: "Banner not found" });
  if (banner[0].image) await deleteFromS3(banner[0].image);
  await db.query("DELETE FROM banners WHERE id = ?", [id]);
  res.json({ message: "Banner deleted" });
});

app.get("/categories", authenticateToken, async (req, res) => {
  const [categories] = await db.query("SELECT * FROM categories");
  res.json(categories);
});

app.get("/promo-codes", authenticateToken, async (req, res) => {
  const [promoCodes] = await db.query("SELECT * FROM promo_codes");
  res.json(promoCodes);
});

app.get("/promo-codes/check/:code", authenticateToken, async (req, res) => {
  const { code } = req.params;
  const [promo] = await db.query("SELECT * FROM promo_codes WHERE code = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())", [code]);
  if (promo.length === 0) return res.status(404).json({ error: "Promo code not found or invalid" });
  res.json(promo[0]);
});

app.post("/promo-codes", authenticateToken, async (req, res) => {
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Code and discount percent required" });
  const [result] = await db.query(
    "INSERT INTO promo_codes (code, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)",
    [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true]
  );
  res.status(201).json({ id: result.insertId, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
});

app.put("/promo-codes/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Code and discount percent required" });
  await db.query(
    "UPDATE promo_codes SET code = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?",
    [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id]
  );
  res.json({ id, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
});

app.delete("/promo-codes/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  await db.query("DELETE FROM promo_codes WHERE id = ?", [id]);
  res.json({ message: "Promo code deleted" });
});

app.post("/branches", authenticateToken, async (req, res) => {
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Branch name required" });
  const [result] = await db.query("INSERT INTO branches (name, address, phone, telegram_chat_id) VALUES (?, ?, ?, ?)", [name, address || null, phone || null, telegram_chat_id || null]);
  res.status(201).json({ id: result.insertId, name, address, phone, telegram_chat_id });
});

app.put("/branches/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Branch name required" });
  await db.query("UPDATE branches SET name = ?, address = ?, phone = ?, telegram_chat_id = ? WHERE id = ?", [name, address || null, phone || null, telegram_chat_id || null, id]);
  res.json({ id, name, address, phone, telegram_chat_id });
});

app.delete("/branches/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  await db.query("DELETE FROM branches WHERE id = ?", [id]);
  res.json({ message: "Branch deleted" });
});

app.post("/categories", authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Category name required" });
  const [result] = await db.query("INSERT INTO categories (name) VALUES (?)", [name]);
  res.status(201).json({ id: result.insertId, name });
});

app.put("/categories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Category name required" });
  await db.query("UPDATE categories SET name = ? WHERE id = ?", [name, id]);
  res.json({ id, name });
});

app.delete("/categories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  await db.query("DELETE FROM categories WHERE id = ?", [id]);
  res.json({ message: "Category deleted" });
});

app.get("/subcategories", authenticateToken, async (req, res) => {
  const [subcategories] = await db.query(`
    SELECT s.*, c.name as category_name 
    FROM subcategories s
    JOIN categories c ON s.category_id = c.id
  `);
  res.json(subcategories);
});

app.post("/subcategories", authenticateToken, async (req, res) => {
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Name and category required" });
  const [result] = await db.query("INSERT INTO subcategories (name, category_id) VALUES (?, ?)", [name, categoryId]);
  const [newSubcategory] = await db.query(
    "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
    [result.insertId]
  );
  res.status(201).json(newSubcategory[0]);
});

app.put("/subcategories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Name and category required" });
  await db.query("UPDATE subcategories SET name = ?, category_id = ? WHERE id = ?", [name, categoryId, id]);
  const [updatedSubcategory] = await db.query(
    "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
    [id]
  );
  res.json(updatedSubcategory[0]);
});

app.delete("/subcategories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  await db.query("DELETE FROM subcategories WHERE id = ?", [id]);
  res.json({ message: "Subcategory deleted" });
});

app.post("/products", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload failed: " + err.message });
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId } = req.body;
    if (!req.file) return res.status(400).json({ error: "Image required" });
    let imageKey = await uploadToS3(req.file);
    if (!name || !branchId || !categoryId) return res.status(400).json({ error: "Name, branchId, and categoryId required" });
    const [result] = await db.query(
      `INSERT INTO products (
        name, description, price_small, price_medium, price_large, price_single, 
        branch_id, category_id, sub_category_id, image
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        description || null,
        priceSmall ? parseFloat(priceSmall) : null,
        priceMedium ? parseFloat(priceMedium) : null,
        priceLarge ? parseFloat(priceLarge) : null,
        priceSingle ? parseFloat(priceSingle) : null,
        branchId,
        categoryId,
        subCategoryId || null,
        imageKey,
      ]
    );
    const [newProduct] = await db.query(
      `SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name
       FROM products p
       LEFT JOIN branches b ON p.branch_id = b.id
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN subcategories s ON p.sub_category_id = s.id
       WHERE p.id = ?`,
      [result.insertId]
    );
    res.status(201).json(newProduct[0]);
  });
});

app.put("/products/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload failed: " + err.message });
    const { id } = req.params;
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId } = req.body;
    const [existing] = await db.query("SELECT image FROM products WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Product not found" });
    let imageKey = req.file ? await uploadToS3(req.file) : existing[0].image;
    if (req.file && existing[0].image) await deleteFromS3(existing[0].image);
    await db.query(
      `UPDATE products SET 
        name = ?, description = ?, price_small = ?, price_medium = ?, price_large = ?, 
        price_single = ?, branch_id = ?, category_id = ?, sub_category_id = ?, image = ? 
      WHERE id = ?`,
      [
        name,
        description || null,
        priceSmall ? parseFloat(priceSmall) : null,
        priceMedium ? parseFloat(priceMedium) : null,
        priceLarge ? parseFloat(priceLarge) : null,
        priceSingle ? parseFloat(priceSingle) : null,
        branchId,
        categoryId,
        subCategoryId || null,
        imageKey,
        id,
      ]
    );
    const [updatedProduct] = await db.query(
      `SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name
       FROM products p
       LEFT JOIN branches b ON p.branch_id = b.id
       LEFT JOIN categories c ON p.category_id = c.id
       LEFT JOIN subcategories s ON p.sub_category_id = s.id
       WHERE p.id = ?`,
      [id]
    );
    res.json(updatedProduct[0]);
  });
});

app.delete("/products/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const [product] = await db.query("SELECT image FROM products WHERE id = ?", [id]);
  if (product.length === 0) return res.status(404).json({ error: "Product not found" });
  if (product[0].image) await deleteFromS3(product[0].image);
  await db.query("DELETE FROM products WHERE id = ?", [id]);
  res.json({ message: "Product deleted" });
});

app.post("/discounts", authenticateToken, async (req, res) => {
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent || discountPercent < 1 || discountPercent > 100) {
    return res.status(400).json({ error: "Valid product ID and discount percent (1-100) required" });
  }
  const [product] = await db.query("SELECT id FROM products WHERE id = ?", [productId]);
  if (product.length === 0) return res.status(404).json({ error: "Product not found" });
  const [existingDiscount] = await db.query(`
    SELECT id FROM discounts 
    WHERE product_id = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
  `, [productId]);
  if (existingDiscount.length > 0) return res.status(400).json({ error: "Active discount already exists for this product" });
  const [result] = await db.query(
    "INSERT INTO discounts (product_id, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)",
    [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true]
  );
  const [newDiscount] = await db.query(`
    SELECT d.*, p.name as product_name 
    FROM discounts d
    JOIN products p ON d.product_id = p.id
    WHERE d.id = ?
  `, [result.insertId]);
  res.status(201).json(newDiscount[0]);
});

app.put("/discounts/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent || discountPercent < 1 || discountPercent > 100) {
    return res.status(400).json({ error: "Valid product ID and discount percent (1-100) required" });
  }
  const [discount] = await db.query("SELECT product_id FROM discounts WHERE id = ?", [id]);
  if (discount.length === 0) return res.status(404).json({ error: "Discount not found" });
  const [product] = await db.query("SELECT id FROM products WHERE id = ?", [productId]);
  if (product.length === 0) return res.status(404).json({ error: "Product not found" });
  if (discount[0].product_id !== productId) {
    const [existingDiscount] = await db.query(`
      SELECT id FROM discounts 
      WHERE product_id = ? AND id != ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
    `, [productId, id]);
    if (existingDiscount.length > 0) return res.status(400).json({ error: "Another active discount exists for this product" });
  }
  await db.query(
    "UPDATE discounts SET product_id = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?",
    [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id]
  );
  const [updatedDiscount] = await db.query(`
    SELECT d.*, p.name as product_name 
    FROM discounts d
    JOIN products p ON d.product_id = p.id
    WHERE d.id = ?
  `, [id]);
  res.json(updatedDiscount[0]);
});

app.delete("/discounts/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const [discount] = await db.query(`
    SELECT d.*, p.name as product_name 
    FROM discounts d
    JOIN products p ON d.product_id = p.id
    WHERE d.id = ?
  `, [id]);
  if (discount.length === 0) return res.status(404).json({ error: "Discount not found" });
  await db.query("DELETE FROM discounts WHERE id = ?", [id]);
  res.json({ message: "Discount deleted", product: { id: discount[0].product_id, name: discount[0].product_name } });
});

app.post("/stories", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload failed: " + err.message });
    if (!req.file) return res.status(400).json({ error: "Image required" });
    let imageKey = await uploadToS3(req.file);
    const [result] = await db.query("INSERT INTO stories (image) VALUES (?)", [imageKey]);
    res.status(201).json({ id: result.insertId, image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}` });
  });
});

app.put("/stories/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload failed: " + err.message });
    const { id } = req.params;
    const [existing] = await db.query("SELECT image FROM stories WHERE id = ?", [id]);
    if (existing.length === 0) return res.status(404).json({ error: "Story not found" });
    let imageKey = req.file ? await uploadToS3(req.file) : existing[0].image;
    if (req.file && existing[0].image) await deleteFromS3(existing[0].image);
    await db.query("UPDATE stories SET image = ? WHERE id = ?", [imageKey, id]);
    res.json({ id, image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}` });
  });
});

app.delete("/stories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const [story] = await db.query("SELECT image FROM stories WHERE id = ?", [id]);
  if (story.length === 0) return res.status(404).json({ error: "Story not found" });
  if (story[0].image) await deleteFromS3(story[0].image);
  await db.query("DELETE FROM stories WHERE id = ?", [id]);
  res.json({ message: "Story deleted" });
});

app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });
  const [existingUsers] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
  if (existingUsers.length > 0) return res.status(400).json({ error: "Email already exists" });
  const hashedPassword = await bcrypt.hash(password, 10);
  const [result] = await db.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hashedPassword]);
  const token = jwt.sign({ id: result.insertId, email }, JWT_SECRET, { expiresIn: "1h" });
  res.status(201).json({ token, user: { id: result.insertId, name, email } });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });
  const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
  if (users.length === 0) return res.status(401).json({ error: "Invalid credentials" });
  const user = users[0];
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "1h" });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.get("/users", authenticateToken, async (req, res) => {
  const [users] = await db.query("SELECT id, name, email FROM users");
  res.json(users);
});

app.get("/product-image/:key", optionalAuthenticateToken, async (req, res) => {
  const { key } = req.params;
  try {
    const image = await getFromS3(`boody-images/${key}`);
    res.setHeader("Content-Type", image.ContentType || "image/jpeg");
    image.Body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch image: " + err.message });
  }
});

// Initialize server
const startServer = async () => {
  try {
    await initializeDatabase();
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: "test-connection.txt",
      Body: "Test file for S3 connection.",
    }));
    app.listen(5000, () => console.log("Server running on port 5000"));
  } catch (err) {
    console.error("Server initialization failed:", err.message);
    process.exit(1);
  }
};

startServer();