// ── In-app input/confirm dialogs ──
// Electron's renderer does not implement window.prompt() — it throws — and
// window.confirm() pops a native box that blocks every terminal in the app
// until it is answered. These are the local replacements.

const modal = () => document.getElementById('prompt-modal');
const titleEl = () => document.getElementById('prompt-title');
const messageEl = () => document.getElementById('prompt-message');
const inputEl = () => document.getElementById('prompt-input');
const errorEl = () => document.getElementById('prompt-error');

let resolver = null;

function finish(value) {
  if (!resolver) return;
  const { resolve } = resolver;
  resolver = null;
  modal().classList.add('hidden');
  modal().classList.remove('confirm');
  document.removeEventListener('keydown', onKeydown, true);
  resolve(value);
}

function onKeydown(e) {
  if (!resolver) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    submit();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    finish(null);
  }
}

function submit() {
  if (!resolver) return;
  const input = inputEl();
  const v = input.value;
  if (resolver.validate && !resolver.validate(v)) {
    errorEl().textContent = resolver.error || 'Invalid value.';
    input.focus();
    return;
  }
  finish(v);
}

function open({ title, message, value = '', select = false, confirm = false, validate, error }) {
  // One at a time; a second request answers itself with "cancelled" rather
  // than clobbering the dialog a user is mid-way through.
  if (resolver) finish(null);

  titleEl().textContent = title || 'Input';
  messageEl().textContent = message || '';
  messageEl().classList.toggle('hidden', !message);
  const input = inputEl();
  input.value = value;
  errorEl().textContent = '';

  modal().classList.toggle('confirm', !!confirm);
  modal().classList.remove('hidden');
  document.addEventListener('keydown', onKeydown, true);

  if (confirm) {
    document.getElementById('prompt-ok').focus();
  } else {
    input.focus();
    if (select) input.select();
  }

  return new Promise((resolve) => {
    resolver = { resolve, validate, error };
  });
}

// prompt(): resolves with the string, or null on cancel.
function appPrompt(message, { title = 'Input', value = '', validate, error } = {}) {
  return open({ title, message, value, select: true, validate, error });
}

// confirm(): resolves true/false.
function appConfirm(message, { title = 'Confirm', okLabel = 'OK' } = {}) {
  const okBtn = document.getElementById('prompt-ok');
  okBtn.textContent = okLabel;
  const p = open({ title, message, confirm: true });
  return p.then((v) => {
    // Only restore the default label if no other dialog took over meanwhile.
    if (!resolver) okBtn.textContent = 'OK';
    return v !== null;
  });
}

function init() {
  document.getElementById('prompt-ok').addEventListener('click', submit);
  document.getElementById('prompt-cancel').addEventListener('click', () => finish(null));
  modal().addEventListener('click', (e) => {
    if (e.target === modal()) finish(null);
  });
}

// Smoketest hooks: the real app never touches these. The flag is set by
// appending ?selftest=1 to index.html before the bundle runs (see smoketest.js).
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('selftest')) {
  window.__testPrompt = appPrompt;
  window.__testConfirm = appConfirm;
}

module.exports = { init, appPrompt, appConfirm };
