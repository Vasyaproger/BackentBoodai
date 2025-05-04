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
const compression = require("compression");
const Redis = require("ioredis");

// Инициализация приложения
const app = express();
app.use(compression()); // Сжатие HTTP-ответов
app.use(cors());
app.use(express.json({ limit: "10mb" })); // Ограничение размера JSON

// Константы
const JWT_SECRET = "your_jwt_secret_key_very_secure_2025"; // Секретный ключ для JWT
const S3_BUCKET = "4eeafbc6-4af2cd44-4c23-4530-a2bf-750889dfdf75";
const TELEGRAM_BOT_TOKEN = "7858016810:AAELHxlmZORP7iHEIWdqYKw-rHl-q3aB8yY";

// Инициализация Redis
const redis = new Redis({
  host: "localhost", // Укажите ваш Redis сервер
  port: 6379,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

// Инициализация Firebase Admin
const serviceAccount = require("./boodai-pizza-firebase-adminsdk.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const firestore = admin.firestore();

// Настройка S3
const s3Client = new S3Client({
  credentials: {
    accessKeyId: "DN1NLZTORA2L6NZ529JJ",
    secretAccessKey: "iGg3syd3UiWzhoYbYlEEDSVX1HHVmWUptrBt81Y8",
  },
  endpoint: "https://s3.twcstorage.ru",
  region: "ru-1",
  forcePathStyle: true,
});

// Настройка Multer для загрузки изображений
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single("image");

// Подключение к MySQL с оптимизированным пулом
const db = mysql.createPool({
  host: "vh438.timeweb.ru",
  user: "ch79145_boodai",
  password: "16162007",
  database: "ch79145_boodai",
  waitForConnections: true,
  connectionLimit: 20, // Увеличено для параллельных запросов
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// Проверка подключения к S3
const testS3Connection = async () => {
  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: "test-connection.txt",
      Body: "S3 connection test",
    });
    await s3Client.send(command);
    console.log("S3 подключение успешно!");
  } catch (err) {
    console.error("Ошибка S3:", err.message);
    throw err;
  }
};

// Загрузка изображения в S3
const uploadToS3 = async (file) => {
  const key = `boody-images/${Date.now()}${path.extname(file.originalname)}`;
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    CacheControl: "max-age=31536000", // Кэширование на год
  };

  try {
    const upload = new Upload({ client: s3Client, params });
    await upload.done();
    return key;
  } catch (err) {
    console.error("Ошибка загрузки в S3:", err.message);
    throw err;
  }
};

// Получение изображения из S3
const getFromS3 = async (key) => {
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
  };

  try {
    const command = new GetObjectCommand(params);
    const data = await s3Client.send(command);
    return data;
  } catch (err) {
    console.error("Ошибка получения из S3:", err.message);
    throw err;
  }
};

// Удаление изображения из S3
const deleteFromS3 = async (key) => {
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
  };

  try {
    const command = new DeleteObjectCommand(params);
    await s3Client.send(command);
    console.log("Изображение удалено из S3:", key);
  } catch (err) {
    console.error("Ошибка удаления из S3:", err.message);
    throw err;
  }
};

// Middleware для проверки токена
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Токен отсутствует" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Недействительный токен" });
    req.user = user;
    next();
  });
};

// Middleware для опциональной аутентификации
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

// Инициализация сервера
const initializeServer = async () => {
  try {
    console.log("Подключение к MySQL...");
    const connection = await db.getConnection();
    console.log("MySQL подключен!");

    // Создание таблиц с индексами
    await Promise.all([
      connection.query(`
        CREATE TABLE IF NOT EXISTS branches (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          address VARCHAR(255),
          phone VARCHAR(20),
          telegram_chat_id VARCHAR(50),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_name (name)
        )
      `),
      connection.query(`
        CREATE TABLE IF NOT EXISTS categories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_name (name)
        )
      `),
      connection.query(`
        CREATE TABLE IF NOT EXISTS subcategories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          category_id INT NOT NULL,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
          INDEX idx_category_id (category_id)
        )
      `),
      connection.query(`
        CREATE TABLE IF NOT EXISTS products (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          price_small DECIMAL(10,2),
          price_medium DECIMAL(10,2),
          price_large DECIMAL(10,2),
          price_single DECIMAL(10,2),
          branch_id INT NOT NULL,
          category_id INT NOT NULL,
          sub_category_id INT,
          image VARCHAR(255),
          mini_recipe TEXT,
          is_pizza BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
          INDEX idx_branch_id (branch_id),
          INDEX idx_category_id (category_id)
        )
      `),
      connection.query(`
        CREATE TABLE IF NOT EXISTS promo_codes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          code VARCHAR(50) NOT NULL UNIQUE,
          discount_percent INT NOT NULL,
          expires_at TIMESTAMP NULL,
          is_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_code (code)
        )
      `),
      connection.query(`
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
      `),
      connection.query(`
        CREATE TABLE IF NOT EXISTS stories (
          id INT AUTO_INCREMENT PRIMARY KEY,
          image VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `),
      connection.query(`
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
      `),
      connection.query(`
        CREATE TABLE IF NOT EXISTS banners (
          id INT AUTO_INCREMENT PRIMARY KEY,
          image VARCHAR(255) NOT NULL,
          title VARCHAR(255),
          description TEXT,
          button_text VARCHAR(100),
          promo_code_id INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (promo_code_id) REFERENCES promo_codes(id) ON DELETE SET NULL
        )
      `),
      connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL,
          role ENUM('user', 'admin') DEFAULT 'user',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_email (email)
        )
      `),
    ]);

    console.log("Таблицы созданы с индексами");

    // Инициализация филиалов
    const [branches] = await connection.query("SELECT * FROM branches");
    if (branches.length === 0) {
      await Promise.all([
        connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["BOODAI PIZZA", "-1002311447135"]),
        connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Район", "-1002638475628"]),
        connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Араванский", "-1002311447135"]),
        connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Ошский район", "-1002638475628"]),
      ]);
      console.log("Филиалы добавлены");
    } else {
      await Promise.all([
        connection.query(
          "UPDATE branches SET telegram_chat_id = ? WHERE name = 'BOODAI PIZZA' AND (telegram_chat_id IS NULL OR telegram_chat_id = '')",
          ["-1002311447135"]
        ),
        connection.query(
          "UPDATE branches SET telegram_chat_id = ? WHERE name = 'Район' AND (telegram_chat_id IS NULL OR telegram_chat_id = '')",
          ["-1002638475628"]
        ),
        connection.query(
          "UPDATE branches SET telegram_chat_id = ? WHERE name = 'Араванский' AND (telegram_chat_id IS NULL OR telegram_chat_id = '')",
          ["-1002311447135"]
        ),
        connection.query(
          "UPDATE branches SET telegram_chat_id = ? WHERE name = 'Ошский район' AND (telegram_chat_id IS NULL OR telegram_chat_id = '')",
          ["-1002638475628"]
        ),
      ]);
      console.log("Telegram chat_id обновлены");
    }

    // Создание админа
    const [users] = await connection.query("SELECT * FROM users WHERE email = ?", ["admin@boodaypizza.com"]);
    if (users.length === 0) {
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await connection.query("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)", ["Admin", "admin@boodaypizza.com", hashedPassword, "admin"]);
      console.log("Админ создан: admin@boodaypizza.com / admin123");
    }

    connection.release();
    await testS3Connection();

    app.listen(5000, () => console.log("Сервер запущен на порту 5000"));
  } catch (err) {
    console.error("Ошибка инициализации:", err.message);
    process.exit(1);
  }
};

// Проверка роли админа
const requireAdmin = async (req, res, next) => {
  try {
    const [user] = await db.query("SELECT role FROM users WHERE id = ?", [req.user.id]);
    if (user.length === 0 || user[0].role !== "admin") {
      return res.status(403).json({ error: "Доступ только для админов" });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
};

// Публичные маршруты
app.get("/api/public/branches", async (req, res) => {
  try {
    const cacheKey = "branches";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [branches] = await db.query("SELECT id, name, address, telegram_chat_id FROM branches");
    await redis.setex(cacheKey, 3600, JSON.stringify(branches));
    res.json(branches);
  } catch (err) {
    console.error("Ошибка получения филиалов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/branches/:branchId/products", async (req, res) => {
  const { branchId } = req.params;
  try {
    const cacheKey = `products:${branchId}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [products] = await db.query(`
      SELECT p.id, p.name, p.description, p.price_small, p.price_medium, p.price_large, 
             p.price_single AS price, p.image AS image_url, c.name AS category,
             d.discount_percent, d.expires_at
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
      WHERE p.branch_id = ?
    `, [branchId]);

    await redis.setex(cacheKey, 3600, JSON.stringify(products));
    res.json(products);
  } catch (err) {
    console.error("Ошибка получения продуктов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/stories", async (req, res) => {
  try {
    const cacheKey = "stories";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [stories] = await db.query("SELECT * FROM stories");
    const storiesWithUrls = stories.map(story => ({
      ...story,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`
    }));

    await redis.setex(cacheKey, 3600, JSON.stringify(storiesWithUrls));
    res.json(storiesWithUrls);
  } catch (err) {
    console.error("Ошибка получения историй:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/banners", async (req, res) => {
  try {
    const cacheKey = "banners";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [banners] = await db.query(`
      SELECT b.*, pc.code AS promo_code, pc.discount_percent
      FROM banners b
      LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
    `);
    const bannersWithUrls = banners.map(banner => ({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
      promo_code: banner.promo_code ? {
        id: banner.promo_code_id,
        code: banner.promo_code,
        discount_percent: banner.discount_percent || 0
      } : null
    }));

    await redis.setex(cacheKey, 3600, JSON.stringify(bannersWithUrls));
    res.json(bannersWithUrls);
  } catch (err) {
    console.error("Ошибка получения баннеров:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/banners/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const cacheKey = `banner:${id}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [banners] = await db.query(`
      SELECT b.*, pc.code AS promo_code, pc.discount_percent
      FROM banners b
      LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
      WHERE b.id = ?
    `, [id]);

    if (banners.length === 0) return res.status(404).json({ error: "Баннер не найден" });

    const banner = banners[0];
    const bannerWithUrl = {
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
      promo_code: banner.promo_code ? {
        id: banner.promo_code_id,
        code: banner.promo_code,
        discount_percent: banner.discount_percent || 0
      } : null
    };

    await redis.setex(cacheKey, 3600, JSON.stringify(bannerWithUrl));
    res.json(bannerWithUrl);
  } catch (err) {
    console.error("Ошибка получения баннера:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/public/validate-promo", async (req, res) => {
  const { promoCode } = req.body;
  try {
    const cacheKey = `promo:${promoCode}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [promo] = await db.query(
      "SELECT discount_percent AS discount FROM promo_codes WHERE code = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
      [promoCode]
    );
    if (promo.length === 0) return res.status(400).json({ message: "Промокод недействителен" });

    await redis.setex(cacheKey, 3600, JSON.stringify({ discount: promo[0].discount }));
    res.json({ discount: promo[0].discount });
  } catch (err) {
    console.error("Ошибка проверки промокода:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/public/send-order", async (req, res) => {
  const { orderDetails, deliveryDetails, cartItems, discount, promoCode, branchId, userId, boodaiCoinsUsed } = req.body;

  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: "Корзина пуста" });
  }
  if (!branchId) {
    return res.status(400).json({ error: "Не указан филиал" });
  }

  try {
    // Рассчет стоимости
    const total = cartItems.reduce((sum, item) => sum + (Number(item.originalPrice) || 0) * item.quantity, 0);
    const discountedTotal = total * (1 - (discount || 0) / 100);
    let finalTotal = discountedTotal;
    let coinsUsed = Number(boodaiCoinsUsed) || 0;
    let coinsEarned = total * 0.05;

    // Экранирование для Markdown
    const escapeMarkdown = (text) => (text ? text.replace(/([_*[\]()~`>#+-.!])/g, "\\$1") : "Нет");

    // Формирование текста заказа
    const orderText = `
📦 *Новый заказ:*
🏪 Филиал: ${escapeMarkdown((await db.query("SELECT name FROM branches WHERE id = ?", [branchId]))[0][0]?.name || "Неизвестный филиал")}
👤 Имя: ${escapeMarkdown(orderDetails.name || deliveryDetails.name)}
📞 Телефон: ${escapeMarkdown(orderDetails.phone || deliveryDetails.phone)}
📝 Комментарии: ${escapeMarkdown(orderDetails.comments || deliveryDetails.comments || "Нет")}
📍 Адрес: ${escapeMarkdown(deliveryDetails.address || "Самовывоз")}

🛒 *Товары:*
${cartItems.map((item) => `- ${escapeMarkdown(item.name)} (${item.quantity} шт. по ${item.originalPrice} сом)`).join("\n")}

💰 Итог: ${total.toFixed(2)} сом
${promoCode ? `💸 Скидка (${discount}%): ${discountedTotal.toFixed(2)} сом` : ""}
${coinsUsed > 0 ? `📉 Монеты: ${coinsUsed.toFixed(2)}` : ""}
💰 Финал: ${finalTotal.toFixed(2)} сом
    `;

    // Сохранение заказа
    const [result] = await db.query(
      "INSERT INTO orders (branch_id, total, status, order_details, delivery_details, cart_items, discount, promo_code) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)",
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

    // Получение филиала
    const [branch] = await db.query("SELECT name, telegram_chat_id FROM branches WHERE id = ?", [branchId]);
    if (branch.length === 0) return res.status(400).json({ error: `Филиал ${branchId} не найден` });

    const chatId = branch[0].telegram_chat_id;
    if (!chatId) return res.status(500).json({ error: `Для филиала "${branch[0].name}" не настроен Telegram chat ID` });

    // Отправка в Telegram
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: orderText,
      parse_mode: "Markdown",
    });

    // Обработка Boodai Coins
    let newBalance = 0;
    if (userId) {
      const userRef = firestore.collection("users").doc(userId);
      const userDoc = await userRef.get();
      if (userDoc.exists) {
        const userData = userDoc.data();
        const currentCoins = Number(userData.boodaiCoins) || 0;
        const userName = userData.name || "Неизвестный пользователь";

        if (coinsUsed > currentCoins) {
          return res.status(400).json({ error: `Недостаточно монет: ${currentCoins.toFixed(2)}` });
        }

        newBalance = currentCoins - coinsUsed + coinsEarned;
        finalTotal = Math.max(0, discountedTotal - coinsUsed);

        await Promise.all([
          userRef.update({ boodaiCoins: newBalance }),
          firestore.collection("transactions").add({
            userId,
            type: "order",
            amount: coinsEarned,
            coinsUsed,
            orderTotal: total,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
          }),
          axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: `
💰 *Транзакция Boodai Coins:*
🏪 ${escapeMarkdown(branch[0].name)}
👤 ${escapeMarkdown(userName)} (ID: ${userId})
📊 Начислено: ${coinsEarned.toFixed(2)}
${coinsUsed > 0 ? `📉 Использовано: ${coinsUsed.toFixed(2)}` : ""}
💸 Баланс: ${newBalance.toFixed(2)}
📝 Заказ: ${total.toFixed(2)} сом
📅 ${new Date().toLocaleString("ru-RU")}
            `,
            parse_mode: "Markdown",
          }),
        ]);
      }
    }

    // Очистка кэша
    await redis.del(`products:${branchId}`);
    res.status(200).json({ message: "Заказ отправлен", orderId: result.insertId, boodaiCoins: newBalance });
  } catch (error) {
    console.error("Ошибка заказа:", error.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Админские маршруты
app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Введите email и пароль" });

  try {
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) return res.status(401).json({ error: "Неверный email или пароль" });

    const user = users[0];
    if (user.role !== "admin") return res.status(403).json({ error: "Доступ только для админов" });

    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error("Ошибка входа:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление филиалами
app.get("/admin/branches", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:branches";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [branches] = await db.query("SELECT * FROM branches");
    await redis.setex(cacheKey, 3600, JSON.stringify(branches));
    res.json(branches);
  } catch (err) {
    console.error("Ошибка получения филиалов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/branches", authenticateToken, requireAdmin, async (req, res) => {
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Название филиала обязательно" });

  try {
    const [result] = await db.query(
      "INSERT INTO branches (name, address, phone, telegram_chat_id) VALUES (?, ?, ?, ?)",
      [name, address || null, phone || null, telegram_chat_id || null]
    );
    await redis.del("branches");
    await redis.del("admin:branches");
    res.status(201).json({ id: result.insertId, name, address, phone, telegram_chat_id });
  } catch (err) {
    console.error("Ошибка добавления филиала:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/admin/branches/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Название филиала обязательно" });

  try {
    await db.query(
      "UPDATE branches SET name = ?, address = ?, phone = ?, telegram_chat_id = ? WHERE id = ?",
      [name, address || null, phone || null, telegram_chat_id || null, id]
    );
    await redis.del("branches");
    await redis.del("admin:branches");
    res.json({ id, name, address, phone, telegram_chat_id });
  } catch (err) {
    console.error("Ошибка обновления филиала:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/admin/branches/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM branches WHERE id = ?", [id]);
    await redis.del("branches");
    await redis.del("admin:branches");
    res.json({ message: "Филиал удален" });
  } catch (err) {
    console.error("Ошибка удаления филиала:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление продуктами
app.get("/admin/products", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:products";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [products] = await db.query(`
      SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name,
             d.discount_percent, d.expires_at, d.is_active as discount_active
      FROM products p
      LEFT JOIN branches b ON p.branch_id = b.id
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN subcategories s ON p.sub_category_id = s.id
      LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
    `);
    await redis.setex(cacheKey, 3600, JSON.stringify(products));
    res.json(products);
  } catch (err) {
    console.error("Ошибка получения продуктов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/products", authenticateToken, requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Ошибка загрузки изображения" });

    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId, miniRecipe, isPizza } = req.body;
    if (!req.file || !name || !branchId || !categoryId) {
      return res.status(400).json({ error: "Обязательные поля отсутствуют" });
    }

    try {
      const imageKey = await uploadToS3(req.file);
      const [result] = await db.query(
        `INSERT INTO products (
          name, description, price_small, price_medium, price_large, price_single, 
          branch_id, category_id, sub_category_id, image, mini_recipe, is_pizza
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          miniRecipe || null,
          isPizza === "true" || isPizza === true
        ]
      );

      await redis.del(`products:${branchId}`);
      await redis.del("admin:products");
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
      console.error("Ошибка добавления продукта:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.put("/admin/products/:id", authenticateToken, requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Ошибка загрузки изображения" });

    const { id } = req.params;
    const { name, description, priceSmall, priceMedium, priceLarge, priceSingle, branchId, categoryId, subCategoryId, miniRecipe, isPizza } = req.body;

    try {
      const [existing] = await db.query("SELECT image, branch_id FROM products WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Продукт не найден" });

      let imageKey = existing[0].image;
      if (req.file) {
        imageKey = await uploadToS3(req.file);
        if (existing[0].image) await deleteFromS3(existing[0].image);
      }

      await db.query(
        `UPDATE products SET 
          name = ?, description = ?, price_small = ?, price_medium = ?, price_large = ?, 
          price_single = ?, branch_id = ?, category_id = ?, sub_category_id = ?, 
          image = ?, mini_recipe = ?, is_pizza = ?
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
          miniRecipe || null,
          isPizza === "true" || isPizza === true,
          id,
        ]
      );

      await redis.del(`products:${existing[0].branch_id}`);
      await redis.del(`products:${branchId}`);
      await redis.del("admin:products");
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
      console.error("Ошибка обновления продукта:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.delete("/admin/products/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [product] = await db.query("SELECT image, branch_id FROM products WHERE id = ?", [id]);
    if (product.length === 0) return res.status(404).json({ error: "Продукт не найден" });

    if (product[0].image) await deleteFromS3(product[0].image);
    await db.query("DELETE FROM products WHERE id = ?", [id]);
    await redis.del(`products:${product[0].branch_id}`);
    await redis.del("admin:products");
    res.json({ message: "Продукт удален" });
  } catch (err) {
    console.error("Ошибка удаления продукта:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление категориями
app.get("/admin/categories", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:categories";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [categories] = await db.query("SELECT * FROM categories");
    await redis.setex(cacheKey, 3600, JSON.stringify(categories));
    res.json(categories);
  } catch (err) {
    console.error("Ошибка получения категорий:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/categories", authenticateToken, requireAdmin, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Название категории обязательно" });

  try {
    const [result] = await db.query("INSERT INTO categories (name) VALUES (?)", [name]);
    await redis.del("admin:categories");
    res.status(201).json({ id: result.insertId, name });
  } catch (err) {
    console.error("Ошибка добавления категории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/admin/categories/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Название категории обязательно" });

  try {
    await db.query("UPDATE categories SET name = ? WHERE id = ?", [name, id]);
    await redis.del("admin:categories");
    res.json({ id, name });
  } catch (err) {
    console.error("Ошибка обновления категории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/admin/categories/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM categories WHERE id = ?", [id]);
    await redis.del("admin:categories");
    res.json({ message: "Категория удалена" });
  } catch (err) {
    console.error("Ошибка удаления категории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление подкатегориями
app.get("/admin/subcategories", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:subcategories";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [subcategories] = await db.query(`
      SELECT s.*, c.name as category_name 
      FROM subcategories s
      JOIN categories c ON s.category_id = c.id
    `);
    await redis.setex(cacheKey, 3600, JSON.stringify(subcategories));
    res.json(subcategories);
  } catch (err) {
    console.error("Ошибка получения подкатегорий:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/subcategories", authenticateToken, requireAdmin, async (req, res) => {
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Название и категория обязательны" });

  try {
    const [result] = await db.query("INSERT INTO subcategories (name, category_id) VALUES (?, ?)", [name, categoryId]);
    await redis.del("admin:subcategories");
    const [newSubcategory] = await db.query(
      "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
      [result.insertId]
    );
    res.status(201).json(newSubcategory[0]);
  } catch (err) {
    console.error("Ошибка добавления подкатегории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/admin/subcategories/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Название и категория обязательны" });

  try {
    await db.query("UPDATE subcategories SET name = ?, category_id = ? WHERE id = ?", [name, categoryId, id]);
    await redis.del("admin:subcategories");
    const [updatedSubcategory] = await db.query(
      "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
      [id]
    );
    res.json(updatedSubcategory[0]);
  } catch (err) {
    console.error("Ошибка обновления подкатегории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/admin/subcategories/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM subcategories WHERE id = ?", [id]);
    await redis.del("admin:subcategories");
    res.json({ message: "Подкатегория удалена" });
  } catch (err) {
    console.error("Ошибка удаления подкатегории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление промокодами
app.get("/admin/promo-codes", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:promo-codes";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [promoCodes] = await db.query("SELECT * FROM promo_codes");
    await redis.setex(cacheKey, 3600, JSON.stringify(promoCodes));
    res.json(promoCodes);
  } catch (err) {
    console.error("Ошибка получения промокодов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/promo-codes", authenticateToken, requireAdmin, async (req, res) => {
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Код и процент скидки обязательны" });

  try {
    const [result] = await db.query(
      "INSERT INTO promo_codes (code, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)",
      [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true]
    );
    await redis.del("admin:promo-codes");
    res.status(201).json({ id: result.insertId, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
  } catch (err) {
    console.error("Ошибка добавления промокода:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/admin/promo-codes/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Код и процент скидки обязательны" });

  try {
    await db.query(
      "UPDATE promo_codes SET code = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?",
      [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id]
    );
    await redis.del("admin:promo-codes");
    res.json({ id, code, discount_percent: discountPercent, expires_at: expiresAt || null, is_active: isActive !== undefined ? isActive : true });
  } catch (err) {
    console.error("Ошибка обновления промокода:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/admin/promo-codes/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM promo_codes WHERE id = ?", [id]);
    await redis.del("admin:promo-codes");
    res.json({ message: "Промокод удален" });
  } catch (err) {
    console.error("Ошибка удаления промокода:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление скидками
app.get("/admin/discounts", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:discounts";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [discounts] = await db.query(`
      SELECT d.*, p.name as product_name 
      FROM discounts d
      JOIN products p ON d.product_id = p.id
      WHERE d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
    `);
    await redis.setex(cacheKey, 3600, JSON.stringify(discounts));
    res.json(discounts);
  } catch (err) {
    console.error("Ошибка получения скидок:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/discounts", authenticateToken, requireAdmin, async (req, res) => {
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent) return res.status(400).json({ error: "ID продукта и процент скидки обязательны" });
  if (discountPercent < 1 || discountPercent > 100) return res.status(400).json({ error: "Процент скидки должен быть от 1 до 100" });

  try {
    const [product] = await db.query("SELECT id, branch_id FROM products WHERE id = ?", [productId]);
    if (product.length === 0) return res.status(404).json({ error: "Продукт не найден" });

    const [existingDiscount] = await db.query(`
      SELECT id FROM discounts 
      WHERE product_id = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
    `, [productId]);
    if (existingDiscount.length > 0) return res.status(400).json({ error: "Для этого продукта уже есть активная скидка" });

    const [result] = await db.query(
      "INSERT INTO discounts (product_id, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)",
      [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true]
    );

    await redis.del(`products:${product[0].branch_id}`);
    await redis.del("admin:discounts");
    const [newDiscount] = await db.query(
      `SELECT d.*, p.name as product_name 
       FROM discounts d
       JOIN products p ON d.product_id = p.id
       WHERE d.id = ?`,
      [result.insertId]
    );

    res.status(201).json(newDiscount[0]);
  } catch (err) {
    console.error("Ошибка добавления скидки:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/admin/discounts/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent) return res.status(400).json({ error: "ID продукта и процент скидки обязательны" });
  if (discountPercent < 1 || discountPercent > 100) return res.status(400).json({ error: "Процент скидки должен быть от 1 до 100" });

  try {
    const [discount] = await db.query("SELECT product_id FROM discounts WHERE id = ?", [id]);
    if (discount.length === 0) return res.status(404).json({ error: "Скидка не найдена" });

    const [product] = await db.query("SELECT id, branch_id FROM products WHERE id = ?", [productId]);
    if (product.length === 0) return res.status(404).json({ error: "Продукт не найден" });

    if (discount[0].product_id !== productId) {
      const [existingDiscount] = await db.query(`
        SELECT id FROM discounts 
        WHERE product_id = ? AND id != ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
      `, [productId, id]);
      if (existingDiscount.length > 0) return res.status(400).json({ error: "Для этого продукта уже есть другая активная скидка" });
    }

    await db.query(
      "UPDATE discounts SET product_id = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?",
      [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id]
    );

    await redis.del(`products:${product[0].branch_id}`);
    await redis.del("admin:discounts");
    const [updatedDiscount] = await db.query(
      `SELECT d.*, p.name as product_name 
       FROM discounts d
       JOIN products p ON d.product_id = p.id
       WHERE d.id = ?`,
      [id]
    );

    res.json(updatedDiscount[0]);
  } catch (err) {
    console.error("Ошибка обновления скидки:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/admin/discounts/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [discount] = await db.query(`
      SELECT d.*, p.name as product_name, p.branch_id
      FROM discounts d
      JOIN products p ON d.product_id = p.id
      WHERE d.id = ?
    `, [id]);
    if (discount.length === 0) return res.status(404).json({ error: "Скидка не найдена" });

    await db.query("DELETE FROM discounts WHERE id = ?", [id]);
    await redis.del(`products:${discount[0].branch_id}`);
    await redis.del("admin:discounts");
    res.json({ message: "Скидка удалена", product: { id: discount[0].product_id, name: discount[0].product_name } });
  } catch (err) {
    console.error("Ошибка удаления скидки:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление историями
app.get("/admin/stories", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:stories";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [stories] = await db.query("SELECT * FROM stories");
    const storiesWithUrls = stories.map(story => ({
      ...story,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`
    }));

    await redis.setex(cacheKey, 3600, JSON.stringify(storiesWithUrls));
    res.json(storiesWithUrls);
  } catch (err) {
    console.error("Ошибка получения историй:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/stories", authenticateToken, requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Ошибка загрузки изображения" });
    if (!req.file) return res.status(400).json({ error: "Изображение обязательно" });

    try {
      const imageKey = await uploadToS3(req.file);
      const [result] = await db.query("INSERT INTO stories (image) VALUES (?)", [imageKey]);
      await redis.del("stories");
      await redis.del("admin:stories");
      res.status(201).json({ id: result.insertId, image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}` });
    } catch (err) {
      console.error("Ошибка добавления истории:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.put("/admin/stories/:id", authenticateToken, requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Ошибка загрузки изображения" });

    const { id } = req.params;
    try {
      const [existing] = await db.query("SELECT image FROM stories WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "История не найдена" });

      let imageKey = existing[0].image;
      if (req.file) {
        imageKey = await uploadToS3(req.file);
        if (existing[0].image) await deleteFromS3(existing[0].image);
      }

      await db.query("UPDATE stories SET image = ? WHERE id = ?", [imageKey, id]);
      await redis.del("stories");
      await redis.del("admin:stories");
      res.json({ id, image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}` });
    } catch (err) {
      console.error("Ошибка обновления истории:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.delete("/admin/stories/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [story] = await db.query("SELECT image FROM stories WHERE id = ?", [id]);
    if (story.length === 0) return res.status(404).json({ error: "История не найдена" });

    if (story[0].image) await deleteFromS3(story[0].image);
    await db.query("DELETE FROM stories WHERE id = ?", [id]);
    await redis.del("stories");
    await redis.del("admin:stories");
    res.json({ message: "История удалена" });
  } catch (err) {
    console.error("Ошибка удаления истории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление баннерами
app.get("/admin/banners", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cache trainableKey = "admin:banners";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [banners] = await db.query(`
      SELECT b.*, pc.code AS promo_code, pc.discount_percent
      FROM banners b
      LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
    `);
    const bannersWithUrls = banners.map(banner => ({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
      promo_code: banner.promo_code ? {
        id: banner.promo_code_id,
        code: banner.promo_code,
        discount_percent: banner.discount_percent || 0
      } : null
    }));

    await redis.setex(cacheKey, 3600, JSON.stringify(bannersWithUrls));
    res.json(bannersWithUrls);
  } catch (err) {
    console.error("Ошибка получения баннеров:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/banners", authenticateToken, requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Ошибка загрузки изображения" });
    if (!req.file) return res.status(400).json({ error: "Изображение обязательно" });

    const { title, description, button_text, promo_code_id } = req.body;
    try {
      const imageKey = await uploadToS3(req.file);
      const [result] = await db.query(
        "INSERT INTO banners (image, title, description, button_text, promo_code_id) VALUES (?, ?, ?, ?, ?)",
        [imageKey, title || null, description || null, button_text || null, promo_code_id || null]
      );

      await redis.del("banners");
      await redis.del("admin:banners");
      const [newBanner] = await db.query(
        `SELECT b.*, pc.code AS promo_code, pc.discount_percent
         FROM banners b
         LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
         WHERE b.id = ?`,
        [result.insertId]
      );

      const banner = newBanner[0];
      res.status(201).json({
        id: result.insertId,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
        title,
        description,
        button_text,
        promo_code_id,
        promo_code: banner.promo_code ? {
          id: banner.promo_code_id,
          code: banner.promo_code,
          discount_percent: banner.discount_percent || 0
        } : null
      });
    } catch (err) {
      console.error("Ошибка добавления баннера:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.put("/admin/banners/:id", authenticateToken, requireAdmin, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ error: "Ошибка загрузки изображения" });

    const { id } = req.params;
    const { title, description, button_text, promo_code_id } = req.body;
    try {
      const [existing] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Баннер не найден" });

      let imageKey = existing[0].image;
      if (req.file) {
        imageKey = await uploadToS3(req.file);
        if (existing[0].image) await deleteFromS3(existing[0].image);
      }

      await db.query(
        "UPDATE banners SET image = ?, title = ?, description = ?, button_text = ?, promo_code_id = ? WHERE id = ?",
        [imageKey, title || null, description || null, button_text || null, promo_code_id || null, id]
      );

      await redis.del("banners");
      await redis.del("admin:banners");
      await redis.del(`banner:${id}`);
      const [updatedBanner] = await db.query(
        `SELECT b.*, pc.code AS promo_code, pc.discount_percent
         FROM banners b
         LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
         WHERE b.id = ?`,
        [id]
      );

      const banner = updatedBanner[0];
      res.json({
        id,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
        title,
        description,
        button_text,
        promo_code_id,
        promo_code: banner.promo_code ? {
          id: banner.promo_code_id,
          code: banner.promo_code,
          discount_percent: banner.discount_percent || 0
        } : null
      });
    } catch (err) {
      console.error("Ошибка обновления баннера:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.delete("/admin/banners/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [banner] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
    if (banner.length === 0) return res.status(404).json({ error: "Баннер не найден" });

    if (banner[0].image) await deleteFromS3(banner[0].image);
    await db.query("DELETE FROM banners WHERE id = ?", [id]);
    await redis.del("banners");
    await redis.del("admin:banners");
    await redis.del(`banner:${id}`);
    res.json({ message: "Баннер удален" });
  } catch (err) {
    console.error("Ошибка удаления баннера:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Управление пользователями
app.get("/admin/users", authenticateToken, requireAdmin, async (req, res) => {
  try {
    const cacheKey = "admin:users";
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [users] = await db.query("SELECT id, name, email, role FROM users");
    await redis.setex(cacheKey, 3600, JSON.stringify(users));
    res.json(users);
  } catch (err) {
    console.error("Ошибка получения пользователей:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/admin/users", authenticateToken, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "Все поля обязательны" });
  }

  try {
    const [existingUsers] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: "Пользователь с таким email уже существует" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      "INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)",
      [name, email, hashedPassword, role]
    );
    await redis.del("admin:users");
    res.status(201).json({ id: result.insertId, name, email, role });
  } catch (err) {
    console.error("Ошибка добавления пользователя:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, email, password, role } = req.body;
  if (!name || !email || !role) {
    return res.status(400).json({ error: "Имя, email и роль обязательны" });
  }

  try {
    const updates = { name, email, role };
    if (password) updates.password = await bcrypt.hash(password, 10);

    await db.query(
      "UPDATE users SET name = ?, email = ?, password = ?, role = ? WHERE id = ?",
      [updates.name, updates.email, updates.password || null, updates.role, id]
    );
    await redis.del("admin:users");
    res.json({ id, name, email, role });
  } catch (err) {
    console.error("Ошибка обновления пользователя:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/admin/users/:id", authenticateToken, requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const [user] = await db.query("SELECT id FROM users WHERE id = ?", [id]);
    if (user.length === 0) return res.status(404).json({ error: "Пользователь не найден" });

    await db.query("DELETE FROM users WHERE id = ?", [id]);
    await redis.del("admin:users");
    res.json({ message: "Пользователь удален" });
  } catch (err) {
    console.error("Ошибка удаления пользователя:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Публичные маршруты для пользователей
app.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Все поля обязательны" });
  }

  try {
    const [existingUsers] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: "Пользователь с таким email уже существует" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query("INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'user')", [name, email, hashedPassword]);
    const token = jwt.sign({ id: result.insertId, email, role: "user" }, JWT_SECRET, { expiresIn: "1h" });
    res.status(201).json({ token, user: { id: result.insertId, name, email, role: "user" } });
  } catch (err) {
    console.error("Ошибка регистрации:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Введите email и пароль" });
  }

  try {
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const user = users[0];
    if (!(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error("Ошибка входа:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/product-image/:key", optionalAuthenticateToken, async (req, res) => {
  const { key } = req.params;
  try {
    const image = await getFromS3(`boody-images/${key}`);
    res.setHeader("Content-Type", image.ContentType || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000");
    image.Body.pipe(res);
  } catch (err) {
    console.error("Ошибка получения изображения:", err.message);
    res.status(500).json({ error: "Ошибка получения изображения" });
  }
});

initializeServer();