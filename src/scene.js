// The scene on the start page: one visitor, one domain, two servers. Packets take the public route to the live server,
// then the rule to the new one. The scene shows the user's own domain rules, one after the other, and what is typed in
// the Domains form while it is typed: the domain above the visitor, the IP on the new server, the route to that server.
// Decoration only. Without WebGL the start page stays as it was (and loads nothing extra). The scene only exists while
// the start page is shown; a tab with a website takes it down.
const THREE_URL = './vendor/three-r160.module.min.js';
const C = { blue: 0x2e90fa, green: 0x12b76a, line: 0xaab6c6, soft: 0xd9e1ec, white: 0xffffff };
// Motion is per second, not per frame: a fast display does not make a fast scene.
const DEFAULT_DOMAIN = 'example.com', DEFAULT_IP = '203.0.113.10', SWITCH_EVERY_S = 5.2, PACKETS = 6, PACKET_LAPS_PER_S = 0.19, STILL_AT_S = 2.2, MAX_STEP_S = 0.05;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/, IPV6 = /^[0-9a-f:]{3,39}$/i;
const host = document.getElementById('scene'), welcome = document.getElementById('welcome');
const clamp01 = value => Math.min(1, Math.max(0, value));
// Only the form of an open Domains panel counts: a closed panel can still hold half a rule.
let THREE = null, loading = null, stop = null, rules = [], formOpen = false, gone = false;
const field = id => (formOpen ? document.getElementById(id)?.value || '' : '').trim();
const typedDomain = () => field('domain-input').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').slice(0, 40);
const typedIP = () => { const ip = field('ip-input'); return IPV4.test(ip) || (ip.includes(':') && IPV6.test(ip)) ? ip : ''; };
// The user can stop the motion with the button in the corner of the scene. The choice is kept for the next start.
const PAUSE_KEY = 'dioptra-scene-paused', pauseButton = document.getElementById('scene-pause');
let paused = (() => { try { return localStorage.getItem(PAUSE_KEY) === '1'; } catch { return false; } })();
function showPause() { pauseButton.classList.toggle('paused', paused); pauseButton.querySelector('span').textContent = paused ? 'Play animation' : 'Pause animation'; }
// Asked once, and the context of the question is handed back at once: a page may only hold a few.
const canDraw = (() => { try { const probe = document.createElement('canvas'), gl = probe.getContext('webgl2') || probe.getContext('webgl'); gl?.getExtension('WEBGL_lose_context')?.loseContext(); return Boolean(gl); } catch { return false; } })();

// The stage: renderer, camera, size, pointer, text labels that follow a point of the scene, and one render loop. The loop
// rests while there is nothing to see (window hidden, no room, paused, less motion asked); a scene that stands still
// draws one frame when something changes.
function stage({ fov, distance }) {
  host.querySelector('canvas').replaceWith(document.createElement('canvas'));
  const canvas = host.querySelector('canvas'), labels = host.querySelector('.labels');
  canvas.setAttribute('aria-hidden', 'true');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100), size = { w: 0, h: 0 }, pointer = { x: 0, y: 0 };
  const motion = matchMedia('(prefers-reduced-motion: reduce)'), still = () => reduce || paused;
  let reduce = motion.matches, draw = () => {}, alive = true, raf = 0, last = 0, elapsed = reduce ? STILL_AT_S : 0;
  // One frame. step is the time since the last one; 0 redraws without moving on.
  const frame = step => { draw(elapsed, step, still()); renderer.render(scene, camera); };
  const tick = now => {
    raf = 0;
    if (!alive || still() || document.hidden || !size.w) return; // rests until wake()
    // The first frame after a rest has no frame before it. Both times come from the same clock, the one of the frames.
    const step = last ? Math.min(MAX_STEP_S, Math.max(0, (now - last) / 1000)) : 0; last = now; elapsed += step;
    frame(step); raf = requestAnimationFrame(tick);
  };
  // Something changed (the size, the window is back, the pause button, a rule, the form): show it, and run if the scene may run.
  const wake = () => {
    if (!alive || !size.w || document.hidden) return;
    if (still()) return frame(0);
    if (!raf) { last = 0; raf = requestAnimationFrame(tick); }
  };
  // On a narrow stage the camera steps back, so the whole composition (made for about 1.7 to 1) stays in view.
  const fit = () => {
    const box = host.getBoundingClientRect();
    size.w = box.height ? box.width : 0; size.h = box.height; // no size: the style sheet hides the scene for lack of room
    if (!size.w) return;
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h; camera.position.z = distance * Math.max(1, 1.7 / camera.aspect); camera.updateProjectionMatrix();
    frame(0); wake(); // a resized canvas is empty until it is drawn again
  };
  const observer = new ResizeObserver(fit);
  const onMove = event => { const box = host.getBoundingClientRect(); pointer.x = clamp01((event.clientX - box.left) / box.width) * 2 - 1; pointer.y = -(clamp01((event.clientY - box.top) / box.height) * 2 - 1); };
  // A graphics driver that gives up is not asked again: the start page goes back to its three notes.
  const onLost = () => { gone = true; unmount(); };
  const onMotion = event => { reduce = event.matches; pauseButton.hidden = reduce; cancelAnimationFrame(raf); raf = 0; wake(); };
  const WAKE_ON = ['visibilitychange', 'input', 'dioptra:state'];
  window.addEventListener('pointermove', onMove, { passive: true });
  canvas.addEventListener('webglcontextlost', onLost);
  for (const type of WAKE_ON) document.addEventListener(type, wake);
  pauseButton.addEventListener('click', wake);
  motion.addEventListener('change', onMotion);
  pauseButton.hidden = reduce; // already still: nothing to pause
  const point = new THREE.Vector3();
  return {
    scene, camera, pointer,
    label(text, kind = '') { const node = document.createElement('span'); node.className = `tag3d ${kind}`; node.textContent = text; labels.append(node); return node; },
    // Puts a label at the place on screen where a point of the scene is.
    pin(node, object) { object.getWorldPosition(point).project(camera); node.style.transform = `translate(${(point.x * 0.5 + 0.5) * size.w}px,${(-point.y * 0.5 + 0.5) * size.h}px) translate(-50%,-50%)`; },
    run(fn) { draw = fn; observer.observe(host); fit(); },
    stop() {
      alive = false; cancelAnimationFrame(raf); observer.disconnect();
      window.removeEventListener('pointermove', onMove); canvas.removeEventListener('webglcontextlost', onLost);
      for (const type of WAKE_ON) document.removeEventListener(type, wake);
      pauseButton.removeEventListener('click', wake);
      motion.removeEventListener('change', onMotion);
      labels.replaceChildren();
      scene.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); });
      renderer.dispose(); renderer.forceContextLoss(); // hands the WebGL context back now instead of when the garbage collector gets to it
    },
  };
}
// A box drawn the way the rest of Dioptra is drawn: white faces, thin lines.
function wireBox(w, h, d) {
  const group = new THREE.Group(), geometry = new THREE.BoxGeometry(w, h, d);
  group.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: C.white, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
  group.add(new THREE.LineSegments(new THREE.EdgesGeometry(geometry), new THREE.LineBasicMaterial({ color: C.line })));
  return group;
}

function build(s) {
  const world = new THREE.Group(), TILT = 0.5, TURN = -0.42, LIFT = 0.15;
  s.scene.add(world); world.rotation.set(TILT, TURN, 0); world.position.set(0.25, LIFT, 0);
  // Floor of faint dots.
  const dots = []; for (let x = -6; x <= 6; x += 0.75) for (let z = -3; z <= 3; z += 0.75) dots.push(x, 0, z);
  world.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(dots, 3)), new THREE.PointsMaterial({ color: C.soft, size: 2.2, sizeAttenuation: false })));
  // The visitor: a browser window standing up.
  const visitor = new THREE.Group(), screen = wireBox(1.7, 1.1, 0.06), foot = wireBox(0.5, 0.05, 0.3), neck = wireBox(0.08, 0.2, 0.05);
  screen.position.y = 0.78; foot.position.y = 0.025; neck.position.y = 0.12;
  visitor.add(screen, foot, neck, new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.85, 1.12, 0.035), new THREE.Vector3(0.85, 1.12, 0.035)]), new THREE.LineBasicMaterial({ color: C.line })));
  visitor.position.set(-4.3, 0, 0.3); visitor.rotation.y = 0.5; world.add(visitor);
  // A server: three slabs with a light each.
  const server = color => {
    const group = new THREE.Group(), lights = [], top = new THREE.Object3D();
    for (let level = 0; level < 3; level++) {
      const slab = wireBox(1.35, 0.26, 0.95), light = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), new THREE.MeshBasicMaterial({ color }));
      slab.position.y = 0.16 + level * 0.34; light.position.set(-0.5, 0.16 + level * 0.34, 0.48);
      group.add(slab, light); lights.push(light);
    }
    top.position.y = 1.5; group.add(top); group.userData = { lights, top };
    return group;
  };
  const live = server(C.green), fresh = server(C.blue);
  live.position.set(3.9, 0, -1.9); fresh.position.set(3.9, 0, 1.9); world.add(live, fresh);
  // The two routes share their first stretch, up to the fork.
  const fork = new THREE.Vector3(-1.5, 0.04, 0.3);
  const path = to => new THREE.CatmullRomCurve3([new THREE.Vector3(-3.5, 0.04, 0.3), fork, new THREE.Vector3(0.6, 0.04, to.z * 0.55), new THREE.Vector3(2.2, 0.04, to.z), new THREE.Vector3(3.15, 0.04, to.z)], false, 'catmullrom', 0.35);
  const curves = { live: path(live.position), fresh: path(fresh.position) }, lines = {};
  for (const key of ['live', 'fresh']) { lines[key] = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curves[key].getPoints(90)), new THREE.LineBasicMaterial({ color: C.line, transparent: true })); world.add(lines[key]); }
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshBasicMaterial({ color: C.white })), knotRing = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 40), new THREE.MeshBasicMaterial({ color: C.line }));
  knot.position.copy(fork); knotRing.position.copy(fork); knotRing.rotation.x = Math.PI / 2; world.add(knot, knotRing);
  const packets = Array.from({ length: PACKETS }, (_, index) => { const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.075, 14, 10), new THREE.MeshBasicMaterial({ color: C.green, transparent: true })); world.add(mesh); return { mesh, at: index / PACKETS, route: 'live' }; });
  // Labels, in the fonts of the page.
  const tags = { domain: s.label(DEFAULT_DOMAIN, 'name'), rule: s.label('Public DNS', 'green'), live: s.label('Live', 'green'), fresh: s.label('New server', 'blue') };
  const above = new THREE.Object3D(), atFork = new THREE.Object3D();
  above.position.set(0, 1.72, 0); visitor.add(above); atFork.position.copy(fork).setY(0.75); world.add(atFork);
  const colors = { live: new THREE.Color(C.green), fresh: new THREE.Color(C.blue), idle: new THREE.Color(C.line) };
  let route = 'live', sinceSwitch = 0, turn = 0, shown = '';
  s.run((time, step, still) => {
    // How far a value moves to its target in this frame. A scene that stands still jumps there: nothing will ease it later.
    const ease = rate => still ? 1 : 1 - (1 - rate) ** (step * 60);
    sinceSwitch += step; if (sinceSwitch > SWITCH_EVERY_S) { turn++; sinceSwitch = 0; }
    // What is being typed comes first, then the user's own rules in turn. Without either the scene shows the example.
    const domainTyped = typedDomain(), ipTyped = typedIP(), rule = domainTyped || ipTyped || !rules.length ? null : rules[turn % rules.length];
    const domain = domainTyped || rule?.domain || DEFAULT_DOMAIN, ip = ipTyped || rule?.ip || '';
    // With an IP the rule is on. Without one the scene shows both routes, one after the other.
    route = ip || turn % 2 ? 'fresh' : 'live';
    const state = `${domain}|${ip}|${route}`;
    if (state !== shown) {
      shown = state; tags.domain.textContent = domain;
      tags.rule.textContent = route === 'fresh' ? `Rule → ${ip || DEFAULT_IP}` : 'Public DNS'; tags.rule.className = `tag3d ${route === 'fresh' ? 'blue' : 'green'}`;
      tags.fresh.textContent = ip ? `New server · ${ip}` : 'New server';
      tags.live.classList.toggle('dim', route !== 'live'); tags.fresh.classList.toggle('dim', route !== 'fresh');
      knotRing.material.color.copy(colors[route]);
    }
    for (const key of ['live', 'fresh']) { lines[key].material.color.lerp(key === route ? colors[key] : colors.idle, ease(0.08)); lines[key].material.opacity += ((key === route ? 1 : 0.55) - lines[key].material.opacity) * ease(0.08); }
    for (const [group, key] of [[live, 'live'], [fresh, 'fresh']]) group.userData.lights.forEach((light, index) => { light.material.color.copy(key === route ? colors[key] : colors.idle); light.scale.setScalar(key === route ? 1 + 0.35 * Math.max(0, Math.sin(time * 5 + index * 1.7)) : 1); });
    for (const packet of packets) {
      const before = packet.at; packet.at = (packet.at + PACKET_LAPS_PER_S * step) % 1;
      if (packet.at < before || still) packet.route = route; // a new packet takes the route of this moment
      packet.mesh.position.copy(curves[packet.route].getPointAt(packet.at)).setY(0.16);
      packet.mesh.material.color.copy(colors[packet.route]); packet.mesh.material.opacity = Math.min(1, packet.at * 12, (1 - packet.at) * 12);
    }
    world.rotation.y += ((TURN + s.pointer.x * 0.07) - world.rotation.y) * ease(0.05); world.rotation.x += ((TILT - s.pointer.y * 0.04) - world.rotation.x) * ease(0.05);
    world.position.y = LIFT + Math.sin(time * 0.7) * 0.04;
    world.updateMatrixWorld(true);
    s.pin(tags.domain, above); s.pin(tags.rule, atFork); s.pin(tags.live, live.userData.top); s.pin(tags.fresh, fresh.userData.top);
  });
}
function routes() {
  const s = stage({ fov: 26, distance: 15.5 });
  try { build(s); } catch (error) { s.stop(); throw error; } // half a scene leaves nothing running
  return s.stop;
}

// The scene lives on the start page and is taken down as soon as that page is not shown (a website, Compare, an error).
function unmount() { stop?.(); stop = null; welcome.classList.remove('has-scene'); }
async function sync() {
  if (gone || welcome.hidden) return unmount();
  if (stop) return; // already there
  try {
    THREE ??= await (loading ??= import(THREE_URL));
    if (stop || gone || welcome.hidden) return; // the page changed while three.js loaded
    welcome.classList.add('has-scene');
    stop = routes();
  } catch { gone = true; unmount(); } // three.js could not start: the start page stays as it was, and it is not tried again
}
if (host && canDraw) {
  pauseButton.onclick = () => { paused = !paused; try { localStorage.setItem(PAUSE_KEY, paused ? '1' : '0'); } catch { /* no storage: the choice holds until the app closes */ } showPause(); };
  showPause();
  const update = state => { rules = (state?.rules || []).filter(rule => rule.enabled); formOpen = state?.panel === 'domains'; sync(); };
  // renderer.js sends this after every render, with the state it rendered. This file loads after the first render, so it asks once itself.
  document.addEventListener('dioptra:state', event => update(event.detail));
  window.browser.command('state').then(result => { if (result.ok) update(result.state); });
}
