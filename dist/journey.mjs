const clamp = (v, min = 0, max = 1) => Math.max(min, Math.min(max, v));
const ease = t => ((t = clamp(t)), t * t * (3 - 2 * t));
const lerp = (a, b, t) => a + (b - a) * t;

const AUTO_ORBIT_SPEED = 0.42; // rad/s — smooth continuous 360° showcase (~15s/rev)

function layout(active, count, verdict, narrow, rotation, spread = 0, ambientSpin = 0) {
  const baseGap = narrow ? 3.35 : 4.25;
  const gap = lerp(baseGap, narrow ? 3.85 : 4.95, spread);
  const all = [0, 1, 2];
  const sides = all.filter(i => i !== active);
  return all.map(i => {
    const primary = i === active;
    const side = sides.indexOf(i) === 0 ? -1 : 1;
    const pass = verdict?.[i];
    const verdictY = pass === true ? 0.24 : pass === false ? -0.28 : 0;
    const heroScale = primary ? 1.16 : count === 2 ? 0.66 : 0.6;
    const compareScale = count === 1 ? (primary ? 1.05 : 0) : 0.86;
    const sideOrbit = lerp(side * -0.38, side * -0.14, spread) + ambientSpin * 0.35;
    return {
      x: primary ? 0 : side * gap,
      y: verdictY,
      z: primary ? lerp(1.55, 0.25, spread) : lerp(-1.65, 0.05, spread),
      angle: primary ? rotation : sideOrbit,
      scale: i >= count ? 0 : lerp(heroScale, compareScale, spread),
      tone: pass === false ? 0.28 : 1,
      primary,
      pass,
    };
  });
}

const NUMERIC_KEYS = ['x', 'y', 'z', 'angle', 'scale', 'tone'];
const blend = (a, b, t) =>
  a.map((item, i) => {
    const out = { ...b[i] };
    for (const key of NUMERIC_KEYS) out[key] = lerp(item[key], b[i][key], t);
    return out;
  });

export function mountJourney(onPick) {
  const host = document.querySelector('#opening');
  const view = document.querySelector('#scene');
  const canvas = document.querySelector('#lodge-canvas');
  const button = document.querySelector('#opening-skip');
  const replay = document.querySelector('#replay-opening');
  const rotate = document.querySelector('#turn-lodge');
  const hint = document.querySelector('#orbit-hint');
  const stepReadout = document.querySelector('#opening-step');
  const introPicks = [...document.querySelectorAll('.opening-prices [data-pick]')];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');

  if (!host || !view || !canvas) return null;

  let engine = null;
  let failed = false;
  let lost = false;
  let playing = false;
  let visible = true;
  let frame = 0;
  let start = 0;
  let lastTick = 0;
  let changed = 0;
  let runs = 0;
  let deadline = 0;

  let spinAngle = 0;
  let manualOffset = 0;
  let targetOffset = 0;
  let spread = 0;
  let targetSpread = 0;
  let parallaxX = 0;
  let parallaxY = 0;
  let targetParallaxX = 0;
  let targetParallaxY = 0;

  let current = { active: 0, count: 3, verdict: null, demo: true };
  let previous = null;
  const duration = 4200;

  // Defer loading Three.js & GLB assets until after first paint so the UI is instant
  const readyPromise = new Promise(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  })
    .then(() => import('./scene3d.mjs'))
    .then(mod => mod.createScene(canvas, wake))
    .then(scene => {
      engine = scene;
      if (!lost) {
        view.dataset.renderer = 'three-pbr';
        view.classList.add('webgl-ready');
        rotate.hidden = false;
        if (hint) hint.hidden = false;
        offerReplay();
        lastTick = 0;
        wake();
      }
      return scene;
    })
    .catch(() => {
      failed = true;
      finish();
      offerReplay();
      return null;
    });

  function offerReplay() {
    replay.hidden = failed || lost || motion.matches || !engine || !current.demo;
  }

  function move(toOpening) {
    const newHost = toOpening ? document.querySelector('#opening-art') : view;
    if (canvas.parentNode !== newHost) newHost.append(canvas);
  }

  function wake() {
    if (!frame && !document.hidden && engine && (playing || visible) && !lost) {
      frame = requestAnimationFrame(draw);
    }
  }

  function setIntroHighlight(index) {
    introPicks.forEach((el, idx) => el.classList.toggle('current', idx === index));
  }

  function draw(now) {
    frame = 0;
    if (!engine || lost) return;
    if (playing && !start) return;

    const dt = lastTick ? Math.min(0.06, Math.max(0, (now - lastTick) * 0.001)) : 0.016;
    lastTick = now;

    if (!motion.matches) {
      spinAngle = (spinAngle + dt * AUTO_ORBIT_SPEED) % (Math.PI * 200);
      manualOffset += (targetOffset - manualOffset) * 0.14;
      spread += (targetSpread - spread) * 0.12;
      parallaxX += (targetParallaxX - parallaxX) * 0.1;
      parallaxY += (targetParallaxY - parallaxY) * 0.1;
    } else {
      manualOffset = targetOffset;
      spread = targetSpread;
      parallaxX = 0;
      parallaxY = 0;
    }

    const totalAngle = spinAngle + manualOffset;
    const aspect = Math.max(0.5, canvas.clientWidth / Math.max(1, canvas.clientHeight));
    const narrow = aspect < 1.45;
    const baseDistance = narrow ? Math.max(9.6, 15.2 - 3.2 * aspect) : 9.2;

    let items, eye, target, warmth, zoom;

    if (playing) {
      const p = clamp((now - start) / duration);
      const travel = ease(p / 0.54);
      const fan = ease((p - 0.32) / 0.58);
      const end = layout(0, 3, null, narrow, totalAngle, 0, spinAngle);
      items = end.map((item, i) =>
        i === 0
          ? { ...item, z: lerp(0.55, item.z, fan), angle: totalAngle - (1 - travel) * 0.55 }
          : {
              ...item,
              x: item.x * fan,
              y: lerp(-0.85, 0, fan),
              z: lerp(-2.4, item.z, fan),
              scale: item.scale * fan,
              angle: item.angle * fan + spinAngle * 0.25,
            }
      );
      eye = [
        lerp(3.1, 0.14, travel),
        lerp(2.2, 3.65, fan),
        lerp(narrow ? 6.8 : 5.8, baseDistance, fan),
      ];
      target = [0, lerp(1.1, 0.95, fan), lerp(0.45, 1.05, fan)];
      warmth = lerp(0.38, 0.94, ease(p));
      zoom = lerp(1.22, narrow ? 1.26 : 1.44, fan);

      host.style.setProperty('--chapter', p);
      if (p >= 0.22) host.classList.add('copy-ready');
      if (p >= 0.52) host.classList.add('choices-visible');
      if (stepReadout) {
        stepReadout.textContent =
          p < 0.36 ? '01 · ARRIVING IN ASHEVILLE' : p < 0.72 ? '02 · THREE PRIVATE QUOTES' : '03 · READY TO COMPARE';
      }
      if (introPicks.length === 3 && p >= 0.52) {
        const spotlight = p < 0.68 ? 0 : p < 0.84 ? 1 : 0;
        setIntroHighlight(spotlight);
      }
      if (p >= 1) {
        setIntroHighlight(0);
        finish();
        return;
      }
    } else {
      const next = layout(current.active, current.count, current.verdict, narrow, totalAngle, spread, spinAngle);
      const t = previous ? ease((now - changed) / 620) : 1;
      items = previous && t < 1 ? blend(previous, next, t) : next;
      if (t >= 1) previous = null;

      const distance = lerp(baseDistance, baseDistance + (narrow ? 4.4 : 4.2), spread);
      eye = [
        0.14 + parallaxX * 0.9,
        lerp(3.65, 5.85, spread) + parallaxY * 0.45,
        distance,
      ];
      target = [0, lerp(0.95, 0.62, spread), lerp(1.05, 0.08, spread)];
      warmth = 0.94;
      zoom = narrow ? 1.26 : 1.44;
    }

    engine.draw({ eye, target, aspect, zoom }, items, warmth, now * 0.001, motion.matches);

    const settling =
      Math.abs(targetOffset - manualOffset) > 0.001 ||
      Math.abs(targetSpread - spread) > 0.001;

    if (!motion.matches || playing || previous || settling) {
      wake();
    }
  }

  function finish(focus = false) {
    if (!playing && !host.open) return;
    clearTimeout(deadline);
    const origin = canvas.getBoundingClientRect();
    playing = false;
    canvas.classList.remove('waiting');
    host.close();
    move(false);
    if (!focus) document.querySelector('#headline')?.focus({ preventScroll: true });
    const destination = canvas.getBoundingClientRect();
    if (!focus && !lost && engine && !motion.matches && destination.width && destination.height) {
      const shiftX = (origin.width - destination.width) / 2 + origin.left - destination.left;
      const shiftY = (origin.height - destination.height) / 2 + origin.top - destination.top;
      canvas.animate(
        [
          { opacity: 0.76, transform: `translate(${shiftX * 0.12}px,${shiftY * 0.12}px) scale(1.08)` },
          { opacity: 1, transform: 'none' },
        ],
        { duration: 560, easing: 'cubic-bezier(.18,.7,.25,1)' }
      );
    }
    if (focus) document.querySelector('#headline')?.focus({ preventScroll: true });
    offerReplay();
    wake();
  }

  function play() {
    if (motion.matches || lost || failed || !current.demo) return;
    cancelAnimationFrame(frame);
    frame = 0;
    playing = true;
    start = 0;
    lastTick = 0;
    host.classList.remove('choices-visible', 'copy-ready');
    host.style.setProperty('--chapter', 0);
    setIntroHighlight(0);
    if (stepReadout) stepReadout.textContent = '01 · ARRIVING IN ASHEVILLE';
    move(true);
    host.showModal();
    clearTimeout(deadline);
    button.focus({ preventScroll: true });

    const run = ++runs;
    const begin = () => {
      if (!playing || run !== runs) return;
      if (!engine || failed) {
        finish();
        return;
      }
      canvas.classList.remove('waiting');
      start = performance.now();
      lastTick = start;
      deadline = setTimeout(finish, duration + 450);
      wake();
    };
    if (engine) return begin();
    canvas.classList.add('waiting');
    Promise.race([readyPromise, new Promise(resolve => setTimeout(resolve, 1400))]).then(begin);
  }

  button.onclick = () => {
    finish(true);
    document.querySelector('#decision-title')?.focus();
  };
  host.addEventListener('cancel', event => {
    event.preventDefault();
    finish(true);
  });
  introPicks.forEach(card => {
    card.addEventListener('click', () => {
      const idx = Number(card.dataset.pick);
      finish(false);
      const targetBtn = document.querySelectorAll('#quote-select button')[idx];
      targetBtn?.click();
      targetBtn?.focus({ preventScroll: true });
    });
  });

  replay.onclick = play;
  rotate.onclick = () => {
    targetOffset += Math.PI / 3;
    if (motion.matches) manualOffset = targetOffset;
    wake();
  };

  // Gentle pointer parallax + 3D island hover/click picking while auto-rotation runs continuously
  view.addEventListener('pointermove', event => {
    if (!engine || lost || playing) return;
    const box = view.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const nx = (event.clientX - box.left) / box.width;
    const ny = (event.clientY - box.top) / box.height;
    if (event.pointerType === 'mouse') {
      const hit = engine.pick?.(nx * 2 - 1, 1 - ny * 2) ?? -1;
      view.style.cursor = hit >= 0 && hit !== current.active ? 'pointer' : '';
      if (!motion.matches) {
        targetParallaxX = (nx - 0.5) * 1.5;
        targetParallaxY = (0.5 - ny) * 1.5;
        wake();
      }
    }
  });
  view.addEventListener('click', event => {
    if (!engine || lost || playing || !onPick) return;
    const box = view.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const nx = (event.clientX - box.left) / box.width;
    const ny = (event.clientY - box.top) / box.height;
    const hit = engine.pick?.(nx * 2 - 1, 1 - ny * 2) ?? -1;
    if (hit >= 0 && hit < current.count && hit !== current.active) {
      onPick(hit);
    }
  });
  view.addEventListener('pointerleave', () => {
    view.style.cursor = '';
    targetParallaxX = 0;
    targetParallaxY = 0;
  });

  const resize = new ResizeObserver(() => {
    lastTick = 0;
    wake();
  });
  resize.observe(view);
  resize.observe(document.querySelector('#opening-art'));

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) {
      lastTick = 0;
      wake();
    }
  });
  observer.observe(view);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else {
      lastTick = 0;
      wake();
    }
  });

  motion.addEventListener('change', () => {
    if (motion.matches) {
      previous = null;
      finish();
    }
    lastTick = 0;
    offerReplay();
    wake();
  });

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    lost = true;
    finish();
    view.classList.remove('webgl-ready');
    if (hint) hint.hidden = true;
    offerReplay();
    rotate.hidden = true;
  });

  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    lastTick = 0;
    if (engine) {
      view.classList.add('webgl-ready');
      rotate.hidden = false;
      if (hint) hint.hidden = false;
      offerReplay();
      wake();
    }
  });

  return {
    set(state) {
      const narrow = canvas.clientWidth / Math.max(1, canvas.clientHeight) < 1.45;
      const totalAngle = spinAngle + manualOffset;
      previous = motion.matches
        ? null
        : layout(current.active, current.count, current.verdict, narrow, totalAngle, spread, spinAngle);
      if (current.active !== state.active) {
        manualOffset = 0;
        targetOffset = 0;
      }
      current = state;
      changed = performance.now();
      offerReplay();
      wake();
    },
    setScroll(progress) {
      targetSpread = clamp(progress);
      if (motion.matches) spread = targetSpread;
      wake();
    },
    start() {
      if (motion.matches || !current.demo) {
        wake();
        return;
      }
      let seen = false;
      try {
        seen = sessionStorage.getItem('inbudget-opening-v1') === 'seen';
        sessionStorage.setItem('inbudget-opening-v1', 'seen');
      } catch {}
      if (!seen && !location.hash) play();
      else wake();
    },
  };
}
