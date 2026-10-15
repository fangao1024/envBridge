const svgNamespace = 'http://www.w3.org/2000/svg';

// Icons are decorative; the surrounding button or status supplies its label.
// Symbols live in popup.html so an initially hidden popup has no SVG fetch barrier.
export function icon(name) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.classList.add('icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(svgNamespace, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}
