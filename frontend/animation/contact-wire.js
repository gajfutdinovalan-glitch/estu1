const CONTACT_WIRE_RATIO = 211 / 242;

let contactAlignmentFrame = 0;

let contactResizeObserver = null;

function syncContactAlignment() {
  cancelAnimationFrame(contactAlignmentFrame);
  contactAlignmentFrame = requestAnimationFrame(() => {
    document.querySelectorAll('.hero').forEach(hero => {
      if (hero.offsetParent === null) return;
      const contactLine = hero.querySelector('.contact-line');
      const contactAnchor = hero.querySelector('.pole-contact-anchor');
      if (!contactLine || !contactAnchor) return;
      const heroRect = hero.getBoundingClientRect();
      const anchorRect = contactAnchor.getBoundingClientRect();
      const lineHeight = contactLine.getBoundingClientRect().height;
      const anchorY = anchorRect.top + anchorRect.height / 2 - heroRect.top;
      const nextTop = anchorY - lineHeight * CONTACT_WIRE_RATIO;
      hero.style.setProperty('--contact-live-top', `${nextTop}px`);
    });
  });
}

function setupContactAlignment() {
  window.addEventListener('resize', syncContactAlignment, {passive: true});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) syncContactAlignment();
  });
  if ('ResizeObserver' in window) {
    contactResizeObserver = new ResizeObserver(syncContactAlignment);
    document.querySelectorAll('.hero, .trolley-animation').forEach(element => contactResizeObserver.observe(element));
  }
  syncContactAlignment();
}

export { setupContactAlignment, syncContactAlignment };
