# 错题本 (cuotiben)

女儿的错题本：手机拍照上传 → Cloudflare Worker (D1 + R2 + Workers AI 识题) → 间隔重复复习 → Agent API。

- 网页: https://cuotiben.quake0day.workers.dev （密码登录，加到 iPhone 主屏幕可当 app 用）
- Agent 文档: https://cuotiben.quake0day.workers.dev/llms.txt
- 代码: `src/index.js` (Worker), `public/index.html` (前端), `schema.sql` (D1)

## 部署
```bash
wrangler deploy
wrangler d1 execute cuotiben-db --remote --file schema.sql
wrangler secret put APP_PASSWORD   # 网页密码
wrangler secret put API_TOKEN      # agent Bearer token
```

## Agent 示例
```bash
curl -H "Authorization: Bearer $TOKEN" https://cuotiben.quake0day.workers.dev/api/v1/mistakes?due=1
curl -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"subject":"数学","topic":"分数加减","question":"1/2+1/3=?","correct_answer":"5/6"}' \
  https://cuotiben.quake0day.workers.dev/api/v1/mistakes
curl -H "Authorization: Bearer $TOKEN" "https://cuotiben.quake0day.workers.dev/api/v1/export?format=md"
```
