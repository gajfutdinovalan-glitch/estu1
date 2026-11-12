function initTrolleyScene() {
  const gate = document.getElementById('authGate');
  const views = [...document.querySelectorAll('.portable-maz-canvas')].map(canvas => {
    const auth = gate.contains(canvas);
    const root = auth ? gate : canvas.closest('.hero');
    const networkCanvas = root.querySelector('.portable-network-canvas');
    return {canvas, ctx: canvas.getContext('2d'), visible: false, scale: 1, auth, root, cache: null,
      networkCanvas, networkCtx: networkCanvas?.getContext('2d'), networkPlacement: null};
  });
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const images = {};
  const roofPivot = {x: 1000, y: 340};
  const wireY = 42;
  // Keep the existing rigid pole length when lowering the contact wire.
  const poleLength = Math.hypot(968, 312);
  const sourceBase = {x: 972, y: 208};
  const sourceTip = {x: 14, y: 11};
  const sourceRopeAnchor = {x: 43, y: 23};
  const sourcePoleLength = Math.hypot(sourceTip.x - sourceBase.x, sourceTip.y - sourceBase.y);
  const sourcePoleAngle = Math.atan2(sourceTip.y - sourceBase.y, sourceTip.x - sourceBase.x);
  const wheelCenter = {x: 627.207, y: 627.091};
  const wheelRadius = 622.6;
  const wheelDisplayRadius = 78 * .9 * 1.05;
  const networkWorldWidth = 1280;
  const workplaceNetwork = Object.freeze({scale: 1.1 * 1.3 / 1.2, drop: .2, wireY: 55});
  const networkSpeed = 235 * 1.05;
  const motionRate = 1.38;
  const rearAxleDelaySeconds = .8;
  const composition = Object.freeze({x: 64, y: 87.2, scale: .92, width: 2176, height: 900});
  const workplaceComposition = Object.freeze({...composition, y: 73});
  const mudflapSize = Object.freeze({width: 11, length: 36});
  let ready = false;
  let frame = 0;
  let previous = 0;
  let time = 0;

  function layout(view) {
    return view.auth ? composition : workplaceComposition;
  }
  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  function smoothContext(canvas) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  }
  function resample(image, width, height) {
    let source = image;
    while (source.width > width * 2) {
      const step = makeCanvas(Math.ceil(source.width / 2), Math.ceil(source.height / 2));
      smoothContext(step).drawImage(source, 0, 0, step.width, step.height);
      source = step;
    }
    const result = makeCanvas(width, height);
    smoothContext(result).drawImage(source, 0, 0, width, height);
    return result;
  }
  function drawFleetPlate(ctx) {
    const plate = {x: 1568, y: 491, width: 72, height: 32};
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#171717';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(plate.x + .75, plate.y + .75, plate.width - 1.5, plate.height - 1.5, 8);
    ctx.fill();
    ctx.stroke();
    ctx.font = '700 26px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#171717';
    const ink = ctx.measureText('2019');
    const baseline = plate.y + plate.height / 2 + (ink.actualBoundingBoxAscent - ink.actualBoundingBoxDescent) / 2;
    ctx.fillText('2019', plate.x + plate.width / 2, baseline);
    ctx.restore();
  }
  function prepare(view) {
    const composition = layout(view);
    const effectiveScale = view.scale * composition.scale;
    const ox = Math.round(composition.x * view.scale);
    const oy = Math.round(composition.y * view.scale);
    const body = makeCanvas(view.canvas.width, view.canvas.height);
    const ctx = smoothContext(body);
    ctx.setTransform(effectiveScale, 0, 0, effectiveScale, ox, oy);
    ctx.drawImage(images.body, 63, 346, 1922, 455, 63, 330, 1922, 455);
    // Cache the complete plate with the body so its fine rim never animates separately.
    drawFleetPlate(ctx);
    // The vehicle is supersampled; keep the independent wire at its existing display resolution.
    const networkRatio = view.networkPixelRatio / view.pixelRatio;
    const networkEffectiveScale = effectiveScale * networkRatio;
    const networkScale = view.auth ? 1 : workplaceNetwork.scale;
    const networkWidth = Math.max(1, Math.round(networkWorldWidth * networkEffectiveScale * networkScale));
    const networkHeight = Math.max(1, Math.round(networkWidth * 297 / 2042));
    const network = resample(images.network, networkWidth, networkHeight);
    const networkStep = Math.max(1, networkWidth - Math.round(2 * view.networkPixelRatio));
    const networkDrop = view.auth ? 0 : Math.round(networkHeight * workplaceNetwork.drop);
    const contactHeight = view.auth ? wireY : workplaceNetwork.wireY;
    const networkWirePixelY = Math.round(Math.round(composition.y * view.scale * networkRatio) + contactHeight * networkEffectiveScale) + networkDrop;
    const wirePixelY = networkWirePixelY / networkRatio;
    view.cache = {body, network, networkStep, effectiveScale, ox, oy, wirePixelY, networkEffectiveScale, networkWirePixelY,
      networkTop: networkWirePixelY - Math.round(networkHeight * 217 / 297)};
  }
  function drawWheel(ctx, x, y, angle, radius = wheelDisplayRadius) {
    const ratio = radius / wheelRadius;
    const imageX = -wheelCenter.x * ratio;
    const imageY = -wheelCenter.y * ratio;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(images.wheel, imageX, imageY, images.wheel.width * ratio, images.wheel.height * ratio);
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius * .59, 0, Math.PI * 2);
    ctx.clip();
    ctx.rotate(angle);
    ctx.drawImage(images.wheel, imageX, imageY, images.wheel.width * ratio, images.wheel.height * ratio);
    ctx.restore();
    ctx.restore();
  }
  function drawMudflap(ctx, flap) {
    ctx.save();
    ctx.translate(flap.x, flap.y);
    ctx.scale(mudflapSize.width / 16, mudflapSize.length / 51);
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(8, 0);
    ctx.bezierCurveTo(8, 18, 8 + flap.flex, 34, 7 + flap.flex, 48);
    ctx.quadraticCurveTo(flap.flex, 51, -7 + flap.flex, 48);
    ctx.bezierCurveTo(-8 + flap.flex, 32, -8, 16, -8, 0);
    ctx.closePath();
    ctx.fillStyle = '#050505';
    ctx.fill();
    ctx.restore();
  }
  function syncNetwork(view) {
    if (!view?.cache || !view.networkCanvas) return;
    const networkCanvas = view.networkCanvas;
    const box = view.canvas.getBoundingClientRect();
    const root = view.root.getBoundingClientRect();
    if (!box.width || !root.width) return;
    const density = view.networkPixelRatio;
    const left = Math.round(root.left * density) / density;
    const width = Math.max(1, Math.ceil(root.width * density));
    const height = view.cache.network.height;
    if (networkCanvas.width !== width) networkCanvas.width = width;
    if (networkCanvas.height !== height) networkCanvas.height = height;
    networkCanvas.style.left = `${left - root.left}px`;
    networkCanvas.style.width = `${width / density}px`;
    networkCanvas.style.top = `${Math.round(box.top * density + view.cache.networkTop) / density - root.top}px`;
    networkCanvas.style.height = `${height / density}px`;
    const wireTop = networkCanvas.getBoundingClientRect().top + (view.cache.networkWirePixelY - view.cache.networkTop) / density;
    view.networkPlacement = {density, originPixelX: Math.round((box.left - left) * density), width: root.width,
      wirePixelY: (wireTop - box.top) * view.pixelRatio};
  }
  function drawNetwork(view, t) {
    const cache = view.cache;
    const global = view.networkCtx && view.networkPlacement;
    const ctx = global ? view.networkCtx : view.ctx;
    const canvas = global ? view.networkCanvas : view.canvas;
    const origin = global ? view.networkPlacement.originPixelX : 0;
    const top = global ? 0 : cache.networkTop;
    const travel = t * networkSpeed * cache.networkEffectiveScale;
    const offset = ((travel - origin) % cache.networkStep + cache.networkStep) % cache.networkStep;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (global) ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let x = -offset - cache.networkStep; x < canvas.width; x += cache.networkStep) ctx.drawImage(cache.network, x, top);
    if (global) canvas.dataset.rendered = 'true';
    return offset;
  }
  function bumpAt(cycle, center, duration, amount) {
    const distance = (cycle - center) / duration;
    return Math.abs(distance) < 1 ? amount * (1 + Math.cos(Math.PI * distance)) / 2 : 0;
  }
  function wheelLiftsAt(t, axleDelay = rearAxleDelaySeconds) {
    const lift = delay => {
      const cycle = (((t * motionRate - delay) % 18) + 18) % 18;
      return bumpAt(cycle, 3.3, .6, -9) + bumpAt(cycle, 4.05, .5, 2)
        + bumpAt(cycle, 11.1, .68, -10.5) + bumpAt(cycle, 11.95, .55, 2.3);
    };
    // The front axle reaches each bump first; the rear follows along the same profile.
    return {front: lift(0), rear: lift(axleDelay * motionRate)};
  }
  function motionAt(t) {
    const progress = t * motionRate;
    const cycle = ((progress % 18) + 18) % 18;
    const stops = [[0, -36], [5.5, 22], [10, 34], [14, -12], [18, -36]];
    const next = stops.findIndex(point => point[0] > cycle);
    const [start, from] = stops[next - 1];
    const [end, to] = stops[next];
    const u = (cycle - start) / (end - start);
    const ease = u * u * u * (u * (u * 6 - 15) + 10);
    // Independent suspension pulses break up the old orbit; derivatives stay continuous at joins.
    const bob = 3.2 * Math.sin(progress * Math.PI * 2 / 3.6) + 1.4 * Math.sin(progress * Math.PI * 2 / 6)
      + bumpAt(cycle, 3.3, .9, -7) + bumpAt(cycle, 4.25, 1, 3.5)
      + bumpAt(cycle, 11.1, 1.15, -8) + bumpAt(cycle, 12.3, 1.1, 4);
    return {drift: (from + (to - from) * ease) * 1.35, bob: bob * 1.46};
  }
  function draw(view, t) {
    const {ctx, canvas} = view;
    if (!ctx || !view.cache) return;
    const cache = view.cache;
    const {effectiveScale: e, ox, oy} = cache;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Shared vehicle-relative coordinates keep the pole on its contact wire.
    const networkOffset = drawNetwork(view, t);
    const pose = motionAt(t);
    const dx = pose.drift * e;
    const dy = pose.bob * e;
    const drift = pose.drift;
    const bob = pose.bob;
    const base = {x: roofPivot.x + drift, y: roofPivot.y + bob};
    const contactWirePixelY = view.auth ? cache.wirePixelY : (view.networkPlacement?.wirePixelY ?? cache.wirePixelY);
    const canonicalWireY = (contactWirePixelY - oy) / e;
    const vertical = base.y - canonicalWireY;
    const tip = {x: base.x - Math.sqrt(poleLength ** 2 - vertical ** 2), y: canonicalWireY};
    const angle = Math.atan2(tip.y - base.y, tip.x - base.x) - sourcePoleAngle;
    const poleScale = poleLength / sourcePoleLength;

    const wheelAngle = t * Math.PI * 2 / 1.12;
    const wheelLifts = wheelLiftsAt(t);
    const wheelCenters = [{x: 628 + drift, y: 754 + bob + wheelLifts.rear}, {x: 1531 + drift, y: 754 + bob + wheelLifts.front}];
    const mudflaps = wheelCenters.map((wheel, index) => ({
      x: wheel.x - wheelDisplayRadius - 12,
      y: 776 + bob,
      flex: -3 + Math.sin(t * 7.5 + index * .8) * 2.2 + Math.sin(t * 12 + index * .8) * .9
        + (index === 0 ? wheelLifts.rear : wheelLifts.front) * .35
    }));
    // Rubber is body-mounted and sits behind the tyres and the original body artwork.
    ctx.save();
    ctx.setTransform(e, 0, 0, e, ox, oy);
    mudflaps.forEach(flap => drawMudflap(ctx, flap));
    ctx.restore();
    for (const wheel of wheelCenters) {
      ctx.save();
      ctx.translate(ox + wheel.x * e, oy + wheel.y * e);
      ctx.scale(e, e);
      drawWheel(ctx, 0, 0, wheelAngle);
      ctx.restore();
    }
    // Translate the native-resolution cache continuously; never rerasterize or scale its thin rims.
    ctx.drawImage(cache.body, dx, dy);

    // The pole is foreground hardware; it is painted above the completed body layer.
    ctx.save();
    ctx.setTransform(e, 0, 0, e, ox, oy);
    ctx.translate(base.x, base.y);
    ctx.rotate(angle);
    ctx.scale(poleScale, poleScale);
    ctx.drawImage(images.pole, -sourceBase.x, -sourceBase.y);
    ctx.restore();

    const rx = (sourceRopeAnchor.x - sourceBase.x) * poleScale;
    const ry = (sourceRopeAnchor.y - sourceBase.y) * poleScale;
    const ropeAnchor = {x: base.x + rx * Math.cos(angle) - ry * Math.sin(angle), y: base.y + rx * Math.sin(angle) + ry * Math.cos(angle)};
    const sway = Math.sin(t * 2.5) * 8 + Math.sin(t * 4.1) * 2;
    const holder = {x: 83 + drift, y: 396 + bob};
    ctx.save();
    ctx.setTransform(e, 0, 0, e, ox, oy);
    ctx.beginPath();
    ctx.moveTo(ropeAnchor.x, ropeAnchor.y);
    ctx.bezierCurveTo(ropeAnchor.x + sway, ropeAnchor.y + 100, holder.x + sway - 3, holder.y - 60, holder.x, holder.y);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
    canvas.dataset.rendered = 'true';
    view.geometry = {time: t, drift, bob, dx, dy, base, tip, poleLength, ropeAnchor, ropeHolder: holder, mudflaps, wheelCenters, wheelLifts, wheelRadius: wheelDisplayRadius, networkOffset, networkWorldWidth, networkSpeed};
  }
  function tick(now) {
    frame = 0;
    if (document.hidden || !views.some(view => view.visible)) { previous = 0; return; }
    if (previous) time += Math.min((now - previous) / 1000, .05);
    previous = now;
    views.filter(view => view.visible).forEach(view => draw(view, motion.matches ? 0 : time));
    if (!motion.matches) frame = requestAnimationFrame(tick);
  }
  function refresh() {
    gate.classList.toggle('scene-paused', document.hidden || gate.hidden);
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previous = 0;
    views.forEach(syncNetwork);
    if (ready && !document.hidden && views.some(view => view.visible)) frame = requestAnimationFrame(tick);
  }
  function size(view, width) {
    if (!width) return;
    const composition = layout(view);
    const displayPixelRatio = devicePixelRatio || 1;
    const pixelRatio = view.auth ? displayPixelRatio : Math.max(displayPixelRatio, Math.min(displayPixelRatio * 2, 4));
    // Integer CSS dimensions also avoid a fractional GPU texture at non-default zoom.
    let cssUnit = 1;
    while (cssUnit < 64 && Math.abs(cssUnit * displayPixelRatio - Math.round(cssUnit * displayPixelRatio)) > .000001) cssUnit++;
    const cssWidth = Math.max(cssUnit, Math.round(width / cssUnit) * cssUnit);
    const cssHeight = Math.ceil(cssWidth * composition.height / composition.width / cssUnit) * cssUnit;
    const pixels = Math.round(cssWidth * pixelRatio);
    const height = Math.round(cssHeight * pixelRatio);
    const stage = view.canvas.parentElement.getBoundingClientRect();
    const densityChanged = view.pixelRatio !== pixelRatio || view.networkPixelRatio !== displayPixelRatio;
    view.pixelRatio = pixelRatio;
    view.networkPixelRatio = displayPixelRatio;
    view.canvas.style.width = `${pixels / pixelRatio}px`;
    view.canvas.style.height = `${height / pixelRatio}px`;
    view.canvas.style.left = `${Math.round(stage.left / cssUnit) * cssUnit - stage.left}px`;
    view.canvas.style.top = `${Math.round(stage.top / cssUnit) * cssUnit - stage.top}px`;
    if (view.canvas.width !== pixels || view.canvas.height !== height || densityChanged || !view.cache) {
      view.canvas.width = pixels;
      view.canvas.height = height;
      view.scale = pixels / composition.width;
      if (ready) prepare(view);
    }
    syncNetwork(view);
    if (ready) draw(view, motion.matches ? 0 : time);
  }
  const resize = new ResizeObserver(entries => {
    for (const entry of entries) size(views.find(view => view.canvas.parentElement === entry.target), entry.contentRect.width);
    refresh();
  });
  const visibility = new IntersectionObserver(entries => {
    for (const entry of entries) views.find(view => view.canvas === entry.target).visible = entry.isIntersecting;
    refresh();
  });
  views.forEach(view => { resize.observe(view.canvas.parentElement); visibility.observe(view.canvas); });
  const roots = new ResizeObserver(entries => {
    for (const entry of entries) {
      for (const view of views.filter(view => view.root === entry.target)) {
        size(view, view.canvas.parentElement.getBoundingClientRect().width);
        if (ready && view.cache) drawNetwork(view, motion.matches ? 0 : time);
      }
    }
  });
  views.forEach(view => roots.observe(view.root));
  const screenVisibility = new MutationObserver(refresh);
  [gate, document.getElementById('appShell')].forEach(root => screenVisibility.observe(root, {attributes: true, attributeFilter: ['hidden']}));
  document.addEventListener('visibilitychange', refresh);
  window.addEventListener('scroll', () => {
    views.filter(view => view.visible).forEach(view => size(view, view.canvas.parentElement.getBoundingClientRect().width));
  }, {passive: true});
  motion.addEventListener('change', refresh);
  function resizeViews() {
    views.forEach(view => size(view, view.canvas.parentElement.getBoundingClientRect().width));
    refresh();
  }
  window.addEventListener('resize', resizeViews);
  function watchResolution() {
    const resolution = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    resolution.addEventListener('change', () => {
      resizeViews();
      watchResolution();
    }, {once: true});
  }
  watchResolution();
  Promise.all(['body', 'wheel', 'pole', 'network'].map(name => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => { images[name] = image; resolve(); };
    image.onerror = reject;
    image.src = `assets/portable-maz/${name}.png?v=20261031-mudflaps11`;
  }))).then(() => {
    ready = true;
    views.forEach(view => size(view, view.canvas.parentElement.getBoundingClientRect().width));
    refresh();
  }).catch(() => {
    views.forEach(view => { view.canvas.dataset.rendered = 'error'; });
    console.warn('Не удалось загрузить изображение МАЗа или контактной сети.');
  });
}

export { initTrolleyScene };
