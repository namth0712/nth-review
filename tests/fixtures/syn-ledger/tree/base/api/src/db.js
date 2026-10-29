import mysql from 'mysql2/promise';

export const pool = mysql.createPool({ uri: process.env.DATABASE_URL, connectionLimit: 10 });

// Runs `work` in one transaction: commits when it resolves, rolls back when it throws.
export async function withTransaction(work) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await work(conn);
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
