const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers }
});

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);

function corsHeaders(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = clean(env.ALLOWED_ORIGIN, 300);
  const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  return {
    "access-control-allow-origin": origin === allowed || local ? origin : allowed,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (!type.includes("application/json")) throw new Error("JSON_REQUIRED");
  return request.json();
}

async function createEvent(request, env, headers) {
  let body;
  try { body = await readBody(request); }
  catch { return json({ error: "Please send valid JSON." }, 400, headers); }

  const event = {
    storyId: clean(body.storyId, 64),
    sessionId: clean(body.sessionId, 80),
    eventType: clean(body.eventType || "choice", 40),
    scene: clean(body.scene, 80),
    prompt: clean(body.prompt, 1000),
    answer: clean(body.answer, 1000),
    clientTimestamp: clean(body.clientTimestamp, 60),
    metadata: JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}).slice(0, 4000)
  };

  if (!event.storyId || !event.sessionId || !event.scene || !event.prompt || !event.answer) {
    return json({ error: "storyId, sessionId, scene, prompt, and answer are required." }, 422, headers);
  }

  const result = await env.DB.prepare(
    `INSERT INTO answer_events
      (story_id, session_id, event_type, scene, prompt, answer, metadata, client_timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(event.storyId, event.sessionId, event.eventType, event.scene, event.prompt, event.answer, event.metadata, event.clientTimestamp).run();

  return json({ ok: true, id: result.meta.last_row_id }, 201, headers);
}

async function saveProgress(request, env, headers) {
  let body;
  try { body = await readBody(request); }
  catch { return json({ error: "Please send valid JSON." }, 400, headers); }

  const storyId = clean(body.storyId, 64);
  const scene = clean(body.scene, 80);
  const affection = Math.max(0, Math.min(100, Number(body.affection) || 0));
  const complete = body.memory111Complete ? 1 : 0;
  const payload = JSON.stringify(body.payload && typeof body.payload === "object" ? body.payload : {}).slice(0, 12000);
  if (!storyId || !scene) return json({ error: "storyId and scene are required." }, 422, headers);

  await env.DB.prepare(
    `INSERT INTO progress_snapshots (story_id, scene, affection, memory_111_complete, payload, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(story_id) DO UPDATE SET
       scene=excluded.scene,
       affection=excluded.affection,
       memory_111_complete=excluded.memory_111_complete,
       payload=excluded.payload,
       updated_at=datetime('now')`
  ).bind(storyId, scene, affection, complete, payload).run();

  return json({ ok: true }, 200, headers);
}

async function listEvents(request, env, headers) {
  const url = new URL(request.url);
  const storyId = clean(url.searchParams.get("storyId"), 64);
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 200));
  const query = storyId
    ? env.DB.prepare("SELECT * FROM answer_events WHERE story_id = ? ORDER BY id DESC LIMIT ?").bind(storyId, limit)
    : env.DB.prepare("SELECT * FROM answer_events ORDER BY id DESC LIMIT ?").bind(limit);
  const { results } = await query.all();
  return json({ events: results }, 200, headers);
}

async function listProgress(request, env, headers) {
  const { results } = await env.DB.prepare("SELECT * FROM progress_snapshots ORDER BY updated_at DESC LIMIT 500").all();
  return json({ saves: results }, 200, headers);
}

function adminPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>1u Answers</title><style>body{margin:0;background:#f5f0ff;color:#43335f;font:15px system-ui}main{max-width:1000px;margin:auto;padding:28px}header{display:flex;gap:10px;flex-wrap:wrap}input,button{padding:11px 14px;border:1px solid #c9b9df;border-radius:12px;background:white}button{background:#8268b3;color:white;font-weight:700}article{margin:14px 0;padding:16px;border-radius:16px;background:white;box-shadow:0 8px 24px #6d56931c}small{color:#8a779f}.answer{font-size:18px;color:#b44f87}</style><main><h1>1u · 回答记录</h1><header><input id="token" type="password" placeholder="Admin token"><input id="story" placeholder="按 ID 筛选"><button id="load">查看</button></header><p id="status"></p><section id="list"></section></main><script>const q=s=>document.querySelector(s);q('#load').onclick=async()=>{q('#status').textContent='载入中…';const token=q('#token').value;const story=q('#story').value.trim();sessionStorage.setItem('1u-admin-token',token);const r=await fetch('/api/admin/events?limit=500'+(story?'&storyId='+encodeURIComponent(story):''),{headers:{authorization:'Bearer '+token}});if(!r.ok){q('#status').textContent='无法读取，请检查 token';return}const d=await r.json();q('#status').textContent=d.events.length+' 条记录';q('#list').innerHTML=d.events.map(e=>'<article><b>ID ['+esc(e.story_id)+'] · '+esc(e.scene)+'</b><p>'+esc(e.prompt)+'</p><p class="answer">'+esc(e.answer)+'</p><small>'+esc(e.created_at)+'</small></article>').join('')||'<article>暂时没有记录</article>'};function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}q('#token').value=sessionStorage.getItem('1u-admin-token')||'';</script></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function answersPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>1u 回答记录</title><style>body{margin:0;background:#f5f0ff;color:#43335f;font:15px system-ui}main{max-width:900px;margin:auto;padding:28px}header{display:flex;gap:10px;flex-wrap:wrap}input,button{padding:11px 14px;border:1px solid #c9b9df;border-radius:12px;background:white}button{background:#8268b3;color:white;font-weight:700}article{margin:14px 0;padding:16px;border-radius:16px;background:white;box-shadow:0 8px 24px #6d56931c}small{color:#8a779f}.answer{font-size:18px;color:#b44f87}</style><main><h1>1u · 回答记录</h1><header><input id="story" placeholder="输入 ID 筛选"><button id="load">查看</button></header><p id="status">载入中…</p><section id="list"></section></main><script>const q=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function load(){const story=q('#story').value.trim();q('#status').textContent='载入中…';const r=await fetch('/api/admin/events?limit=500'+(story?'&storyId='+encodeURIComponent(story):''));if(!r.ok){q('#status').textContent='暂时无法读取';return}const d=await r.json();q('#status').textContent=d.events.length+' 条记录';q('#list').innerHTML=d.events.map(e=>'<article><b>ID ['+esc(e.story_id)+'] · '+esc(e.scene)+'</b><p>'+esc(e.prompt)+'</p><p class="answer">'+esc(e.answer)+'</p><small>'+esc(e.created_at)+'</small></article>').join('')||'<article>暂时没有记录</article>'}q('#load').onclick=load;load();</script></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    try {
      if (request.method === "GET" && url.pathname === "/api/health") return json({ ok: true, service: "1uz-backend" }, 200, headers);
      if (request.method === "POST" && url.pathname === "/api/events") return createEvent(request, env, headers);
      if (request.method === "POST" && url.pathname === "/api/progress") return saveProgress(request, env, headers);
      if (request.method === "GET" && url.pathname === "/api/admin/events") return listEvents(request, env, headers);
      if (request.method === "GET" && url.pathname === "/api/admin/progress") return listProgress(request, env, headers);
      if (request.method === "GET" && url.pathname === "/answers") return answersPage();
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) return adminPage();
      return json({ error: "Not found" }, 404, headers);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error" }, 500, headers);
    }
  }
};
