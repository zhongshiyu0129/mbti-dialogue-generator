// ============================================================
// MBTI 对话图生成器 - 服务端
// - 托管前端静态页面
// - 代理火山方舟 API（图片生成 / 语言模型），Key 只存在服务端环境变量
// - 基础限流，防止公开后被刷
// ============================================================
const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// 火山方舟配置（Key 从环境变量读取，绝不写进代码、不下发浏览器）
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';

// 请求体里含 base64 参考图，放宽体积上限
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

// ---------- 安全：拦截敏感文件，不允许通过静态服务下载 ----------
app.use((req, res, next) => {
  const p = decodeURIComponent(req.path);
  const deny =
    p === '/config.js' ||
    p === '/server.js' ||
    p === '/package.json' ||
    p === '/package-lock.json' ||
    p === '/.env' ||
    p === '/.api_key' ||
    p === '/.gitignore' ||
    /\.(key|env)$/.test(p) ||
    p.startsWith('/.git') ||
    p.startsWith('/_backup');
  if (deny) return res.status(404).send('Not Found');
  next();
});

// ---------- 限流（基础防刷，按来源 IP） ----------
// 图片生成较贵：每 10 分钟最多 15 次
const imageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '生成过于频繁，请稍后再试（每 10 分钟最多 15 张）。' },
});
// 语言模型分镜：每 10 分钟最多 60 次
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试。' },
});

// ---------- 通用代理转发 ----------
async function proxyToArk(req, res, arkPath) {
  if (!ARK_API_KEY) {
    return res.status(500).json({ error: '服务器未配置 ARK_API_KEY，请联系管理员。' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000); // 3 分钟超时
  try {
    const upstream = await fetch(ARK_BASE + arkPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ARK_API_KEY}`,
      },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const buf = await upstream.arrayBuffer();
    const ct = upstream.headers.get('content-type');
    res.status(upstream.status);
    if (ct) res.setHeader('Content-Type', ct);
    res.send(Buffer.from(buf));
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'AI 生成超时，请重试。' });
    }
    res.status(502).json({ error: '代理请求失败：' + e.message });
  } finally {
    clearTimeout(timer);
  }
}

app.post('/api/images/generations', imageLimiter, (req, res) => {
  proxyToArk(req, res, '/images/generations');
});
app.post('/api/chat/completions', chatLimiter, (req, res) => {
  proxyToArk(req, res, '/chat/completions');
});

// 简单健康检查
app.get('/api/health', (req, res) => {
  res.json({ ok: true, keyConfigured: Boolean(ARK_API_KEY) });
});

// ---------- 静态前端（dotfiles 一律拒绝） ----------
app.use(
  express.static(__dirname, {
    index: 'index.html',
    dotfiles: 'deny',
    extensions: ['html'],
  })
);

// SPA 兜底：未匹配的路由返回首页
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`MBTI 对话图生成器已启动: http://localhost:${PORT}`);
  if (!ARK_API_KEY) {
    console.warn('警告：未设置 ARK_API_KEY 环境变量，API 调用将失败。');
  }
});
