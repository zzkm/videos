/* Free Vidz client - vanilla JS, no build step */
const app = document.getElementById("app");
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- tiny local state (no accounts: an anonymous id + upload tokens live in this browser) ---- */
const store = {
  get(k, d) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};
let voter = store.get("fv_voter", null);
if (!voter) {
  voter = crypto.randomUUID();
  store.set("fv_voter", voter);
}
const tokens = () => store.get("fv_tokens", {});

/* ---- helpers ---- */
async function api(path, opts = {}) {
  const headers = { "x-voter": voter, ...(opts.headers || {}) };
  const init = { method: opts.method || "GET", headers };
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.json);
  } else if (opts.body !== undefined) init.body = opts.body;
  const r = await fetch(path, init);
  let data = null;
  try {
    data = await r.json();
  } catch {}
  if (!r.ok) throw new Error(data?.error || `Error ${r.status}`);
  return data;
}
let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 2600);
}
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const fmtNum = (n) => Number(n || 0).toLocaleString();
function ago(ts) {
  const s = Math.max(1, (Date.now() - ts) / 1000);
  const u = [[31536000, "year"], [2592000, "month"], [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [sec, name] of u) if (s >= sec) { const n = Math.floor(s / sec); return `${n} ${name}${n > 1 ? "s" : ""} ago`; }
  return "just now";
}
const b64 = (blob) =>
  new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(r.result.split(",")[1]);
    r.onerror = () => ng(r.error);
    r.readAsDataURL(blob);
  });

function makeThumb(file) {
  return new Promise((res) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    let finished = false;
    const done = (r) => {
      if (finished) return;
      finished = true;
      URL.revokeObjectURL(url);
      res(r);
    };
    v.muted = true;
    v.playsInline = true;
    v.preload = "metadata";
    v.onloadeddata = () => {
      v.currentTime = Math.min(1, (v.duration || 2) / 2);
    };
    v.onseeked = () => {
      try {
        const w = 320;
        const h = Math.round((w * v.videoHeight) / v.videoWidth) || 180;
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").drawImage(v, 0, 0, w, h);
        done(c.toDataURL("image/jpeg", 0.6));
      } catch {
        done(null);
      }
    };
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}

/* ---- router ---- */
const m = location.pathname.match(/^\/videos\/([A-Za-z0-9]{5})\/?$/);
if (m) watch(m[1]);
else home();

/* ================= HOME ================= */
function home() {
  app.innerHTML = `
  <section class="panel" id="upload">
    <h1>Upload a video. Get a link. Done.</h1>
    <p class="sub">No account, no email, no waiting. Up to 100 MB per video.</p>
    <form id="up">
      <label class="drop" id="drop">
        <input type="file" id="file" accept="video/*" hidden>
        <span id="dropText">⬆ Click here or drop a video</span>
      </label>
      <input id="title" maxlength="100" placeholder="Title" required>
      <textarea id="desc" maxlength="2000" rows="2" placeholder="Description (optional)"></textarea>
      <button class="btn big" id="go" type="submit">Upload now</button>
      <div class="bar" id="bar" hidden><i></i><span>0%</span></div>
    </form>
  </section>
  <section>
    <div class="row"><h2>Fresh videos</h2><input id="q" type="search" placeholder="Search videos" aria-label="Search videos"></div>
    <div class="grid" id="grid"></div>
  </section>`;

  const file = $("#file"), drop = $("#drop"), title = $("#title");
  const setFile = (f) => {
    if (!f) return;
    $("#dropText").textContent = `✔ ${f.name} (${fmtSize(f.size)})`;
    if (!title.value) title.value = f.name.replace(/\.[^.]+$/, "").slice(0, 100);
  };
  file.addEventListener("change", () => setFile(file.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add("over");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove("over");
    })
  );
  drop.addEventListener("drop", (e) => {
    if (e.dataTransfer.files[0]) {
      file.files = e.dataTransfer.files;
      setFile(file.files[0]);
    }
  });
  $("#up").addEventListener("submit", (e) => {
    e.preventDefault();
    upload(file.files[0], title.value.trim(), $("#desc").value.trim());
  });

  let t;
  const load = async () => {
    const q = $("#q").value.trim();
    const grid = $("#grid");
    try {
      const list = await api("/api/videos?q=" + encodeURIComponent(q));
      grid.innerHTML = list.length
        ? list
            .map(
              (v) => `
        <a class="card" href="/videos/${v.id}">
          <div class="thumb">${v.thumb ? `<img src="${v.thumb}" alt="" loading="lazy">` : "▶"}</div>
          <div class="info"><div class="t">${esc(v.title)}</div>
          <div class="m">${fmtNum(v.views)} views • 👍 ${fmtNum(v.likes)} • ${ago(v.created_at)}</div></div>
        </a>`
            )
            .join("")
        : `<div class="empty">${q ? "Nothing found." : "No videos yet. Be the first to upload!"}</div>`;
    } catch (err) {
      grid.innerHTML = `<div class="empty">Could not load videos: ${esc(err.message)}</div>`;
    }
  };
  $("#q").addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(load, 250);
  });
  load();
}

async function upload(file, title, description) {
  if (!file) return toast("Pick a video file first", true);
  if (!title) return toast("Add a title", true);
  const go = $("#go"), bar = $("#bar");
  go.disabled = true;
  bar.hidden = false;
  const setProgress = (p, label) => {
    $("i", bar).style.width = p * 100 + "%";
    $("span", bar).textContent = label || Math.round(p * 100) + "%";
  };
  try {
    setProgress(0, "Preparing…");
    const thumb = await makeThumb(file);
    const init = await api("/api/videos", {
      method: "POST",
      json: { title, description, mime: file.type || "video/mp4", size: file.size, thumb },
    });
    const { id, token, chunkSize, chunkCount } = init;
    store.set("fv_tokens", { ...tokens(), [id]: token });

    let next = 0, sent = 0;
    const worker = async () => {
      while (next < chunkCount) {
        const i = next++;
        const blob = file.slice(i * chunkSize, (i + 1) * chunkSize);
        const data = await b64(blob);
        for (let attempt = 0; ; attempt++) {
          try {
            await api(`/api/videos/${id}/chunks/${i}`, {
              method: "PUT",
              headers: { "x-token": token, "content-type": "text/plain" },
              body: data,
            });
            break;
          } catch (e) {
            if (attempt >= 3) throw e;
            await sleep(700 * (attempt + 1));
          }
        }
        sent += blob.size;
        setProgress(sent / file.size);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setProgress(1, "Finishing…");
    await api(`/api/videos/${id}/complete`, { method: "POST", headers: { "x-token": token } });
    location.href = `/videos/${id}`;
  } catch (e) {
    toast(e.message, true);
    go.disabled = false;
    bar.hidden = true;
  }
}

/* ================= WATCH ================= */
async function watch(id) {
  let v;
  try {
    v = await api(`/api/videos/${id}`);
  } catch {
    app.innerHTML = `<section class="panel"><h1>Video not found 💀</h1><p class="sub">It may have been deleted, or the link is wrong.</p><a class="btn" href="/">Back to home</a></section>`;
    return;
  }
  const url = `${location.origin}/videos/${id}`;
  const direct = `${url}/stream`;
  const owner = !!tokens()[id];
  let mine = v.mine;

  app.innerHTML = `
  <div class="watch">
    <video id="player" controls playsinline preload="metadata" src="/videos/${id}/stream"></video>
    <h1>${esc(v.title)}</h1>
    <div class="meta"><span id="views">${fmtNum(v.views)}</span> views • ${new Date(v.created_at).toLocaleDateString()} • ${fmtSize(v.size)}</div>
    <div class="actions">
      <button class="pill like" id="like">👍 <span>${fmtNum(v.likes)}</span></button>
      <button class="pill dislike" id="dislike">👎 <span>${fmtNum(v.dislikes)}</span></button>
      <button class="pill" id="share">↗ Share</button>
      ${owner ? `<button class="pill danger" id="del">🗑 Delete</button>` : ""}
    </div>
    <div class="panel share" id="sharebox" hidden>
      <input id="shareurl" readonly value="${esc(url)}" aria-label="Video link">
      <button class="chip" data-copy="${esc(url)}">Copy link</button>
      <button class="chip" data-copy="${esc(direct)}">Copy direct file link</button>
      ${navigator.share ? `<button class="chip" id="native">Share via…</button>` : ""}
      <a class="chip" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(v.title)}">X</a>
      <a class="chip" target="_blank" rel="noopener" href="https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(v.title)}">Reddit</a>
      <a class="chip" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(v.title + " " + url)}">WhatsApp</a>
      <a class="chip" target="_blank" rel="noopener" href="https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(v.title)}">Telegram</a>
    </div>
    ${v.description ? `<div class="panel desc">${esc(v.description)}</div>` : ""}
    <section class="panel">
      <h2 id="ccount">Comments</h2>
      <div class="cform">
        <input id="cname" maxlength="30" placeholder="Name (optional)" aria-label="Name">
        <textarea id="cbody" rows="2" maxlength="500" placeholder="Add a comment" aria-label="Comment"></textarea>
        <button class="btn small" id="csend">Post</button>
      </div>
      <div id="clist"></div>
    </section>
  </div>`;
  document.title = `${v.title} - Free Vidz`;

  const paint = () => {
    $("#like").classList.toggle("on", mine === 1);
    $("#dislike").classList.toggle("on", mine === -1);
  };
  paint();

  const react = async (val) => {
    const next = mine === val ? 0 : val;
    try {
      const r = await api(`/api/videos/${id}/react`, { method: "POST", json: { value: next } });
      mine = r.mine;
      $("#like span").textContent = fmtNum(r.likes);
      $("#dislike span").textContent = fmtNum(r.dislikes);
      paint();
    } catch (e) {
      toast(e.message, true);
    }
  };
  $("#like").onclick = () => react(1);
  $("#dislike").onclick = () => react(-1);

  $("#share").onclick = () => {
    const box = $("#sharebox");
    box.hidden = !box.hidden;
    if (!box.hidden) $("#shareurl").select();
  };
  $("#shareurl").onfocus = (e) => e.target.select();
  document.querySelectorAll("[data-copy]").forEach(
    (b) =>
      (b.onclick = async () => {
        try {
          await navigator.clipboard.writeText(b.dataset.copy);
          toast("Copied!");
        } catch {
          toast("Copy failed. Select the link and copy it.", true);
        }
      })
  );
  if ($("#native")) $("#native").onclick = () => navigator.share({ title: v.title, url }).catch(() => {});

  if ($("#del"))
    $("#del").onclick = async () => {
      if (!confirm("Delete this video forever?")) return;
      try {
        await api(`/api/videos/${id}`, { method: "DELETE", headers: { "x-token": tokens()[id] } });
        const t = tokens();
        delete t[id];
        store.set("fv_tokens", t);
        location.href = "/";
      } catch (e) {
        toast(e.message, true);
      }
    };

  // count a view once per browser session
  const seen = sessionStorage.getItem("fv_seen_" + id);
  if (!seen) {
    sessionStorage.setItem("fv_seen_" + id, "1");
    api(`/api/videos/${id}/view`, { method: "POST" })
      .then(() => ($("#views").textContent = fmtNum(v.views + 1)))
      .catch(() => {});
  }

  /* comments */
  const renderComments = (list) => {
    $("#ccount").textContent = `Comments (${list.length})`;
    $("#clist").innerHTML = list.length
      ? list
          .map((c) => `<div class="cm"><b>${esc(c.name)}</b><small>${ago(c.created_at)}</small><p>${esc(c.body)}</p></div>`)
          .join("")
      : `<div class="empty">No comments yet. Say something.</div>`;
  };
  let comments = [];
  try {
    comments = await api(`/api/videos/${id}/comments`);
  } catch {}
  renderComments(comments);
  $("#cname").value = store.get("fv_name", "");
  $("#csend").onclick = async () => {
    const body = $("#cbody").value.trim();
    if (!body) return toast("Write something first", true);
    const name = $("#cname").value.trim();
    store.set("fv_name", name);
    try {
      const c = await api(`/api/videos/${id}/comments`, { method: "POST", json: { name, body } });
      comments.unshift(c);
      $("#cbody").value = "";
      renderComments(comments);
    } catch (e) {
      toast(e.message, true);
    }
  };
}
