// Free Vidz - video uploader on Cloudflare Workers + D1 (no accounts)
// Videos are stored in D1 as base64 chunks (D1 row limit is 2MB, so we chunk).

const CHUNK = 786432; // 768 KiB raw (multiple of 3 -> clean base64 boundaries)
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB per video
const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ID_RE = /^[A-Za-z0-9]{5}$/;

let schemaReady;
function ensureSchema(db) {
  schemaReady ??= db
    .batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        mime TEXT NOT NULL, size INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'uploading', owner_token TEXT NOT NULL, thumb TEXT,
        views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0,
        dislikes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS chunks (
        video_id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY (video_id, idx))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS reactions (
        video_id TEXT NOT NULL, voter TEXT NOT NULL, value INTEGER NOT NULL,
        PRIMARY KEY (video_id, voter))`),
      db.prepare(`CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
        name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_comments_video ON comments(video_id, id)`),
    ])
    .catch((e) => {
      schemaReady = undefined;
      throw e;
    });
  return schemaReady;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function newId() {
  const b = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(b, (x) => ALPHABET[x % ALPHABET.length]).join("");
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const isApp = path.startsWith("/api/") || path.startsWith("/videos/");
      if (!isApp) return env.ASSETS.fetch(request);

      await ensureSchema(env.DB);

      let m;
      if ((m = path.match(/^\/videos\/([A-Za-z0-9]{5})\/stream$/))) return stream(request, env, m[1]);
      if ((m = path.match(/^\/videos\/([A-Za-z0-9]{5})\/?$/))) return watchPage(request, env, m[1]);
      if (path.startsWith("/api/")) return api(request, env, url);
      return env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return fail("Server error", 500);
    }
  },
};

/* ---------- HTML shell for /videos/:id (adds OG tags so links preview nicely) ---------- */
async function watchPage(request, env, id) {
  const v = await env.DB.prepare("SELECT title, description FROM videos WHERE id=?1 AND status='ready'")
    .bind(id)
    .first();
  const shell = await env.ASSETS.fetch(new Request(new URL("/", request.url)));
  if (!v) return new Response(shell.body, { status: 404, headers: shell.headers });
  const origin = new URL(request.url).origin;
  const desc = esc((v.description || "Watch this video").slice(0, 200));
  const meta = `
<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(v.title)}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${origin}/videos/${id}">
<meta property="og:video" content="${origin}/videos/${id}/stream">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(v.title)}">`;
  return new HTMLRewriter()
    .on("title", { element: (e) => e.setInnerContent(`${v.title} - Free Vidz`) })
    .on("head", { element: (e) => e.append(meta, { html: true }) })
    .transform(shell);
}

/* ---------- Video streaming with Range support ---------- */
async function stream(request, env, id) {
  const v = await env.DB.prepare("SELECT size, mime, chunk_count FROM videos WHERE id=?1 AND status='ready'")
    .bind(id)
    .first();
  if (!v) return new Response("Not found", { status: 404 });

  const baseHeaders = {
    "content-type": v.mime,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=86400",
  };
  const getChunk = async (idx) => {
    const data = await env.DB.prepare("SELECT data FROM chunks WHERE video_id=?1 AND idx=?2")
      .bind(id, idx)
      .first("data");
    return data ? b64ToBytes(data) : null;
  };

  const range = request.headers.get("range");
  if (!range) {
    let i = 0;
    const body = new ReadableStream({
      async pull(ctrl) {
        if (i >= v.chunk_count) return ctrl.close();
        const c = await getChunk(i++);
        if (!c) return ctrl.error(new Error("missing chunk"));
        ctrl.enqueue(c);
      },
    });
    return new Response(body, { headers: { ...baseHeaders, "content-length": String(v.size) } });
  }

  const r = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!r || (r[1] === "" && r[2] === "")) return new Response("Bad range", { status: 416 });
  let start, end;
  if (r[1] === "") {
    start = Math.max(0, v.size - Number(r[2]));
    end = v.size - 1;
  } else {
    start = Number(r[1]);
    end = r[2] === "" ? v.size - 1 : Math.min(Number(r[2]), v.size - 1);
  }
  if (start > end || start >= v.size)
    return new Response("Range not satisfiable", { status: 416, headers: { "content-range": `bytes */${v.size}` } });

  // serve at most one chunk per request; the browser asks for the rest
  const idx = Math.floor(start / CHUNK);
  end = Math.min(end, (idx + 1) * CHUNK - 1);
  const bytes = await getChunk(idx);
  if (!bytes) return new Response("Missing data", { status: 500 });
  const off = idx * CHUNK;
  const body = bytes.subarray(start - off, end - off + 1);
  return new Response(body, {
    status: 206,
    headers: {
      ...baseHeaders,
      "content-range": `bytes ${start}-${end}/${v.size}`,
      "content-length": String(body.byteLength),
    },
  });
}

/* ---------- JSON API ---------- */
async function api(request, env, url) {
  const db = env.DB;
  const method = request.method;
  const seg = url.pathname.split("/").filter(Boolean); // api, videos, :id, ...
  if (seg[1] !== "videos") return fail("Not found", 404);

  // /api/videos
  if (seg.length === 2) {
    if (method === "GET") {
      const q = (url.searchParams.get("q") || "").trim().slice(0, 50);
      const { results } = await db
        .prepare(
          `SELECT id, title, size, views, likes, dislikes, created_at, thumb FROM videos
           WHERE status='ready' AND (?1 = '' OR title LIKE ?2)
           ORDER BY created_at DESC LIMIT 48`
        )
        .bind(q, `%${q}%`)
        .all();
      return json(results);
    }
    if (method === "POST") {
      const b = await request.json().catch(() => null);
      if (!b) return fail("Invalid JSON");
      const title = String(b.title || "").trim().slice(0, 100);
      const description = String(b.description || "").trim().slice(0, 2000);
      const mime = String(b.mime || "");
      const size = Number(b.size);
      if (!title) return fail("Title is required");
      if (!/^video\/[\w.+-]+$/.test(mime)) return fail("That file is not a video");
      if (!Number.isFinite(size) || size <= 0) return fail("Empty file");
      if (size > MAX_SIZE) return fail(`Max size is ${MAX_SIZE / 1024 / 1024} MB`);
      const thumb =
        typeof b.thumb === "string" && b.thumb.startsWith("data:image/jpeg;base64,") && b.thumb.length < 60000
          ? b.thumb
          : null;

      // clean up abandoned uploads (older than 6h)
      const cutoff = Date.now() - 6 * 3600 * 1000;
      await db.batch([
        db
          .prepare(
            "DELETE FROM chunks WHERE video_id IN (SELECT id FROM videos WHERE status='uploading' AND created_at<?1)"
          )
          .bind(cutoff),
        db.prepare("DELETE FROM videos WHERE status='uploading' AND created_at<?1").bind(cutoff),
      ]);

      let id;
      for (let i = 0; i < 8; i++) {
        const c = newId();
        if (!(await db.prepare("SELECT 1 FROM videos WHERE id=?1").bind(c).first())) {
          id = c;
          break;
        }
      }
      if (!id) return fail("Could not allocate id", 500);
      const token = crypto.randomUUID();
      const chunkCount = Math.ceil(size / CHUNK);
      await db
        .prepare(
          `INSERT INTO videos (id, title, description, mime, size, chunk_count, owner_token, thumb, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
        )
        .bind(id, title, description, mime, size, chunkCount, token, thumb, Date.now())
        .run();
      return json({ id, token, chunkSize: CHUNK, chunkCount });
    }
    return fail("Method not allowed", 405);
  }

  const id = seg[2];
  if (!ID_RE.test(id)) return fail("Not found", 404);
  const token = request.headers.get("x-token") || "";
  const voter = (request.headers.get("x-voter") || "").slice(0, 64);

  // /api/videos/:id
  if (seg.length === 3) {
    if (method === "GET") {
      const v = await db
        .prepare(
          `SELECT id, title, description, mime, size, views, likes, dislikes, created_at
           FROM videos WHERE id=?1 AND status='ready'`
        )
        .bind(id)
        .first();
      if (!v) return fail("Video not found", 404);
      const mine = voter
        ? (await db.prepare("SELECT value FROM reactions WHERE video_id=?1 AND voter=?2").bind(id, voter).first("value")) ?? 0
        : 0;
      return json({ ...v, mine });
    }
    if (method === "DELETE") {
      const v = await db.prepare("SELECT owner_token FROM videos WHERE id=?1").bind(id).first();
      if (!v) return fail("Video not found", 404);
      if (v.owner_token !== token) return fail("Only the uploader can delete this", 403);
      await db.batch([
        db.prepare("DELETE FROM chunks WHERE video_id=?1").bind(id),
        db.prepare("DELETE FROM reactions WHERE video_id=?1").bind(id),
        db.prepare("DELETE FROM comments WHERE video_id=?1").bind(id),
        db.prepare("DELETE FROM videos WHERE id=?1").bind(id),
      ]);
      return json({ ok: true });
    }
    return fail("Method not allowed", 405);
  }

  const action = seg[3];

  // PUT /api/videos/:id/chunks/:idx
  if (action === "chunks" && method === "PUT") {
    const idx = Number(seg[4]);
    const v = await db.prepare("SELECT owner_token, status, chunk_count FROM videos WHERE id=?1").bind(id).first();
    if (!v || v.owner_token !== token) return fail("Forbidden", 403);
    if (v.status !== "uploading") return fail("Upload already finished");
    if (!Number.isInteger(idx) || idx < 0 || idx >= v.chunk_count) return fail("Bad chunk index");
    const data = await request.text();
    if (!data || data.length > 1_100_000) return fail("Bad chunk size");
    await db.prepare("INSERT OR REPLACE INTO chunks (video_id, idx, data) VALUES (?1,?2,?3)").bind(id, idx, data).run();
    return json({ ok: true });
  }

  // POST /api/videos/:id/complete
  if (action === "complete" && method === "POST") {
    const v = await db.prepare("SELECT owner_token, chunk_count FROM videos WHERE id=?1").bind(id).first();
    if (!v || v.owner_token !== token) return fail("Forbidden", 403);
    const n = await db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE video_id=?1").bind(id).first("n");
    if (n !== v.chunk_count) return fail(`Missing chunks (${n}/${v.chunk_count})`);
    await db.prepare("UPDATE videos SET status='ready' WHERE id=?1").bind(id).run();
    return json({ ok: true, id });
  }

  // POST /api/videos/:id/view
  if (action === "view" && method === "POST") {
    await db.prepare("UPDATE videos SET views = views + 1 WHERE id=?1 AND status='ready'").bind(id).run();
    return json({ ok: true });
  }

  // POST /api/videos/:id/react  { value: 1 | -1 | 0 }
  if (action === "react" && method === "POST") {
    if (!voter) return fail("Missing voter id");
    const b = await request.json().catch(() => ({}));
    const value = Number(b.value);
    if (![1, -1, 0].includes(value)) return fail("Bad value");
    const exists = await db.prepare("SELECT 1 FROM videos WHERE id=?1 AND status='ready'").bind(id).first();
    if (!exists) return fail("Video not found", 404);
    await db.batch([
      value === 0
        ? db.prepare("DELETE FROM reactions WHERE video_id=?1 AND voter=?2").bind(id, voter)
        : db.prepare("INSERT OR REPLACE INTO reactions (video_id, voter, value) VALUES (?1,?2,?3)").bind(id, voter, value),
      db
        .prepare(
          `UPDATE videos SET
             likes = (SELECT COUNT(*) FROM reactions WHERE video_id=?1 AND value=1),
             dislikes = (SELECT COUNT(*) FROM reactions WHERE video_id=?1 AND value=-1)
           WHERE id=?1`
        )
        .bind(id),
    ]);
    const c = await db.prepare("SELECT likes, dislikes FROM videos WHERE id=?1").bind(id).first();
    return json({ ...c, mine: value });
  }

  // /api/videos/:id/comments
  if (action === "comments") {
    if (method === "GET") {
      const { results } = await db
        .prepare("SELECT id, name, body, created_at FROM comments WHERE video_id=?1 ORDER BY id DESC LIMIT 100")
        .bind(id)
        .all();
      return json(results);
    }
    if (method === "POST") {
      const b = await request.json().catch(() => null);
      const body = String(b?.body || "").trim().slice(0, 500);
      const name = String(b?.name || "").trim().slice(0, 30) || "Anonymous";
      if (!body) return fail("Write something first");
      const exists = await db.prepare("SELECT 1 FROM videos WHERE id=?1 AND status='ready'").bind(id).first();
      if (!exists) return fail("Video not found", 404);
      const created_at = Date.now();
      const res = await db
        .prepare("INSERT INTO comments (video_id, name, body, created_at) VALUES (?1,?2,?3,?4)")
        .bind(id, name, body, created_at)
        .run();
      return json({ id: res.meta.last_row_id, name, body, created_at });
    }
  }

  return fail("Not found", 404);
}
