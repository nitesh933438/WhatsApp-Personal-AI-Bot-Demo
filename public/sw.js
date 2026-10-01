/* Cache only static assets. Never cache login or authenticated HTML pages. */
const CACHE = "personal-bot-static-v25";
const STATIC_ASSETS = [
  "/js/footer.js", "/js/app.js", "/js/install.js", "/js/notifications.js",
  "/js/login.js", "/js/home.js", "/js/chat-simple.js", "/js/contacts.js",
  "/js/settings-simple.js", "/css/app.css", "/favicon.svg",
  "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { title: "Personal Bot", body: event.data?.text?.() || "" }; }
  const title = data.title || "Personal Bot";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: `personal-bot-${data._id || data.createdAt || Date.now()}`,
    renotify: true,
    data: { url: data.url || "/dashboard.html", notificationId: data._id || "" }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = event.notification?.data?.url || "/dashboard.html";
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const client of list) {
      if ("focus" in client) {
        client.navigate(target);
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== "GET") return;
  // Navigations and API traffic must reach the server; do not fall back to a cached login page.
  if (request.mode === "navigate" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/socket.io/")) return;
  if (!STATIC_ASSETS.includes(url.pathname)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
