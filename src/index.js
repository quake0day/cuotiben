// 错题本 — Cloudflare Worker (D1 元数据 + R2 照片 + Workers AI 识题)
// 网页: 密码 cookie 登录;  Agent API: Authorization: Bearer <API_TOKEN>

const SESSION_MSG = 'cuotiben-session-v1';
const DAY = 86400000;
const SRS_DAYS = [1, 3, 7, 14, 30]; // 连续答对 n 次后的下次复习间隔
const MASTER_STREAK = 5;
const SUBJECTS = ['数学', '语文', '英语', '科学', '其他'];
const MAX_IMAGE = 8 * 1024 * 1024;

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (p === '/llms.txt' || p === '/api/v1/docs') return cors(text(docs(url.origin)));
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      if (p === '/api/login' && req.method === 'POST') return login(req, env);
      if (p === '/api/logout' && req.method === 'POST') return json({ ok: true }, 200, { 'set-cookie': 's=; Path=/; Max-Age=0' });
      const actor = await whoami(req, env);
      if (!actor) return cors(json({ error: 'unauthorized' }, 401));
      return cors(await route(req, env, ctx, url, actor));
    } catch (e) {
      console.error(e.stack || e);
      return cors(json({ error: String(e.message || e) }, e.status || 500));
    }
  },
};

// ---------- routing ----------

async function route(req, env, ctx, url, actor) {
  const p = url.pathname, m = req.method;
  const seg = p.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
  if (!p.startsWith('/api/v1/')) return json({ error: 'not found' }, 404);

  if (seg[0] === 'me') return json({ actor, subjects: SUBJECTS });
  if (seg[0] === 'agent-brief' && m === 'GET') return text(agentBrief(url.origin, env), 'text/markdown; charset=utf-8');
  if (seg[0] === 'stats' && m === 'GET') return json(await stats(env));
  if (seg[0] === 'export' && m === 'GET') return exportAll(env, url);
  if (seg[0] === 'images' && seg[1] && m === 'GET') return serveImage(env, seg[1], req);

  if (seg[0] === 'mistakes') {
    if (!seg[1]) {
      if (m === 'GET') return json(await listMistakes(env, url));
      if (m === 'POST') return json(await createMistake(req, env, actor, url.origin), 201);
    } else {
      const id = seg[1];
      if (!seg[2]) {
        if (m === 'GET') return json(await getMistakeOr404(env, id, url.origin));
        if (m === 'PATCH' || m === 'PUT') return json(await updateMistake(req, env, id, url.origin));
        if (m === 'DELETE') return json(await deleteMistake(env, id));
      }
      if (seg[2] === 'images') {
        if (m === 'POST' && !seg[3]) return json(await addImages(req, env, id, url.origin), 201);
        if (m === 'DELETE' && seg[3]) return json(await deleteImage(env, id, seg[3]));
      }
      if (seg[2] === 'review' && m === 'POST') return json(await review(req, env, id, actor, url.origin));
      if (seg[2] === 'reviews' && m === 'GET') return json(await listReviews(env, id));
      if (seg[2] === 'recognize' && m === 'POST') return json(await recognize(env, id, url.origin, actor, await req.json().catch(() => ({}))));
    }
  }
  return json({ error: 'not found' }, 404);
}

// ---------- auth ----------

async function sessionToken(env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.APP_PASSWORD),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(SESSION_MSG));
  return hex(new Uint8Array(sig));
}

// 返回 'web' / 'agent:<name>' / null
async function whoami(req, env) {
  const auth = req.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const tok = auth.slice(7).trim();
    if (env.API_TOKEN && safeEq(tok, env.API_TOKEN)) {
      const name = (req.headers.get('x-agent-name') || 'agent').replace(/[^\w.-]/g, '').slice(0, 40) || 'agent';
      return `agent:${name}`;
    }
    // 密码当 token 也行(方便手动 curl)
    if (env.APP_PASSWORD && safeEq(tok, env.APP_PASSWORD)) return 'web';
    return null;
  }
  if (!env.APP_PASSWORD) return 'web';
  const c = (req.headers.get('cookie') || '').match(/(?:^|;\s*)s=([0-9a-f]+)/);
  return c && c[1] === (await sessionToken(env)) ? 'web' : null;
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function login(req, env) {
  const { password } = await req.json().catch(() => ({}));
  if (!env.APP_PASSWORD || password !== env.APP_PASSWORD) return json({ error: '密码错误' }, 401);
  return json({ ok: true }, 200, {
    'set-cookie': `s=${await sessionToken(env)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${365 * 86400}`,
  });
}

// ---------- mistakes ----------

const FIELDS = ['subject', 'topic', 'question', 'wrong_answer', 'correct_answer', 'analysis', 'source', 'note'];

function cleanFields(src, partial = false) {
  const out = {};
  for (const f of FIELDS) {
    if (src[f] === undefined) { if (!partial) out[f] = ''; continue; }
    out[f] = String(src[f] ?? '').trim().slice(0, f === 'subject' ? 20 : 8000);
  }
  if (src.tags !== undefined) {
    let t = src.tags;
    if (typeof t === 'string') t = t.split(/[,，\s]+/);
    out.tags = JSON.stringify([...new Set((Array.isArray(t) ? t : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, 20));
  } else if (!partial) out.tags = '[]';
  if (src.difficulty !== undefined && src.difficulty !== '') {
    const d = parseInt(src.difficulty, 10);
    out.difficulty = Number.isFinite(d) ? Math.min(5, Math.max(1, d)) : null;
  } else if (!partial) out.difficulty = null;
  if (src.status !== undefined && ['open', 'mastered'].includes(src.status)) out.status = src.status;
  return out;
}

// 支持 multipart/form-data (字段 + photo 文件) 和 JSON (字段 + images:[{data:base64,content_type}])
async function parseBody(req) {
  const ct = req.headers.get('content-type') || '';
  const files = [];
  let fields = {};
  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData();
    for (const [k, v] of fd.entries()) {
      if (v instanceof File) {
        if (v.size > 0) files.push({ bytes: await v.arrayBuffer(), type: v.type || 'image/jpeg', kind: k === 'photo' ? 'question' : k });
      } else if (k === 'tags') (fields.tags ||= []).push(v);
      else fields[k] = v;
    }
  } else {
    fields = await req.json().catch(() => ({}));
    for (const im of Array.isArray(fields.images) ? fields.images : []) {
      let data = String(im.data || im.base64 || '');
      let type = im.content_type || im.type || 'image/jpeg';
      const mm = data.match(/^data:([^;]+);base64,(.*)$/s);
      if (mm) { type = mm[1]; data = mm[2]; }
      if (data) files.push({ bytes: b64decode(data), type, kind: im.kind || 'question' });
    }
    delete fields.images;
  }
  for (const f of files) {
    if (f.bytes.byteLength > MAX_IMAGE) throw new Error(`图片超过 ${MAX_IMAGE / 1048576}MB`);
    if (!/^image\//.test(f.type)) f.type = 'image/jpeg';
  }
  return { fields, files };
}

async function createMistake(req, env, actor, origin) {
  const { fields, files } = await parseBody(req);
  const id = newId();
  const now = iso();
  const f = cleanFields(fields);
  await insertMistake(env, id, f, actor);
  await storeImages(env, id, files);
  return getMistake(env, id, origin);
}

async function insertMistake(env, id, f, actor) {
  const now = iso();
  await env.DB.prepare(`INSERT INTO mistakes (id, subject, topic, question, wrong_answer, correct_answer, analysis, tags, source, note, difficulty, status, next_review_at, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, f.subject, f.topic, f.question, f.wrong_answer, f.correct_answer, f.analysis, f.tags, f.source, f.note || '', f.difficulty,
      f.status || 'open', isoDays(1), actor, now, now).run();
}

async function updateMistake(req, env, id, origin) {
  await getMistakeOr404(env, id, origin);
  const { fields, files } = await parseBody(req);
  const f = cleanFields(fields, true);
  const keys = Object.keys(f);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    await env.DB.prepare(`UPDATE mistakes SET ${sets}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => f[k]), iso(), id).run();
    if (f.status === 'mastered') await env.DB.prepare('UPDATE mistakes SET next_review_at = NULL WHERE id = ?').bind(id).run();
    if (f.status === 'open') await env.DB.prepare('UPDATE mistakes SET next_review_at = COALESCE(next_review_at, ?), streak = 0 WHERE id = ?').bind(isoDays(1), id).run();
  }
  await storeImages(env, id, files);
  return getMistake(env, id, origin);
}

async function deleteMistake(env, id) {
  const imgs = (await env.DB.prepare('SELECT r2_key FROM images WHERE mistake_id = ?').bind(id).all()).results;
  for (const i of imgs) {
    const shared = await env.DB.prepare('SELECT COUNT(*) c FROM images WHERE r2_key = ? AND mistake_id != ?').bind(i.r2_key, id).first('c');
    if (!shared) await env.PHOTOS.delete(i.r2_key);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM images WHERE mistake_id = ?').bind(id),
    env.DB.prepare('DELETE FROM reviews WHERE mistake_id = ?').bind(id),
    env.DB.prepare('DELETE FROM mistakes WHERE id = ?').bind(id),
  ]);
  return { ok: true, id };
}

async function getMistake(env, id, origin) {
  const row = await env.DB.prepare('SELECT * FROM mistakes WHERE id = ?').bind(id).first();
  if (!row) return null;
  const imgs = (await env.DB.prepare('SELECT * FROM images WHERE mistake_id = ? ORDER BY created_at').bind(id).all()).results;
  return shape(row, imgs, origin);
}

async function getMistakeOr404(env, id, origin) {
  const m = await getMistake(env, id, origin);
  if (!m) throw Object.assign(new Error('not found'), { status: 404 });
  return m;
}

async function listMistakes(env, url) {
  const q = url.searchParams;
  const where = [], args = [];
  if (q.get('subject')) { where.push('subject = ?'); args.push(q.get('subject')); }
  if (q.get('status')) { where.push('status = ?'); args.push(q.get('status')); }
  if (q.get('topic')) { where.push('topic LIKE ?'); args.push(`%${q.get('topic')}%`); }
  if (q.get('tag')) { where.push('tags LIKE ?'); args.push(`%"${q.get('tag').replace(/"/g, '')}"%`); }
  if (q.get('q')) { where.push('(question LIKE ? OR topic LIKE ? OR analysis LIKE ? OR correct_answer LIKE ?)'); const s = `%${q.get('q')}%`; args.push(s, s, s, s); }
  if (q.get('since')) { where.push('created_at >= ?'); args.push(q.get('since')); }
  if (q.get('due') === '1' || q.get('due') === 'true') { where.push("status = 'open' AND next_review_at IS NOT NULL AND next_review_at <= ?"); args.push(iso()); }
  const limit = Math.min(500, Math.max(1, parseInt(q.get('limit') || '50', 10) || 50));
  const offset = Math.max(0, parseInt(q.get('offset') || '0', 10) || 0);
  const order = q.get('due') ? 'next_review_at ASC' : 'created_at DESC';
  const sql = `FROM mistakes ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const total = (await env.DB.prepare(`SELECT COUNT(*) c ${sql}`).bind(...args).first()).c;
  const rows = (await env.DB.prepare(`SELECT * ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...args, limit, offset).all()).results;
  const imgs = await imagesFor(env, rows.map((r) => r.id));
  return { total, limit, offset, items: rows.map((r) => shape(r, imgs[r.id] || [], url.origin)) };
}

async function imagesFor(env, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = (await env.DB.prepare(`SELECT * FROM images WHERE mistake_id IN (${chunk.map(() => '?').join(',')}) ORDER BY created_at`).bind(...chunk).all()).results;
    for (const r of rows) (out[r.mistake_id] ||= []).push(r);
  }
  return out;
}

function shape(row, imgs, origin) {
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    due: row.status === 'open' && !!row.next_review_at && row.next_review_at <= iso(),
    images: imgs.map((i) => ({ id: i.id, kind: i.kind, content_type: i.content_type, size: i.size, url: `${origin}/api/v1/images/${i.id}` })),
  };
}

// ---------- images ----------

async function storeImages(env, mistakeId, files) {
  for (const f of files) {
    const imgId = newId();
    const ext = ({ 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' })[f.type] || 'jpg';
    const key = `m/${mistakeId}/${imgId}.${ext}`;
    await env.PHOTOS.put(key, f.bytes, { httpMetadata: { contentType: f.type } });
    await env.DB.prepare('INSERT INTO images (id, mistake_id, r2_key, content_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(imgId, mistakeId, key, f.type, f.bytes.byteLength, f.kind || 'question', iso()).run();
  }
  if (files.length) await env.DB.prepare('UPDATE mistakes SET updated_at = ? WHERE id = ?').bind(iso(), mistakeId).run();
}

async function addImages(req, env, id, origin) {
  await getMistakeOr404(env, id, origin);
  const { files } = await parseBody(req);
  if (!files.length) throw new Error('没有图片');
  await storeImages(env, id, files);
  return getMistake(env, id, origin);
}

async function deleteImage(env, id, imgId) {
  const img = await env.DB.prepare('SELECT * FROM images WHERE id = ? AND mistake_id = ?').bind(imgId, id).first();
  if (!img) throw Object.assign(new Error('not found'), { status: 404 });
  const shared = await env.DB.prepare('SELECT COUNT(*) c FROM images WHERE r2_key = ? AND id != ?').bind(img.r2_key, imgId).first('c');
  if (!shared) await env.PHOTOS.delete(img.r2_key);
  await env.DB.prepare('DELETE FROM images WHERE id = ?').bind(imgId).run();
  return { ok: true };
}

async function serveImage(env, imgId, req) {
  const img = await env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(imgId).first();
  if (!img) return json({ error: 'not found' }, 404);
  const obj = await env.PHOTOS.get(img.r2_key);
  if (!obj) return json({ error: 'gone' }, 404);
  const etag = obj.httpEtag;
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
  return new Response(obj.body, {
    headers: { 'content-type': img.content_type, 'cache-control': 'private, max-age=31536000, immutable', etag },
  });
}

// ---------- review (spaced repetition) ----------

async function review(req, env, id, actor, origin) {
  const m = await getMistakeOr404(env, id, origin);
  const body = await req.json().catch(() => ({}));
  const result = body.result === 'correct' || body.result === 'right' || body.result === true ? 'correct' : 'wrong';
  const note = String(body.note || '').slice(0, 2000);
  const now = iso();
  let streak = result === 'correct' ? m.streak + 1 : 0;
  let status = 'open', next;
  if (streak >= MASTER_STREAK) { status = 'mastered'; next = null; }
  else next = isoDays(SRS_DAYS[Math.min(streak, SRS_DAYS.length - 1)]);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO reviews (mistake_id, result, note, reviewed_by, reviewed_at) VALUES (?,?,?,?,?)').bind(id, result, note, actor, now),
    env.DB.prepare('UPDATE mistakes SET streak = ?, status = ?, review_count = review_count + 1, last_reviewed_at = ?, next_review_at = ?, updated_at = ? WHERE id = ?')
      .bind(streak, status, now, next, now, id),
  ]);
  return getMistake(env, id, origin);
}

async function listReviews(env, id) {
  return { items: (await env.DB.prepare('SELECT * FROM reviews WHERE mistake_id = ? ORDER BY reviewed_at DESC').bind(id).all()).results };
}

// ---------- AI 识题 ----------

const RECOG_PROMPT = `这是一张孩子作业/试卷/答案纸的照片，可能同时包含多道题。印刷体通常是题目或标准答案，手写的通常是孩子的作答或批改痕迹。
任务：找出照片中孩子做错的题，每道错题单独输出一项。如果家长备注指定了题号或范围，严格按备注只输出这些题，每题一项。
只输出 JSON，不要其它文字，格式：
{"items":[
 {
  "subject": "数学|语文|英语|科学|其他 之一",
  "topic": "知识点，中文，10字以内，如 两位数乘法 / 四舍五入 / 一般过去时",
  "question": "这道题的原文，保留原语言，尽量完整转录（数学式子用普通文字）",
  "wrong_answer": "孩子写的错误答案（看不到则留空）",
  "correct_answer": "正确答案",
  "analysis": "错因分析和正确解法，中文，面向家长，100字以内",
  "difficulty": 1到5的整数,
  "tags": ["最多3个中文标签"]
 }
]}`;

async function recognize(env, id, origin, actor, body = {}) {
  const m = await getMistakeOr404(env, id, origin);
  const img = m.images.find((i) => i.kind === 'question') || m.images[0];
  if (!img) throw new Error('这道题还没有照片');
  const imgRow = await env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(img.id).first();
  const obj = await env.PHOTOS.get(imgRow.r2_key);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const dataUrl = `data:${img.content_type};base64,${b64encode(bytes)}`;
  const hint = String(body.hint || m.note || '').trim();
  const prompt = RECOG_PROMPT + (hint ? `\n\n家长备注：${hint}` : '') + (m.subject ? `\n科目：${m.subject}` : '');

  let raw, model = env.VISION_MODEL;
  try {
    raw = await runVision(env, model, dataUrl, prompt);
  } catch (e) {
    console.error('vision primary failed', e.message);
    model = env.VISION_MODEL_FALLBACK;
    raw = await runVision(env, model, dataUrl, prompt);
  }
  const parsed = extractJson(raw);
  let items = Array.isArray(parsed?.items) ? parsed.items : parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed] : Array.isArray(parsed) ? parsed : [];
  items = items.filter((x) => x && typeof x === 'object');
  if (!items.length) throw new Error('AI 没有返回可解析的结果: ' + String(raw).slice(0, 200));

  // 第一道题填进当前记录（只填空白字段），其余各建一条新记录，共用同一张照片
  const first = cleanFields(aiPatch(m, items[0]), true);
  const keys = Object.keys(first);
  if (keys.length) {
    await env.DB.prepare(`UPDATE mistakes SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .bind(...keys.map((k) => first[k]), iso(), id).run();
  }
  const created = [];
  for (const it of items.slice(1)) {
    const nid = newId();
    const f = cleanFields({ ...aiPatch({ subject: m.subject, tags: [] }, it), source: m.source, note: m.note });
    if (!f.subject) f.subject = m.subject;
    await insertMistake(env, nid, f, actor);
    for (const im of m.images) {
      const r = await env.DB.prepare('SELECT * FROM images WHERE id = ?').bind(im.id).first();
      await env.DB.prepare('INSERT INTO images (id, mistake_id, r2_key, content_type, size, kind, created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(newId(), nid, r.r2_key, r.content_type, r.size, r.kind, iso()).run();
    }
    created.push(nid);
  }
  return { ...(await getMistake(env, id, origin)), _ai: { model, filled: keys, items: items.length, created, raw: parsed } };
}

// 只填空白字段，不覆盖人工填写的内容
function aiPatch(m, parsed) {
  const patch = {};
  for (const f of ['subject', 'topic', 'question', 'wrong_answer', 'correct_answer', 'analysis']) {
    if (!m[f] && parsed[f]) patch[f] = String(parsed[f]);
  }
  if (patch.subject && !SUBJECTS.includes(patch.subject)) patch.subject = '其他';
  if (!m.difficulty && parsed.difficulty) patch.difficulty = parsed.difficulty;
  if (!(m.tags || []).length && Array.isArray(parsed.tags)) patch.tags = parsed.tags;
  return patch;
}

async function runVision(env, model, dataUrl, prompt) {
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }];
  // gemma-4 默认会先"思考"把 token 用光，关掉；llama-3.2-vision 不认这个参数但会忽略
  const r = await env.AI.run(model, { messages, max_tokens: 2048, chat_template_kwargs: { enable_thinking: false } });
  return r?.choices?.[0]?.message?.content ?? r?.response ?? r?.description ?? JSON.stringify(r);
}

function extractJson(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  const m = String(s).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- stats / export ----------

async function stats(env) {
  const now = iso();
  const [total, open, mastered, due, bySubject, byTopic, recent] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) c FROM mistakes').first('c'),
    env.DB.prepare("SELECT COUNT(*) c FROM mistakes WHERE status='open'").first('c'),
    env.DB.prepare("SELECT COUNT(*) c FROM mistakes WHERE status='mastered'").first('c'),
    env.DB.prepare("SELECT COUNT(*) c FROM mistakes WHERE status='open' AND next_review_at <= ?").bind(now).first('c'),
    env.DB.prepare("SELECT subject, COUNT(*) total, SUM(status='open') open FROM mistakes GROUP BY subject ORDER BY total DESC").all(),
    env.DB.prepare("SELECT subject, topic, COUNT(*) total FROM mistakes WHERE topic != '' GROUP BY subject, topic ORDER BY total DESC LIMIT 15").all(),
    env.DB.prepare('SELECT COUNT(*) c FROM mistakes WHERE created_at >= ?').bind(isoDays(-7)).first('c'),
  ]);
  return { total, open, mastered, due, added_last_7d: recent, by_subject: bySubject.results, top_topics: byTopic.results };
}

async function exportAll(env, url) {
  const fmt = url.searchParams.get('format') || 'json';
  url.searchParams.set('limit', '500');
  const all = [];
  for (let off = 0; ; off += 500) {
    url.searchParams.set('offset', String(off));
    const page = await listMistakes(env, url);
    all.push(...page.items);
    if (all.length >= page.total || !page.items.length) break;
  }
  if (fmt !== 'md') return json({ total: all.length, items: all });
  const lines = [`# 错题本导出 (${all.length} 题, ${iso()})`, ''];
  for (const m of all) {
    lines.push(`## [${m.subject || '未分类'}] ${m.topic || '(无知识点)'} — ${m.id}`);
    lines.push(`- 状态: ${m.status === 'mastered' ? '已掌握' : '待复习'} | 连对: ${m.streak} | 复习次数: ${m.review_count} | 下次复习: ${m.next_review_at || '-'}`);
    lines.push(`- 录入: ${m.created_at} by ${m.created_by}${m.source ? ' | 来源: ' + m.source : ''}${m.note ? ' | 备注: ' + m.note : ''}${m.difficulty ? ' | 难度: ' + m.difficulty : ''}${m.tags.length ? ' | 标签: ' + m.tags.join(', ') : ''}`);
    if (m.question) lines.push('', '**题目**', '', m.question);
    if (m.wrong_answer) lines.push('', `**错答**: ${m.wrong_answer}`);
    if (m.correct_answer) lines.push('', `**正解**: ${m.correct_answer}`);
    if (m.analysis) lines.push('', '**分析**', '', m.analysis);
    for (const im of m.images) lines.push('', `![${im.kind}](${im.url})`);
    lines.push('');
  }
  return text(lines.join('\n'), 'text/markdown; charset=utf-8');
}

// ---------- docs for agents ----------

function docs(origin) {
  return `# 错题本 Agent API

Base URL: ${origin}/api/v1
认证: 每个请求带 \`Authorization: Bearer <API_TOKEN>\`，可选 \`X-Agent-Name: <你的名字>\`（会记录在 created_by / reviewed_by）。
所有响应为 JSON；图片 URL 需要同样的 Bearer 头才能下载。

## 数据模型 mistake
id, subject(数学|语文|英语|科学|其他), topic(知识点), question(题目), wrong_answer, correct_answer, analysis(错因/解法),
tags[], source(来源), note(家长备注，识题时作为提示，如"第4、5题"), difficulty(1-5), status(open|mastered), streak(连续答对), review_count, last_reviewed_at,
next_review_at, due(bool 现在该复习), created_by, created_at, updated_at, images[{id,kind,url}]

## 读取
GET /mistakes?subject=数学&status=open&topic=乘法&tag=粗心&q=关键字&since=2026-10-01&due=1&limit=50&offset=0
GET /mistakes/{id}
GET /mistakes/{id}/reviews
GET /stats                         → 总数、待复习、各科/知识点分布
GET /export?format=json|md         → 全部错题（md 适合直接喂给模型）
GET /images/{imageId}              → 原图二进制

## 写入
POST /mistakes  (JSON)   {"subject":"数学","topic":"分数加减","question":"...","wrong_answer":"...","correct_answer":"...","analysis":"...","tags":["粗心"],"difficulty":2,
                          "images":[{"data":"<base64 或 data:URL>","content_type":"image/jpeg","kind":"question"}]}
POST /mistakes  (multipart/form-data)  字段同上 + 一个或多个 photo 文件
PATCH /mistakes/{id}     只改给出的字段；status 可设 open|mastered
DELETE /mistakes/{id}
POST /mistakes/{id}/images   (JSON images[] 或 multipart photo)
DELETE /mistakes/{id}/images/{imageId}
POST /mistakes/{id}/review   {"result":"correct|wrong","note":"..."}   → 间隔重复：连对 ${MASTER_STREAK} 次自动 mastered；答错重置
POST /mistakes/{id}/recognize   {"hint":"可选提示"}  让 Workers AI 看第一张照片，自动填写空白字段；
                                一张照片里有多道错题时会自动拆成多条记录（共用照片），返回 _ai.created=[新id]

## 典型 agent 用法
- 每日复习：GET /mistakes?due=1 → 出题给孩子 → POST /review
- 周报：GET /stats + GET /mistakes?since=<7天前>
- 录入：拍照后 POST /mistakes (base64) 再 POST /recognize
`;
}

function agentBrief(origin, env) {
  return `你现在可以读写我女儿的错题本。下面是全部接入信息，请直接使用，不要再问我要地址或密钥。

API_TOKEN: ${env.API_TOKEN}
每个请求都带 header:  Authorization: Bearer ${env.API_TOKEN}
可选 header:  X-Agent-Name: <你的名字>  （会记录到 created_by / reviewed_by）

快速验证:
curl -H "Authorization: Bearer ${env.API_TOKEN}" ${origin}/api/v1/stats

读取全部错题（Markdown，最适合直接阅读）:
curl -H "Authorization: Bearer ${env.API_TOKEN}" "${origin}/api/v1/export?format=md"

今天该复习的题:
curl -H "Authorization: Bearer ${env.API_TOKEN}" "${origin}/api/v1/mistakes?due=1"

提交一道新错题:
curl -H "Authorization: Bearer ${env.API_TOKEN}" -H "content-type: application/json" \\
  -d '{"subject":"数学","topic":"分数加减","question":"1/2+1/3=?","wrong_answer":"2/5","correct_answer":"5/6","analysis":"分母不同要先通分","tags":["通分"]}' \\
  ${origin}/api/v1/mistakes

记录复习结果:
curl -X POST -H "Authorization: Bearer ${env.API_TOKEN}" -H "content-type: application/json" \\
  -d '{"result":"correct","note":"独立做对"}' ${origin}/api/v1/mistakes/<id>/review

---- 完整 API 文档 ----
${docs(origin)}`;
}

// ---------- utils ----------

const iso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoDays = (d) => new Date(Date.now() + d * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
function newId() {
  const u = new Uint8Array(8); crypto.getRandomValues(u);
  return Date.now().toString(36) + hex(u).slice(0, 8);
}
function b64decode(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u.buffer;
}
function b64encode(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function json(data, status = 200, headers = {}) {
  if (data instanceof Response) return data;
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function text(body, type = 'text/plain; charset=utf-8') {
  return new Response(body, { headers: { 'content-type': type } });
}
function cors(res) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  h.set('access-control-allow-headers', 'authorization,content-type,x-agent-name');
  return new Response(res.body, { status: res.status, headers: h });
}
