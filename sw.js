// BPC service worker: keeps the app shell available offline. Pages and scripts are fetched
// from the network first, so a new deploy always shows up; the cache is only the fallback.
// Supabase and other cross-origin requests are never cached.
const CACHE="bpc-shell-v27";
const SHELL=["./","index.html","style.css","app.js","config.js","manifest.webmanifest","icons/icon-192.png"];
self.addEventListener("install",e=>{
  e.waitUntil(caches.open(CACHE).then(c=>Promise.all(SHELL.map(u=>c.add(u).catch(()=>null)))).then(()=>self.skipWaiting()));
});
self.addEventListener("activate",e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch",e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=="GET"||u.origin!==location.origin)return;
  // Revalidate with the server every time (a cheap 304 when nothing changed), so a new deploy
  // is never hidden behind the browser's HTTP cache.
  const net=r.mode==="navigate"?fetch(r.url,{cache:"no-cache",credentials:"same-origin"}):fetch(r,{cache:"no-cache"});
  e.respondWith(net.then(res=>{
    if(res&&res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(r,copy)).catch(()=>{});}
    return res;
  }).catch(()=>caches.match(r).then(m=>m||(r.mode==="navigate"?caches.match("index.html"):Response.error()))));
});
