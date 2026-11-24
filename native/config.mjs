const name = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => name(value) && /^[\p{L}\p{N}_-]+$/u.test(value) && !value.includes('--');
const selector = value => name(value) || (Array.isArray(value) && value.length > 0 && value.every(name));
const route = value => name(value) && /^\/[\w/-]+(?:\?[^#\s]*)?$/.test(value) && !value.startsWith('//');

function check(ok, message) {
  if (!ok) throw new Error(`Invalid config: ${message}`);
}

function entries(items, label) {
  check(Array.isArray(items) && items.length > 0, `expected non-empty ${label}`);
  const seen = new Set();
  for (const item of items) {
    check(object(item) && identifier(item.id), `invalid ${label} ID`);
    const key = item.id.normalize('NFC').toLowerCase();
    check(!seen.has(key), `duplicate ${label} ID ${item.id}`);
    seen.add(key);
  }
  return items;
}

export function validateConfig(config) {
  check(object(config) && name(config.project), 'project name required');
  check(config.timeoutMs === undefined || (Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0),
    'timeoutMs must be a positive integer');
  for (const viewport of entries(config.viewports, 'viewports')) {
    check(name(viewport.wsEndpoint) && URL.canParse(viewport.wsEndpoint) &&
      ['ws:', 'wss:'].includes(new URL(viewport.wsEndpoint).protocol), `${viewport.id} needs a DevTools wsEndpoint`);
    for (const key of ['width', 'height']) {
      check(viewport[key] === undefined || (Number.isSafeInteger(viewport[key]) && viewport[key] > 0),
        `${viewport.id}.${key} must be a positive logical window dimension`);
    }
  }
  const nodesByState = new Map();
  for (const state of entries(config.states, 'states')) {
    check(route(state.path) && state.url === undefined, `${state.id} needs a native Mini Program path`);
    check(state.expectPath === undefined || route(state.expectPath), `${state.id}.expectPath`);
    check(state.data === undefined || object(state.data), `${state.id}.data must be an object`);
    check(state.ready === undefined || selector(state.ready), `${state.id}.ready needs a WXML selector`);
    check(state.steps === undefined || Array.isArray(state.steps), `${state.id}.steps must be an array`);
    for (const step of state.steps ?? []) {
      check(object(step) && ['waitFor', 'waitForPage', 'tap', 'input'].includes(step.action), `${state.id}: unknown step`);
      if (step.action === 'waitForPage') check(route(step.path), `${state.id}: waitForPage needs a path`);
      else check(selector(step.selector), `${state.id}: ${step.action} needs a WXML selector`);
      if (step.action === 'input') check(typeof step.value === 'string', `${state.id}: input needs a string value`);
    }
    const ids = new Map();
    function visit(rules, scope) {
      for (const rule of entries(rules, `${state.id} selectors`)) {
        check(!ids.has(rule.id), `${state.id}: duplicate node ID ${rule.id}`);
        check(selector(rule.selector) && ['frame', 'text'].includes(rule.kind), `${rule.id}: invalid selector or kind`);
        check(rule.name === undefined || name(rule.name), `${rule.id}.name`);
        check(rule.component === undefined || name(rule.component), `${rule.id}.component`);
        const chain = scope.concat(rule.selector);
        ids.set(rule.id, chain);
        if (rule.children !== undefined) {
          check(rule.kind === 'frame' && Array.isArray(rule.children), `${rule.id}: only frames may have children`);
          if (rule.children.length) visit(rule.children, chain);
        }
      }
    }
    visit(state.selectors, []);
    nodesByState.set(state.id, ids);
  }
  const actions = new Set();
  check(config.edges === undefined || Array.isArray(config.edges), 'edges must be an array');
  for (const edge of config.edges ?? []) {
    check(object(edge) && nodesByState.get(edge.from)?.has(edge.source) && nodesByState.has(edge.to),
      'edge must reference two states and a declared source node ID');
    check(edge.action === undefined || edge.action === 'NAVIGATE', 'only NAVIGATE edges are supported');
    const key = JSON.stringify([edge.from, edge.source]);
    check(!actions.has(key), `multiple edges share ${edge.from}/${edge.source}`);
    actions.add(key);
  }
  return nodesByState;
}
