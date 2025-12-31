import express from "express";
import sqlite3 from "sqlite3";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { authenticateToken, authenticateTokenOptional } from "./auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";

dotenv.config();
const SECRET = process.env.SECRET;
const router = express.Router();

const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + unique + path.extname(file.originalname));
  },
});
const upload = multer({ storage });

// 게시글 작성
router.post(
  "/articles",
  authenticateToken,
  upload.single("image"),
  (req, res) => {
    const db = new sqlite3.Database("./clash_community.db");
    const { title, content, tags, category } = req.body;
    const user_id = req.user.id;
    const createdAt = new Date().toISOString();
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    if (!title || !content || !category) {
      return res
        .status(400)
        .json({ error: "제목, 내용, 카테고리는 필수입니다." });
    }

    const query = `
    INSERT INTO articles (user_id, title, content, created_at, tags, category, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

    db.run(
      query,
      [user_id, title, content, createdAt, tags, category, imageUrl],
      function (err) {
        if (err) {
          console.error("❌ 게시글 작성 오류:", err.message);
          return res.status(500).json({ error: "게시글 작성 실패" });
        }

        res
          .status(201)
          .json({
            message: "게시글이 작성되었습니다.",
            articleId: this.lastID,
          });
        db.close();
      }
    );
  }
);

// 전체 게시글 조회 (카테고리 필터 포함)
router.get("/articles", (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const { category } = req.query;

  let query = `
    SELECT articles.id, articles.title, articles.content, articles.user_id, articles.created_at, 
           users_tag.nickname, articles.category, articles.likes, articles.image_url, articles.views
    FROM articles
    LEFT JOIN users_tag ON articles.user_id = users_tag.user_id
  `;

  if (category) query += ` WHERE articles.category = ?`;
  query += ` ORDER BY articles.created_at DESC`;

  db.all(query, category ? [category] : [], (err, rows) => {
    if (err) {
      console.error("❌ 게시글 조회 오류:", err.message);
      return res.status(500).json({ error: "게시글을 불러오지 못했습니다." });
    }

    res.json(rows);
    db.close();
  });
});

// 게시글 조회 (조회수 증가 포함)
// 기존 코드 수정 (좋아요 여부 확인 추가)
router.get("/articles/:id", authenticateTokenOptional, (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const articleId = req.params.id;
  const userId = req.user?.id; // optional 로그인

  const increment = req.query.view === "true";

  const updateView = () => {
    if (!increment) return;
    db.run(`UPDATE articles SET views = views + 1 WHERE id = ?`, [articleId]);
  };

  const query = `
    SELECT a.*, u.nickname,
      EXISTS (
        SELECT 1 FROM likes WHERE user_id = ? AND article_id = a.id
      ) AS liked
    FROM articles a
    LEFT JOIN users_tag u ON a.user_id = u.user_id
    WHERE a.id = ?
  `;

  db.get(query, [userId ?? -1, articleId], (err, row) => {
    if (err) return res.status(500).json({ error: "게시글 조회 실패" });
    if (!row) return res.status(404).json({ error: "게시글 없음" });

    row.liked = !!row.liked; // 숫자 -> 불린 처리
    updateView();
    res.json(row);
    db.close();
  });
});

// 게시글 수정
router.put(
  "/articles/:id",
  authenticateToken,
  upload.single("image"),
  (req, res) => {
    const db = new sqlite3.Database("./clash_community.db");
    const articleId = req.params.id;
    const { title, content, tags, category } = req.body;
    const updatedAt = new Date().toISOString();

    if (!title || !content || !category) {
      return res
        .status(400)
        .json({ error: "제목, 내용, 카테고리는 필수입니다." });
    }

    db.get(
      `SELECT * FROM articles WHERE id = ?`,
      [articleId],
      (err, article) => {
        if (err || !article)
          return res.status(404).json({ error: "게시글이 존재하지 않습니다." });

        if (article.user_id !== req.user.id) {
          return res
            .status(403)
            .json({ error: "작성자만 수정할 수 있습니다." });
        }

        const imageUrl = req.file
          ? `/uploads/${req.file.filename}`
          : article.image_url;
        const query = `
      UPDATE articles
      SET title = ?, content = ?, tags = ?, category = ?, updated_at = ?, image_url = ?
      WHERE id = ?
    `;

        db.run(
          query,
          [title, content, tags, category, updatedAt, imageUrl, articleId],
          function (err) {
            if (err) return res.status(500).json({ error: "수정 실패" });
            res.json({
              message: "게시글이 수정되었습니다.",
              updatedId: articleId,
            });
            db.close();
          }
        );
      }
    );
  }
);

// 게시글 삭제
router.delete("/articles/:id", authenticateToken, (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const articleId = req.params.id;

  db.get(`SELECT * FROM articles WHERE id = ?`, [articleId], (err, article) => {
    if (err || !article)
      return res.status(404).json({ error: "게시글이 존재하지 않습니다." });

    if (article.user_id !== req.user.id) {
      return res.status(403).json({ error: "작성자만 삭제할 수 있습니다." });
    }

    db.run(`DELETE FROM articles WHERE id = ?`, [articleId], function (err) {
      if (err) {
        console.error("❌ 게시글 삭제 오류:", err.message);
        return res.status(500).json({ error: "게시글 삭제 실패" });
      }

      res.json({
        message: "게시글이 성공적으로 삭제되었습니다.",
        deletedId: articleId,
      });
      db.close();
    });
  });
});

// 내 글 조회
router.get("/my-articles", authenticateToken, (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const userId = req.user.id;

  const query = `
    SELECT articles.id, articles.title, articles.content, articles.user_id, articles.created_at, 
           users_tag.nickname, articles.category, articles.likes, articles.views
    FROM articles
    LEFT JOIN users_tag ON articles.user_id = users_tag.user_id
    WHERE articles.user_id = ?
    ORDER BY articles.created_at DESC
  `;

  db.all(query, [userId], (err, rows) => {
    if (err) {
      console.error("❌ 내 글 조회 오류:", err.message);
      return res.status(500).json({ error: "내 글 조회 실패" });
    }

    res.json(rows);
    db.close();
  });
});

// 게시글 좋아요 토글
router.post("/articles/:id/like", authenticateToken, (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const articleId = req.params.id;
  const userId = req.user.id;

  const checkQuery = `SELECT * FROM likes WHERE user_id = ? AND article_id = ?`;
  db.get(checkQuery, [userId, articleId], (err, row) => {
    if (err) return res.status(500).json({ error: "좋아요 상태 조회 실패" });

    if (row) {
      const deleteQuery = `DELETE FROM likes WHERE user_id = ? AND article_id = ?`;
      db.run(deleteQuery, [userId, articleId], function (err) {
        if (err) return res.status(500).json({ error: "좋아요 취소 실패" });

        const updateQuery = `UPDATE articles SET likes = likes - 1 WHERE id = ? AND likes > 0`;
        db.run(updateQuery, [articleId], function (err) {
          if (err)
            return res.status(500).json({ error: "좋아요 수 감소 실패" });

          res.json({ message: "좋아요 취소됨" });
          db.close();
        });
      });
    } else {
      const insertQuery = `INSERT INTO likes (user_id, article_id) VALUES (?, ?)`;
      db.run(insertQuery, [userId, articleId], function (err) {
        if (err) return res.status(500).json({ error: "좋아요 추가 실패" });

        const updateQuery = `UPDATE articles SET likes = likes + 1 WHERE id = ?`;
        db.run(updateQuery, [articleId], function (err) {
          if (err)
            return res.status(500).json({ error: "좋아요 수 증가 실패" });

          res.json({ message: "좋아요 추가됨" });
          db.close();
        });
      });
    }
  });
});
router.get("/my-likes", authenticateToken, (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const userId = req.user.id;

  const query = `
    SELECT a.id, a.title, a.content, a.likes, a.created_at, ut.nickname
    FROM likes l
    JOIN articles a ON l.article_id = a.id
    JOIN users_tag ut ON a.user_id = ut.user_id
    WHERE l.user_id = ?
    ORDER BY a.created_at DESC
  `;

  db.all(query, [userId], (err, rows) => {
    if (err)
      return res.status(500).json({ error: "데이터를 불러올 수 없습니다." });
    res.json(rows);
    db.close();
  });
});

export default router;
