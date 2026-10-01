'use strict';
const base = (process.env.HEALTHCHECK_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
const paths = ['/healthz', '/readyz'];

(async () => {
  const results = [];
  for (const p of paths) {
    try {
      const res = await fetch(base + p, { redirect: 'manual' });
      const body = await res.text();
      results.push({ path: p, status: res.status, ok: res.ok, body: body.slice(0, 500) });
    } catch (err) {
      results.push({ path: p, status: 0, ok: false, error: err.message });
    }
  }
  console.log(JSON.stringify({ base, results }, null, 2));
  if (results.some(r => !r.ok)) process.exit(1);
})().catch(err => { console.error(err); process.exit(1); });
