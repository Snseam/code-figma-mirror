import { inventory } from './cli.mjs';

function sourceLines(node) {
  if (Number.isSafeInteger(node.lineCount) && node.lineCount > 0) return node.lineCount;
  return (node.singleLine === true || /\/text-\d+@\d+$/.test(node.id)) && !/[\r\n\u2028\u2029]/.test(node.text) ? 1 : null;
}

function allowedTextFit(node, fit, left, right, siblings) {
  if (node.kind !== 'text' || node.component || node.figmaKey || sourceLines(node) !== 1 || !fit) return false;
  const extra = fit.width - node.width;
  const anchor = node.style?.align === 'CENTER' ? .5 : ['RIGHT', 'END'].includes(node.style?.align) ? 1 : 0;
  if (!(extra > 0 && extra <= 4) || fit.height !== node.height || Math.abs(fit.x - (node.x - anchor * extra)) > .001 ||
      !Number.isFinite(fit.x) || ['JUSTIFY', 'JUSTIFIED'].includes(node.style?.align)) return false;
  for (const peer of siblings) {
    if (peer === node || peer.y >= node.y + node.height || peer.y + peer.height <= node.y) continue;
    if (peer.kind === 'frame' && !peer.children?.length && !peer.style?.fill && !peer.style?.stroke && !peer.style?.backdropBlur) continue;
    if (peer.x >= node.x + node.width) right = Math.min(right, (peer.x + node.x + node.width) / 2);
    else if (peer.x + peer.width <= node.x) left = Math.max(left, (peer.x + peer.width + node.x) / 2);
    else return false;
  }
  return fit.x >= left - .001 && fit.x + fit.width <= right + .001;
}

export function audit(bundle, snapshot, tolerance = 1, expected = null) {
  inventory(bundle);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Invalid geometry tolerance');
  const observed = snapshot.observed;
  if (!observed || !['geometry', 'edges', 'instances'].every(key => Array.isArray(observed[key]))) {
    throw new Error('Export a design snapshot with observed geometry, instances and edges');
  }
  const issues = [];
  const key = (...fields) => JSON.stringify(fields);
  const editedText = new Map();
  for (const change of expected?.designChanges ?? []) {
    if (change.op !== 'update' || typeof change.after?.text !== 'string') continue;
    for (const { boardId, id } of [change, ...(change.propagatesTo ?? [])]) {
      editedText.set(key(boardId, id), change);
    }
  }
  function expectedText(boardId, node) {
    const change = editedText.get(key(boardId, node.id));
    return change && change.before.text === node.text ? change.after.text : node.text;
  }
  const nodeKey = row => key(row.boardId, row.id);
  const edgeKey = edge => key(edge.from, edge.source, edge.action, edge.action === 'BACK' ? null : edge.to);
  const index = (list, getKey, label) => {
    const indexed = new Map();
    for (const row of list) {
      const id = getKey(row);
      if (indexed.has(id)) issues.push({ issue: `duplicate-${label}`, id });
      indexed.set(id, row);
    }
    return indexed;
  };
  if (bundle.project !== snapshot.project) issues.push({ issue: 'wrong-project', expected: bundle.project, actual: snapshot.project });
  const geometry = index(observed.geometry, nodeKey, 'geometry');
  const instances = index(observed.instances, nodeKey, 'instance');
  const links = index(observed.componentLinks || [], nodeKey, 'component-link');
  const actualEdges = index(observed.edges, edgeKey, 'edge');
  const expectedEdges = new Set(bundle.edges.map(edgeKey));
  const mainIds = new Map();
  const componentSets = new Map();
  const boards = index(snapshot.boards || [], row => row.id, 'board');
  const expectedBoards = new Set(bundle.boards.map(board => board.id));
  const expectedGeometry = new Set();
  const expectedInstances = new Set();
  let matchedLayers = 0;
  let matchedInstances = 0;
  let maxDeviation = 0;
  const boardMetrics = {};
  for (const board of bundle.boards) {
    const metrics = { expectedInstances: 0, retainedInstances: 0, requiredProperties: 0, matchedProperties: 0,
      textRuns: 0, matchedLines: 0, unknownLines: 0, expectedEdges: bundle.edges.filter(edge => edge.from === board.id).length,
      matchedEdges: 0, rawGeometryIssues: 0, compensatedFields: 0, layoutIssues: 0 };
    boardMetrics[board.id] = metrics;
    const record = boards.get(board.id);
    if (!record || (record.status && record.status !== 'exported') ||
        record.width !== board.width || record.height !== board.height) issues.push({ issue: 'board-mismatch', boardId: board.id });
    expectedGeometry.add(key(board.id, board.id));
    function visit(node, parentId, left, right, siblings) {
      const locator = key(board.id, node.id);
      expectedGeometry.add(locator);
      const actual = geometry.get(locator);
      if (!actual) issues.push({ issue: 'missing-layer', boardId: board.id, id: node.id });
      else {
        matchedLayers++;
        const fit = actual.textFit;
        const validFit = allowedTextFit(node, fit, left, right, siblings);
        if (fit && !validFit) issues.push({ issue: 'invalid-text-fit', boardId: board.id, id: node.id });
        for (const field of ['x', 'y', 'width', 'height']) {
          const difference = typeof actual[field] === 'number' ? Math.abs(actual[field] - node[field]) : NaN;
          if (Number.isFinite(difference)) maxDeviation = Math.max(maxDeviation, difference);
          const rawMismatch = !Number.isFinite(difference) || difference > tolerance;
          if (rawMismatch) metrics.rawGeometryIssues++;
          const expected = validFit && ['x', 'width'].includes(field) ? fit[field] : node[field];
          if (!Number.isFinite(difference) || Math.abs(actual[field] - expected) > tolerance) {
            metrics.layoutIssues++;
            issues.push({ issue: 'geometry-mismatch', boardId: board.id, id: node.id, field, expected, actual: actual[field] });
          } else if (rawMismatch) {
            metrics.compensatedFields++;
          }
        }
        if (node.kind === 'text' && actual.type !== 'TEXT') issues.push({ issue: 'text-not-editable', boardId: board.id, id: node.id });
        if (node.kind === 'text' && ('text' in actual || editedText.has(locator)) && actual.text !== expectedText(board.id, node)) {
          issues.push({ issue: 'text-mismatch', boardId: board.id, id: node.id, expected: expectedText(board.id, node), actual: actual.text });
        }
        if ('parentId' in actual && actual.parentId !== parentId) {
          issues.push({ issue: 'wrong-parent', boardId: board.id, id: node.id, expected: parentId, actual: actual.parentId });
        }
      }
      if (node.kind === 'text' && node.text?.trim()) {
        metrics.textRuns++;
        const expected = sourceLines(node);
        if (expected === null || !Number.isSafeInteger(actual?.lineCount) || actual.lineCount < 1) metrics.unknownLines++;
        else if (actual.lineCount === expected) metrics.matchedLines++;
        else issues.push({ issue: 'line-count-mismatch', boardId: board.id, id: node.id, expected, actual: actual.lineCount });
      }
      if (node.component || node.figmaKey) {
        metrics.expectedInstances++;
        const link = links.get(locator);
        const slots = node.kind === 'text' ? [node] : (node.children || []).filter(child => child.kind === 'text' && !child.component && !child.figmaKey);
        const values = Object.values(link?.properties ?? {}).filter(property => property.type === 'TEXT').map(property => property.value);
        for (const slot of slots.filter(slot => typeof slot.text === 'string')) {
          metrics.requiredProperties++;
          const required = expectedText(board.id, slot);
          const match = values.indexOf(required);
          if (match >= 0) {
            metrics.matchedProperties++;
            values.splice(match, 1);
          } else if (link?.properties || editedText.has(key(board.id, slot.id))) {
            issues.push({ issue: 'missing-text-property', boardId: board.id, id: slot.id, expected: required });
          }
        }
        expectedInstances.add(locator);
        const instance = instances.get(locator);
        const master = instance?.mainId;
        if (!master) issues.push({ issue: 'missing-component-instance', boardId: board.id, id: node.id });
        else {
          matchedInstances++;
          metrics.retainedInstances++;
          const component = node.figmaKey || node.component;
          const variant = node.variant || 'Default';
          if (link) {
            if (link.sourceMainId && link.sourceMainId !== master) issues.push({ issue: 'changed-component-master', boardId: board.id, id: node.id });
            if (!node.figmaKey && (link.family !== component || (link.setId &&
              ![variant, `State=${variant}`].includes(link.variant)))) {
              issues.push({ issue: 'wrong-component-family-or-variant', boardId: board.id, id: node.id, component, variant });
            }
          }
          const layout = instance.layout || null;
          if (layout || instance.setId) {
            if (!instance.setId || (componentSets.has(component) && componentSets.get(component) !== instance.setId)) {
              issues.push({ issue: 'different-component-set', component, id: node.id });
            }
            if ((!node.figmaKey && instance.family !== component) || instance.variant !== variant) {
              issues.push({ issue: 'wrong-variant', component, id: node.id });
            }
            componentSets.set(component, instance.setId);
          }
          const identity = key(component, variant, layout);
          if (mainIds.has(identity) && mainIds.get(identity) !== master) issues.push({ issue: 'different-master', component: identity, id: node.id });
          mainIds.set(identity, master);
        }
      }
      const contain = node.style?.clip || node.component;
      for (const child of node.children || []) visit(child, node.id, Math.max(left - node.x, contain ? 0 : -Infinity),
        Math.min(right - node.x, contain ? node.width : Infinity), node.children);
    }
    for (const child of board.children) visit(child, board.id, 0, board.width, board.children);
  }
  for (const id of boards.keys()) if (!expectedBoards.has(id)) issues.push({ issue: 'unexpected-board', boardId: id });
  for (const [id, row] of geometry) if (!expectedGeometry.has(id)) issues.push({ issue: 'unexpected-layer', boardId: row.boardId, id: row.id });
  for (const [id, row] of instances) if (!expectedInstances.has(id)) issues.push({ issue: 'unexpected-instance', boardId: row.boardId, id: row.id });
  for (const change of snapshot.changes || []) {
    if (change.scope === 'design' && change.op === 'add' && expectedBoards.has(change.boardId)) {
      issues.push({ issue: 'added-design-layer', boardId: change.boardId, id: change.id });
    }
  }
  for (const edge of bundle.edges) {
    if (!actualEdges.has(edgeKey(edge))) issues.push({ issue: 'missing-reaction', edge });
    else boardMetrics[edge.from].matchedEdges++;
  }
  for (const [id, edge] of actualEdges) if (!expectedEdges.has(id)) issues.push({ issue: 'unexpected-reaction', edge });
  return {
    passed: !issues.length, tolerance, maxDeviation, matchedLayers, matchedInstances, matchedEdges: [...expectedEdges].filter(id => actualEdges.has(id)).length,
    issues, boardMetrics
  };
}
