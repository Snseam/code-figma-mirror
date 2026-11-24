async function checkCanvas(project, page, boards) {
  const expected = new Set(project.edges.map(edge => JSON.stringify([
    edge.from, edge.source, edge.action, edge.action === "BACK" ? null : edge.to
  ])));
  const failures = [];
  const masterByVariant = new Map();
  const boardById = new Map(boards.map(item => [item.frame.id, item.id]));
  let observedLinks = 0;
  let observedInstances = 0;
  let observedText = 0;
  let layerCount = 0;
  let maxDeviation = 0;

  async function inspect(spec, node, boardId) {
    if (!node) { failures.push([boardId, spec.id, "missing"]); return; }
    layerCount++;
    for (const field of ["x", "y", "width", "height"]) {
      const delta = Math.abs(node[field] - spec[field]);
      maxDeviation = Math.max(maxDeviation, delta);
      if (delta > 1) failures.push([boardId, spec.id, field, delta]);
    }
    if (spec.component) {
      const main = node.type === "INSTANCE" ? await node.getMainComponentAsync() : null;
      const group = JSON.stringify([spec.component, spec.variant || "Default"]);
      if (!main || (masterByVariant.has(group) && masterByVariant.get(group) !== main.id)) {
        failures.push([boardId, spec.id, "component"]);
      } else {
        observedInstances++;
        masterByVariant.set(group, main.id);
      }
    }
    if (spec.kind === "text") {
      if (node.type === "TEXT" && node.characters === spec.text) observedText++;
      else failures.push([boardId, spec.id, "text"]);
    }
    for (const reaction of node.reactions || []) {
      for (const action of reaction.actions || []) {
        const target = action.type === "BACK" ? null : boardById.get(action.destinationId);
        const key = JSON.stringify([boardId, spec.id, action.type === "BACK" ? "BACK" : action.navigation, target]);
        if (reaction.trigger?.type === "ON_CLICK" && expected.delete(key)) observedLinks++;
        else failures.push([boardId, spec.id, "unexpected reaction"]);
      }
    }
    const children = spec.children || [];
    if (children.length !== (node.children?.length || 0) && spec.kind === "frame") failures.push([boardId, spec.id, "child count"]);
    for (const [index, child] of children.entries()) await inspect(child, node.children[index], boardId);
  }
  for (const board of project.boards) {
    const frame = boards.find(item => item.id === board.id)?.frame;
    if (!frame || frame.width !== board.width || frame.height !== board.height) {
      failures.push([board.id, "board bounds"]);
      continue;
    }
    for (const [index, child] of board.children.entries()) await inspect(child, frame.children[index], board.id);
  }
  for (const item of expected) failures.push(["missing reaction", JSON.parse(item)]);
  return { pageId: page.id, boards: boards.length, observedText, observedInstances, observedLinks, layerCount,
    maxDeviation, failCount: failures.length, failures: failures.slice(0, 20) };
}
