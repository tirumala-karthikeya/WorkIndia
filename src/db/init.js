const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const path = require('path');
const bcrypt = require('bcrypt');

require('dotenv').config();

const initializeDatabase = async () => {
  try {
    // Create connection
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD,
    });

    console.log('Connected to MySQL server');

    // Read the schema file
    const schemaPath = path.join(__dirname, '../database/schema.sql');
    const schema = await fs.readFile(schemaPath, 'utf8');

    // Split the schema into individual statements
    const statements = schema
      .split(';')
      .map(statement => statement.trim())
      .filter(statement => statement.length > 0);

    // Execute each statement
    for (const statement of statements) {
      try {
        await connection.query(statement);
        console.log('Executed:', statement.substring(0, 50) + '...');
      } catch (err) {
        // Ignore duplicate key/index errors
        if (err.code === 'ER_DUP_KEYNAME' || err.code === 'ER_DUP_KEY' || err.code === 'ER_DUP_INDEX') {
          console.warn('Warning (ignored):', err.sqlMessage);
          continue;
        }
        throw err;
      }
    }

    // Create admin user if not exists
    const [adminExists] = await connection.query(
      'SELECT * FROM users WHERE email = ?',
      ['admin@railway.com']
    );

    if (adminExists.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await connection.query(
        'INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)',
        ['Admin', 'admin@railway.com', hashedPassword, 'admin']
      );
      console.log('Admin user created');
    } else {
      console.log('Admin user already exists');
    }

    console.log('Database initialization completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error initializing database:', error);
    process.exit(1);
  }
};

initializeDatabase(); 