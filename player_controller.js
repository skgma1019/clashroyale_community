import dotenv from "dotenv";
dotenv.config();

import express from "express";
import axios from "axios";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import sqlite3 from "sqlite3";
import { authenticateToken } from "./auth.js";

const router = express.Router();

if (!process.env.JWT_SECRET || !process.env.CLASH_API_TOKEN) {
  console.error("❌ 환경변수 설정 누락. .env 파일을 확인하세요.");
  process.exit(1);
}

// 플레이어 단일 조회
router.get("/api/player/:tag", async (req, res) => {
  const tag = req.params.tag.toUpperCase().replace("#", "");
  const encodedTag = encodeURIComponent(`#${tag}`);

  try {
    const response = await axios.get(
      `https://api.clashroyale.com/v1/players/${encodedTag}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.CLASH_API_TOKEN}`,
        },
      }
    );
    res.json(response.data);
  } catch (error) {
    console.error("[❌ Clash API 오류]", error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      message: "플레이어 정보를 불러오는 데 실패했습니다.",
      error: error.response?.data || error.message,
    });
  }
});

// 회원가입
router.post("/register", async (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const { email, password, nickname, tag } = req.body;

  if (!email || !password || !nickname || !tag) {
    return res
      .status(400)
      .json({ error: "이메일, 비밀번호, 닉네임, 태그는 필수입니다." });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const checkQuery = `SELECT * FROM users_tag WHERE nickname = ?`;
    db.get(checkQuery, [nickname], (err, existing) => {
      if (err) return res.status(500).json({ error: "중복 체크 실패" });
      if (existing)
        return res.status(409).json({ error: "이미 존재하는 닉네임입니다." });

      db.run(
        `INSERT INTO users (email, password) VALUES (?, ?)`,
        [email, hashedPassword],
        function (err) {
          if (err)
            return res.status(500).json({ error: "회원가입 실패 (users)" });

          const userId = this.lastID;
          db.run(
            `INSERT INTO users_tag (user_id, tag, nickname) VALUES (?, ?, ?)`,
            [userId, tag, nickname],
            (err) => {
              if (err)
                return res
                  .status(500)
                  .json({ error: "회원가입 실패 (users_tag)" });
              res.status(201).json({ message: "회원가입 성공", userId });
              db.close();
            }
          );
        }
      );
    });
  } catch (error) {
    res.status(500).json({ error: "회원가입 처리 중 예외 발생" });
    db.close();
  }
});

// 로그인
router.post("/login", (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const { email, password } = req.body;

  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err) return res.status(500).json({ error: "로그인 실패" });
    if (!user)
      return res.status(404).json({ error: "존재하지 않는 이메일입니다." });

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ error: "비밀번호가 틀렸습니다." });

    const token = jwt.sign({ id: user.id, email }, process.env.JWT_SECRET, {
      expiresIn: "1h",
    });
    res.json({ message: "로그인 성공", token, userId: user.id });
    db.close();
  });
});

// 인증된 사용자 정보
router.get("/me", authenticateToken, (req, res) => {
  res.json({ message: "인증된 사용자입니다.", user: req.user });
});

// 자신의 프로필 조회
router.get("/me/info", authenticateToken, (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const userId = req.user.id;

  const query = `
    SELECT u.email, ut.nickname, ut.tag, ut.trophies, ut.clan_name, ut.arena, ut.last_updated
    FROM users u
    LEFT JOIN users_tag ut ON u.id = ut.user_id
    WHERE u.id = ?
  `;

  db.get(query, [userId], (err, row) => {
    if (err) return res.status(500).json({ error: "회원 정보 불러오기 실패" });
    if (!row)
      return res.status(404).json({ error: "회원 정보를 찾을 수 없습니다." });
    res.json(row);
    db.close();
  });
});

// 프로필 수정
router.patch("/me/profile", authenticateToken, async (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const userId = req.user.id;
  const { nickname, tag } = req.body;

  if (!nickname && !tag)
    return res.status(400).json({ error: "수정할 항목이 없습니다." });

  try {
    const existing = await new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM users_tag WHERE (nickname = ? OR tag = ?) AND user_id != ?`,
        [nickname, tag, userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (existing && nickname && existing.nickname === nickname) {
      return res.status(409).json({ error: "이미 존재하는 닉네임입니다." });
    }

    const fields = [];
    const values = [];

    if (nickname) {
      fields.push("nickname = ?");
      values.push(nickname);
    }

    if (tag) {
      const normalizedTag = tag.startsWith("#") ? tag : `#${tag.toUpperCase()}`;
      const encodedTag = encodeURIComponent(normalizedTag);
      const url = `https://api.clashroyale.com/v1/players/${encodedTag}`;

      try {
        const clashRes = await axios.get(url, {
          headers: { Authorization: `Bearer ${process.env.CLASH_API_TOKEN}` },
        });

        const data = clashRes.data;
        fields.push("tag = ?", "trophies = ?", "clan_name = ?", "arena = ?");
        values.push(
          normalizedTag,
          data.trophies,
          data.clan?.name || null,
          data.arena?.name || null
        );
      } catch (apiErr) {
        console.error(
          "❌ API 호출 실패:",
          apiErr.response?.data || apiErr.message
        );
        return res.status(500).json({ error: "클래시 API 호출 실패" });
      }
    }

    fields.push("last_updated = CURRENT_TIMESTAMP");
    values.push(userId);

    const updateQuery = `UPDATE users_tag SET ${fields.join(
      ", "
    )} WHERE user_id = ?`;

    await new Promise((resolve, reject) => {
      db.run(updateQuery, values, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    res.json({ message: "프로필이 성공적으로 업데이트되었습니다." });
  } catch (err) {
    console.error("❌ 서버 오류:", err);
    res.status(500).json({ error: "서버 내부 오류" });
  } finally {
    db.close();
  }
});

// 유저 공개 설정
router.patch("/me/privacy", authenticateToken, (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const userId = req.user.id;
  const { is_public } = req.body;

  if (typeof is_public !== "number") {
    return res
      .status(400)
      .json({ error: "is_public은 숫자(0 또는 1)여야 합니다." });
  }

  db.run(
    `UPDATE users_tag SET is_public = ? WHERE user_id = ?`,
    [is_public, userId],
    function (err) {
      if (err) {
        console.error("❌ 공개 설정 오류:", err.message);
        return res.status(500).json({ error: "공개 설정 저장 실패" });
      }
      res.json({ message: "공개 설정이 저장되었습니다." });
      db.close();
    }
  );
});

// 다른 유저의 정보 조회 (JOIN + 공개여부 확인 포함)
router.get("/users/:id/info", (req, res) => {
  const db = new sqlite3.Database("./clash_community.db");
  const userId = req.params.id;

  const query = `
    SELECT u.email, ut.nickname, ut.tag, ut.trophies, ut.clan_name, ut.arena, ut.last_updated, ut.is_public
    FROM users u
    LEFT JOIN users_tag ut ON u.id = ut.user_id
    WHERE u.id = ?
  `;

  db.get(query, [userId], (err, row) => {
    if (err) return res.status(500).json({ error: "유저 정보 조회 실패" });
    if (!row)
      return res.status(404).json({ error: "유저가 존재하지 않습니다." });
    if (row.is_public === 0)
      return res.status(403).json({ error: "비공개 처리된 계정입니다." });

    res.json(row);
    db.close();
  });
});

export default router;
