import { inventory } from './cli.mjs';

export function audit(bundle, snapshot, tolerance = 1) {
  inventory(bundle);
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Invalid geometry tolerance');
  const observed = snapshot.observed;
  if (!observed || !['geometry', 'edges', 'instances'].every(key => Array.isArray(observed[key]))) {
    throw new Error('Export a design snapshot with observed geometry, instances and edges');
  }
  const issues = [];
  const key = (...fields) => JSON.stringify(fields);
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
  for (const board of bundle.boards) {
    const record = boards.get(board.id);
    if (!record || (record.status && record.status !== 'exported') ||
        record.width !== board.width || record.height !== board.height) issues.push({ issue: 'board-mismatch', boardId: board.id });
    expectedGeometry.add(key(board.id, board.id));
    function visit(node, parentId) {
      const locator = key(board.id, node.id);
      expectedGeometry.add(locator);
      const actual = geometry.get(locator);
      if (!actual) issues.push({ issue: 'missing-layer', boardId: board.id, id: node.id });
      else {
        matchedLayers++;
        for (const field of ['x', 'y', 'width', 'height']) {
          const difference = typeof actual[field] === 'number' ? Math.abs(actual[field] - node[field]) : NaN;
          if (Number.isFinite(difference)) maxDeviation = Math.max(maxDeviation, difference);
          if (!Number.isFinite(difference) || difference > tolerance) {
            issues.push({ issue: 'geometry-mismatch', boardId: board.id, id: node.id, field, expected: node[field], actual: actual[field] });
          }
        }
        if (node.kind === 'text' && actual.type !== 'TEXT') issues.push({ issue: 'text-not-editable', boardId: board.id, id: node.id });
        if (node.kind === 'text' && 'text' in actual && actual.text !== node.text) {
          issues.push({ issue: 'text-mismatch', boardId: board.id, id: node.id, expected: node.text, actual: actual.text });
        }
        if ('parentId' in actual && actual.parentId !== parentId) {
          issues.push({ issue: 'wrong-parent', boardId: board.id, id: node.id, expected: parentId, actual: actual.parentId });
        }
      }
      if (node.component || node.figmaKey) {
        expectedInstances.add(locator);
        const instance = instances.get(locator);
        const master = instance?.mainId;
        if (!master) issues.push({ issue: 'missing-component-instance', boardId: board.id, id: node.id });
        else {
          matchedInstances++;
          const component = node.figmaKey || node.component;
          const variant = node.variant || 'Default';
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
      for (const child of node.children || []) visit(child, node.id);
    }
    for (const child of board.children) visit(child, board.id);
  }
  for (const id of boards.keys()) if (!expectedBoards.has(id)) issues.push({ issue: 'unexpected-board', boardId: id });
  for (const [id, row] of geometry) if (!expectedGeometry.has(id)) issues.push({ issue: 'unexpected-layer', boardId: row.boardId, id: row.id });
  for (const [id, row] of instances) if (!expectedInstances.has(id)) issues.push({ issue: 'unexpected-instance', boardId: row.boardId, id: row.id });
  for (const change of snapshot.changes || []) {
    if (change.scope === 'design' && change.op === 'add' && expectedBoards.has(change.boardId)) {
      issues.push({ issue: 'added-design-layer', boardId: change.boardId, id: change.id });
    }
  }
  for (const edge of bundle.edges) if (!actualEdges.has(edgeKey(edge))) issues.push({ issue: 'missing-reaction', edge });
  for (const [id, edge] of actualEdges) if (!expectedEdges.has(id)) issues.push({ issue: 'unexpected-reaction', edge });
  return {
    passed: !issues.length, tolerance, maxDeviation, matchedLayers, matchedInstances, matchedEdges: [...expectedEdges].filter(id => actualEdges.has(id)).length,
    issues
  };
}
