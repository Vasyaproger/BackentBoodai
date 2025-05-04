const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = "your_jwt_secret_key";
const S3_BUCKET = "4eeafbc6-4af2cd44-4c23-4530-a2bf-750889dfdf75";
const TELEGRAM_BOT_TOKEN = "7858016810:AAELHxlmZORP7iHEIWdqYKw-rHl-q3aB8yY";

// S3 Client Configuration
const s3Client = new S3Client({
  credentials: {
    accessKeyId: "DN1NLZTORA2L6NZ529JJ",
    secretAccessKey: "iGg3syd3UiWzhoYbYlEEDSVX1HHVmWUptrBt81Y8",
  },
  endpoint: "https://s3.twcstorage.ru",
  region: "ru-1",
  forcePathStyle: true,
});

// MySQL Connection Pool
const db = mysql.createPool({
  host: "vh438.timeweb.ru",
  user: "ch79145_boodai",
  password: "16162007",
  database: "ch79145_boodai",
  connectionLimit: 10,
});

// Multer for Image Uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
}).single("image");

// S3 Utility Functions
const uploadToS3 = async (file) => {
  const key = `boody-images/${Date.now()}${path.extname(file.originalname)}`;
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  };
  await s3Client.send(new PutObjectCommand(params));
  return key;
};

const getFromS3 = async (key) => {
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
  };
  return await s3Client.send(new GetObjectCommand(params));
};

const deleteFromS3 = async (key) => {
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
  };
  await s3Client.send(new DeleteObjectCommand(params));
};

// JWT Authentication Middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Токен отсутствует" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Недействительный токен" });
    req.user = user;
    next();
  });
};

// Server Initialization
const initializeServer = async () => {
  try {
    const connection = await db.getConnection();
    console.log("Connected to MySQL");

    // Create essential tables
    await connection.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address VARCHAR(255),
        phone VARCHAR(20),
        telegram_chat_id VARCHAR(50)
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
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS subcategories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category_id INT,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS orders (
        id INT AUTO_INCREMENT PRIMARY KEY,
        branch_id INT,
        total DECIMAL(10,2),
        status ENUM('pending', 'processing', 'completed', 'cancelled') DEFAULT 'pending',
        order_details JSON,
        delivery_details JSON,
        cart_items JSON,
        discount INT DEFAULT 0,
        promo_code VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        image VARCHAR(255) NOT NULL
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS banners (
        id INT AUTO_INCREMENT PRIMARY KEY,
        image VARCHAR(255) NOT NULL,
        title VARCHAR(255),
        description TEXT,
        button_text VARCHAR(100)
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        discount_percent INT NOT NULL,
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL
      )
    `);

    // Seed admin user
    const [users] = await connection.query("SELECT * FROM users WHERE email = ?", ["admin@boodaypizza.com"]);
    if (users.length === 0) {
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await connection.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", ["Admin", "admin@boodaypizza.com", hashedPassword]);
      console.log("Admin created: admin@boodaypizza.com / admin123");
    }

    // Seed branches with Telegram chat IDs
    const [branches] = await connection.query("SELECT * FROM branches");
    if (branches.length === 0) {
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["BOODAI PIZZA", "-1002311447135"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Район", "-1002638475628"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Араванский", "-1002311447135"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Ошский район", "-1002638475628"]);
      console.log("Branches seeded");
    }

    connection.release();
    app.listen(5000, () => console.log("Server running on port 5000"));
  } catch (err) {
    console.error("Server initialization error:", err.message);
    process.exit(1);
  }
};

// Public Routes
app.get("/api/public/branches", async (req, res) => {
  try {
    const [branches] = await db.query("SELECT id, name, address, phone FROM branches");
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/public/branches/:branchId/products", async (req, res) => {
  const { branchId } = req.params;
  try {
    const [products] = await db.query(`
      SELECT p.id, p.name, p.description, p.price_small, p.price_medium, p.price_large, 
             p.price_single AS price, p.image AS image_url, c.name AS category
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.branch_id = ?
    `, [branchId]);
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/public/stories", async (req, res) => {
  try {
    const [stories] = await db.query("SELECT id, image FROM stories");
    const storiesWithUrls = stories.map(story => ({
      id: story.id,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`
    }));
    res.json(storiesWithUrls);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/public/banners", async (req, res) => {
  try {
    const [banners] = await db.query("SELECT id, image, title, description, button_text FROM banners");
    const bannersWithUrls = banners.map(banner => ({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`
    }));
    res.json(bannersWithUrls);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/public/send-order", async (req, res) => {
  const { orderDetails, deliveryDetails, cartItems, discount, promoCode, branchId } = req.body;
  if (!cartItems?.length || !branchId) {
    return res.status(400).json({ error: "Invalid cart or branchId" });
  }

  try {
    const total = cartItems.reduce((sum, item) => sum + (Number(item.originalPrice) || 0) * item.quantity, 0);
    const finalTotal = total * (1 - (discount || 0) / 100);

    const escapeMarkdown = (text) => (text ? text.replace(/([_*[\]()~`>#+-.!])/g, "\\$1") : "None");
    const orderText = `
📦 *New Order:*
🏪 Branch: ${escapeMarkdown((await db.query("SELECT name FROM branches WHERE id = ?", [branchId]))[0][0]?.name || "Unknown")}
👤 Name: ${escapeMarkdown(orderDetails.name || deliveryDetails.name)}
📞 Phone: ${escapeMarkdown(orderDetails.phone || deliveryDetails.phone)}
📝 Comments: ${escapeMarkdown(orderDetails.comments || "None")}
📍 Address: ${escapeMarkdown(deliveryDetails.address || "Pickup")}

🛒 *Items:*
${cartItems.map((item) => `- ${escapeMarkdown(item.name)} (${item.quantity} x ${item.originalPrice} KGS)`).join("\n")}

💰 Total: ${total.toFixed(2)} KGS
${promoCode ? `💸 Discount (${discount}%): ${finalTotal.toFixed(2)} KGS` : ""}
    `;

    const [result] = await db.query(
      "INSERT INTO orders (branch_id, total, status, order_details, delivery_details, cart_items, discount, promo_code) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
      [branchId, finalTotal, JSON.stringify(orderDetails), JSON.stringify(deliveryDetails), JSON.stringify(cartItems), discount || 0, promoCode || null]
    );

    const [branch] = await db.query("SELECT telegram_chat_id FROM branches WHERE id = ?", [branchId]);
    if (!branch[0]?.telegram_chat_id) {
      return res.status(500).json({ error: "Branch Telegram chat ID not configured" });
    }

    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: branch[0].telegram_chat_id,
        text: orderText,
        parse_mode: "Markdown",
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      return res.status(500).json({ error: `Telegram error: ${error.description}` });
    }

    res.json({ message: "Order sent", orderId: result.insertId });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/product-image/:key", async (req, res) => {
  try {
    const image = await getFromS3(`boody-images/${req.params.key}`);
    res.setHeader("Content-Type", image.ContentType || "image/jpeg");
    image.Body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: "Image retrieval error" });
  }
});

// Admin Routes
app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required" });

  try {
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0 || !(await bcrypt.compare(password, users[0].password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ id: users[0].id, email }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token, user: { id: users[0].id, name: users[0].name, email } });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/branches", authenticateToken, async (req, res) => {
  try {
    const [branches] = await db.query("SELECT * FROM branches");
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/branches", authenticateToken, async (req, res) => {
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  try {
    const [result] = await db.query("INSERT INTO branches (name, address, phone, telegram_chat_id) VALUES (?, ?, ?, ?)", [name, address || null, phone || null, telegram_chat_id || null]);
    res.status(201).json({ id: result.insertId, name, address, phone, telegram_chat_id });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/branches/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  try {
    await db.query("UPDATE branches SET name = ?, address = ?, phone = ?, telegram_chat_id = ? WHERE id = ?", [name, address || null, phone || null, telegram_chat_id || null, id]);
    res.json({ id, name, address, phone, telegram_chat_id });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/branches/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM branches WHERE id = ?", [id]);
    res.json({ message: "Branch deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/products", authenticateToken, async (req, res) => {
  try {
    const [products] = await db.query(`
      SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name
      FROM products p
      LEFT JOIN branches b ON p.branch_id = b.id
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN subcategories s ON p.sub_category_id = s.id
    `);
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/products", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload error" });
    if (!req.file) return res.status(400).json({ error: "Image required" });

    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId } = req.body;
    if (!name || !branchId || !categoryId) return res.status(400).json({ error: "Required fields missing" });

    try {
      const imageKey = await uploadToS3(req.file);
      const [result] = await db.query(
        `INSERT INTO products (name, description, price_small, price_medium, price_large, price_single, branch_id, category_id, sub_category_id, image)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, description || null, priceSmall || null, priceMedium || null, priceLarge || null, priceSingle || null, branchId, categoryId, subCategoryId || null, imageKey]
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
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });
});

app.put("/products/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload error" });

    const { id } = req.params;
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId } = req.body;

    try {
      const [existing] = await db.query("SELECT image FROM products WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Product not found" });

      const imageKey = req.file ? await uploadToS3(req.file) : existing[0].image;
      if (req.file && existing[0].image) await deleteFromS3(existing[0].image);

      await db.query(
        `UPDATE products SET name = ?, description = ?, price_small = ?, price_medium = ?, price_large = ?, price_single = ?, branch_id = ?, category_id = ?, sub_category_id = ?, image = ?
         WHERE id = ?`,
        [name, description || null, priceSmall || null, priceMedium || null, priceLarge || null, priceSingle || null, branchId, categoryId, subCategoryId || null, imageKey, id]
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
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });
});

app.delete("/products/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [product] = await db.query("SELECT image FROM products WHERE id = ?", [id]);
    if (product.length === 0) return res.status(404).json({ error: "Product not found" });

    if (product[0].image) await deleteFromS3(product[0].image);
    await db.query("DELETE FROM products WHERE id = ?", [id]);
    res.json({ message: "Product deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/banners", authenticateToken, async (req, res) => {
  try {
    const [banners] = await db.query("SELECT id, image, title, description, button_text FROM banners");
    const bannersWithUrls = banners.map(banner => ({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`
    }));
    res.json(bannersWithUrls);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/banners", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload error" });
    if (!req.file) return res.status(400).json({ error: "Image required" });

    const { title, description, button_text } = req.body;
    try {
      const imageKey = await uploadToS3(req.file);
      const [result] = await db.query(
        "INSERT INTO banners (image, title, description, button_text) VALUES (?, ?, ?, ?)",
        [imageKey, title || null, description || null, button_text || null]
      );

      res.status(201).json({
        id: result.insertId,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
        title,
        description,
        button_text
      });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });
});

app.put("/banners/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload error" });

    const { id } = req.params;
    const { title, description, button_text } = req.body;

    try {
      const [existing] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Banner not found" });

      const imageKey = req.file ? await uploadToS3(req.file) : existing[0].image;
      if (req.file && existing[0].image) await deleteFromS3(existing[0].image);

      await db.query(
        "UPDATE banners SET image = ?, title = ?, description = ?, button_text = ? WHERE id = ?",
        [imageKey, title || null, description || null, button_text || null, id]
      );

      res.json({
        id,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
        title,
        description,
        button_text
      });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });
});

app.delete("/banners/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [banner] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
    if (banner.length === 0) return res.status(404).json({ error: "Banner not found" });

    if (banner[0].image) await deleteFromS3(banner[0].image);
    await db.query("DELETE FROM banners WHERE id = ?", [id]);
    res.json({ message: "Banner deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/stories", authenticateToken, async (req, res) => {
  try {
    const [stories] = await db.query("SELECT id, image FROM stories");
    const storiesWithUrls = stories.map(story => ({
      id: story.id,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`
    }));
    res.json(storiesWithUrls);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/stories", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Image upload error" });
    if (!req.file) return res.status(400).json({ error: "Image required" });

    try {
      const imageKey = await uploadToS3(req.file);
      const [result] = await db.query("INSERT INTO stories (image) VALUES (?)", [imageKey]);
      res.status(201).json({
        id: result.insertId,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`
      });
    } catch (err) {
      res.status(500).json({ error: "Server error" });
    }
  });
});

app.delete("/stories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [story] = await db.query("SELECT image FROM stories WHERE id = ?", [id]);
    if (story.length === 0) return res.status(404).json({ error: "Story not found" });

    if (story[0].image) await deleteFromS3(story[0].image);
    await db.query("DELETE FROM stories WHERE id = ?", [id]);
    res.json({ message: "Story deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/promo-codes", authenticateToken, async (req, res) => {
  try {
    const [promoCodes] = await db.query("SELECT * FROM promo_codes");
    res.json(promoCodes);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/promo-codes", authenticateToken, async (req, res) => {
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Code and discount percent required" });

  try {
    const [result] = await db.query(
      "INSERT INTO promo_codes (code, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)",
      [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true]
    );
    res.status(201).json({ id: result.insertId, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/promo-codes/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Code and discount percent required" });

  try {
    await db.query(
      "UPDATE promo_codes SET code = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?",
      [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id]
    );
    res.json({ id, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/promo-codes/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM promo_codes WHERE id = ?", [id]);
    res.json({ message: "Promo code deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/categories", authenticateToken, async (req, res) => {
  try {
    const [categories] = await db.query("SELECT * FROM categories");
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/categories", authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  try {
    const [result] = await db.query("INSERT INTO categories (name) VALUES (?)", [name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/categories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Name required" });

  try {
    await db.query("UPDATE categories SET name = ? WHERE id = ?", [name, id]);
    res.json({ id, name });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/categories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM categories WHERE id = ?", [id]);
    res.json({ message: "Category deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/subcategories", authenticateToken, async (req, res) => {
  try {
    const [subcategories] = await db.query("SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id");
    res.json(subcategories);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/subcategories", authenticateToken, async (req, res) => {
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Name and category required" });

  try {
    const [result] = await db.query("INSERT INTO subcategories (name, category_id) VALUES (?, ?)", [name, categoryId]);
    const [newSubcategory] = await db.query(
      "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
      [result.insertId]
    );
    res.status(201).json(newSubcategory[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.put("/subcategories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Name and category required" });

  try {
    await db.query("UPDATE subcategories SET name = ?, category_id = ? WHERE id = ?", [name, categoryId, id]);
    const [updatedSubcategory] = await db.query(
      "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
      [id]
    );
    res.json(updatedSubcategory[0]);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/subcategories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM subcategories WHERE id = ?", [id]);
    res.json({ message: "Subcategory deleted" });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

initializeServer();