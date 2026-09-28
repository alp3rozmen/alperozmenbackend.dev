const mysql = require('mysql2/promise');
require('dotenv').config();

// Havuz lazy bağlanır; ilk sorguda bağlantı açılır.
const db = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT) || 3306,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
});

const startDbConnection = async () => {
  try {
    await db.query('SELECT 1');
    console.log('MySQL connected');
  } catch (err) {
    console.error('MySQL connection error:', err.message);
  }
};

module.exports = { db, startDbConnection };
