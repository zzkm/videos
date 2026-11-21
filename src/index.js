const CHUNK = 512 * 1024;            // D1 は 1行 2MB 上限なので 512KB(base64で約700KB)ずつ保存
const MAX_SIZE = 100 * 1024 * 1024;  // 1動画の最大サイズ。必要なら変更
const WINDOW = 6 * CHUNK;            // Range 1回で返す最大バイト数
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store" } });
const err = (m, s = 400) => json({ error: m }, s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => ALNUM[b % 62]).join("");

function b64(buf) {
  const u = new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const b = atob(s), u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

async function page(env, req, id) {
  let meta = "", status = 200;
  if (id) {
    const v = await env.DB.prepare("SELECT title,description FROM videos WHERE id=? AND status='ready'").bind(id).first();
    if (v) {
      const o = new URL(req.url).origin, u = `${o}/videos/${id}`;
      meta = `<meta property="og:type" content="video.other"><meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${esc(v.description || "A video shared on Free Vidz")}"><meta property="og:url" content="${u}">
<meta property="og:image" content="${u}/thumb.jpg"><meta name="twitter:card" content="summary_large_image">`;
    } else status = 404;
  }
  const html = await (await env.ASSETS.fetch(new Request(new URL("/", req.url)))).text();
  return new Response(html.replace("</head>", meta + "</head>"), { status, headers: { "content-type": "text/html;charset=utf-8" } });
}

async function stream(env, req, id) {
  // アドレスバー直打ち/保存 (Sec-Fetch-Dest: document) や他サイトからの埋め込みを拒否
  const dest = req.headers.get("sec-fetch-dest"), ref = req.headers.get("referer");
  if ((dest && dest !== "video") || (ref && new URL(ref).origin !== new URL(req.url).origin)) return new Response("Forbidden", { status: 403 });
  const v = await env.DB.prepare("SELECT mime,size,chunk_size FROM videos WHERE id=? AND status='ready'").bind(id).first();
  if (!v) return new Response("Not found", { status: 404 });
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  let start = 0, end = v.size - 1;
  if (m) {
    if (m[1] === "") start = Math.max(0, v.size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== "") end = Math.min(Number(m[2]), v.size - 1); }
  }
  if (start > end || start >= v.size) return new Response("Range Not Satisfiable", { status: 416, headers: { "content-range": `bytes */${v.size}` } });
  end = Math.min(end, start + WINDOW - 1);
  const cs = v.chunk_size, first = Math.floor(start / cs), last = Math.floor(end / cs);
  const { results } = await env.DB.prepare("SELECT idx,data FROM chunks WHERE video_id=? AND idx BETWEEN ? AND ? ORDER BY idx").bind(id, first, last).all();
  const out = new Uint8Array(end - start + 1);
  for (const r of results) {
    const bytes = unb64(r.data), base = r.idx * cs;
    const from = Math.max(start, base), to = Math.min(end + 1, base + bytes.length);
    if (to > from) out.set(bytes.subarray(from - base, to - base), from - start);
  }
  return new Response(out, { status: 206, headers: {
    "content-type": v.mime, "accept-ranges": "bytes", "content-length": String(out.length),
    "content-range": `bytes ${start}-${end}/${v.size}`, "cache-control": "private, max-age=3600", "content-disposition": "inline", "x-content-type-options": "nosniff" } });
}

async function thumb(env, id) {
  const v = await env.DB.prepare("SELECT thumb FROM videos WHERE id=? AND status='ready'").bind(id).first();
  if (!v?.thumb) return new Response("", { status: 404 });
  return new Response(unb64(v.thumb), { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } });
}

async function api(env, req, url) {
  const DB = env.DB, p = url.pathname, method = req.method;
  let m;

  if (p === "/api/videos" && method === "GET") {
    const sort = url.searchParams.get("sort") === "top" ? "(views + (likes - dislikes) * 5) DESC, created_at DESC" : "created_at DESC";
    const q = (url.searchParams.get("q") || "").trim().slice(0, 50);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 24, 48);
    const where = q ? "AND title LIKE ? ESCAPE '\\'" : "";
    const st = DB.prepare(`SELECT id,title,duration,views,likes,created_at FROM videos WHERE status='ready' ${where} ORDER BY ${sort} LIMIT ?`);
    const like = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    const { results } = await (q ? st.bind(like, limit) : st.bind(limit)).all();
    return json(results);
  }

  if (p === "/api/videos" && method === "POST") {
    const b = await req.json().catch(() => null);
    if (!b) return err("Invalid request");
    const size = Number(b.size), mime = String(b.mime || "");
    const title = String(b.title || "").trim().slice(0, 100);
    if (!title) return err("Enter a title");
    if (!mime.startsWith("video/")) return err("Choose a video file");
    if (!(size > 0) || size > MAX_SIZE) return err(`File must be ${MAX_SIZE / 1048576} MB or smaller`);
    let th = null;
    if (typeof b.thumb === "string" && b.thumb.startsWith("data:image/jpeg;base64,") && b.thumb.length < 300000) th = b.thumb.split(",")[1];
    const id = newId(), token = crypto.randomUUID(), chunks = Math.ceil(size / CHUNK);
    await DB.prepare("INSERT INTO videos(id,title,description,mime,size,chunk_size,chunks,thumb,duration,token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id, title, String(b.description || "").slice(0, 2000), mime, size, CHUNK, chunks, th, Number(b.duration) || 0, token, Date.now()).run();
    return json({ id, token, chunks, chunkSize: CHUNK });
  }

  if ((m = p.match(/^\/api\/videos\/(\w+)\/chunks\/(\d+)$/)) && method === "PUT") {
    const [, id, n] = m, idx = Number(n);
    const v = await DB.prepare("SELECT token,chunks,status FROM videos WHERE id=?").bind(id).first();
    if (!v || v.token !== req.headers.get("x-token")) return err("Not allowed", 403);
    if (v.status !== "uploading" || idx >= v.chunks) return err("Bad chunk");
    const buf = await req.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > CHUNK) return err("Bad chunk size");
    await DB.prepare("INSERT OR REPLACE INTO chunks(video_id,idx,data) VALUES(?,?,?)").bind(id, idx, b64(buf)).run();
    return json({ ok: true });
  }

  if ((m = p.match(/^\/api\/videos\/(\w+)\/complete$/)) && method === "POST") {
    const id = m[1];
    const v = await DB.prepare("SELECT token,chunks FROM videos WHERE id=?").bind(id).first();
    if (!v || v.token !== req.headers.get("x-token")) return err("Not allowed", 403);
    const c = await DB.prepare("SELECT COUNT(*) n FROM chunks WHERE video_id=?").bind(id).first();
    if (c.n !== v.chunks) return err("Upload incomplete");
    await DB.prepare("UPDATE videos SET status='ready' WHERE id=?").bind(id).run();
    return json({ id });
  }

  if ((m = p.match(/^\/api\/videos\/(\w+)$/))) {
    const id = m[1];
    if (method === "GET") {
      const v = await DB.prepare("SELECT id,title,description,mime,size,duration,views,likes,dislikes,shares,created_at FROM videos WHERE id=? AND status='ready'").bind(id).first();
      if (!v) return err("Not found", 404);
      const voter = (url.searchParams.get("voter") || "").slice(0, 64);
      v.my = voter ? (await DB.prepare("SELECT value FROM reactions WHERE video_id=? AND voter=?").bind(id, voter).first())?.value || 0 : 0;
      return json(v);
    }
    if (method === "DELETE") {
      const v = await DB.prepare("SELECT token FROM videos WHERE id=?").bind(id).first();
      if (!v || v.token !== req.headers.get("x-token")) return err("Not allowed", 403);
      await DB.batch(["chunks", "reactions", "comments"].map(t => DB.prepare(`DELETE FROM ${t} WHERE video_id=?`).bind(id))
        .concat(DB.prepare("DELETE FROM videos WHERE id=?").bind(id)));
      return json({ ok: true });
    }
  }

  if ((m = p.match(/^\/api\/videos\/(\w+)\/(view|share)$/)) && method === "POST") {
    const col = m[2] === "view" ? "views" : "shares";
    await DB.prepare(`UPDATE videos SET ${col}=${col}+1 WHERE id=? AND status='ready'`).bind(m[1]).run();
    return json({ ok: true });
  }

  if ((m = p.match(/^\/api\/videos\/(\w+)\/react$/)) && method === "POST") {
    const id = m[1], b = await req.json().catch(() => ({}));
    const voter = String(b.voter || "").slice(0, 64), nv = [1, -1].includes(b.value) ? b.value : 0;
    if (voter.length < 8) return err("Invalid request");
    const old = (await DB.prepare("SELECT value FROM reactions WHERE video_id=? AND voter=?").bind(id, voter).first())?.value || 0;
    const dl = (nv === 1) - (old === 1), dd = (nv === -1) - (old === -1);
    await DB.batch([
      nv ? DB.prepare("INSERT OR REPLACE INTO reactions(video_id,voter,value) VALUES(?,?,?)").bind(id, voter, nv)
         : DB.prepare("DELETE FROM reactions WHERE video_id=? AND voter=?").bind(id, voter),
      DB.prepare("UPDATE videos SET likes=MAX(0,likes+?),dislikes=MAX(0,dislikes+?) WHERE id=?").bind(dl, dd, id)]);
    const v = await DB.prepare("SELECT likes,dislikes FROM videos WHERE id=?").bind(id).first();
    return json({ ...v, my: nv });
  }

  if ((m = p.match(/^\/api\/videos\/(\w+)\/comments$/))) {
    const id = m[1];
    if (method === "POST") {
      const b = await req.json().catch(() => ({}));
      const body = String(b.body || "").trim().slice(0, 500), name = String(b.name || "").trim().slice(0, 30) || "Anonymous";
      if (!body) return err("Enter a comment");
      await DB.prepare("INSERT INTO comments(video_id,name,body,created_at) VALUES(?,?,?,?)").bind(id, name, body, Date.now()).run();
    }
    const { results } = await DB.prepare("SELECT id,name,body,created_at FROM comments WHERE video_id=? ORDER BY created_at DESC LIMIT 100").bind(id).all();
    return json(results);
  }

  return err("Not found", 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url), p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(env, req, url);
      let m;
      if ((m = p.match(/^\/videos\/(\w+)\/stream$/))) return await stream(env, req, m[1]);
      if ((m = p.match(/^\/videos\/(\w+)\/thumb\.jpg$/))) return await thumb(env, m[1]);
      if ((m = p.match(/^\/videos\/(\w+)\/?$/))) return await page(env, req, m[1]);
      if (p === "/") return await page(env, req, null);
      return await env.ASSETS.fetch(req); // /style.css, /app.js
    } catch (e) {
      return err("Server error: " + e.message, 500);
    }
  },
};
