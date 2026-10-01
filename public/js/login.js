(() => {
  'use strict';

  const form = document.getElementById('form');
  const username = document.getElementById('username');
  const password = document.getElementById('password');
  const loginBtn = document.getElementById('loginBtn');
  const error = document.getElementById('error');
  const mode = document.getElementById('mode');
  const togglePassword = document.getElementById('togglePassword');

  function setTheme(theme) {
    const dark = theme === 'dark';
    document.body.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
    if (mode) mode.innerHTML = dark ? '☀️  Switch to light mode' : '🌙  Switch to dark mode';
  }

  if (localStorage.getItem('theme') === 'dark') setTheme('dark');
  else setTheme('light');

  mode?.addEventListener('click', () => {
    setTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
  });

  togglePassword?.addEventListener('click', () => {
    const visible = password.type === 'text';
    password.type = visible ? 'password' : 'text';
    togglePassword.textContent = visible ? 'Show' : 'Hide';
    togglePassword.setAttribute('aria-label', visible ? 'Show password' : 'Hide password');
    password.focus({ preventScroll: true });
  });

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';

    const user = username.value.trim();
    const pass = password.value;

    if (!user || !pass) {
      error.textContent = 'Username and password are required.';
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: user, password: pass })
      });

      const data = await response.json().catch(() => ({
        success: false,
        message: 'Server returned an invalid response.'
      }));

      if (!response.ok || !data.success) {
        throw new Error(data.message || `Login failed (${response.status})`);
      }

      if (data.token) localStorage.setItem('token', data.token);
      window.location.replace('/dashboard.html');
    } catch (err) {
      console.error('Login error:', err);
      error.textContent = err?.message || 'Unable to sign in. Please try again.';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In to Dashboard';
    }
  });
})();
