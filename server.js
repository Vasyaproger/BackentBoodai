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

const app = express();
app.use(cors());
app.use(express.json());

// Секретный ключ для JWT
const JWT_SECRET = "your_jwt_secret_key";

// Настройка S3Client для Timeweb Cloud
const s3Client = new S3Client({
  credentials: {
    accessKeyId: "DN1NLZTORA2L6NZ529JJ",
    secretAccessKey: "iGg3syd3UiWzhoYbYlEEDSVX1HHVmWUptrBt81Y8",
  },
  endpoint: "https://s3.twcstorage.ru",
  region: "ru-1",
  forcePathStyle: true,
});

const S3_BUCKET = "4eeafbc6-4af2cd44-4c23-4530-a2bf-750889dfdf75";
const TELEGRAM_BOT_TOKEN = "7858016810:AAELHxlmZORP7iHEIWdqYKw-rHl-q3aB8yY";

// Проверка подключения к S3
const testS3Connection = async () => {
  try {
    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: "test-connection.txt",
      Body: "Это тестовый файл для проверки подключения к S3.",
    });
    await s3Client.send(command);
    console.log("Успешно подключились к S3!");
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: "test-connection.txt" }));
  } catch (err) {
    console.error("Ошибка подключения к S3:", err.message);
    throw err;
  }
};

// Настройка multer для загрузки изображений
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // Ограничение 5MB
}).fields([
  { name: "image", maxCount: 1 },
  { name: "sauceImage_0", maxCount: 1 },
  { name: "sauceImage_1", maxCount: 1 },
  { name: "sauceImage_2", maxCount: 1 },
]);

// Функция для загрузки изображения в S3
const uploadToS3 = async (file) => {
  const key = `boody-images/${Date.now()}${path.extname(file.originalname)}`;
  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  };

  try {
    const upload = new Upload({ client: s3Client, params });
    await upload.done();
    return key;
  } catch (err) {
    console.error("Ошибка при загрузке в S3:", err.message);
    throw err;
  }
};

// Функция для получения изображения из S3
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
    console.error("Ошибка при получении из S3:", err.message);
    throw err;
  }
};

// Функция для удаления изображения из S3
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

// Подключение к базе данных MySQL
const db = mysql.createPool({
  host: "vh438.timeweb.ru",
  user: "ch79145_boodai",
  password: "16162007",
  database: "ch79145_boodai",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Middleware для аутентификации токена
const authenticateToken = (req, res, next) => {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Токен отсутствует" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Недействительный токен" });
    req.user = user;
    next();
  });
};

// Опциональная аутентификация для маршрута изображений
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

// Маршрут для получения изображения по ключу
app.get("/product-image/:key", optionalAuthenticateToken, async (req, res) => {
  const { key } = req.params;
  try {
    const image = await getFromS3(`boody-images/${key}`);
    res.setHeader("Content-Type", image.ContentType || "image/jpeg");
    image.Body.pipe(res);
  } catch (err) {
    console.error("Ошибка при отправке изображения:", err.message);
    res.status(404).json({ error: "Изображение не найдено" });
  }
});

// Инициализация сервера
const initializeServer = async () => {
  try {
    const connection = await db.getConnection();
    console.log("Подключено к MySQL успешно!");

    // Создание таблицы products
    await connection.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        price_small DECIMAL(10,2),
        price_medium DECIMAL(10,2),
        price_large DECIMAL(10,2),
        price_single DECIMAL(10,2),
        size ENUM('small', 'medium', 'large', 'single') DEFAULT 'single',
        is_spicy BOOLEAN DEFAULT FALSE,
        branch_id INT NOT NULL,
        category_id INT NOT NULL,
        sub_category_id INT,
        image VARCHAR(255),
        mini_recipe TEXT,
        is_pizza BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
        FOREIGN KEY (sub_category_id) REFERENCES subcategories(id) ON DELETE SET NULL
      )
    `);
    console.log("Таблица products проверена/создана");

    // Создание таблицы sauces
    await connection.query(`
      CREATE TABLE IF NOT EXISTS sauces (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        image VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);
    console.log("Таблица sauces проверена/создана");

    // Миграция данных продуктов в JSON
    const [products] = await connection.query("SELECT id, name, description FROM products");
    for (const product of products) {
      try {
        JSON.parse(product.name);
      } catch (e) {
        await connection.query(
          "UPDATE products SET name = ?, description = ? WHERE id = ?",
          [
            JSON.stringify({ ru: product.name || "", ky: "", en: "" }),
            JSON.stringify({ ru: product.description || "", ky: "", en: "" }),
            product.id,
          ]
        );
      }
    }
    console.log("Данные продуктов мигрированы в формат JSON");

    // Создание таблицы branches
    await connection.query(`
      CREATE TABLE IF NOT EXISTS branches (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        address VARCHAR(255),
        phone VARCHAR(20),
        telegram_chat_id VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Таблица branches проверена/создана");

    // Создание таблицы categories
    await connection.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Таблица categories проверена/создана");

    // Создание таблицы subcategories
    await connection.query(`
      CREATE TABLE IF NOT EXISTS subcategories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        category_id INT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
      )
    `);
    console.log("Таблица subcategories проверена/создана");

    // Создание таблицы promo_codes
    await connection.query(`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        discount_percent INT NOT NULL,
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Таблица promo_codes проверена/создана");

    // Создание таблицы orders
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
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
      )
    `);
    console.log("Таблица orders проверена/создана");

    // Создание таблицы stories
    await connection.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        image VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Таблица stories проверена/создана");

    // Создание таблицы discounts
    await connection.query(`
      CREATE TABLE IF NOT EXISTS discounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        product_id INT NOT NULL,
        discount_percent INT NOT NULL,
        expires_at TIMESTAMP NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);
    console.log("Таблица discounts проверена/создана");

    // Создание таблицы banners
    await connection.query(`
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
    `);
    console.log("Таблица banners проверена/создана");

    // Создание таблицы users
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Таблица users проверена/создана");

    // Проверка и добавление администратора
    const [users] = await connection.query("SELECT * FROM users WHERE email = ?", ["admin@boodaypizza.com"]);
    if (users.length === 0) {
      const hashedPassword = await bcrypt.hash("admin123", 10);
      await connection.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", ["Админ", "admin@boodaypizza.com", hashedPassword]);
      console.log("Админ создан: admin@boodaypizza.com / admin123");
    }

    // Добавление филиалов
    const [branches] = await connection.query("SELECT * FROM branches");
    if (branches.length === 0) {
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["BOODAI PIZZA", "-1002311447135"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Район", "-1002638475628"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Араванский", "-1002311447135"]);
      await connection.query("INSERT INTO branches (name, telegram_chat_id) VALUES (?, ?)", ["Ошский район", "-1002638475628"]);
      console.log("Филиалы добавлены");
    }

    connection.release();
    await testS3Connection();

    app.listen(5000, () => console.log("Сервер запущен на порту 5000"));
  } catch (err) {
    console.error("Ошибка инициализации сервера:", err.message);
    process.exit(1);
  }
};

// Публичные маршруты
app.get("/api/public/branches", async (req, res) => {
  try {
    const [branches] = await db.query("SELECT id, name, address, telegram_chat_id FROM branches");
    res.json(branches);
  } catch (err) {
    console.error("Ошибка при получении филиалов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/branches/:branchId/products", async (req, res) => {
  const { branchId } = req.params;
  try {
    const [products] = await db.query(`
      SELECT p.id, p.name, p.description, p.price_small, p.price_medium, p.price_large, 
             p.price_single, p.size, p.is_spicy, p.image AS image_url, c.name AS category,
             d.discount_percent, d.expires_at,
             (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', s.id, 'name', s.name, 'image', s.image)) 
              FROM sauces s WHERE s.product_id = p.id) AS sauces
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
      WHERE p.branch_id = ?
    `, [branchId]);
    const parsedProducts = products.map((p) => ({
      ...p,
      name: p.name ? JSON.parse(p.name) : { ru: "", ky: "", en: "" },
      description: p.description ? JSON.parse(p.description) : { ru: "", ky: "", en: "" },
      sauces: p.sauces ? JSON.parse(p.sauces) : [],
    }));
    res.json(parsedProducts);
  } catch (err) {
    console.error("Ошибка при получении продуктов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/branches/:branchId/orders", async (req, res) => {
  const { branchId } = req.params;
  try {
    const [orders] = await db.query(`
      SELECT id, total, created_at, status
      FROM orders
      WHERE branch_id = ?
      ORDER BY created_at DESC
      LIMIT 10
    `, [branchId]);
    res.json(orders);
  } catch (err) {
    console.error("Ошибка при получении истории заказов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/stories", async (req, res) => {
  try {
    const [stories] = await db.query("SELECT * FROM stories");
    const storiesWithUrls = stories.map((story) => ({
      ...story,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`,
    }));
    res.json(storiesWithUrls);
  } catch (err) {
    console.error("Ошибка при получении историй:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/banners", async (req, res) => {
  try {
    const [banners] = await db.query(`
      SELECT b.*, pc.code AS promo_code, pc.discount_percent
      FROM banners b
      LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
    `);
    const bannersWithUrls = banners.map((banner) => ({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
      promo_code: banner.promo_code
        ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 }
        : null,
    }));
    res.json(bannersWithUrls);
  } catch (err) {
    console.error("Ошибка при получении баннеров:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/banners/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [banners] = await db.query(`
      SELECT b.*, pc.code AS promo_code, pc.discount_percent
      FROM banners b
      LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
      WHERE b.id = ?
    `, [id]);
    if (banners.length === 0) {
      return res.status(404).json({ error: "Баннер не найден" });
    }
    const banner = banners[0];
    res.json({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
      promo_code: banner.promo_code
        ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 }
        : null,
    });
  } catch (err) {
    console.error("Ошибка при получении баннера:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/public/validate-promo", async (req, res) => {
  const { promoCode } = req.body;
  try {
    const [promo] = await db.query(
      "SELECT discount_percent AS discount FROM promo_codes WHERE code = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
      [promoCode]
    );
    if (promo.length === 0) {
      return res.status(400).json({ message: "Промокод недействителен" });
    }
    res.json({ discount: promo[0].discount });
  } catch (err) {
    console.error("Ошибка при проверке промокода:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/api/public/send-order", async (req, res) => {
  const { orderDetails, deliveryDetails, cartItems, discount, promoCode, branchId } = req.body;

  if (!cartItems || !Array.isArray(cartItems) || cartItems.length === 0) {
    return res.status(400).json({ error: "Корзина пуста" });
  }
  if (!branchId) {
    return res.status(400).json({ error: "Не указан филиал" });
  }

  try {
    const total = cartItems.reduce((sum, item) => {
      let itemPrice = 0;
      if (item.size === "small" && item.price_small) itemPrice = Number(item.price_small);
      else if (item.size === "medium" && item.price_medium) itemPrice = Number(item.price_medium);
      else if (item.size === "large" && item.price_large) itemPrice = Number(item.price_large);
      else itemPrice = Number(item.price_single) || Number(item.originalPrice) || 0;
      return sum + itemPrice * item.quantity;
    }, 0);
    const discountedTotal = total * (1 - (discount || 0) / 100);
    const finalTotal = discountedTotal;

    const escapeMarkdown = (text) => (text ? text.replace(/([_*[\]()~`>#+-.!])/g, "\\$1") : "Нет");
    const orderText = `
📦 *Новый заказ:*
🏪 Филиал: ${escapeMarkdown((await db.query("SELECT name FROM branches WHERE id = ?", [branchId]))[0][0]?.name || "Неизвестный филиал")}
👤 Имя: ${escapeMarkdown(orderDetails.name || deliveryDetails.name)}
📞 Телефон: ${escapeMarkdown(orderDetails.phone || deliveryDetails.phone)}
📝 Комментарии: ${escapeMarkdown(orderDetails.comments || deliveryDetails.comments || "Нет")}
📍 Адрес: ${escapeMarkdown(deliveryDetails.address || "Самовывоз")}

🛒 *Товары:*
${cartItems.map((item) => {
  const itemName = typeof item.name === "object" ? item.name.ru || item.name.en || item.name.ky || "Без названия" : item.name;
  const itemPrice =
    item.size === "small" && item.price_small
      ? item.price_small
      : item.size === "medium" && item.price_medium
      ? item.price_medium
      : item.size === "large" && item.price_large
      ? item.price_large
      : item.price_single || item.originalPrice || 0;
  return `- ${escapeMarkdown(itemName)} (${item.quantity} шт. по ${itemPrice} сом, ${item.size || "без размера"}, ${item.is_spicy ? "острый" : "не острый"})`;
}).join("\n")}

💰 Итог: ${total.toFixed(2)} сом
${promoCode ? `💸 Скидка (${discount}%): ${discountedTotal.toFixed(2)} сом` : "💸 Скидка не применена"}
💰 Итоговая сумма: ${finalTotal.toFixed(2)} сом
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
      return res.status(400).json({ error: `Филиал с id ${branchId} не найден` });
    }

    const chatId = branch[0].telegram_chat_id;
    if (!chatId) {
      return res.status(500).json({ error: `Для филиала "${branch[0].name}" не настроен Telegram chat ID` });
    }

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: orderText,
      parse_mode: "Markdown",
    });

    res.status(200).json({ message: "Заказ отправлен", orderId: result.insertId });
  } catch (error) {
    console.error("Ошибка при отправке заказа:", error.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

// Остальные маршруты
app.get("/", (req, res) => res.send("API Booday Pizza"));

app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Введите email и пароль" });

  try {
    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    if (users.length === 0) return res.status(401).json({ error: "Неверный email или пароль" });

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Неверный email или пароль" });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/branches", authenticateToken, async (req, res) => {
  try {
    const [branches] = await db.query("SELECT * FROM branches");
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/products", authenticateToken, async (req, res) => {
  try {
    const [products] = await db.query(
      `
      SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name,
             d.discount_percent, d.expires_at, d.is_active as discount_active,
             (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', s.id, 'name', s.name, 'image', s.image)) 
              FROM sauces s WHERE s.product_id = p.id) AS sauces
      FROM products p
      LEFT JOIN branches b ON p.branch_id = b.id
      LEFT JOIN categories c ON p.category_id = c.id
      LEFT JOIN subcategories s ON p.sub_category_id = s.id
      LEFT JOIN discounts d ON p.id = d.product_id AND d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
    `
    );
    const parsedProducts = products.map((p) => ({
      ...p,
      name: p.name ? JSON.parse(p.name) : { ru: "", ky: "", en: "" },
      description: p.description ? JSON.parse(p.description) : { ru: "", ky: "", en: "" },
      sauces: p.sauces ? JSON.parse(p.sauces) : [],
    }));
    res.json(parsedProducts);
  } catch (err) {
    console.error("Ошибка при получении продуктов:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/discounts", authenticateToken, async (req, res) => {
  try {
    const [discounts] = await db.query(
      `
      SELECT d.*, p.name as product_name 
      FROM discounts d
      JOIN products p ON d.product_id = p.id
      WHERE d.is_active = TRUE AND (d.expires_at IS NULL OR d.expires_at > NOW())
    `
    );
    const parsedDiscounts = discounts.map((d) => ({
      ...d,
      product_name: d.product_name ? JSON.parse(d.product_name) : { ru: "", ky: "", en: "" },
    }));
    res.json(parsedDiscounts);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/stories", authenticateToken, async (req, res) => {
  try {
    const [stories] = await db.query("SELECT * FROM stories");
    const storiesWithUrls = stories.map((story) => ({
      ...story,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${story.image.split("/").pop()}`,
    }));
    res.json(storiesWithUrls);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/banners", authenticateToken, async (req, res) => {
  try {
    const [banners] = await db.query(
      `
      SELECT b.*, pc.code AS promo_code, pc.discount_percent
      FROM banners b
      LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
    `
    );
    const bannersWithUrls = banners.map((banner) => ({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
      promo_code: banner.promo_code
        ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 }
        : null,
    }));
    res.json(bannersWithUrls);
  } catch (err) {
    console.error("Ошибка при получении баннеров:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/banners/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const [banners] = await db.query(
      `
      SELECT b.*, pc.code AS promo_code, pc.discount_percent
      FROM banners b
      LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
      WHERE b.id = ?
    `,
      [id]
    );
    if (banners.length === 0) {
      return res.status(404).json({ error: "Баннер не найден" });
    }
    const banner = banners[0];
    res.json({
      ...banner,
      image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${banner.image.split("/").pop()}`,
      promo_code: banner.promo_code
        ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 }
        : null,
    });
  } catch (err) {
    console.error("Ошибка при получении баннера:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/banners", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error("Ошибка загрузки изображения:", err.message);
      return res.status(400).json({ error: "Ошибка загрузки изображения" });
    }

    const { title, description, button_text, promo_code_id } = req.body;

    if (!req.files?.image) {
      return res.status(400).json({ error: "Изображение обязательно" });
    }

    let imageKey;
    try {
      imageKey = await uploadToS3(req.files.image[0]);
    } catch (s3Err) {
      console.error("Ошибка при загрузке в S3:", s3Err.message);
      return res.status(500).json({ error: "Ошибка загрузки в S3" });
    }

    try {
      const [result] = await db.query(
        "INSERT INTO banners (image, title, description, button_text, promo_code_id) VALUES (?, ?, ?, ?, ?)",
        [imageKey, title || null, description || null, button_text || null, promo_code_id || null]
      );

      const [newBanner] = await db.query(
        `
        SELECT b.*, pc.code AS promo_code, pc.discount_percent
        FROM banners b
        LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
        WHERE b.id = ?
      `,
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
        promo_code: banner.promo_code
          ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 }
          : null,
      });
    } catch (err) {
      console.error("Ошибка при добавлении баннера:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.put("/banners/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error("Ошибка загрузки изображения:", err.message);
      return res.status(400).json({ error: "Ошибка загрузки изображения" });
    }

    const { id } = req.params;
    const { title, description, button_text, promo_code_id } = req.body;
    let imageKey;

    try {
      const [existing] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
      if (existing.length === 0) {
        return res.status(404).json({ error: "Баннер не найден" });
      }

      if (req.files?.image) {
        imageKey = await uploadToS3(req.files.image[0]);
        if (existing[0].image) {
          await deleteFromS3(existing[0].image);
        }
      } else {
        imageKey = existing[0].image;
      }

      await db.query(
        "UPDATE banners SET image = ?, title = ?, description = ?, button_text = ?, promo_code_id = ? WHERE id = ?",
        [imageKey, title || null, description || null, button_text || null, promo_code_id || null, id]
      );

      const [updatedBanner] = await db.query(
        `
        SELECT b.*, pc.code AS promo_code, pc.discount_percent
        FROM banners b
        LEFT JOIN promo_codes pc ON b.promo_code_id = pc.id
        WHERE b.id = ?
      `,
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
        promo_code: banner.promo_code
          ? { id: banner.promo_code_id, code: banner.promo_code, discount_percent: banner.discount_percent || 0 }
          : null,
      });
    } catch (err) {
      console.error("Ошибка при обновлении баннера:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.delete("/banners/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [banner] = await db.query("SELECT image FROM banners WHERE id = ?", [id]);
    if (banner.length === 0) return res.status(404).json({ error: "Баннер не найден" });

    if (banner[0].image) {
      await deleteFromS3(banner[0].image);
    }

    await db.query("DELETE FROM banners WHERE id = ?", [id]);
    res.json({ message: "Баннер удален" });
  } catch (err) {
    console.error("Ошибка при удалении баннера:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/categories", authenticateToken, async (req, res) => {
  try {
    const [categories] = await db.query(
      `
      SELECT c.*, 
             (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', s.id, 'name', s.name))
              FROM subcategories s WHERE s.category_id = c.id) AS sub_categories
      FROM categories c
    `
    );
    const parsedCategories = categories.map((c) => ({
      ...c,
      sub_categories: c.sub_categories ? JSON.parse(c.sub_categories) : [],
    }));
    res.json(parsedCategories);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/promo-codes", authenticateToken, async (req, res) => {
  try {
    const [promoCodes] = await db.query("SELECT * FROM promo_codes");
    res.json(promoCodes);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/promo-codes/check/:code", authenticateToken, async (req, res) => {
  const { code } = req.params;
  try {
    const [promo] = await db.query(
      "SELECT * FROM promo_codes WHERE code = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
      [code]
    );
    if (promo.length === 0) return res.status(404).json({ error: "Промокод не найден или недействителен" });
    res.json(promo[0]);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/api/public/promo-codes/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await db.query(
      "SELECT * FROM promo_codes WHERE id = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Промокод не найден или недействителен" });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error("Ошибка при получении промокода:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/promo-codes", authenticateToken, async (req, res) => {
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Код и процент скидки обязательны" });

  try {
    const [result] = await db.query(
      "INSERT INTO promo_codes (code, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)",
      [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true]
    );
    res.status(201).json({
      id: result.insertId,
      code,
      discount_percent: discountPercent,
      expires_at: expiresAt || null,
      is_active: isActive !== undefined ? isActive : true,
    });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/promo-codes/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { code, discountPercent, expiresAt, isActive } = req.body;
  if (!code || !discountPercent) return res.status(400).json({ error: "Код и процент скидки обязательны" });

  try {
    await db.query(
      "UPDATE promo_codes SET code = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?",
      [code, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id]
    );
    res.json({
      id,
      code,
      discount_percent: discountPercent,
      expires_at: expiresAt || null,
      is_active: isActive !== undefined ? isActive : true,
    });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/promo-codes/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM promo_codes WHERE id = ?", [id]);
    res.json({ message: "Промокод удален" });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/branches", authenticateToken, async (req, res) => {
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Название филиала обязательно" });

  try {
    const [result] = await db.query(
      "INSERT INTO branches (name, address, phone, telegram_chat_id) VALUES (?, ?, ?, ?)",
      [name, address || null, phone || null, telegram_chat_id || null]
    );
    res.status(201).json({ id: result.insertId, name, address, phone, telegram_chat_id });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/branches/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, address, phone, telegram_chat_id } = req.body;
  if (!name) return res.status(400).json({ error: "Название филиала обязательно" });

  try {
    await db.query(
      "UPDATE branches SET name = ?, address = ?, phone = ?, telegram_chat_id = ? WHERE id = ?",
      [name, address || null, phone || null, telegram_chat_id || null, id]
    );
    res.json({ id, name, address, phone, telegram_chat_id });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/branches/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM branches WHERE id = ?", [id]);
    res.json({ message: "Филиал удален" });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/categories", authenticateToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Название категории обязательно" });

  try {
    const [result] = await db.query("INSERT INTO categories (name) VALUES (?)", [name]);
    res.status(201).json({ id: result.insertId, name });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/categories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "Название категории обязательно" });

  try {
    await db.query("UPDATE categories SET name = ? WHERE id = ?", [name, id]);
    res.json({ id, name });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/categories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM categories WHERE id = ?", [id]);
    res.json({ message: "Категория удалена" });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/subcategories", authenticateToken, async (req, res) => {
  try {
    const [subcategories] = await db.query(
      `
      SELECT s.*, c.name as category_name 
      FROM subcategories s
      JOIN categories c ON s.category_id = c.id
    `
    );
    res.json(subcategories);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/subcategories", authenticateToken, async (req, res) => {
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Название и категория обязательны" });

  try {
    const [result] = await db.query("INSERT INTO subcategories (name, category_id) VALUES (?, ?)", [name, categoryId]);
    const [newSubcategory] = await db.query(
      "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
      [result.insertId]
    );
    res.status(201).json(newSubcategory[0]);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/subcategories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, categoryId } = req.body;
  if (!name || !categoryId) return res.status(400).json({ error: "Название и категория обязательны" });

  try {
    await db.query("UPDATE subcategories SET name = ?, category_id = ? WHERE id = ?", [name, categoryId, id]);
    const [updatedSubcategory] = await db.query(
      "SELECT s.*, c.name as category_name FROM subcategories s JOIN categories c ON s.category_id = c.id WHERE s.id = ?",
      [id]
    );
    res.json(updatedSubcategory[0]);
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/subcategories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM subcategories WHERE id = ?", [id]);
    res.json({ message: "Подкатегория удалена" });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/products", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error("Ошибка загрузки изображения:", err.message);
      return res.status(400).json({ error: "Ошибка загрузки изображения" });
    }

    const { name, description, price, size, isSpicy, branchId, categoryId, subCategoryId, sauces } = req.body;
    if (!req.files?.image || !name || !branchId || !categoryId || !size || !price) {
      return res.status(400).json({ error: "Изображение, название, филиал, категория, размер и цена обязательны" });
    }

    let imageKey;
    let sauceImages = [];
    try {
      imageKey = await uploadToS3(req.files.image[0]);
      if (req.files) {
        for (let i = 0; i < 3; i++) {
          const sauceImageKey = `sauceImage_${i}`;
          if (req.files[sauceImageKey]) {
            const sauceImageKeyS3 = await uploadToS3(req.files[sauceImageKey][0]);
            sauceImages.push(sauceImageKeyS3);
          } else {
            sauceImages.push(null);
          }
        }
      }
    } catch (s3Err) {
      console.error("Ошибка при загрузке в S3:", s3Err.message);
      return res.status(500).json({ error: "Ошибка загрузки в S3" });
    }

    try {
      const nameJson = typeof name === "string" ? JSON.parse(name) : name;
      const descriptionJson = typeof description === "string" ? JSON.parse(description) : description || { ru: "", ky: "", en: "" };
      const saucesJson = typeof sauces === "string" ? JSON.parse(sauces) : sauces || [];
      const priceFloat = parseFloat(price);
      const isSpicyBool = isSpicy === "true" || isSpicy === true;

      const [result] = await db.query(
        `
        INSERT INTO products (
          name, description, price_${size}, size, is_spicy, branch_id, category_id, sub_category_id, image
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        [
          JSON.stringify(nameJson),
          JSON.stringify(descriptionJson),
          priceFloat,
          size,
          isSpicyBool,
          branchId,
          categoryId,
          subCategoryId || null,
          imageKey,
        ]
      );

      const productId = result.insertId;
      for (let i = 0; i < saucesJson.length; i++) {
        const sauce = saucesJson[i];
        if (sauce.name) {
          await db.query("INSERT INTO sauces (product_id, name, image) VALUES (?, ?, ?)", [productId, sauce.name, sauceImages[i] || null]);
        }
      }

      const [newProduct] = await db.query(
        `
        SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name,
               (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', s.id, 'name', s.name, 'image', s.image)) 
                FROM sauces s WHERE s.product_id = p.id) AS sauces
        FROM products p
        LEFT JOIN branches b ON p.branch_id = b.id
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN subcategories s ON p.sub_category_id = s.id
        WHERE p.id = ?
      `,
        [productId]
      );

      res.status(201).json({
        ...newProduct[0],
        name: JSON.parse(newProduct[0].name),
        description: JSON.parse(newProduct[0].description),
        sauces: newProduct[0].sauces ? JSON.parse(newProduct[0].sauces) : [],
      });
    } catch (err) {
      console.error("Ошибка при добавлении продукта:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.put("/products/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error("Ошибка загрузки изображения:", err.message);
      return res.status(400).json({ error: "Ошибка загрузки изображения" });
    }

    const { id } = req.params;
    const { name, description, price, size, isSpicy, branchId, categoryId, subCategoryId, sauces } = req.body;

    try {
      const [existing] = await db.query("SELECT image FROM products WHERE id = ?", [id]);
      if (existing.length === 0) {
        return res.status(404).json({ error: "Продукт не найден" });
      }

      let imageKey = existing[0].image;
      let sauceImages = [];
      if (req.files?.image) {
        imageKey = await uploadToS3(req.files.image[0]);
        if (existing[0].image) await deleteFromS3(existing[0].image);
      }
      if (req.files) {
        for (let i = 0; i < 3; i++) {
          const sauceImageKey = `sauceImage_${i}`;
          if (req.files[sauceImageKey]) {
            const sauceImageKeyS3 = await uploadToS3(req.files[sauceImageKey][0]);
            sauceImages.push(sauceImageKeyS3);
          } else {
            sauceImages.push(null);
          }
        }
      }

      const nameJson = typeof name === "string" ? JSON.parse(name) : name;
      const descriptionJson = typeof description === "string" ? JSON.parse(description) : description || { ru: "", ky: "", en: "" };
      const saucesJson = typeof sauces === "string" ? JSON.parse(sauces) : sauces || [];
      const priceFloat = parseFloat(price);
      const isSpicyBool = isSpicy === "true" || isSpicy === true;

      await db.query(
        `
        UPDATE products SET 
          name = ?, description = ?, price_${size} = ?, size = ?, is_spicy = ?, 
          branch_id = ?, category_id = ?, sub_category_id = ?, image = ? 
        WHERE id = ?
      `,
        [
          JSON.stringify(nameJson),
          JSON.stringify(descriptionJson),
          priceFloat,
          size,
          isSpicyBool,
          branchId,
          categoryId,
          subCategoryId || null,
          imageKey,
          id,
        ]
      );

      await db.query("DELETE FROM sauces WHERE product_id = ?", [id]);
      for (let i = 0; i < saucesJson.length; i++) {
        const sauce = saucesJson[i];
        if (sauce.name) {
          await db.query("INSERT INTO sauces (product_id, name, image) VALUES (?, ?, ?)", [id, sauce.name, sauceImages[i] || null]);
        }
      }

      const [updatedProduct] = await db.query(
        `
        SELECT p.*, b.name as branch_name, c.name as category_name, s.name as subcategory_name,
               (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', s.id, 'name', s.name, 'image', s.image)) 
                FROM sauces s WHERE s.product_id = p.id) AS sauces
        FROM products p
        LEFT JOIN branches b ON p.branch_id = b.id
        LEFT JOIN categories c ON p.category_id = c.id
        LEFT JOIN subcategories s ON p.sub_category_id = s.id
        WHERE p.id = ?
      `,
        [id]
      );

      res.json({
        ...updatedProduct[0],
        name: JSON.parse(updatedProduct[0].name),
        description: JSON.parse(updatedProduct[0].description),
        sauces: updatedProduct[0].sauces ? JSON.parse(updatedProduct[0].sauces) : [],
      });
    } catch (err) {
      console.error("Ошибка при обновлении продукта:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.delete("/products/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [product] = await db.query("SELECT image FROM products WHERE id = ?", [id]);
    if (product.length === 0) return res.status(404).json({ error: "Продукт не найден" });

    if (product[0].image) {
      await deleteFromS3(product[0].image);
    }

    const [sauces] = await db.query("SELECT image FROM sauces WHERE product_id = ?", [id]);
    for (const sauce of sauces) {
      if (sauce.image) await deleteFromS3(sauce.image);
    }

    await db.query("DELETE FROM products WHERE id = ?", [id]);
    res.json({ message: "Продукт удален" });
  } catch (err) {
    console.error("Ошибка при удалении продукта:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/discounts", authenticateToken, async (req, res) => {
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent) return res.status(400).json({ error: "ID продукта и процент скидки обязательны" });
  if (discountPercent < 1 || discountPercent > 100) return res.status(400).json({ error: "Процент скидки должен быть от 1 до 100" });

  try {
    const [product] = await db.query("SELECT id FROM products WHERE id = ?", [productId]);
    if (product.length === 0) return res.status(404).json({ error: "Продукт не найден" });

    const [existingDiscount] = await db.query(
      `
      SELECT id FROM discounts 
      WHERE product_id = ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
    `,
      [productId]
    );
    if (existingDiscount.length > 0) {
      return res.status(400).json({ error: "Для этого продукта уже существует активная скидка" });
    }

    const [result] = await db.query(
      "INSERT INTO discounts (product_id, discount_percent, expires_at, is_active) VALUES (?, ?, ?, ?)",
      [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true]
    );

    const [newDiscount] = await db.query(
      `
      SELECT d.*, p.name as product_name 
      FROM discounts d
      JOIN products p ON d.product_id = p.id
      WHERE d.id = ?
    `,
      [result.insertId]
    );

    res.status(201).json({
      ...newDiscount[0],
      product_name: JSON.parse(newDiscount[0].product_name),
    });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.put("/discounts/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { productId, discountPercent, expiresAt, isActive } = req.body;
  if (!productId || !discountPercent) return res.status(400).json({ error: "ID продукта и процент скидки обязательны" });
  if (discountPercent < 1 || discountPercent > 100) return res.status(400).json({ error: "Процент скидки должен быть от 1 до 100" });

  try {
    const [discount] = await db.query("SELECT product_id FROM discounts WHERE id = ?", [id]);
    if (discount.length === 0) return res.status(404).json({ error: "Скидка не найдена" });

    const [product] = await db.query("SELECT id FROM products WHERE id = ?", [productId]);
    if (product.length === 0) return res.status(404).json({ error: "Продукт не найден" });

    if (discount[0].product_id !== productId) {
      const [existingDiscount] = await db.query(
        `
        SELECT id FROM discounts 
        WHERE product_id = ? AND id != ? AND is_active = TRUE AND (expires_at IS NULL OR expires_at > NOW())
      `,
        [productId, id]
      );
      if (existingDiscount.length > 0) {
        return res.status(400).json({ error: "Для этого продукта уже существует другая активная скидка" });
      }
    }

    await db.query(
      "UPDATE discounts SET product_id = ?, discount_percent = ?, expires_at = ?, is_active = ? WHERE id = ?",
      [productId, discountPercent, expiresAt || null, isActive !== undefined ? isActive : true, id]
    );

    const [updatedDiscount] = await db.query(
      `
      SELECT d.*, p.name as product_name 
      FROM discounts d
      JOIN products p ON d.product_id = p.id
      WHERE d.id = ?
    `,
      [id]
    );

    res.json({
      ...updatedDiscount[0],
      product_name: JSON.parse(updatedDiscount[0].product_name),
    });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.delete("/discounts/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [discount] = await db.query(
      `
      SELECT d.*, p.name as product_name 
      FROM discounts d
      JOIN products p ON d.product_id = p.id
      WHERE d.id = ?
    `,
      [id]
    );
    if (discount.length === 0) return res.status(404).json({ error: "Скидка не найдена" });

    await db.query("DELETE FROM discounts WHERE id = ?", [id]);
    res.json({ message: "Скидка удалена", product: { id: discount[0].product_id, name: JSON.parse(discount[0].product_name) } });
  } catch (err) {
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.post("/stories", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error("Ошибка загрузки изображения:", err.message);
      return res.status(400).json({ error: "Ошибка загрузки изображения" });
    }

    if (!req.files?.image) {
      return res.status(400).json({ error: "Изображение обязательно" });
    }

    let imageKey;
    try {
      imageKey = await uploadToS3(req.files.image[0]);
    } catch (s3Err) {
      console.error("Ошибка при загрузке в S3:", s3Err.message);
      return res.status(500).json({ error: "Ошибка загрузки в S3" });
    }

    try {
      const [result] = await db.query("INSERT INTO stories (image) VALUES (?)", [imageKey]);
      res.status(201).json({
        id: result.insertId,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
      });
    } catch (err) {
      console.error("Ошибка при добавлении истории:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.put("/stories/:id", authenticateToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error("Ошибка загрузки изображения:", err.message);
      return res.status(400).json({ error: "Ошибка загрузки изображения" });
    }

    const { id } = req.params;
    let imageKey;

    try {
      const [existing] = await db.query("SELECT image FROM stories WHERE id = ?", [id]);
      if (existing.length === 0) {
        return res.status(404).json({ error: "История не найдена" });
      }

      if (req.files?.image) {
        imageKey = await uploadToS3(req.files.image[0]);
        if (existing[0].image) {
          await deleteFromS3(existing[0].image);
        }
      } else {
        imageKey = existing[0].image;
      }

      await db.query("UPDATE stories SET image = ? WHERE id = ?", [imageKey, id]);
      res.json({
        id,
        image: `https://vasyaproger-backentboodai-543a.twc1.net/product-image/${imageKey.split("/").pop()}`,
      });
    } catch (err) {
      console.error("Ошибка при обновлении истории:", err.message);
      res.status(500).json({ error: "Ошибка сервера" });
    }
  });
});

app.delete("/stories/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const [story] = await db.query("SELECT image FROM stories WHERE id = ?", [id]);
    if (story.length === 0) return res.status(404).json({ error: "История не найдена" });

    if (story[0].image) {
      await deleteFromS3(story[0].image);
    }

    await db.query("DELETE FROM stories WHERE id = ?", [id]);
    res.json({ message: "История удалена" });
  } catch (err) {
    console.error("Ошибка при удалении истории:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

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
    const [result] = await db.query("INSERT INTO users (name, email, password) VALUES (?, ?, ?)", [name, email, hashedPassword]);
    const token = jwt.sign({ id: result.insertId, email }, JWT_SECRET, { expiresIn: "1h" });
    res.status(201).json({ token, user: { id: result.insertId, name, email } });
  } catch (err) {
    console.error("Ошибка при регистрации:", err.message);
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
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    console.error("Ошибка при входе:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.get("/users", authenticateToken, async (req, res) => {
  try {
    const [users] = await db.query("SELECT id, name, email FROM users");
    res.json(users);
  } catch (err) {
    console.error("Ошибка при получении пользователей:", err.message);
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

initializeServer();