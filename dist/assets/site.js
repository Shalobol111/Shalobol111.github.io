import { mode } from './config.js';

const form = document.querySelector('#lead-form');
const menu = document.querySelector('.mobile-nav');
const status = document.querySelector('#lead-status');
const submit = form.querySelector('button[type="submit"]');
const fields = form.elements;
let sending = false;

form.noValidate = true;
submit.disabled = false;
if (mode === 'preview') {
  const note = document.createElement('p');
  note.className = 'preview-note';
  note.textContent = 'Форма проверяет поля. Чтобы оставить заявку, воспользуйтесь контактами рядом.';
  form.prepend(note);
  submit.textContent = 'Проверить форму';
}

menu.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.open) {
    menu.open = false;
    menu.querySelector('summary').focus();
  }
});

document.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (menu.open && (!menu.contains(event.target) || link)) {
    menu.open = false;
  }
  if (!link || link.hash !== '#contact' || link.pathname !== location.pathname) return;
  if (link.dataset.service) fields.service.value = link.dataset.service;
  requestAnimationFrame(() => fields.name.focus({ preventScroll: true }));
});

function showStatus(message, state) {
  status.textContent = message;
  status.dataset.state = state;
}

function setError(field, message) {
  document.querySelector('#' + field.name + '-error').textContent = message;
  if (message) field.setAttribute('aria-invalid', 'true');
  else field.removeAttribute('aria-invalid');
}

function phoneIsValid(value) {
  return /^\+?[\d ()-]+$/.test(value) && /^(?:[78])?\d{10}$/.test(value.replace(/\D/g, ''));
}

const errors = {
  name: () => /^[^\r\n]{2,80}$/u.test(fields.name.value.trim()) ? '' : 'Введите имя, не менее двух символов.',
  phone: () => phoneIsValid(fields.phone.value.trim()) ? '' : 'Введите российский номер телефона, например +7 900 000-00-00.',
  consent: () => fields.consent.checked ? '' : 'Подтвердите согласие на обработку данных.',
};

for (const key of Object.keys(errors)) {
  fields[key].addEventListener('input', () => {
    if (fields[key].hasAttribute('aria-invalid')) setError(fields[key], errors[key]());
  });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sending) return;

  showStatus('', '');
  let firstInvalid;
  for (const [key, validate] of Object.entries(errors)) {
    const error = validate();
    setError(fields[key], error);
    if (error && !firstInvalid) firstInvalid = fields[key];
  }
  if (firstInvalid) {
    firstInvalid.focus();
    return;
  }

  if (mode === 'preview') {
    showStatus('Поля заполнены верно. Это предпросмотр, письмо не отправлено.', 'success');
    return;
  }

  sending = true;
  submit.disabled = true;
  submit.textContent = 'Отправляем…';
  try {
    const response = await fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: fields.name.value.trim(),
        phone: fields.phone.value.trim(),
        service: fields.service.value,
        comment: fields.comment.value.trim(),
        website: fields.website.value,
        consent: fields.consent.checked
      }),
      signal: AbortSignal.timeout(22_000)
    });
    if (response.status === 429) {
      showStatus('Слишком много попыток. Попробуйте позже или позвоните нам.', 'error');
      return;
    }
    if (!response.ok || !(await response.json()).ok) throw new Error('Delivery failed');
    form.reset();
    showStatus('Заявка отправлена. Свяжемся, чтобы уточнить задачу.', 'success');
  } catch {
    showStatus('Не удалось отправить заявку. Попробуйте ещё раз или свяжитесь с нами по телефону.', 'error');
  } finally {
    sending = false;
    submit.disabled = false;
    submit.textContent = 'Отправить заявку';
  }
});


const ledger = document.querySelector('.ledger');
const stages = [...ledger.querySelectorAll('.stage-options button')];
for (const [index, button] of stages.entries()) {
  button.addEventListener('click', () => {
    stages.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    ledger.style.setProperty('--step', index);
    ledger.dataset.active = index;
    ledger.querySelector('#stage-date').textContent = button.querySelector('small').textContent.slice(0, 2);
    ledger.querySelector('#stage-title').textContent = button.querySelector('strong').textContent;
    ledger.querySelector('#stage-description').textContent = button.dataset.description;
    ledger.querySelector('.stage-status').textContent = button.dataset.status;
  });
}

const dialog = document.querySelector('#legal-dialog');
for (const link of document.querySelectorAll('a[href^="/documents/"], a[href^="/dist/documents/"]')) {
  link.addEventListener('click', event => {
    event.preventDefault();
    const key = link.hash.slice(1);
    for (const section of dialog.querySelectorAll('[data-document]')) {
      section.hidden = Boolean(key && section.dataset.document !== key);
    }
    dialog.showModal();
  });
}
dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
});

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in-view', 'revealed');
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.08 });
  document.querySelectorAll('.section-heading,.featured,.service-list li,.process li,.package,.expert-layout,.lead-form,.faq-layout').forEach(element => {
    if (element.matches('li')) {
      const position = Array.from(element.parentElement.children).indexOf(element);
      element.style.setProperty('--delay', (position % 3) * 55 + 'ms');
    }
    observer.observe(element);
  });
}

for (const details of document.querySelectorAll('.faq details')) {
  const summary = details.querySelector('summary');
  let animation;
  let opening = false;
  summary.addEventListener('click', event => {
    if (reducedMotion.matches || !details.animate) return;
    event.preventDefault();
    const from = details.getBoundingClientRect().height;
    opening = animation ? !opening : !details.open;
    if (animation) animation.cancel();
    details.open = true;
    details.style.overflow = 'hidden';
    const to = opening ? details.getBoundingClientRect().height : summary.getBoundingClientRect().height + 1;
    animation = details.animate([{height: from + 'px'}, {height: to + 'px'}], {duration: 260, easing: 'cubic-bezier(.16,1,.3,1)'});
    animation.onfinish = () => {
      details.open = opening;
      details.style.overflow = '';
      animation = undefined;
    };
  });
}

