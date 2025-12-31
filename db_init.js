import sqlite3 from "sqlite3";

const DB_PATH = "./clash_community.db";
const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

async function tableExists(tableName) {
  const row = await get(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [tableName]
  );
  return !!row;
}

async function columnExists(tableName, columnName) {
  const columns = await all(`PRAGMA table_info(${tableName});`);
  return columns.some((c) => c.name === columnName);
}

async function addColumnIfMissing(tableName, columnDefSql) {
  const colName = columnDefSql.trim().split(/\s+/)[0];
  const exists = await columnExists(tableName, colName);
  if (exists) {
    console.log(`ℹ️ ${tableName}.${colName} 이미 존재`);
    return;
  }
  await run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefSql};`);
  console.log(`✅ ${tableName}.${colName} 컬럼 추가 완료`);
}

async function createIndexIfMissing(indexSql, indexNameForLog) {
  await run(indexSql);
  console.log(`✅ 인덱스 확인/생성: ${indexNameForLog}`);
}

async function main() {
  try {
    await run(`PRAGMA foreign_keys = ON;`);

    //users
    await run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL
      );
    `);
    console.log("✅ users 테이블 확인/생성 완료");

    await run(`DROP TABLE IF EXISTS users_tag;`);
    //users_tag
    await run(`
      CREATE TABLE IF NOT EXISTS users_tag (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        nickname TEXT NOT NULL UNIQUE,
        tag TEXT,
        trophies INTEGER,
        clan_name TEXT,
        arena TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_public INTEGER DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    console.log("✅ users_tag 테이블 확인/생성 완료");

    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_users_tag_user_id ON users_tag(user_id);`,
      "idx_users_tag_user_id"
    );

    //articles
    await run(`
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME,
        views INTEGER DEFAULT 0,
        likes INTEGER DEFAULT 0,
        is_published INTEGER DEFAULT 1,
        tags TEXT,
        image_url TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
    `);
    console.log("✅ articles 테이블 확인/생성 완료");

    await addColumnIfMissing("articles", "category TEXT");

    // 인덱스
    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_articles_user_id ON articles(user_id);`,
      "idx_articles_user_id"
    );
    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_articles_created_at ON articles(created_at);`,
      "idx_articles_created_at"
    );

    //comments
    await run(`
      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        image_url TEXT,
        parent_id INTEGER,
        FOREIGN KEY (article_id) REFERENCES articles(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (parent_id) REFERENCES comments(id)
      );
    `);
    console.log("✅ comments 테이블 확인/생성 완료");

    await addColumnIfMissing("comments", "parent_id INTEGER");
    await addColumnIfMissing("comments", "image_url TEXT");

    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_comments_article_id ON comments(article_id);`,
      "idx_comments_article_id"
    );
    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_comments_parent_id ON comments(parent_id);`,
      "idx_comments_parent_id"
    );
    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_comments_created_at ON comments(created_at);`,
      "idx_comments_created_at"
    );

    //likes (게시글 좋아요)
    await run(`
      CREATE TABLE IF NOT EXISTS likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        article_id INTEGER NOT NULL,
        UNIQUE(user_id, article_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (article_id) REFERENCES articles(id)
      );
    `);
    console.log("✅ likes 테이블 확인/생성 완료");

    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_likes_article_id ON likes(article_id);`,
      "idx_likes_article_id"
    );

    //comment_likes (댓글 좋아요)
    await run(`
      CREATE TABLE IF NOT EXISTS comment_likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        UNIQUE(user_id, comment_id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (comment_id) REFERENCES comments(id)
      );
    `);
    console.log("✅ comment_likes 테이블 확인/생성 완료");

    await createIndexIfMissing(
      `CREATE INDEX IF NOT EXISTS idx_comment_likes_comment_id ON comment_likes(comment_id);`,
      "idx_comment_likes_comment_id"
    );

    //FK 무결성 체크(선택)
    const fk = await all(`PRAGMA foreign_key_check;`);
    if (fk.length > 0) {
      console.warn("⚠️ foreign_key_check에서 문제 발견(아래 참고):");
      console.warn(fk);
    } else {
      console.log("✅ foreign_key_check: 문제 없음");
    }

    console.log("🎉 DB 스키마 초기화/마이그레이션 완료");
  } catch (err) {
    console.error("❌ DB 초기화 실패:", err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
