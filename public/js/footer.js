(() => {
  const year = document.querySelectorAll('[data-current-year]');
  const versionEls = document.querySelectorAll('[data-app-version]');
  year.forEach(el => { el.textContent = String(new Date().getFullYear()); });
  const setVersion = v => versionEls.forEach(el => { el.textContent = `v${v}`; el.title = `Application version ${v}`; });
  fetch('/api/app/version', { credentials: 'same-origin', cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error('version request failed')))
    .then(d => setVersion(d.version || '1.0.0'))
    .catch(() => setVersion(document.documentElement.dataset.appVersion || '1.0.0'));
})();
