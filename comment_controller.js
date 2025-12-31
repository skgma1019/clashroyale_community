import express from "express";
import sqlite3 from "sqlite3";
import { authenticateToken } from "./auth.js";
import multer from "multer";
import path from "path";
import fs from "fs";

const router = express.Router();

// 업로드 폴더 생성
const uploadDir = "./uploads";
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// multer 설정 (파일명 유니크 + 이미지 제한 + 용량 제한)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + unique + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 3 * 1024 * 1024, // 3MB
  },
  fileFilter: (req, file, cb) => {
    // 이미지 MIME 타입만 허용
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      return cb(new Error("이미지 파일만 업로드할 수 있습니다."));
    }
    cb(null, true);
  },
});

/**
 * 공통: DB 열기
 */
function openDb() {
  return new sqlite3.Database("./clash_community.db");
}

/**
 * 공통: DB close 안전 처리
 */
function safeClose(db) {
  try {
    db.close();
  } catch (e) {
    // ignore
  }
}

/**
 * 공통: sqlite3 run/get/all Promise 래핑
 */
function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

/**
 * 공통: 업로드 파일이 있을 때, 에러 발생 시 파일 삭제(고아 파일 방지)
 */
function tryUnlinkUploaded(req) {
  try {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  } catch {
    // ignore
  }
}

/**
 * multer 에러/검증 에러 처리 미들웨어(라우트별로 사용)
 */
function uploadSingleImage(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (!err) return next();
      // multer/fileFilter 에러
      return res.status(400).json({ error: err.message || "파일 업로드 실패" });
    });
  };
}

/**
 * 댓글 삭제
 * - 작성자만 삭제 가능
 * - comment_likes 정리
 * - 부모 댓글이면 대댓글도 함께 삭제(정책 A)
 */
router.delete("/comments/:id", authenticateToken, async (req, res) => {
  const db = openDb();
  const commentId = Number(req.params.id);

  if (!Number.isInteger(commentId) || commentId <= 0) {
    safeClose(db);
    return res.status(400).json({ error: "잘못된 댓글 ID 입니다." });
  }

  try {
    const comment = await dbGet(db, `SELECT * FROM comments WHERE id = ?`, [
      commentId,
    ]);
    if (!comment) {
      safeClose(db);
      return res.status(404).json({ error: "해당 댓글이 존재하지 않습니다." });
    }

    if (comment.user_id !== req.user.id) {
      safeClose(db);
      return res.status(403).json({ error: "작성자만 삭제할 수 있습니다." });
    }

    // 1) 삭제 대상(부모면 대댓글 포함) 목록 가져오기
    const targets = await dbAll(
      db,
      `
      SELECT id, image_url
      FROM comments
      WHERE id = ? OR parent_id = ?
    `,
      [commentId, commentId]
    );

    // 2) 좋아요 먼저 정리
    for (const t of targets) {
      await dbRun(db, `DELETE FROM comment_likes WHERE comment_id = ?`, [t.id]);
    }

    // 3) 댓글 삭제 (부모 + 대댓글)
    await dbRun(db, `DELETE FROM comments WHERE id = ? OR parent_id = ?`, [
      commentId,
      commentId,
    ]);

    // 4) 업로드 이미지 파일 정리(선택)
    // image_url 형식: /uploads/filename
    for (const t of targets) {
      if (
        t.image_url &&
        typeof t.image_url === "string" &&
        t.image_url.startsWith("/uploads/")
      ) {
        const filename = t.image_url.replace("/uploads/", "");
        const filePath = path.join(uploadDir, filename);
        try {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch {
          // ignore
        }
      }
    }

    safeClose(db);
    return res.json({
      message: "댓글이 성공적으로 삭제되었습니다.",
      deletedId: commentId,
    });
  } catch (err) {
    safeClose(db);
    return res.status(500).json({ error: "댓글 삭제 실패" });
  }
});

/**
 * 댓글 수정
 * - 작성자만 수정 가능
 */
router.patch("/comments/:id", authenticateToken, async (req, res) => {
  const db = openDb();
  const commentId = Number(req.params.id);
  const { content } = req.body;

  if (!Number.isInteger(commentId) || commentId <= 0) {
    safeClose(db);
    return res.status(400).json({ error: "잘못된 댓글 ID 입니다." });
  }

  if (!content || typeof content !== "string" || !content.trim()) {
    safeClose(db);
    return res.status(400).json({ error: "수정할 내용이 없습니다." });
  }

  try {
    const comment = await dbGet(db, `SELECT * FROM comments WHERE id = ?`, [
      commentId,
    ]);
    if (!comment) {
      safeClose(db);
      return res.status(404).json({ error: "해당 댓글이 존재하지 않습니다." });
    }

    if (comment.user_id !== req.user.id) {
      safeClose(db);
      return res.status(403).json({ error: "작성자만 수정할 수 있습니다." });
    }

    await dbRun(db, `UPDATE comments SET content = ? WHERE id = ?`, [
      content.trim(),
      commentId,
    ]);
    safeClose(db);
    return res.json({
      message: "댓글이 수정되었습니다.",
      updatedId: commentId,
    });
  } catch (err) {
    safeClose(db);
    return res.status(500).json({ error: "댓글 수정 실패" });
  }
});

/**
 * 댓글 좋아요 토글
 * - 댓글 존재 확인
 */
router.post("/comments/:id/like", authenticateToken, async (req, res) => {
  const db = openDb();
  const commentId = Number(req.params.id);
  const userId = req.user.id;

  if (!Number.isInteger(commentId) || commentId <= 0) {
    safeClose(db);
    return res.status(400).json({ error: "잘못된 댓글 ID 입니다." });
  }

  try {
    // 댓글 존재 확인
    const exists = await dbGet(db, `SELECT id FROM comments WHERE id = ?`, [
      commentId,
    ]);
    if (!exists) {
      safeClose(db);
      return res.status(404).json({ error: "해당 댓글이 존재하지 않습니다." });
    }

    const row = await dbGet(
      db,
      `SELECT 1 FROM comment_likes WHERE comment_id = ? AND user_id = ?`,
      [commentId, userId]
    );

    if (row) {
      await dbRun(
        db,
        `DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?`,
        [commentId, userId]
      );
      safeClose(db);
      return res.json({ message: "댓글 좋아요 취소됨", liked: false });
    } else {
      await dbRun(
        db,
        `INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)`,
        [commentId, userId]
      );
      safeClose(db);
      return res.json({ message: "댓글 좋아요 추가됨", liked: true });
    }
  } catch (err) {
    safeClose(db);
    return res.status(500).json({ error: "좋아요 처리 실패" });
  }
});

/**
 * 댓글 작성 (대댓글 포함)
 * - image 업로드(이미지만, 용량 제한)
 * - parentId 검증(존재 + 같은 article)
 */
router.post(
  "/articles/:id/comments",
  authenticateToken,
  uploadSingleImage("image"),
  async (req, res) => {
    const db = openDb();
    const articleId = Number(req.params.id);
    const userId = req.user.id;
    const { content, parentId } = req.body;

    if (!Number.isInteger(articleId) || articleId <= 0) {
      tryUnlinkUploaded(req);
      safeClose(db);
      return res.status(400).json({ error: "잘못된 게시글 ID 입니다." });
    }

    if (!content || typeof content !== "string" || !content.trim()) {
      tryUnlinkUploaded(req);
      safeClose(db);
      return res.status(400).json({ error: "댓글 내용을 입력해주세요." });
    }

    const parent = parentId ? Number(parentId) : null;
    if (parentId && (!Number.isInteger(parent) || parent <= 0)) {
      tryUnlinkUploaded(req);
      safeClose(db);
      return res.status(400).json({ error: "잘못된 parentId 입니다." });
    }

    try {
      // 게시글 존재 확인(선택이지만 실무적으로 추천)
      const article = await dbGet(db, `SELECT id FROM articles WHERE id = ?`, [
        articleId,
      ]);
      if (!article) {
        tryUnlinkUploaded(req);
        safeClose(db);
        return res.status(404).json({ error: "게시글이 존재하지 않습니다." });
      }

      // parentId 검증: 존재 + 같은 article
      if (parent !== null) {
        const parentComment = await dbGet(
          db,
          `SELECT id, article_id FROM comments WHERE id = ?`,
          [parent]
        );
        if (!parentComment) {
          tryUnlinkUploaded(req);
          safeClose(db);
          return res
            .status(404)
            .json({ error: "parentId에 해당하는 댓글이 존재하지 않습니다." });
        }
        if (parentComment.article_id !== articleId) {
          tryUnlinkUploaded(req);
          safeClose(db);
          return res
            .status(400)
            .json({ error: "parentId 댓글이 해당 게시글의 댓글이 아닙니다." });
        }
      }

      const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
      const createdAt = new Date().toISOString();

      const result = await dbRun(
        db,
        `
        INSERT INTO comments (article_id, user_id, content, created_at, image_url, parent_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        [articleId, userId, content.trim(), createdAt, imageUrl, parent]
      );

      safeClose(db);
      return res
        .status(201)
        .json({ message: "댓글이 작성되었습니다.", commentId: result.lastID });
    } catch (err) {
      tryUnlinkUploaded(req);
      safeClose(db);
      return res.status(500).json({ error: "댓글 작성 실패" });
    }
  }
);

/**
 * 댓글 조회 (대댓글 포함)
 * - parent(최신) 먼저, replies(오래된->최신)로 정렬 보정
 */
router.get("/articles/:id/comments", async (req, res) => {
  const db = openDb();
  const articleId = Number(req.params.id);

  if (!Number.isInteger(articleId) || articleId <= 0) {
    safeClose(db);
    return res.status(400).json({ error: "잘못된 게시글 ID 입니다." });
  }

  try {
    const rows = await dbAll(
      db,
      `
      SELECT
        c.id, c.user_id, c.content, c.created_at,
        u.nickname, c.image_url, c.parent_id,
        (SELECT COUNT(*) FROM comment_likes WHERE comment_id = c.id) AS likes
      FROM comments c
      LEFT JOIN users_tag u ON c.user_id = u.user_id
      WHERE c.article_id = ?
    `,
      [articleId]
    );

    // 부모/대댓글 분리
    const parents = rows
      .filter((x) => x.parent_id === null)
      // 부모는 최신이 위로
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const replies = rows
      .filter((x) => x.parent_id !== null)
      // 대댓글은 오래된->최신(대화 흐름 자연스럽게)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // 부모에 replies 붙이기
    const replyMap = new Map();
    for (const r of replies) {
      const key = r.parent_id;
      if (!replyMap.has(key)) replyMap.set(key, []);
      replyMap.get(key).push(r);
    }

    for (const p of parents) {
      p.replies = replyMap.get(p.id) || [];
    }

    safeClose(db);
    return res.json(parents);
  } catch (err) {
    safeClose(db);
    return res.status(500).json({ error: "댓글을 불러오는 데 실패했습니다." });
  }
});

export default router;
