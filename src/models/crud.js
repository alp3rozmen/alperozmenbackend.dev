// Basit CRUD tabloları (örn. blogs) için ortak model üreticisi.
// `fields`: istemciden yazılabilen kolonlar.
module.exports = (db, table, fields) => {
  const pick = (data) => fields.filter((f) => data[f] !== undefined);

  const findById = async (id) => {
    const [rows] = await db.query(`SELECT * FROM \`${table}\` WHERE id = ?`, [id]);
    return rows[0] || null;
  };

  return {
    findAll: async () => {
      const [rows] = await db.query(`SELECT * FROM \`${table}\` ORDER BY createdAt DESC`);
      return rows;
    },

    findById,

    create: async (data) => {
      const cols = pick(data);
      const [result] = await db.query(
        `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        cols.map((c) => data[c])
      );
      return findById(result.insertId);
    },

    update: async (id, data) => {
      const cols = pick(data);
      if (cols.length) {
        const [result] = await db.query(
          `UPDATE \`${table}\` SET ${cols.map((c) => `\`${c}\` = ?`).join(', ')} WHERE id = ?`,
          [...cols.map((c) => data[c]), id]
        );
        if (!result.affectedRows) return null;
      }
      return findById(id);
    },

    remove: async (id) => {
      const [result] = await db.query(`DELETE FROM \`${table}\` WHERE id = ?`, [id]);
      return result.affectedRows > 0;
    }
  };
};
