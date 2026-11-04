/* Sl Nails — Aix-en-Provence
   Site statique autonome : aucun back-end, aucun service tiers payant.
   GSAP + ScrollTrigger + Lenis (fichiers locaux dans assets/js).
   Réservation = demande par SMS pré-rempli (sms:), appel (tel:) et fichier agenda (.ics). */
(() => {
  'use strict';

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => Array.from(c.querySelectorAll(s));

  /* ----------------------------------------------------------
     À MODIFIER ICI : coordonnées, horaires, créneaux
     ---------------------------------------------------------- */
  const CONFIG = {
    phone: '+33610809184',
    phoneLabel: '06 10 80 91 84',
    tz: 'Europe/Paris',
    // 0 = dimanche … 6 = samedi : [ouverture, fermeture] en heures
    hours: { 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 18], 5: [9, 18] },
    slotStart: 9,        // première heure d’arrivée proposée
    slotEnd: 16.5,       // dernière heure d’arrivée proposée (16h30)
    slotStep: 0.5,       // pas en heures (0.5 = 30 min)
    minNoticeMinutes: 60,// préavis pour un créneau le jour même
    eventMinutes: 60,    // durée indicative dans le fichier agenda
    daysAhead: 14        // nombre de jours ouvrés proposés
  };

  const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const hasGsap = !!(window.gsap && window.ScrollTrigger);
  const canMotion = hasGsap && !reduce;
  let lenis = null;
  let menuOpen = false;

  /* ---------- utilitaires ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const parisNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: CONFIG.tz }));
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const longDate = (d) => d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  function splitWords(el) {
    if (el.dataset.split === 'done') return $$('.sw__i', el);
    const walk = (node) => {
      Array.from(node.childNodes).forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          n.textContent.split(/(\s+)/).forEach((part) => {
            if (!part) return;
            if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
            const w = document.createElement('span'); w.className = 'sw';
            const i = document.createElement('span'); i.className = 'sw__i'; i.textContent = part;
            w.appendChild(i); frag.appendChild(w);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1 && n.tagName !== 'BR') walk(n);
      });
    };
    walk(el);
    el.dataset.split = 'done';
    return $$('.sw__i', el);
  }

  function splitChars(el) {
    if (el.dataset.chars === 'done') return $$('.sc__i', el);
    const walk = (node) => {
      Array.from(node.childNodes).forEach((n) => {
        if (n.nodeType === 3) {
          const frag = document.createDocumentFragment();
          Array.from(n.textContent).forEach((ch) => {
            if (ch === ' ') { frag.appendChild(document.createTextNode(' ')); return; }
            const c = document.createElement('span'); c.className = 'sc'; c.setAttribute('aria-hidden', 'true');
            const i = document.createElement('span'); i.className = 'sc__i'; i.textContent = ch;
            c.appendChild(i); frag.appendChild(c);
          });
          n.replaceWith(frag);
        } else if (n.nodeType === 1) walk(n);
      });
    };
    walk(el);
    el.dataset.chars = 'done';
    return $$('.sc__i', el);
  }

  /* ----------------------------------------------------------
     Horaires et statut « ouvert / fermé » (toujours actif)
     ---------------------------------------------------------- */
  function openStatus() {
    const n = parisNow();
    const day = n.getDay();
    const h = n.getHours() + n.getMinutes() / 60;
    const today = CONFIG.hours[day];
    if (today && h >= today[0] && h < today[1]) return { open: true, text: `Ouvert maintenant · jusqu’à ${today[1]}h` };
    for (let i = 0; i <= 7; i++) {
      const dd = (day + i) % 7;
      const th = CONFIG.hours[dd];
      if (!th) continue;
      if (i === 0) { if (h < th[0]) return { open: false, text: `Fermé · ouvre aujourd’hui à ${th[0]}h` }; continue; }
      return { open: false, text: `Fermé · ouvre ${i === 1 ? 'demain' : DAYS[dd]} à ${th[0]}h` };
    }
    return { open: false, text: 'Fermé' };
  }

  function initStatus() {
    const paint = () => {
      const st = openStatus();
      const hero = $('#heroStatus');
      if (hero) { hero.innerHTML = `<i></i>${st.text}`; hero.classList.toggle('is-closed', !st.open); }
      const find = $('#findOpen'); if (find) find.textContent = st.text;
      const dow = parisNow().getDay();
      $$('.hours tr').forEach((tr) => tr.classList.toggle('is-today', Number(tr.dataset.day) === dow));
    };
    paint();
    setInterval(paint, 60000);
  }

  /* ----------------------------------------------------------
     Réservation : SMS pré-rempli + .ics (aucun service tiers)
     ---------------------------------------------------------- */
  const bk = { setService: () => {} };

  function initBooking() {
    const form = $('#bk');
    if (!form) return;
    const daysEl = $('#bkDays'), timesEl = $('#bkTimes'), sumEl = $('#bkSum'), errEl = $('#bkErr');
    const smsBtn = $('#bkSms'), done = $('#bkDone'), msgEl = $('#bkMsg');
    const nameEl = $('#bkName'), noteEl = $('#bkNote'), progress = $('.bk__progress span');
    const state = { service: '', date: '', time: '', name: '', note: '' };

    const slotsFor = (date) => {
      const slots = [];
      const now = parisNow();
      const isToday = sameDay(date, now);
      for (let h = CONFIG.slotStart; h <= CONFIG.slotEnd + 1e-9; h += CONFIG.slotStep) {
        const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
        if (isToday && hh * 60 + mm < now.getHours() * 60 + now.getMinutes() + CONFIG.minNoticeMinutes) continue;
        slots.push(`${pad(hh)}:${pad(mm)}`);
      }
      return slots;
    };

    const buildDays = () => {
      const out = [];
      const n = parisNow();
      for (let i = 0; i < 45 && out.length < CONFIG.daysAhead; i++) {
        const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + i);
        if (!CONFIG.hours[d.getDay()]) continue;
        if (i === 0 && slotsFor(d).length === 0) continue;
        out.push(d);
      }
      return out;
    };

    const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const days = buildDays();
    const today = parisNow();
    daysEl.innerHTML = days.map((d) => {
      const isT = sameDay(d, today);
      const wd = isT ? 'auj.' : d.toLocaleDateString('fr-FR', { weekday: 'short' });
      return `<label class="bk__day"><input type="radio" name="jour" value="${iso(d)}" aria-label="${longDate(d)}"><span><small>${wd}</small><b>${d.getDate()}</b><em>${d.toLocaleDateString('fr-FR', { month: 'short' })}</em></span></label>`;
    }).join('');

    const dateFromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

    const renderTimes = () => {
      if (!state.date) { timesEl.innerHTML = '<p class="bk__empty">Choisis d’abord un jour.</p>'; return; }
      const slots = slotsFor(dateFromIso(state.date));
      if (!slots.includes(state.time)) state.time = '';
      timesEl.innerHTML = slots.length
        ? slots.map((t) => `<label class="bk__time"><input type="radio" name="heure" value="${t}"${t === state.time ? ' checked' : ''}><span>${t.replace(':', 'h')}</span></label>`).join('')
        : '<p class="bk__empty">Plus de créneau ce jour-là, essaie le suivant.</p>';
    };

    const plain = (s) => s.replace(/[’‘]/g, "'");
    const buildMessage = () => {
      const d = dateFromIso(state.date);
      const what = state.service === 'Conseil sur-mesure' ? 'un conseil sur-mesure (je ne sais pas encore ce que je veux)' : `"${state.service}"`;
      const note = state.note.trim() ? ` ${state.note.trim()}${/[.!?…]$/.test(state.note.trim()) ? '' : '.'}` : '';
      return plain(`Bonjour Sandra, c'est ${state.name.trim()}. Je souhaiterais prendre rendez-vous chez Sl Nails pour ${what} le ${longDate(d)} vers ${state.time.replace(':', 'h')}.${note} Pourriez-vous me confirmer ce créneau ? Merci beaucoup !`);
    };

    const missing = () => {
      const m = [];
      if (!state.service) m.push('ta prestation');
      if (!state.date) m.push('un jour');
      if (state.date && !state.time) m.push('une heure');
      if (state.name.trim().length < 2) m.push('ton prénom');
      return m;
    };

    const update = () => {
      const miss = missing();
      const steps = [state.service, state.date, state.time, state.name.trim().length >= 2].filter(Boolean).length;
      progress.style.transform = `scaleX(${steps / 4})`;
      if (!miss.length) {
        sumEl.innerHTML = `<strong>${state.service}</strong> · ${longDate(dateFromIso(state.date))} · vers ${state.time.replace(':', 'h')}`;
        const msg = buildMessage();
        msgEl.value = msg;
        smsBtn.href = `sms:${CONFIG.phone}?&body=${encodeURIComponent(msg)}`;
        smsBtn.setAttribute('aria-disabled', 'false');
        errEl.textContent = '';
      } else {
        sumEl.textContent = `Il te manque : ${miss.join(', ')}.`;
        smsBtn.href = `sms:${CONFIG.phone}`;
        smsBtn.setAttribute('aria-disabled', 'true');
      }
    };

    form.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'service') state.service = t.value;
      if (t.name === 'jour') { state.date = t.value; renderTimes(); }
      if (t.name === 'heure') state.time = t.value;
      update();
    });
    nameEl.addEventListener('input', () => { state.name = nameEl.value; update(); });
    noteEl.addEventListener('input', () => { state.note = noteEl.value; update(); });
    form.addEventListener('submit', (e) => e.preventDefault());

    smsBtn.addEventListener('click', (e) => {
      const miss = missing();
      if (miss.length) {
        e.preventDefault();
        errEl.textContent = `Presque fini : il manque ${miss.join(', ')}.`;
        if (canMotion) gsap.fromTo(smsBtn, { x: -8 }, { x: 0, duration: .8, ease: 'elastic.out(1,.3)' });
        if (!state.name.trim() && miss.length === 1) nameEl.focus();
        return;
      }
      done.hidden = false;
      if (canMotion) gsap.from(done, { opacity: 0, y: 24, duration: .8, ease: 'power3.out' });
    });

    $('#bkCopy').addEventListener('click', async (e) => {
      const btn = e.currentTarget; const label = $('span', btn);
      try { await navigator.clipboard.writeText(msgEl.value); }
      catch (err) { msgEl.select(); document.execCommand('copy'); }
      label.textContent = 'Copié ✓';
      setTimeout(() => { label.textContent = 'Copier le message'; }, 2200);
    });

    $('#bkIcs').addEventListener('click', () => {
      if (missing().length) return;
      const d = dateFromIso(state.date);
      const [hh, mm] = state.time.split(':').map(Number);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm);
      const end = new Date(start.getTime() + CONFIG.eventMinutes * 60000);
      const f = (x) => `${x.getFullYear()}${pad(x.getMonth() + 1)}${pad(x.getDate())}T${pad(x.getHours())}${pad(x.getMinutes())}00`;
      const esc = (s) => s.replace(/([,;])/g, '\\$1');
      const ics = [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sl Nails//Rendez-vous//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        'BEGIN:VEVENT',
        `UID:${Date.now()}@sl-nails`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
        `DTSTART:${f(start)}`, `DTEND:${f(end)}`,
        `SUMMARY:${esc(`Sl Nails · ${state.service} (à confirmer)`)}`,
        `LOCATION:${esc("5220 Route d'Avignon, 13540 Aix-en-Provence")}`,
        `DESCRIPTION:${esc(`Demande de rendez-vous à confirmer par SMS avec Sandra : ${CONFIG.phoneLabel}`)}`,
        'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', 'DESCRIPTION:Rendez-vous Sl Nails', 'END:VALARM',
        'END:VEVENT', 'END:VCALENDAR'
      ].join('\r\n');
      const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'rendez-vous-sl-nails.ics';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    });

    bk.setService = (value) => {
      const input = $$('input[name="service"]', form).find((i) => i.value === value);
      if (!input) return;
      input.checked = true; state.service = value; update();
    };

    update();
  }

  /* ----------------------------------------------------------
     Menu mobile
     ---------------------------------------------------------- */
  function initMenu() {
    const burger = $('#burger'), menu = $('#menu'), nav = $('#nav');
    if (!burger || !menu) return;
    const labels = $$('.menu__nav a span', menu);
    const circle = (r) => `circle(${r} at calc(100% - 2.6rem) 2.6rem)`;

    const set = (open) => {
      menuOpen = open;
      burger.setAttribute('aria-expanded', String(open));
      burger.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
      menu.setAttribute('aria-hidden', String(!open));
      nav.classList.toggle('menu-open', open);
      if (!canMotion) { menu.classList.toggle('is-open', open); return; }
      if (open) {
        menu.classList.add('is-open');
        if (lenis) lenis.stop();
        gsap.killTweensOf([menu, labels]);
        gsap.fromTo(menu, { clipPath: circle('0px') }, { clipPath: circle('150%'), duration: 1, ease: 'expo.inOut' });
        gsap.fromTo(labels, { yPercent: 110 }, { yPercent: 0, duration: 1.1, ease: 'expo.out', stagger: .06, delay: .3 });
      } else {
        gsap.to(menu, { clipPath: circle('0px'), duration: .75, ease: 'expo.inOut', onComplete: () => menu.classList.remove('is-open') });
        if (lenis) lenis.start();
      }
    };
    burger.addEventListener('click', () => set(!menuOpen));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && menuOpen) { set(false); burger.focus(); } });
    bk.closeMenu = () => { if (menuOpen) set(false); };
  }

  /* ----------------------------------------------------------
     Liens d’ancrage (Lenis) + présélection de la prestation
     ---------------------------------------------------------- */
  function initAnchors() {
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const sel = a.getAttribute('href');
      if (!sel || sel.length < 2) return;
      let target = null;
      try { target = document.querySelector(sel); } catch (err) { return; }
      if (!target) return;
      e.preventDefault();
      if (a.dataset.service) bk.setService(a.dataset.service);
      if (bk.closeMenu) bk.closeMenu();
      const t = target.parentElement && target.parentElement.classList.contains('pin-spacer') ? target.parentElement : target;
      if (lenis) lenis.scrollTo(t, { offset: sel === '#reserver' ? -10 : 0, duration: 1.7 });
      else t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    });
  }

  /* ----------------------------------------------------------
     Vidéo du hero
     ---------------------------------------------------------- */
  function initVideo() {
    const v = $('#heroVideo');
    if (!v) return;
    if (innerWidth < 700) {
      const s = $('source', v);
      s.src = 'assets/video/hero-sm.mp4';
      v.load();
    }
    if (reduce) { v.pause(); v.removeAttribute('autoplay'); return; }
    const p = v.play(); if (p && p.catch) p.catch(() => {});
    if ('IntersectionObserver' in window) {
      new IntersectionObserver((en) => {
        en.forEach((x) => { if (x.isIntersecting) { const q = v.play(); if (q && q.catch) q.catch(() => {}); } else v.pause(); });
      }, { threshold: 0.05 }).observe($('.hero'));
    }
  }

  /* ----------------------------------------------------------
     Avis : carrousel
     ---------------------------------------------------------- */
  function initReviews() {
    const rev = $('#rev');
    if (!rev) return;
    const slides = $$('.review', rev), dotsWrap = $('#revDots'), bar = $('.rev__bar span', rev);
    const AUTO = 8;
    let idx = 0, busy = false, tween = null, inView = false, hovering = false;
    const words = canMotion ? slides.map((s) => splitWords($('blockquote p', s))) : [];

    const dots = slides.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'rev__dot'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', `Avis ${i + 1}`); b.setAttribute('aria-selected', String(i === 0));
      b.addEventListener('click', () => go(i));
      dotsWrap.appendChild(b); return b;
    });

    const progress = () => {
      if (!canMotion) return;
      if (tween) tween.kill();
      gsap.set(bar, { scaleX: 0 });
      tween = gsap.to(bar, { scaleX: 1, duration: AUTO, ease: 'none', onComplete: () => go(idx + 1) });
      if (!inView || hovering) tween.pause();
    };

    function go(n) {
      n = (n + slides.length) % slides.length;
      if (n === idx || busy) return;
      const cur = slides[idx], next = slides[n];
      busy = true;
      dots.forEach((d, i) => d.setAttribute('aria-selected', String(i === n)));
      const swap = () => { cur.classList.remove('is-active'); next.classList.add('is-active'); };
      if (canMotion) {
        gsap.to([$('.review__stars', cur), $('footer', cur)], { opacity: 0, duration: .3 });
        gsap.to(words[idx], {
          yPercent: -115, duration: .5, ease: 'power3.in', stagger: .004,
          onComplete: () => {
            swap();
            gsap.set(words[n], { yPercent: 115 });
            gsap.fromTo(words[n], { yPercent: 115 }, { yPercent: 0, duration: 1, ease: 'expo.out', stagger: .014, onComplete: () => { busy = false; } });
            gsap.fromTo([$('.review__stars', next), $('footer', next)], { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: .9, ease: 'power3.out', stagger: .12, delay: .2 });
          }
        });
      } else { swap(); busy = false; }
      idx = n;
      progress();
    }

    $('#revPrev').addEventListener('click', () => go(idx - 1));
    $('#revNext').addEventListener('click', () => go(idx + 1));
    rev.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') go(idx - 1);
      if (e.key === 'ArrowRight') go(idx + 1);
    });
    rev.addEventListener('pointerenter', () => { hovering = true; if (tween) tween.pause(); });
    rev.addEventListener('pointerleave', () => { hovering = false; if (tween && inView) tween.play(); });
    let x0 = null;
    rev.addEventListener('pointerdown', (e) => { x0 = e.clientX; });
    rev.addEventListener('pointerup', (e) => {
      if (x0 === null) return;
      const dx = e.clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) go(idx + (dx < 0 ? 1 : -1));
    });

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((en) => {
        inView = en[0].isIntersecting;
        if (!tween) { if (inView) progress(); return; }
        if (inView && !hovering) tween.play(); else tween.pause();
      }, { threshold: 0.35 }).observe(rev);
    }
  }

  /* ----------------------------------------------------------
     Curseur feuille, boutons magnétiques, cartes 3D
     ---------------------------------------------------------- */
  function initPointerFx() {
    if (!fine || !canMotion) return;

    const cur = document.createElement('div');
    cur.className = 'cursor'; cur.setAttribute('aria-hidden', 'true');
    document.body.appendChild(cur);
    const cx = gsap.quickTo(cur, 'x', { duration: .35, ease: 'power3' });
    const cy = gsap.quickTo(cur, 'y', { duration: .35, ease: 'power3' });
    addEventListener('pointermove', (e) => { cx(e.clientX); cy(e.clientY); cur.classList.add('is-on'); }, { passive: true });
    document.addEventListener('pointerleave', () => cur.classList.remove('is-on'));
    document.addEventListener('pointerover', (e) => {
      const lab = e.target.closest('[data-cursor]');
      const link = e.target.closest('a, button, label, input, textarea');
      cur.classList.toggle('has-label', !!lab);
      cur.classList.toggle('is-link', !!link && !lab);
      if (lab) cur.dataset.label = lab.dataset.cursor;
    });

    $$('.magnetic').forEach((el) => {
      const xTo = gsap.quickTo(el, 'x', { duration: .7, ease: 'elastic.out(1,.55)' });
      const yTo = gsap.quickTo(el, 'y', { duration: .7, ease: 'elastic.out(1,.55)' });
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        xTo((e.clientX - (r.left + r.width / 2)) * .32);
        yTo((e.clientY - (r.top + r.height / 2)) * .4);
      });
      el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
    });

    $$('.tilt').forEach((el) => {
      gsap.set(el, { transformPerspective: 900 });
      const rx = gsap.quickTo(el, 'rotationX', { duration: .6, ease: 'power3' });
      const ry = gsap.quickTo(el, 'rotationY', { duration: .6, ease: 'power3' });
      el.addEventListener('pointermove', (e) => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
        ry((px - .5) * 11); rx(-(py - .5) * 11);
        el.style.setProperty('--mx', `${px * 100}%`); el.style.setProperty('--my', `${py * 100}%`);
      });
      el.addEventListener('pointerleave', () => { rx(0); ry(0); });
    });
  }

  /* ----------------------------------------------------------
     Marquees réactifs au scroll
     ---------------------------------------------------------- */
  function initMarquees() {
    const rows = $$('.marquee').map((m, i) => {
      const track = $('.marquee__track', m);
      const unit = track.innerHTML;
      let k = 1;
      while (track.scrollWidth < innerWidth * 1.1 && k < 8) { track.insertAdjacentHTML('beforeend', unit); k++; }
      track.insertAdjacentHTML('beforeend', track.innerHTML);
      m.setAttribute('aria-hidden', 'true');
      return { track, dir: i % 2 === 0 ? -1 : 1, x: 0 };
    });
    let lastY = scrollY, vel = 0, sign = 1;
    gsap.ticker.add((time, delta) => {
      const dt = Math.min(delta, 64) / 1000 || .016;
      const y = scrollY, dy = y - lastY; lastY = y;
      vel += (dy / dt - vel) * .08;
      if (Math.abs(vel) > 40) sign += ((vel > 0 ? 1 : -1) - sign) * .1;
      const boost = Math.min(Math.abs(vel) / 380, 6);
      rows.forEach((r) => {
        const period = r.track.scrollWidth / 2;
        r.x += (64 + boost * 150) * r.dir * sign * dt;
        if (r.x <= -period) r.x += period;
        if (r.x > 0) r.x -= period;
        r.track.style.transform = `translate3d(${r.x}px,0,0)`;
      });
    });
  }

  /* ----------------------------------------------------------
     Préchargeur
     ---------------------------------------------------------- */
  function runLoader() {
    return new Promise((resolve) => {
      const loader = $('.loader');
      const nail = $('.loader__nail'), fill = $('.loader__fill'), count = $('#loadCount');
      const chars = splitChars($('.loader__brand'));
      const counter = { v: 0 };
      gsap.set(fill, { yPercent: 100 });
      gsap.set(chars, { yPercent: 118 });
      const scale = (Math.hypot(innerWidth, innerHeight) / Math.min(nail.offsetWidth, nail.offsetHeight)) * 1.35;
      const tl = gsap.timeline({
        onComplete: () => { loader.style.display = 'none'; resolve(); }
      });
      tl.to(chars, { yPercent: 0, duration: .9, ease: 'expo.out', stagger: .05 }, .1)
        .to(counter, { v: 100, duration: 1.5, ease: 'power2.inOut', onUpdate: () => { count.textContent = Math.round(counter.v); } }, 0)
        .to(fill, { yPercent: 0, duration: 1.5, ease: 'power2.inOut' }, 0)
        .to(chars, { yPercent: -118, duration: .5, ease: 'power3.in', stagger: .025 }, 1.65)
        .to('.loader__count', { opacity: 0, duration: .25 }, 1.65)
        .to(nail, { scale, borderColor: '#E3B8AA', duration: 1, ease: 'expo.in' }, 1.85)
        .to(loader, { '--lc': '#E3B8AA', duration: .01 }, 2.8)
        .add(() => resolve(), 2.85)
        .to(loader, { y: () => -(innerHeight + innerWidth * .18), duration: 1.1, ease: 'expo.inOut' }, 2.85);
      tl.add(() => root.classList.remove('is-loading'), 2.85);
      // visite répétée dans la même session : préchargeur accéléré
      let seen = false;
      try { seen = sessionStorage.getItem('sl-nails-seen') === '1'; sessionStorage.setItem('sl-nails-seen', '1'); } catch (e) { /* stockage indisponible */ }
      if (seen) tl.timeScale(2.2);
    });
  }

  function heroIntro() {
    const chars = $$('.hero__title .sc__i');
    const t = gsap.timeline({ defaults: { ease: 'expo.out' } });
    t.from('.hero__media', { scale: 1.3, duration: 2.8, ease: 'power3.out' }, 0)
      .to(chars, { yPercent: 0, duration: 1.5, stagger: .075 }, .05)
      .from('.hero__eyebrow', { y: 24, opacity: 0, duration: 1.1 }, .5)
      .from('.hero__lead', { y: 34, opacity: 0, duration: 1.2 }, .75)
      .from('.hero__cta .btn', { y: 34, opacity: 0, duration: 1.1, stagger: .12 }, .95)
      .from('.hero__status', { opacity: 0, y: 14, duration: 1 }, 1.25)
      .from('.hero__badge', { scale: 0, rotation: -140, duration: 1.6, ease: 'elastic.out(1,.55)' }, 1)
      .from('.hero__branch', { y: 80, opacity: 0, duration: 1.8, stagger: .2 }, .5)
      .from('.nav', { yPercent: -100, duration: 1.1 }, .9);
  }

  /* ----------------------------------------------------------
     Animations au scroll (adaptées desktop / mobile)
     ---------------------------------------------------------- */
  function initScroll() {
    gsap.registerPlugin(ScrollTrigger);
    ScrollTrigger.config({ ignoreMobileResize: true });
    const nav = $('#nav'), fab = $('#fab');

    gsap.to('.progress span', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: .2 } });

    // menu qui se cache en descendant et réapparaît en remontant
    let hidden = false;
    ScrollTrigger.create({
      start: 0, end: 'max',
      onUpdate: (self) => {
        const y = self.scroll(), h = innerHeight;
        nav.classList.toggle('is-solid', y > h * .6);
        if (fab) fab.classList.toggle('is-on', y > h * .85);
        if (menuOpen) return;
        if (self.direction === 1 && y > h * .5 && !hidden) { hidden = true; gsap.to(nav, { yPercent: -110, duration: .6, ease: 'power3.out' }); }
        else if ((self.direction === -1 || y < h * .5) && hidden) { hidden = false; gsap.to(nav, { yPercent: 0, duration: .6, ease: 'power3.out' }); }
      }
    });

    const mm = gsap.matchMedia();
    mm.add({ wide: '(min-width: 900px)', narrow: '(max-width: 899px)' }, (ctx) => {
      const wide = !!ctx.conditions.wide;
      const undo = [];

      /* titres : mots qui montent derrière un masque */
      $$('[data-split]').forEach((h) => {
        const w = splitWords(h);
        gsap.from(w, { yPercent: 118, duration: 1.25, ease: 'expo.out', stagger: .05, scrollTrigger: { trigger: h, start: 'top 88%', once: true } });
      });

      /* petits textes : fondu + montée */
      $$('.eyebrow:not(.hero__eyebrow), .sec-head__txt, .hs-intro__txt, .hs-intro__hint, .book__lead, .book__facts li, .stat__lbl, .find__addr, .find__open, .hours, .find__btns, .foot__tag, .foot__cols > div, .rev__all').forEach((el) => {
        gsap.from(el, { y: 38, opacity: 0, duration: 1.2, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 92%', once: true } });
      });

      /* hero : parallax multicouche */
      const heroST = { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true };
      gsap.to('.hero__media', { yPercent: 16, ease: 'none', scrollTrigger: heroST });
      gsap.to('.hero__content', { yPercent: wide ? -22 : -10, opacity: 0, ease: 'none', scrollTrigger: { ...heroST, end: 'bottom 30%' } });
      gsap.to('.hero__branch--a', { yPercent: -55, rotation: '+=14', ease: 'none', scrollTrigger: heroST });
      gsap.to('.hero__branch--b', { yPercent: -95, rotation: '-=18', ease: 'none', scrollTrigger: heroST });
      gsap.to('.hero__badge', { yPercent: -60, rotation: 90, ease: 'none', scrollTrigger: heroST });
      gsap.to('.hero__scroll', { opacity: 0, scrollTrigger: { trigger: '.hero', start: 'top top', end: '12% top', scrub: true } });

      /* storytelling pinné */
      const story = $('.story');
      const steps = $$('.story__step', story);
      if (wide) {
        const pin = $('.story__pin', story), imgs = $$('.story__img', story), nums = $('.story__nums-in', story), bar = $('.story__bar span', story);
        const n = steps.length;
        story.classList.add('is-pinned');
        gsap.set(steps.slice(1), { autoAlpha: 0, y: 60 });
        gsap.set(imgs.slice(1), { clipPath: 'inset(100% 0% 0% 0%)' });
        const tl = gsap.timeline({
          defaults: { ease: 'none' },
          scrollTrigger: { trigger: pin, start: 'top top', end: () => `+=${innerHeight * n * .85}`, pin: true, scrub: .7, anticipatePin: 1, invalidateOnRefresh: true }
        });
        tl.fromTo(bar, { scaleX: .25 }, { scaleX: 1, duration: n - 1 }, 0);
        for (let i = 1; i < n; i++) {
          tl.to(steps[i - 1], { autoAlpha: 0, y: -60, duration: .45 }, i - .45)
            .to(imgs[i - 1], { scale: 1.12, duration: .9 }, i - .45)
            .fromTo(imgs[i], { clipPath: 'inset(100% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: .7 }, i - .5)
            .fromTo(steps[i], { autoAlpha: 0, y: 60 }, { autoAlpha: 1, y: 0, duration: .5 }, i - .1)
            .to(nums, { yPercent: -(100 / n) * i, duration: .6 }, i - .4);
        }
        tl.to({}, { duration: .7 }, n - 1);
        undo.push(() => story.classList.remove('is-pinned'));
      } else {
        steps.forEach((s) => {
          gsap.from(s, { y: 56, opacity: 0, duration: 1.1, ease: 'power3.out', scrollTrigger: { trigger: s, start: 'top 86%', once: true } });
        });
        $$('.story__mimg', story).forEach((f) => {
          gsap.fromTo(f, { clipPath: 'inset(100% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.4, ease: 'expo.out', scrollTrigger: { trigger: f, start: 'top 88%', once: true } });
        });
      }

      /* prestations : défilement horizontal piloté par le scroll vertical */
      if (wide) {
        const hs = $('.hscroll'), track = $('.hscroll__track', hs);
        hs.classList.add('is-pinned');
        const dist = () => Math.max(0, track.scrollWidth - innerWidth);
        const tween = gsap.to(track, {
          x: () => -dist(), ease: 'none',
          scrollTrigger: { trigger: hs, start: 'top top', end: () => `+=${dist()}`, pin: true, scrub: .6, anticipatePin: 1, invalidateOnRefresh: true }
        });
        $$('.card', hs).forEach((c) => {
          gsap.from(c, { opacity: .25, scale: .88, rotation: 2.5, ease: 'none', scrollTrigger: { trigger: c, containerAnimation: tween, start: 'left 98%', end: 'left 62%', scrub: true } });
        });
        undo.push(() => hs.classList.remove('is-pinned'));
      } else {
        $$('.hscroll .card').forEach((c, i) => {
          gsap.from(c, { y: 50, opacity: 0, duration: 1, ease: 'power3.out', scrollTrigger: { trigger: '.hscroll__track', start: 'top 82%', once: true }, delay: i * .08 });
        });
      }

      /* chiffres : compteurs */
      $$('[data-count]').forEach((el) => {
        const target = parseFloat(el.dataset.count), dec = parseInt(el.dataset.dec || '0', 10);
        const fmt = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
        const o = { v: 0 };
        el.textContent = fmt(0);
        gsap.to(o, { v: target, duration: 2.4, ease: 'power3.out', onUpdate: () => { el.textContent = fmt(o.v); }, scrollTrigger: { trigger: el, start: 'top 88%', once: true } });
      });

      /* galerie : masques (rideau / cercle) + image qui glisse dans son cadre */
      $$('.g').forEach((g) => {
        const circle = g.classList.contains('g--circle');
        gsap.fromTo(g,
          { clipPath: circle ? 'circle(0% at 50% 50%)' : 'inset(100% 0% 0% 0%)' },
          { clipPath: circle ? 'circle(75% at 50% 50%)' : 'inset(0% 0% 0% 0%)', duration: 1.5, ease: 'expo.out', scrollTrigger: { trigger: g, start: 'top 90%', once: true } });
        if (wide) gsap.fromTo($('img', g), { yPercent: -7 }, { yPercent: 7, ease: 'none', scrollTrigger: { trigger: g, start: 'top bottom', end: 'bottom top', scrub: true } });
      });

      /* réservation, carte, avis */
      gsap.from('.bk', { y: 90, opacity: 0, duration: 1.4, ease: 'power3.out', scrollTrigger: { trigger: '.bk', start: 'top 88%', once: true } });
      gsap.fromTo('.find__map', { clipPath: 'inset(100% 0% 0% 0%)' }, { clipPath: 'inset(0% 0% 0% 0%)', duration: 1.6, ease: 'expo.out', scrollTrigger: { trigger: '.find__map', start: 'top 85%', once: true } });
      gsap.from('.reviews__branch', { yPercent: 20, rotation: 14, ease: 'none', scrollTrigger: { trigger: '.reviews', start: 'top bottom', end: 'bottom top', scrub: true } });
      gsap.to('.book__branch', { yPercent: -40, ease: 'none', scrollTrigger: { trigger: '.book', start: 'top bottom', end: 'bottom top', scrub: true } });

      /* footer : grand nom lettre par lettre */
      const fchars = splitChars($('.foot__brand'));
      gsap.from(fchars, { yPercent: 110, duration: 1.6, ease: 'expo.out', stagger: .07, scrollTrigger: { trigger: '.foot__brand', start: 'top 95%', once: true } });

      return () => undo.forEach((fn) => fn());
    });
  }

  /* ----------------------------------------------------------
     Lenis
     ---------------------------------------------------------- */
  function initLenis() {
    if (!window.Lenis) return;
    lenis = new window.Lenis({ duration: 1.15, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)), smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }

  /* ----------------------------------------------------------
     Démarrage
     ---------------------------------------------------------- */
  function start() {
    initStatus();
    initBooking();
    initMenu();
    initAnchors();
    initVideo();

    if (!hasGsap) {
      root.classList.remove('is-loading');
      root.classList.add('no-gsap');
      initReviews();
      return;
    }

    if (reduce) {
      root.classList.remove('is-loading');
      initReviews();
      return;
    }

    gsap.registerPlugin(ScrollTrigger);
    $$('.story__img img, .card__img').forEach((img) => { img.loading = 'eager'; });
    initLenis();
    if (lenis) lenis.stop();
    splitChars($('.hero__title'));
    gsap.set($$('.hero__title .sc__i'), { yPercent: 118 });
    initReviews();
    initMarquees();
    initPointerFx();
    initScroll();

    const refresh = () => ScrollTrigger.refresh();
    addEventListener('load', refresh);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);

    runLoader();
    // le hero démarre quand le rideau commence à monter ; le scroll est rendu à ce moment
    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      clearInterval(wait);
      root.classList.remove('is-loading');
      if (lenis) lenis.start();
      ScrollTrigger.refresh();
      heroIntro();
    };
    const wait = setInterval(() => { if (!root.classList.contains('is-loading')) begin(); }, 60);
    // filet de sécurité si le préchargeur n’aboutit pas
    setTimeout(() => { const l = $('.loader'); if (l) l.style.display = 'none'; begin(); }, 9000);
  }

  start();
})();
