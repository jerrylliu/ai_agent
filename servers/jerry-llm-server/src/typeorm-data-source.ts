import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';

const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  username: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || '123456',
  database: process.env.DB_DATABASE || 'cyberpunk',
  entities: [__dirname + '/entities/*.entity.js'],
  migrations: [__dirname + '/migrations/*.{js,ts}'],
  synchronize: false,
});

export default AppDataSource;
