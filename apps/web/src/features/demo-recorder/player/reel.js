/* SpendBoard demo reel player — embedded verbatim in every exported reel. Plain ES2019, no dependencies.
   Data: <script id="reel-data" type="application/json">{ title, subtitle, titleCard, scenes: [{ title, caption,
   shots: [{ src, w, h, ms, from: {s, x, y}, to: {s, x, y} }] }] }</script> */
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('reel-data').textContent);
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (id) { return document.getElementById(id); };
  var reel = $('reel'), stage = $('stage'), track = $('track'), label = $('label'), playBtn = $('play');
  var caption = $('caption'), titleCard = $('titlecard'), replay = $('replay');

  // ---------------------------------------------------------------- timeline
  var steps = [];
  if (data.titleCard) steps.push({ kind: 'title', scene: -1, ms: 3500 });
  data.scenes.forEach(function (scene, si) {
    scene.shots.forEach(function (shot, hi) {
      steps.push({ kind: 'shot', scene: si, first: hi === 0, shot: shot, ms: shot.ms });
    });
  });
  var segs = steps.map(function (step) {
    var seg = document.createElement('div');
    seg.className = 'seg' + (step.kind === 'title' || step.first ? ' scene-start' : '');
    seg.style.flex = String(step.ms);
    seg.appendChild(document.createElement('i'));
    seg.title = step.kind === 'title' ? data.title : 'Scene ' + (step.scene + 1) + ': ' + data.scenes[step.scene].title;
    track.appendChild(seg);
    return seg;
  });

  // ---------------------------------------------------------------- camera
  // A view {s: scale, x, y: focus point 0–1}; the focus is centred as far as the zoom allows, so the
  // image always fills its frame (no empty edges).
  function clamp(v, lim) { return Math.max(-lim, Math.min(lim, v)); }
  function transform(v) {
    var lim = (1 - 1 / v.s) / 2;
    return 'scale(' + v.s + ') translate(' + (clamp(0.5 - v.x, lim) * 100).toFixed(3) + '%,' + (clamp(0.5 - v.y, lim) * 100).toFixed(3) + '%)';
  }

  // Two image layers cross-fade; each is sized to its image's aspect ratio inside the stage
  var layers = [0, 1].map(function () {
    var el = document.createElement('div');
    el.className = 'layer';
    var img = document.createElement('img');
    img.alt = '';
    el.appendChild(img);
    stage.insertBefore(el, titleCard);
    return { el: el, img: img, w: 1, h: 1, anim: null };
  });
  var front = 0;

  function fit(layer) {
    var W = stage.clientWidth, H = stage.clientHeight;
    var k = Math.min(W / layer.w, H / layer.h);
    var w = Math.round(layer.w * k), h = Math.round(layer.h * k);
    layer.el.style.width = w + 'px';
    layer.el.style.height = h + 'px';
    layer.el.style.marginLeft = -w / 2 + 'px';
    layer.el.style.marginTop = -h / 2 + 'px';
  }
  window.addEventListener('resize', function () { layers.forEach(fit); });

  // ---------------------------------------------------------------- playback
  var index = -1, playing = false, ended = false, anim = null, token = 0, shownScene = null;

  function setCaption(step) {
    var key = step.kind === 'title' ? -1 : step.scene;
    if (key === shownScene) return;
    shownScene = key;
    caption.classList.remove('on');
    setTimeout(function () {
      if (key !== shownScene) return;
      if (key < 0) return;
      var scene = data.scenes[key];
      caption.querySelector('.step').textContent = 'Scene ' + (key + 1) + ' of ' + data.scenes.length;
      caption.querySelector('h2').textContent = scene.title || 'Untitled scene';
      caption.querySelector('p').textContent = scene.caption || '';
      caption.classList.add('on');
    }, index === 0 ? 0 : 280);
  }

  function updateLabel() {
    var step = steps[index];
    label.textContent = step.kind === 'title' ? 'Intro' : 'Scene ' + (step.scene + 1) + ' / ' + data.scenes.length;
  }

  function show(i) {
    if (i < 0 || i >= steps.length) return;
    var my = ++token;
    index = i;
    ended = false;
    replay.classList.remove('on');
    var step = steps[i];
    segs.forEach(function (seg, k) { seg.classList.toggle('done', k < i); seg.firstChild.style.width = k < i ? '' : '0'; });
    updateLabel();
    setCaption(step);

    if (step.kind === 'title') {
      layers.forEach(function (l) { l.el.classList.remove('on'); });
      titleCard.classList.add('on');
      start(titleCard.animate([{ transform: 'scale(1)' }, { transform: reduced ? 'scale(1)' : 'scale(1.03)' }],
        { duration: step.ms, easing: 'ease-out', fill: 'both' }));
      return;
    }
    var next = layers[1 - front];
    if (next.anim) next.anim.cancel();
    next.w = step.shot.w; next.h = step.shot.h;
    fit(next);
    next.img.src = step.shot.src;
    var ready = next.img.decode ? next.img.decode().catch(function () {}) : Promise.resolve();
    ready.then(function () {
      if (my !== token) return;
      var from = reduced ? step.shot.to : step.shot.from;
      next.anim = next.img.animate([{ transform: transform(from) }, { transform: transform(step.shot.to) }],
        { duration: step.ms, easing: 'ease-in-out', fill: 'both' });
      titleCard.classList.remove('on');
      next.el.classList.add('on');
      layers[front].el.classList.remove('on');
      front = 1 - front;
      start(next.anim);
    });
  }

  function start(a) {
    anim = a;
    if (!playing) a.pause();
    a.onfinish = function () {
      if (a !== anim || !playing) return;
      if (index < steps.length - 1) show(index + 1);
      else finish();
    };
  }

  function finish() {
    setPlaying(false);
    ended = true;
    segs[index].classList.add('done');
    replay.classList.add('on');
  }

  function setPlaying(on) {
    playing = on;
    playBtn.innerHTML = on ? ICON.pause : ICON.play;
    playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play');
    if (anim) { if (on) anim.play(); else anim.pause(); }
    poke();
  }

  function togglePlay() {
    if (ended) { show(0); setPlaying(true); return; }   // play after the end starts over
    setPlaying(!playing);
  }

  // Progress of the current segment
  (function tick() {
    if (anim && index >= 0) {
      var t = anim.currentTime || 0, d = steps[index].ms;
      segs[index].firstChild.style.width = Math.min(100, (t / d) * 100) + '%';
    }
    requestAnimationFrame(tick);
  })();

  // ---------------------------------------------------------------- controls
  var ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5v2H6v3zm11-5h5v5h-2V6h-3zM6 15v3h3v2H4v-5zm12 0h2v5h-5v-2h3z"/></svg>',
    exit: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4V7h3V4zm6 0h2v3h3v2h-5zM4 15h5v5H7v-3H4zm11 0h5v2h-3v3h-2z"/></svg>',
  };
  $('prev').innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zm3.5 7L19 5.5v13z"/></svg>';
  $('next').innerHTML = '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM5 5.5L14.5 12 5 18.5z"/></svg>';
  var fullBtn = $('full');

  function step(delta) { show(Math.max(0, Math.min(steps.length - 1, index + delta))); }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (reel.requestFullscreen) reel.requestFullscreen();
  }
  document.addEventListener('fullscreenchange', function () {
    fullBtn.innerHTML = document.fullscreenElement ? ICON.exit : ICON.full;
    fullBtn.setAttribute('aria-label', document.fullscreenElement ? 'Exit full screen' : 'Full screen');
    setTimeout(function () { layers.forEach(fit); }, 50);
  });

  $('prev').onclick = function () { step(-1); };
  $('next').onclick = function () { step(1); };
  playBtn.onclick = togglePlay;
  fullBtn.onclick = toggleFull;
  replay.onclick = function () { show(0); setPlaying(true); };
  stage.onclick = function (e) { if (e.target !== replay) togglePlay(); };
  stage.ondblclick = toggleFull;
  track.onclick = function (e) {
    for (var k = 0; k < segs.length; k++) {
      var r = segs[k].getBoundingClientRect();
      if (e.clientX <= r.right + 2) { show(k); return; }
    }
  };
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key;
    if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (k === 'Home') show(0);
    else if (k === 'End') show(steps.length - 1);
    else if (k === 'f' || k === 'F') toggleFull();
    else return;
    poke();
  });

  // Controls fade out while playing and the pointer rests
  var idleTimer = null;
  function poke() {
    reel.classList.remove('idle');
    clearTimeout(idleTimer);
    if (playing) idleTimer = setTimeout(function () { reel.classList.add('idle'); }, 2600);
  }
  document.addEventListener('mousemove', poke);
  document.addEventListener('touchstart', poke, { passive: true });

  fullBtn.innerHTML = ICON.full;
  if (!steps.length) { label.textContent = 'Empty reel'; return; }
  show(0);
  setPlaying(true);
})();
