export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class' || key === 'className') element.className = value;
    else if (key === 'style' && typeof value === 'string') element.setAttribute('style', value);
    else if (key === 'style' && value && typeof value === 'object') Object.assign(element.style, value);
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'htmlFor') element.htmlFor = value;
    else if (key in element && key !== 'list') element[key] = value;
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(element, children);
  return element;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag, attrs = {}, ...children) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'text') element.textContent = value;
    else if (key === 'className') element.setAttribute('class', value);
    else element.setAttribute(key, value === true ? '' : String(value));
  }
  appendChildren(element, children);
  return element;
}

function appendChildren(element, children) {
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    element.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
}

export function clear(element) {
  if (!element) return;
  element.replaceChildren();
}

export function fmtNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtIndex(value) {
  return fmtNumber(value, 1);
}

export function fmtPercent(logValue, digits = 1) {
  if (!Number.isFinite(logValue)) return '—';
  const pct = (Math.exp(logValue) - 1) * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${fmtNumber(pct, digits)}%`;
}

export function badge(text, tone = 'neutral') {
  return h('span', { class: `badge badge-${tone}` }, text);
}
