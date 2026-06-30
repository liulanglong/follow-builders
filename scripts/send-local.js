#!/usr/bin/env node

// ============================================================================
// Follow Builders — 本地拉取 + 公司邮箱 SMTP 发送
// ----------------------------------------------------------------------------
// 设计前提(实测确认):
//   - 公司电脑能上公网, 能 git pull 拉到 digest/*.html 成品日报
//   - 公司电脑 SMTP 可达 smtp.honor.com:587 (STARTTLS, 非 465)
//   - 本脚本零 GLM / 零 Resend, 只读现成成品再转发
//
// 流程:
//   1. 扫描 digest/ 目录, 找日期最大的 .html(即当天最新成品)
//   2. 查 state.json, 已发过则跳过(幂等, 防重复发送)
//   3. 用 nodemailer 经公司邮箱 SMTP 发送(587/STARTTLS)
//   4. 成功后更新 state.json
//
// 配置走 .env 文件(scripts/.env), 不硬编码任何凭据:
//   SMTP_HOST=smtp.honor.com
//   SMTP_PORT=587
//   SMTP_USER=你的公司邮箱
//   SMTP_PASS=邮箱授权码(非登录密码)
//   MAIL_TO=收件人邮箱(多个用逗号)
// ============================================================================

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIGEST_DIR = join(__dirname, '..', 'digest');
const STATE_FILE = join(__dirname, 'send-state.json');

// -- 找最新日报 --------------------------------------------------------------

// 从 digest/ 目录里找出日期最大的 .html 文件名(YYYY-MM-DD.html)
// 字符串排序即日期排序, 因为文件名是零填充的 ISO 日期
async function findLatestDigest() {
  if (!existsSync(DIGEST_DIR)) {
    throw new Error(`digest 目录不存在: ${DIGEST_DIR} —— 先 git pull 拉取成品`);
  }
  const files = await readdir(DIGEST_DIR);
  const htmls = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.html$/.test(f)).sort();
  if (!htmls.length) {
    throw new Error('digest/ 下没有 YYYY-MM-DD.html 成品日报 —— 检查 TheGreatJet 是否已落盘');
  }
  return htmls[htmls.length - 1]; // 最大日期 = 最新
}

// -- 幂等去重 ----------------------------------------------------------------

async function loadSent() {
  if (!existsSync(STATE_FILE)) return { sent: [] };
  try {
    const data = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    return { sent: Array.isArray(data.sent) ? data.sent : [] };
  } catch {
    return { sent: [] };
  }
}

async function markSent(filename) {
  const state = await loadSent();
  if (!state.sent.includes(filename)) state.sent.push(filename);
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// -- 校验环境 ----------------------------------------------------------------

function checkEnv() {
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`缺少环境变量: ${missing.join(', ')} —— 请在 scripts/.env 配置`);
  }
}

// -- 主流程 ------------------------------------------------------------------

async function main() {
  checkEnv();

  const latest = await findLatestDigest();
  console.log(`最新日报: digest/${latest}`);

  const state = await loadSent();
  if (state.sent.includes(latest)) {
    console.log(`已发送过 ${latest}, 跳过(幂等)`);
    return;
  }

  const html = await readFile(join(DIGEST_DIR, latest), 'utf8');
  const date = latest.replace(/\.html$/, ''); // YYYY-MM-DD

  // honor 公邮 SMTP 实测配置: 25 端口、明文、无 SSL/STARTTLS
  // SMTP_USER 是 "域名\账号" 格式的 AD 账号(如 hihonor\xxx), 不是邮箱地址
  // 发件人 from 用 MAIL_FROM(邮箱地址), 和登录账号 SMTP_USER 分开
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 25,
    secure: false,      // 25 端口明文
    requireTLS: false,  // honor SMTP 不用 STARTTLS
    tls: {
      // 25 明文端口, 关闭证书校验相关副作用
      rejectUnauthorized: false,
    },
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const recipients = String(process.env.MAIL_TO).split(',').map((s) => s.trim()).filter(Boolean);
  const info = await transporter.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: recipients.join(', '),
    subject: `AI Builders 日报 · ${date}`,
    html,
  });

  await markSent(latest);
  console.log(`已发送 ${latest} -> ${recipients.join(', ')} (id: ${info.messageId})`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
