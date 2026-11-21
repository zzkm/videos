const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ls={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},del:k=>{try{localStorage.removeItem(k)}catch{}}};
const voter=ls.get('voter')||(()=>{const v=crypto.randomUUID();ls.set('voter',v);return v})();
const toast=(m,bad)=>{const t=$('#toast');t.textContent=m;t.className=bad?'show err':'show';clearTimeout(toast.t);toast.t=setTimeout(()=>t.className='',2600)};
async function api(p,o={}){const r=await fetch(p,{...o,headers:{'content-type':'application/json',...(o.headers||{})}});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'Something went wrong');return d}
const num=x=>Number.isFinite(+x)&&x!==null&&x!==''?+x:0;
const first=(o,...k)=>{for(const a of k)if(o[a]!=null)return o[a];return 0};
const pl=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
// APIの欠けた/別名のフィールドがあっても undefined/NaN を出さない
const norm=v=>({...v,views:num(first(v,'views','view_count')),likes:num(first(v,'likes','like_count')),dislikes:num(first(v,'dislikes','dislike_count')),shares:num(first(v,'shares','share_count')),duration:num(v.duration),created_at:num(first(v,'created_at','createdAt'))});
const dur=s=>{s=Math.round(s||0);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=String(s%60).padStart(2,'0');return h?`${h}:${String(m).padStart(2,'0')}:${x}`:`${m}:${x}`};
const ago=t=>{if(!t)return'';if(t<1e11)t*=1000;const s=(Date.now()-t)/1000,n=(x,u)=>`${x} ${u}${x===1?'':'s'} ago`;if(s<60)return'just now';if(s<3600)return n(Math.floor(s/60),'min');if(s<86400)return n(Math.floor(s/3600),'hour');if(s<2592000)return n(Math.floor(s/86400),'day');return new Date(t).toLocaleDateString('en-US')};
const card=v0=>{const v=norm(v0);return `<a class="card" href="/videos/${v.id}"><div class="thumb"><img loading="lazy" draggable="false" src="/videos/${v.id}/thumb.jpg" alt="" onerror="this.replaceWith('🎬')"><span class="dur">${dur(v.duration)}</span></div><div class="info"><div class="t">${esc(v.title)}</div><div class="m">${pl(v.views,'view')} · ${ago(v.created_at)} · 👍 ${v.likes}</div></div></a>`;}

/* ---------- Home ---------- */
function home(){
  const q=new URLSearchParams(location.search).get('q')||'';
  $('#app').innerHTML=`<section class="panel" id="upload"><h1>Upload a video. Get a link.</h1><p class="sub">No signup. No email. Drop a file, share the link.</p>
  <label id="drop" class="drop"><input type="file" id="file" accept="video/*" hidden><span id="dt">Drop your video here, or tap to choose (max 100 MB)</span></label>
  <div id="up" hidden><input id="t" maxlength="100" placeholder="Title" required><textarea id="d" rows="2" maxlength="2000" placeholder="Description (optional)"></textarea>
  <button class="btn big" id="go">Upload</button><div class="bar" hidden><i></i><span>0%</span></div></div></section>
  <div class="row"><h2>Videos</h2><input id="q" type="search" placeholder="Search videos" aria-label="Search videos" value="${esc(q)}"></div>
  <div class="actions" id="tabs"><button class="pill like on" data-s="new">New</button><button class="pill like" data-s="top">Popular</button></div><div id="grid" class="grid"></div>`;
  $('#q').onkeydown=e=>{if(e.key==='Enter')location.href='/?q='+encodeURIComponent($('#q').value)};
  if(location.hash==='#upload')$('#upload').scrollIntoView();
  let file=null;const drop=$('#drop');
  const pick=f=>{if(!f)return;if(!f.type.startsWith('video/'))return toast('Please choose a video file',true);file=f;$('#up').hidden=false;$('#t').value=f.name.replace(/\.[^.]+$/,'');$('#t').focus();$('#dt').textContent=f.name+' ('+(f.size/1048576).toFixed(1)+' MB)'};
  $('#file').onchange=e=>pick(e.target.files[0]);
  ['dragenter','dragover'].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.add('over')}));
  ['dragleave','drop'].forEach(n=>drop.addEventListener(n,e=>{e.preventDefault();drop.classList.remove('over')}));
  drop.addEventListener('drop',e=>pick(e.dataTransfer.files[0]));
  $('#go').onclick=async()=>{if(!file)return;if(!$('#t').value.trim())return toast('Enter a title',true);const btn=$('#go'),bar=$('#up .bar');btn.disabled=true;bar.hidden=false;
    try{const id=await upload(file,$('#t').value,$('#d').value,p=>{bar.querySelector('i').style.width=p+'%';bar.querySelector('span').textContent=Math.floor(p)+'%'});location.href='/videos/'+id}
    catch(x){toast(x.message,true);btn.disabled=false;btn.textContent='Try again'}};
  const load=async s=>{const g=$('#grid');try{const l=await api(`/api/videos?sort=${s}&q=${encodeURIComponent(q)}`);g.innerHTML=l.length?l.map(card).join(''):'<div class="empty">No videos yet. Be the first to upload!</div>'}catch(x){g.innerHTML='<div class="empty">'+esc(x.message)+'</div>'}};
  document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{document.querySelectorAll('#tabs button').forEach(o=>o.classList.toggle('on',o===b));load(b.dataset.s)});
  load('new');
}
function thumbOf(file){return new Promise(res=>{const v=document.createElement('video'),u=URL.createObjectURL(file);let fin=false;
  const done=t=>{if(fin)return;fin=true;URL.revokeObjectURL(u);res({thumb:t,duration:isFinite(v.duration)?v.duration:0})};
  v.muted=true;v.playsInline=true;v.preload='metadata';v.src=u;
  v.onloadedmetadata=()=>{v.currentTime=Math.min(1,(v.duration||2)/2)};
  v.onseeked=()=>{try{const c=document.createElement('canvas');c.width=480;c.height=Math.round(480*(v.videoHeight/v.videoWidth||9/16));c.getContext('2d').drawImage(v,0,0,c.width,c.height);done(c.toDataURL('image/jpeg',.7))}catch{done(null)}};
  v.onerror=()=>done(null);setTimeout(()=>done(null),8000)})}
async function upload(file,title,description,onp){
  const m=await thumbOf(file);
  const r=await api('/api/videos',{method:'POST',body:JSON.stringify({title,description,size:file.size,mime:file.type,thumb:m.thumb,duration:m.duration})});
  ls.set('tok:'+r.id,r.token);
  for(let i=0;i<r.chunks;i++){
    const blob=file.slice(i*r.chunkSize,(i+1)*r.chunkSize);let ok=false,last;
    for(let t=0;t<3&&!ok;t++){try{const x=await fetch(`/api/videos/${r.id}/chunks/${i}`,{method:'PUT',headers:{'x-token':r.token},body:blob});if(!x.ok)throw new Error((await x.json().catch(()=>({}))).error||'Upload failed');ok=true}catch(e){last=e}}
    if(!ok)throw last;onp((i+1)/r.chunks*100);
  }
  await api(`/api/videos/${r.id}/complete`,{method:'POST',headers:{'x-token':r.token}});
  return r.id;
}

/* ---------- Custom player (no native controls / no download UI) ---------- */
function player(root){
  const v=root.querySelector('video'),q=s=>root.querySelector(s);
  const play=q('[data-a=play]'),mute=q('[data-a=mute]'),spd=q('[data-a=spd]'),big=q('.bigplay'),pg=q('.pg'),bf=q('.buf'),tm=q('.tm'),seek=q('.seek'),vol=q('.vol'),shield=q('.shield');
  const rates=[.5,1,1.25,1.5,2];let hide,drag=false;
  const show=()=>{root.classList.add('ui');clearTimeout(hide);if(!v.paused)hide=setTimeout(()=>root.classList.remove('ui'),2500)};
  const toggle=()=>{v.paused||v.ended?v.play().catch(()=>{}):v.pause()};
  const fs=()=>{if(root.requestFullscreen||root.webkitRequestFullscreen){document.fullscreenElement||document.webkitFullscreenElement?(document.exitFullscreen||document.webkitExitFullscreen).call(document):(root.requestFullscreen||root.webkitRequestFullscreen).call(root)}else root.classList.toggle('fx')};
  const skip=s=>{v.currentTime=Math.min(Math.max(0,v.currentTime+s),v.duration||1e9);show()};
  const setVol=x=>{v.volume=x;v.muted=x===0;vol.value=x;mute.textContent=v.muted||!v.volume?'🔇':'🔊'};
  ['contextmenu','dragstart','selectstart'].forEach(n=>root.addEventListener(n,e=>e.preventDefault()));
  v.addEventListener('enterpictureinpicture',()=>document.exitPictureInPicture?.());
  shield.onclick=()=>{toggle();show();root.focus()};
  shield.ondblclick=fs;
  big.onclick=()=>{toggle();root.focus()};play.onclick=toggle;
  q('[data-a=fs]').onclick=fs;
  mute.onclick=()=>{v.muted=!v.muted;mute.textContent=v.muted?'🔇':'🔊'};
  vol.oninput=()=>setVol(+vol.value);
  spd.onclick=()=>{const r=rates[(rates.indexOf(v.playbackRate)+1)%rates.length];v.playbackRate=r;spd.textContent=r+'x'};
  const at=e=>{const b=seek.getBoundingClientRect();return Math.min(1,Math.max(0,(e.clientX-b.left)/b.width))*(v.duration||0)};
  seek.onpointerdown=e=>{drag=true;seek.setPointerCapture(e.pointerId);v.currentTime=at(e)};
  seek.onpointermove=e=>{if(drag)v.currentTime=at(e)};
  seek.onpointerup=seek.onpointercancel=()=>{drag=false};
  v.onplay=v.onpause=v.onended=()=>{const p=!v.paused&&!v.ended;root.classList.toggle('playing',p);play.textContent=p?'❚❚':'▶';big.textContent=v.ended?'↻':'▶';show()};
  v.ontimeupdate=v.onloadedmetadata=v.ondurationchange=()=>{const d=v.duration||0;pg.style.width=d?v.currentTime/d*100+'%':'0';tm.textContent=dur(v.currentTime)+' / '+dur(d)};
  v.onprogress=()=>{const b=v.buffered,d=v.duration||0;if(b.length&&d)bf.style.width=b.end(b.length-1)/d*100+'%'};
  root.onmousemove=root.ontouchstart=show;
  root.onkeydown=e=>{const k=e.key;
    if(k===' '||k==='k')toggle();else if(k==='ArrowLeft')skip(-5);else if(k==='ArrowRight')skip(5);else if(k==='j')skip(-10);else if(k==='l')skip(10);
    else if(k==='ArrowUp')setVol(Math.min(1,v.volume+.1));else if(k==='ArrowDown')setVol(Math.max(0,v.volume-.1));
    else if(k==='m')mute.click();else if(k==='f')fs();else if(k==='Escape'&&root.classList.contains('fx'))root.classList.remove('fx');else return;
    e.preventDefault();show()};
}

/* ---------- Watch page ---------- */
async function watch(id){
  let v;try{v=norm(await api(`/api/videos/${id}?voter=${voter}`))}catch{$('#app').innerHTML='<div class="empty"><h2>Video not found</h2><a href="/" style="text-decoration:underline">Back to home</a></div>';return}
  document.title=v.title+' - Free Vidz';
  const own=!!ls.get('tok:'+id),url=location.origin+'/videos/'+id;
  $('#app').innerHTML=`<div class="watch">
  <div class="pl ui" id="pl" tabindex="0" aria-label="Video player">
    <video playsinline preload="metadata" poster="/videos/${id}/thumb.jpg" src="/videos/${id}/stream" controlsList="nodownload noplaybackrate noremoteplayback" disablePictureInPicture disableRemotePlayback draggable="false"></video>
    <div class="shield"></div><button class="bigplay" aria-label="Play">▶</button>
    <div class="ctl"><div class="seek" role="slider" aria-label="Seek"><i class="buf"></i><i class="pg"></i></div>
    <div class="cr"><button data-a="play" aria-label="Play/Pause">▶</button><button data-a="mute" aria-label="Mute">🔊</button><input class="vol" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume"><span class="tm">0:00 / 0:00</span><span style="flex:1"></span><button data-a="spd" aria-label="Speed">1x</button><button data-a="fs" aria-label="Fullscreen">⛶</button></div></div>
  </div>
  <h1>${esc(v.title)}</h1><div class="meta" id="meta"></div>
  <div class="actions"><button class="pill like" id="lk"></button><button class="pill dislike" id="dk"></button><button class="pill" id="sh">Share</button>${own?'<button class="pill danger" id="rm">Delete</button>':''}</div>
  <div class="panel share" id="shp" hidden><input id="lnk" readonly value="${esc(url)}" aria-label="Video link">
    <a class="chip" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(v.title)}">X</a><a class="chip" target="_blank" rel="noopener" href="https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(url)}">LINE</a><a class="chip" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">Facebook</a><button class="chip" id="cp">Copy link</button></div>
  ${v.description?`<div class="panel desc">${esc(v.description)}</div>`:''}
  <div class="panel"><h2>Comments</h2>
  <form class="cform" id="cf"><input id="cn" maxlength="30" placeholder="Name (optional)" value="${esc(ls.get('name')||'')}"><textarea id="cb" rows="2" maxlength="500" placeholder="Add a comment" required></textarea><button class="btn small">Post</button></form>
  <div id="cl"></div></div>
  <h2>More videos</h2><div class="grid" id="side"></div></div>`;
  player($('#pl'));
  const draw=()=>{$('#lk').className='pill like'+(v.my===1?' on':'');$('#dk').className='pill dislike'+(v.my===-1?' on':'');$('#lk').textContent='👍 '+num(v.likes);$('#dk').textContent='👎 '+num(v.dislikes);$('#meta').textContent=[pl(v.views,'view'),ago(v.created_at),pl(v.shares,'share')].filter(Boolean).join(' · ')};draw();
  const react=async val=>{try{const r=await api(`/api/videos/${id}/react`,{method:'POST',body:JSON.stringify({voter,value:v.my===val?0:val})});v=norm({...v,...r});draw()}catch(e){toast(e.message,true)}};
  $('#lk').onclick=()=>react(1);$('#dk').onclick=()=>react(-1);
  const counted=()=>{fetch(`/api/videos/${id}/share`,{method:'POST'});v.shares=num(v.shares)+1;draw()};
  $('#sh').onclick=async()=>{if(navigator.share){try{await navigator.share({title:v.title,url});counted();return}catch{}}$('#shp').hidden=!$('#shp').hidden};
  $('#shp').addEventListener('click',e=>{if(e.target.closest('a'))counted()});
  $('#cp').onclick=async()=>{try{await navigator.clipboard.writeText(url);toast('Link copied');counted()}catch{prompt('Link',url)}};
  if($('#rm'))$('#rm').onclick=async()=>{if(!confirm('Delete this video? This cannot be undone.'))return;try{await api('/api/videos/'+id,{method:'DELETE',headers:{'x-token':ls.get('tok:'+id)}});ls.del('tok:'+id);location.href='/'}catch(e){toast(e.message,true)}};
  const cl=l=>{$('#cl').innerHTML=l.length?l.map(c=>`<div class="cm"><b>${esc(c.name)}</b><small>${ago(c.created_at)}</small><p>${esc(c.body)}</p></div>`).join(''):'<div class="meta">No comments yet. Say something!</div>'};
  api(`/api/videos/${id}/comments`).then(cl);
  $('#cf').onsubmit=async e=>{e.preventDefault();ls.set('name',$('#cn').value);try{cl(await api(`/api/videos/${id}/comments`,{method:'POST',body:JSON.stringify({name:$('#cn').value,body:$('#cb').value})}));$('#cb').value=''}catch(x){toast(x.message,true)}};
  api('/api/videos?limit=12').then(l=>{$('#side').innerHTML=l.filter(x=>x.id!==id).slice(0,10).map(card).join('')});
  if(!sessionStorage.getItem('v:'+id)){sessionStorage.setItem('v:'+id,1);fetch(`/api/videos/${id}/view`,{method:'POST'})}
}

const m=location.pathname.match(/^\/videos\/(\w+)/);
m?watch(m[1]):home();
