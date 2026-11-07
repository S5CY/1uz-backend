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
  const url = new URL(request.url);
  const storyId = clean(url.searchParams.get("storyId"), 64);
  const query = storyId
    ? env.DB.prepare("SELECT * FROM progress_snapshots WHERE story_id = ? LIMIT 1").bind(storyId)
    : env.DB.prepare("SELECT * FROM progress_snapshots ORDER BY updated_at DESC LIMIT 500");
  const { results } = await query.all();
  return json({ saves: results }, 200, headers);
}

async function listStoryIds(env, headers) {
  const { results } = await env.DB.prepare(`
    SELECT story_id, MAX(last_seen) AS last_seen
    FROM (
      SELECT story_id, MAX(created_at) AS last_seen FROM answer_events GROUP BY story_id
      UNION ALL
      SELECT story_id, MAX(updated_at) AS last_seen FROM progress_snapshots GROUP BY story_id
    )
    GROUP BY story_id
    ORDER BY last_seen DESC
    LIMIT 500
  `).all();
  return json({ ids: results }, 200, headers);
}

function adminPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>1u Answers</title><style>body{margin:0;background:#f5f0ff;color:#43335f;font:15px system-ui}main{max-width:1000px;margin:auto;padding:28px}header{display:flex;gap:10px;flex-wrap:wrap}input,button{padding:11px 14px;border:1px solid #c9b9df;border-radius:12px;background:white}button{background:#8268b3;color:white;font-weight:700}article{margin:14px 0;padding:16px;border-radius:16px;background:white;box-shadow:0 8px 24px #6d56931c}small{color:#8a779f}.answer{font-size:18px;color:#b44f87}</style><main><h1>1u · 回答记录</h1><header><input id="token" type="password" placeholder="Admin token"><input id="story" placeholder="按 ID 筛选"><button id="load">查看</button></header><p id="status"></p><section id="list"></section></main><script>const q=s=>document.querySelector(s);q('#load').onclick=async()=>{q('#status').textContent='载入中…';const token=q('#token').value;const story=q('#story').value.trim();sessionStorage.setItem('1u-admin-token',token);const r=await fetch('/api/admin/events?limit=500'+(story?'&storyId='+encodeURIComponent(story):''),{headers:{authorization:'Bearer '+token}});if(!r.ok){q('#status').textContent='无法读取，请检查 token';return}const d=await r.json();q('#status').textContent=d.events.length+' 条记录';q('#list').innerHTML=d.events.map(e=>'<article><b>ID ['+esc(e.story_id)+'] · '+esc(e.scene)+'</b><p>'+esc(e.prompt)+'</p><p class="answer">'+esc(e.answer)+'</p><small>'+esc(e.created_at)+'</small></article>').join('')||'<article>暂时没有记录</article>'};function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}q('#token').value=sessionStorage.getItem('1u-admin-token')||'';</script></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function answersPage() {
  return new Response(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>1u 回答记录</title><style>body{margin:0;background:#f5f0ff;color:#43335f;font:15px system-ui}main{max-width:900px;margin:auto;padding:28px}header{display:flex;gap:10px;flex-wrap:wrap}input,button{padding:11px 14px;border:1px solid #c9b9df;border-radius:12px;background:white}button{background:#8268b3;color:white;font-weight:700}article{margin:14px 0;padding:16px;border-radius:16px;background:white;box-shadow:0 8px 24px #6d56931c}small{color:#8a779f}.answer{font-size:18px;color:#b44f87}</style><main><h1>1u · 回答记录</h1><header><input id="story" placeholder="输入 ID 筛选"><button id="load">查看</button></header><p id="status">载入中…</p><section id="list"></section></main><script>const q=s=>document.querySelector(s);const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));async function load(){const story=q('#story').value.trim();q('#status').textContent='载入中…';const r=await fetch('/api/admin/events?limit=500'+(story?'&storyId='+encodeURIComponent(story):''));if(!r.ok){q('#status').textContent='暂时无法读取';return}const d=await r.json();q('#status').textContent=d.events.length+' 条记录';q('#list').innerHTML=d.events.map(e=>'<article><b>ID ['+esc(e.story_id)+'] · '+esc(e.scene)+'</b><p>'+esc(e.prompt)+'</p><p class="answer">'+esc(e.answer)+'</p><small>'+esc(e.created_at)+'</small></article>').join('')||'<article>暂时没有记录</article>'}q('#load').onclick=load;load();</script></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function answersPageV2() {
  return new Response(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>1u · 回答档案</title>
<style>
:root{color-scheme:light;--ink:#48365f;--muted:#8b799d;--purple:#8169b4;--pink:#d66fa6;--paper:#fffafd}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#eee7ff,#f8f4ff 46%,#f3edfa);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif}main{width:min(1080px,calc(100% - 28px));margin:auto;padding:34px 0 70px}h1{margin:0;font-family:Georgia,serif;font-size:clamp(2rem,5vw,3.25rem)}.sub{margin:4px 0 24px;color:var(--muted)}.chooser{position:sticky;top:10px;z-index:5;display:flex;gap:10px;padding:14px;border:1px solid #d8cde9;border-radius:18px;background:#ffffffdc;box-shadow:0 12px 35px #5e49731c;backdrop-filter:blur(14px)}select,button{min-height:48px;border:1px solid #cdbfe1;border-radius:14px;font:inherit}select{flex:1;padding:0 14px;color:var(--ink);background:white}button{padding:0 20px;color:white;background:linear-gradient(145deg,#806ab3,#c477a7);font-weight:750}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.summary div{padding:15px;border:1px solid #e2d9ed;border-radius:16px;background:#ffffffc9}.summary small{display:block;color:var(--muted)}.summary strong{font-size:1.15rem}.empty{padding:30px;border:1px dashed #cdbfe1;border-radius:20px;background:#ffffff9c;text-align:center;color:var(--muted)}.group{margin:22px 0}.group h2{display:flex;align-items:center;gap:10px;margin:0 0 10px;font-size:1.25rem}.group h2 span{display:grid;place-items:center;width:30px;height:30px;border-radius:10px;color:white;background:linear-gradient(145deg,#8c78c2,#d17cad);font-size:.78rem}.cards{display:grid;gap:10px}.card{padding:17px 19px;border:1px solid #e1d7eb;border-radius:18px;background:var(--paper);box-shadow:0 8px 22px #5b456d12}.prompt{margin:0 0 7px;font-weight:720}.answer{margin:0;color:#b34f87;font-size:1.06rem;white-space:pre-wrap}.meta{display:flex;justify-content:space-between;gap:10px;margin-top:10px;color:var(--muted);font-size:.75rem}.badge{padding:3px 8px;border-radius:99px;background:#eee6f7}.count{color:var(--muted);font-size:.78rem;font-weight:500}
@media(max-width:620px){main{width:calc(100% - 16px);padding-top:18px}.chooser{top:6px;padding:9px}.chooser button{padding:0 13px}.summary{grid-template-columns:1fr}.card{padding:14px}.meta{align-items:flex-start;flex-direction:column}.group{margin:18px 0}}
</style></head><body><main><h1>1u · 回答档案</h1><p class="sub">先选择一个故事 ID，再查看这个人的完整回答。</p>
<div class="chooser"><select id="story"><option value="">正在读取 ID…</option></select><button id="refresh" type="button">刷新</button></div>
<section class="summary" id="summary" hidden></section><p id="status" class="empty">正在载入 ID…</p><div id="groups"></div></main>
<script>
const q=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const order=['初始资料','你的内心','她的内心','你们之间的问题','灵魂考问','11.1 场景选择','其他记录'];
function groupName(scene){if(scene==='onboarding')return'初始资料';if(scene==='question-room-his-heart')return'你的内心';if(scene==='question-room-her-heart')return'她的内心';if(scene==='question-room-relationship')return'你们之间的问题';if(scene==='question-room-soul')return'灵魂考问';if(scene==='memory-bedroom'||scene.includes('11.1'))return'11.1 场景选择';return'其他记录'}
function sceneLabel(scene){return({'onboarding':'初始资料','question-room-his-heart':'你的内心','question-room-her-heart':'她的内心','question-room-relationship':'关系问题','question-room-soul':'灵魂考问','memory-bedroom':'11.1'}[scene]||scene)}
async function loadIds(){const current=q('#story').value;const r=await fetch('/api/admin/ids');const d=await r.json();q('#story').innerHTML='<option value="">选择一个 ID</option>'+d.ids.map(x=>'<option value="'+esc(x.story_id)+'">'+esc(x.story_id)+'</option>').join('');const requested=new URLSearchParams(location.search).get('id');const wanted=requested||current;if(wanted&&d.ids.some(x=>x.story_id===wanted)){q('#story').value=wanted;await loadStory(wanted)}else{q('#status').textContent=d.ids.length?'请选择上面的 ID。':'目前还没有任何回答记录。';q('#status').hidden=false;q('#summary').hidden=true;q('#groups').innerHTML=''}}
async function loadStory(id){if(!id){q('#status').textContent='请先选择一个 ID。';q('#status').hidden=false;q('#groups').innerHTML='';q('#summary').hidden=true;return}q('#status').textContent='正在读取 '+id+'…';q('#status').hidden=false;history.replaceState(null,'','?id='+encodeURIComponent(id));const [er,pr]=await Promise.all([fetch('/api/admin/events?limit=500&storyId='+encodeURIComponent(id)),fetch('/api/admin/progress?storyId='+encodeURIComponent(id))]);const events=(await er.json()).events||[],save=((await pr.json()).saves||[])[0];q('#summary').hidden=false;q('#summary').innerHTML='<div><small>故事 ID</small><strong>'+esc(id)+'</strong></div><div><small>当前好感度</small><strong>'+(save?esc(save.affection)+'%':'尚未存档')+'</strong></div><div><small>11.1</small><strong>'+(save&&save.memory_111_complete?'已完成':'未完成')+'</strong></div>';if(!events.length){q('#status').textContent='这个 ID 还没有回答记录。';q('#groups').innerHTML='';return}q('#status').hidden=true;const grouped={};events.slice().reverse().forEach(e=>(grouped[groupName(e.scene)]??=[]).push(e));q('#groups').innerHTML=order.filter(name=>grouped[name]?.length).map((name,i)=>'<section class="group"><h2><span>'+String(i+1).padStart(2,'0')+'</span>'+name+' <b class="count">'+grouped[name].length+' 条</b></h2><div class="cards">'+grouped[name].map(e=>'<article class="card"><p class="prompt">'+esc(e.prompt)+'</p><p class="answer">'+esc(e.answer)+'</p><div class="meta"><span class="badge">'+esc(sceneLabel(e.scene))+'</span><time>'+esc(e.created_at)+'</time></div></article>').join('')+'</div></section>').join('')}
q('#story').onchange=e=>loadStory(e.target.value);q('#refresh').onclick=loadIds;loadIds().catch(()=>{q('#status').textContent='读取失败，请稍后刷新。'});
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
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
      if (request.method === "GET" && url.pathname === "/api/admin/ids") return listStoryIds(env, headers);
      if (request.method === "GET" && url.pathname === "/answers") return answersPageV2();
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin")) return adminPage();
      return json({ error: "Not found" }, 404, headers);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error" }, 500, headers);
    }
  }
};
