#!/usr/bin/env node

// ============================================================================
// Follow Builders — Daily Digest Email (cloud)
// ============================================================================
// Reads the central feeds (tweets/blogs/podcasts) + prompts, asks GLM to
// remix a Chinese digest, and emails it via Resend. Built to run in a GitHub
// Actions cron — no local agent, no node_modules needed (Node 20 fetch).
//
// Env: GLM_API_KEY, RESEND_API_KEY, DELIVERY_EMAIL, GLM_MODEL (default glm-4.6)
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM 下没有 __dirname, 手动构造
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// -- Constants ---------------------------------------------------------------

const FEED_X_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json';

const PROMPTS_BASE = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/prompts';
const PROMPT_FILES = ['digest-intro.md', 'summarize-tweets.md', 'summarize-blogs.md', 'summarize-podcast.md', 'translate.md'];

const GLM_ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const REPO_URL = 'https://github.com/zarazhangrui/follow-builders';

// Truncation budgets — keep total well under GLM's 128K context
const MAX_TWEETS_PER_BUILDER = 3;
const MAX_PODCAST_EPISODES = 2;
const PODCAST_TRANSCRIPT_CHARS = 8000;
const MAX_BLOG_POSTS = 5;
const BLOG_CONTENT_CHARS = 4000;

// -- Fetch helpers (with retry — raw.githubusercontent.com 偶发 ECONNRESET) -

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      if (i < retries - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchJSON(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetchWithRetry(url);
  if (!res.ok) return null;
  return res.text();
}

function todayLong() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Asia/Shanghai'
  });
}

// 文件名用的日期戳 YYYY-MM-DD (Asia/Shanghai), 用于落盘归档
function todayStamp() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

// -- Build material text (truncated) -----------------------------------------

function buildXText(builders = []) {
  const lines = [];
  for (const b of builders) {
    const tweets = (b.tweets || [])
      .slice()
      .sort((a, c) => (c.likes || 0) - (a.likes || 0))
      .slice(0, MAX_TWEETS_PER_BUILDER);
    if (!tweets.length) continue;
    lines.push(`${b.name || b.handle} (${b.bio || ''})`);
    for (const t of tweets) {
      lines.push(`  - ${t.text || ''}`);
      lines.push(`    ${t.url || ''} (likes:${t.likes || 0})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function buildPodcastsText(podcasts = []) {
  const lines = [];
  for (const p of podcasts.slice(0, MAX_PODCAST_EPISODES)) {
    lines.push(`${p.name} — ${p.title || ''}`);
    lines.push(`  URL: ${p.url || ''}`);
    lines.push(`  Transcript: ${(p.transcript || '').slice(0, PODCAST_TRANSCRIPT_CHARS)}`);
    lines.push('');
  }
  return lines.join('\n');
}

function buildBlogsText(blogs = []) {
  const lines = [];
  for (const b of blogs.slice(0, MAX_BLOG_POSTS)) {
    lines.push(`${b.name}: ${b.title || ''}`);
    lines.push(`  URL: ${b.url || ''}`);
    if (b.author) lines.push(`  Author: ${b.author}`);
    lines.push(`  Content: ${(b.content || '').slice(0, BLOG_CONTENT_CHARS)}`);
    lines.push('');
  }
  return lines.join('\n');
}

// -- GLM call ----------------------------------------------------------------

async function callGLM(systemText, userText, model) {
  const body = {
    model,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userText }
    ],
    temperature: 0.7,
    top_p: 0.9,
    max_tokens: 8192
  };

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(GLM_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.GLM_API_KEY}`
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`GLM API ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('GLM returned empty content');
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt === 0) await sleep(3000);
    }
  }
  throw lastErr;
}

// -- Fallback digest (GLM 不可用时, 用原始素材直接拼一份降级日报) ------------
// GLM 欠费/限流/抖动时, 不让整条产出链路断掉。把已拉到的素材铺成 HTML,
// 落盘 + 推送照常进行, 顶部加醒目提示让读者知道是降级版。
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildFallbackHtml(builders, podcasts, blogs, reason) {
  const parts = [];
  parts.push(`<h1>AI Builders 日报 · ${todayLong()}</h1>`);
  parts.push(
    `<p style="background:#fef3c7;border-left:4px solid #f59e0b;padding:10px 12px;color:#92400e;">` +
    `⚠️ <strong>AI 加工暂不可用,以下为原始素材快照。</strong>原因:${escapeHtml(reason)}。` +
    `素材本身完整,GLM 恢复后次日将自动回到精编版。</p>`
  );

  if (builders.length) {
    parts.push(`<h2>X / 推特</h2>`);
    for (const b of builders) {
      const tweets = (b.tweets || []).slice().sort((a, c) => (c.likes || 0) - (a.likes || 0)).slice(0, MAX_TWEETS_PER_BUILDER);
      if (!tweets.length) continue;
      parts.push(`<div class="item"><h3>${escapeHtml(b.name || b.handle)} (${escapeHtml(b.bio || '')})</h3>`);
      for (const t of tweets) {
        parts.push(`<p>${escapeHtml(t.text || '')}` + (t.url ? ` <a href="${escapeHtml(t.url)}">详情</a>` : '') + `</p>`);
      }
      parts.push(`</div>`);
    }
  }

  if (blogs.length) {
    parts.push(`<h2>官方博客</h2>`);
    for (const b of blogs.slice(0, MAX_BLOG_POSTS)) {
      parts.push(`<div class="item"><h3>${escapeHtml(b.name)}: ${escapeHtml(b.title || '')}</h3>`);
      parts.push(`<p>${escapeHtml((b.content || '').slice(0, BLOG_CONTENT_CHARS))}` + (b.url ? ` <a href="${escapeHtml(b.url)}">详情</a>` : '') + `</p></div>`);
    }
  }

  if (podcasts.length) {
    parts.push(`<h2>播客</h2>`);
    for (const p of podcasts.slice(0, MAX_PODCAST_EPISODES)) {
      parts.push(`<div class="item"><h3>${escapeHtml(p.name)} — ${escapeHtml(p.title || '')}</h3>`);
      parts.push(`<p>${escapeHtml((p.transcript || '').slice(0, PODCAST_TRANSCRIPT_CHARS))}` + (p.url ? ` <a href="${escapeHtml(p.url)}">详情</a>` : '') + `</p></div>`);
    }
  }

  parts.push(`<p class="footer">由 Follow Builders 技能自动生成 · <a href="${REPO_URL}">详情</a></p>`);
  return parts.join('\n');
}

// -- Email (Resend) — HTML body with 详情 hyperlinks -------------------------

// GLM sometimes wraps its HTML in ``` fences; strip them so the email renders.
function sanitizeFragment(s) {
  return String(s).trim().replace(/^```(?:html)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// Wrap the GLM-produced inner HTML in a styled, mobile-friendly document.
function wrapHtml(inner) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Builders Digest</title>
<style>
  body { margin:0; padding:0; background:#f4f4f5; color:#1f2328;
         font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
         line-height:1.7; }
  .wrap { max-width:560px; margin:0 auto; padding:24px 20px 40px; background:#ffffff; }
  h1 { font-size:22px; line-height:1.3; margin:0 0 20px; padding-bottom:12px;
       border-bottom:2px solid #111827; }
  h2 { font-size:13px; letter-spacing:1.5px; color:#6b7280; text-transform:uppercase;
       margin:28px 0 12px; }
  .item { margin:0 0 22px; padding:0 0 22px; border-bottom:1px solid #eee; }
  h3 { font-size:16px; margin:0 0 8px; color:#111827; }
  p { margin:0 0 10px; font-size:15px; }
  .link { margin:6px 0 0; }
  a { color:#2563eb; text-decoration:none; }
  a:hover { text-decoration:underline; }
  .footer { margin-top:28px; font-size:13px; color:#9ca3af; }
</style>
</head>
<body>
<div class="wrap">
${inner}
</div>
</body>
</html>`;
}

// Plain-text fallback: expand 详情 links to "详情: URL" so links survive.
function htmlToText(html) {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '$2: $1')
    .replace(/<\/(p|h1|h2|h3|div|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Markdown for Server酱 (微信): keep links as [text](url), headings as #/##/###,
// keyword highlight (.hl) → **bold**. Strip <head>/<style> so CSS doesn't leak.
function htmlToMarkdown(html) {
  return html
    .replace(/<head>[\s\S]*?<\/head>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<h1[^>]*>/gi, '\n# ').replace(/<\/h1>/gi, '\n')
    .replace(/<h2[^>]*>/gi, '\n## ').replace(/<\/h2>/gi, '\n')
    .replace(/<h3[^>]*>/gi, '\n### ').replace(/<\/h3>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<span class="hl">(.*?)<\/span>/gi, '**$1**')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendEmail(html, apiKey, toEmail) {
  const recipients = String(toEmail).split(',').map((s) => s.trim()).filter(Boolean);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: recipients,
      subject: `AI Builders 日报 · ${todayLong()}`,
      html,
      text: htmlToText(html)
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

// Server酱 (微信) push — markdown body. SendKey in URL path, no header auth.
// Mirrors push_aihot.py: POST title+desp as form-urlencoded to sctapi.ftqq.com.
async function pushWechat(markdown, sendkey) {
  const body = new URLSearchParams();
  body.set('title', `AI Builders 日报 · ${todayLong()}`);
  body.set('desp', markdown);
  const res = await fetch(`https://sctapi.ftqq.com/${sendkey}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) {
    throw new Error(`Server酱 ${res.status} code=${data.code}: ${data.message || ''}`);
  }
}

// DRY_RUN=1 → write the exact HTML that would be sent to a file instead of
// emailing, so the rendered output can be inspected without touching an inbox.
async function deliver(html) {
  // 落盘成品日报归档(无论是否 DRY_RUN 都存): digest/YYYY-MM-DD.html + .md
  // 失败不中断主流程, 只记日志
  try {
    const dir = join(__dirname, '..', 'digest');
    mkdirSync(dir, { recursive: true });
    const stamp = todayStamp();
    writeFileSync(join(dir, `${stamp}.html`), html, 'utf8');
    writeFileSync(join(dir, `${stamp}.md`), htmlToMarkdown(html), 'utf8');
    console.log(`archived: digest/${stamp}.html + .md`);
  } catch (e) {
    console.error(`archive failed (continue to send): ${e.message}`);
  }

  if (process.env.DRY_RUN) {
    const outPath = join(__dirname, 'digest-preview.html');
    writeFileSync(outPath, html);
    console.log(`DRY_RUN: wrote ${outPath} (${html.length} chars)`);
    return;
  }
  // Resend 邮件推送(可选): 未配 RESEND_API_KEY 则跳过, 只落盘归档。
  // 配了才发; 失败不影响已落盘的成品。
  if (process.env.RESEND_API_KEY && process.env.DELIVERY_EMAIL) {
    try {
      await sendEmail(html, process.env.RESEND_API_KEY, process.env.DELIVERY_EMAIL);
    } catch (err) {
      console.error(`resend email failed (digest already archived): ${err.message}`);
    }
  } else {
    console.log('resend skipped (RESEND_API_KEY / DELIVERY_EMAIL not configured) — 仅落盘归档');
  }
  // Server酱 微信推送(可选):SERVERCHAN_SENDKEY 未配则跳过,失败不影响已发的邮件
  if (process.env.SERVERCHAN_SENDKEY) {
    try {
      await pushWechat(htmlToMarkdown(html), process.env.SERVERCHAN_SENDKEY);
    } catch (err) {
      console.error(`wechat push failed (email already sent): ${err.message}`);
    }
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  // 1. Validate env: 只强制要求 GLM_API_KEY (生成日报用)。
  // RESEND_API_KEY / DELIVERY_EMAIL / SERVERCHAN_SENDKEY 都是可选推送渠道,
  // 未配则跳过对应推送, 不影响生成和落盘。
  const required = ['GLM_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
  const model = process.env.GLM_MODEL || 'glm-4.6';

  // 2. Fetch feeds + prompts in parallel
  const [feedX, feedPodcasts, feedBlogs, ...promptTexts] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL),
    ...PROMPT_FILES.map((f) => fetchText(`${PROMPTS_BASE}/${f}`))
  ]);
  const prompts = {};
  PROMPT_FILES.forEach((f, i) => {
    prompts[f.replace('.md', '')] = promptTexts[i] || '';
  });

  const builders = feedX?.x || [];
  const podcasts = feedPodcasts?.podcasts || [];
  const blogs = feedBlogs?.blogs || [];
  const feedGeneratedAt = feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt;

  // 3. Empty content → send a "no updates" notice, skip GLM (saves tokens)
  if (!builders.length && !podcasts.length && !blogs.length) {
    const noticeHtml =
      `<h1>AI Builders 日报 · ${todayLong()}</h1>` +
      `<p>今日各板块均无新内容更新。明日再见。</p>` +
      `<p class="footer">由 Follow Builders 技能自动生成 · <a href="${REPO_URL}">详情</a></p>`;
    await deliver(wrapHtml(noticeHtml));
    console.log(JSON.stringify({ status: 'ok', method: 'email', note: 'no new content' }));
    return;
  }

  // 4. Build messages — system holds stable rules (all 5 prompts + constraints),
  //    user holds the daily-changing material
  const systemText =
    `你是《AI Builders 日报》的中文编辑。请把用户提供的英文素材整理成一份高质量的中文 digest，通过邮件发给订阅者。\n\n` +
    `【全局格式规则】\n${prompts['digest-intro'] || ''}\n\n` +
    `【中文翻译规则】\n${prompts['translate'] || ''}\n\n` +
    `【推文总结规则】\n${prompts['summarize-tweets'] || ''}\n\n` +
    `【博客总结规则】\n${prompts['summarize-blogs'] || ''}\n\n` +
    `【播客总结规则】\n${prompts['summarize-podcast'] || ''}\n\n` +
    `【硬性约束】\n` +
    `- 输出纯中文(技术术语如 LLM/GPU/API/RAG/agent/fine-tuning 等保留英文；人名/公司名/产品名保留英文)。\n` +
    `- 板块顺序固定：X / 推特 → 官方博客 → 播客。某板块无内容则省略该板块。\n` +
    `- 每条内容必须有原始 URL，无 URL 的内容直接丢弃。绝不编造，只用素材里的内容。\n` +
    `- 详细度：每条都要展开介绍，不要压成一句话摘要。遵循「观点 + 依据」(数据/例子/对比/原话)，让读者看完知道这人讲了什么、凭什么这么讲。宁可详尽，不要简略。\n` +
    `- 输出格式为 HTML 片段：只输出 body 内部内容，不要 <html>/<head>/<body> 标签，不要 \`\`\`html 代码块，不要任何解释性文字。\n` +
    `- 链接规则：所有原始 URL 一律写成 <a href="URL">详情</a>，绝不把原始 URL 以明文出现；「详情」紧跟摘要文字末尾(同一个 <p> 内)，不另起一行。结尾那行的仓库地址也用 <a href="...">详情</a>。\n` +
    `- 关键词高亮：每条摘要挑 1-3 个最核心的概念/数字/产品名，用 <span class="hl">关键词</span> 包裹。只标实质名词/数字，不标虚词、不标整句，每条不超过 3 个。\n` +
    `- 严格按以下结构输出(无内容的板块整段省略)：\n` +
    `<h1>AI Builders 日报 · 日期</h1>\n` +
    `<h2>X / 推特</h2>\n` +
    `<div class="item"><h3>作者全名 (角色/公司)</h3><p>先点出该作者当天的核心观点/判断(1 句)，再展开论据——具体数据、例子、对比或引用原话(2-4 句)，让读者明白他为什么这么判断。核心词用 <span class="hl">高亮</span> 标注。<a href="原始URL">详情</a></p></div>\n` +
    `<h2>官方博客</h2>\n` +
    `<div class="item"><h3>博客名: 文章标题</h3><p>展开文章核心主张(1 句)+ 关键细节/数据/结论(2-4 句)，让读者抓到要点和依据。核心词用 <span class="hl">高亮</span> 标注。<a href="原始URL">详情</a></p></div>\n` +
    `<h2>播客</h2>\n` +
    `<div class="item"><h3>节目名 · 集标题</h3><p>The Takeaway(一句核心收获)+ 展开介绍这集聊了什么(嘉宾观点/关键金句/具体案例，2-4 句)。核心词用 <span class="hl">高亮</span> 标注。<a href="原始URL">详情</a></p></div>\n` +
    `<p class="footer">由 Follow Builders 技能自动生成 · <a href="${REPO_URL}">详情</a></p>\n` +
    `- 正文段落不使用 em-dash(—)，用中文标点；标题分隔符保持原样。`;

  const userText =
    `以下是今日素材(feed 生成时间: ${feedGeneratedAt || '未知'})。请按 system 中的规则生成中文 digest。\n\n` +
    `=== X / TWITTER 素材 ===\n${buildXText(builders)}\n` +
    `=== OFFICIAL BLOGS 素材 ===\n${buildBlogsText(blogs)}\n` +
    `=== PODCASTS 素材 ===\n${buildPodcastsText(podcasts)}`;

  // 5. GLM remix (失败时降级到原始素材版, 保证日报每天都能产出)
  let digestText;
  let degraded = false;
  let degradeReason = '';
  try {
    digestText = await callGLM(systemText, userText, model);
  } catch (err) {
    // GLM 欠费/限流/抖动: 不中断, 用原始素材拼一份降级日报, 照常落盘推送
    degraded = true;
    degradeReason = err.message;
    console.error(`GLM failed, falling back to raw-material digest: ${err.message}`);
    digestText = buildFallbackHtml(builders, podcasts, blogs, err.message);
  }

  // 6. Send email (降级版走 wrapHtml 前先不 sanitize, 因为它本身是合法片段;
  //    正常版才需要 sanitizeFragment 去掉 GLM 偶尔加的 ```html 围栏)
  const finalHtml = wrapHtml(degraded ? digestText : sanitizeFragment(digestText));
  await deliver(finalHtml);

  console.log(JSON.stringify({
    status: 'ok',
    method: 'email',
    degraded,
    ...(degraded ? { degradeReason } : { model }),
    builders: builders.length,
    podcasts: podcasts.length,
    blogs: blogs.length,
    digestChars: digestText.length
  }));
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  if (err.cause) console.error('CAUSE:', err.cause?.code || err.cause?.message || JSON.stringify(err.cause));
  console.error(err.stack);
  process.exit(1);
});
