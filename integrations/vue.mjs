import { ElementTypes, NodeTypes } from '@vue/compiler-dom';
import { fileComponentName, sourceKey } from './identity.mjs';

function rootReason(element) {
  if (element.type !== NodeTypes.ELEMENT) return 'indirect-root';
  if (element.tagType !== ElementTypes.ELEMENT) return 'component-or-template-root';
  if (element.tag.toLowerCase() === 'template') return 'component-or-template-root';
  for (const prop of element.props) {
    if (prop.type !== NodeTypes.DIRECTIVE) continue;
    if (['if', 'else', 'else-if', 'for', 'is'].includes(prop.name)) return 'structural-root';
    if (prop.name === 'bind' && (!prop.arg || !prop.arg.isStatic)) return 'dynamic-bind';
    if (prop.name === 'bind' && prop.arg.content === 'is') return 'dynamic-tag';
  }
  return null;
}

function attributeName(prop) {
  const name = prop.type === NodeTypes.ATTRIBUTE ? prop.name :
    prop.name === 'bind' && prop.arg?.isStatic ? prop.arg.content : '';
  return name.replaceAll('-', '').toLowerCase();
}

function stamp(element, key) {
  if (element.props.some(prop => attributeName(prop) === 'datamirrorkey' ||
    (prop.type === NodeTypes.DIRECTIVE && prop.name === 'bind' && !prop.arg?.isStatic))) return;
  element.props.push({
    type: NodeTypes.ATTRIBUTE, name: 'data-mirror-key', nameLoc: element.loc, loc: element.loc,
    value: { type: NodeTypes.TEXT, content: key, loc: element.loc }
  });
}

function markBranches(element, root) {
  let condition;
  for (const child of element.children) {
    if (child.type === NodeTypes.COMMENT || (child.type === NodeTypes.TEXT && !child.content.trim())) continue;
    if (child.type !== NodeTypes.ELEMENT || child.tagType !== ElementTypes.ELEMENT) {
      condition = null;
      continue;
    }
    const branch = child.props.find(prop => prop.type === NodeTypes.DIRECTIVE && ['if', 'else-if', 'else'].includes(prop.name));
    const expression = branch?.exp?.content?.trim();
    if (branch?.name !== 'else') condition = expression && /^[\w$]+(?:\.[\w$]+)*$/.test(expression) ? expression : null;
    const key = branch && condition ? `${root}/${condition}/${branch.name}` : root;
    if (key !== root) stamp(child, key);
    markBranches(child, key);
  }
}

export function vueComponentIdentity(options = {}) {
  const latest = new Map();
  function transform(node, context) {
    if (node.type !== NodeTypes.ROOT) return;
    const filename = context.filename;
    const component = fileComponentName(filename);
    const children = node.children.filter(child => child.type !== NodeTypes.COMMENT &&
      !(child.type === NodeTypes.TEXT && !child.content.trim()));
    const element = children[0];
    let status = 'skipped';
    let reason;
    if (!component) reason = 'unknown-filename';
    else if (children.length !== 1) reason = 'fragment';
    else if ((reason = rootReason(element)) === null) {
      if (element.props.some(prop => attributeName(prop) === 'datacomponent')) {
        status = 'preserved';
        reason = 'explicit-attribute';
      } else {
        element.props.push({
          type: NodeTypes.ATTRIBUTE, name: 'data-component', nameLoc: element.loc, loc: element.loc,
          value: { type: NodeTypes.TEXT, content: component, loc: element.loc }
        });
        const key = sourceKey(filename, component, options.root);
        if (key) {
          stamp(element, key);
          markBranches(element, key);
        }
        status = 'injected';
        reason = 'host-root';
      }
    }
    const event = { filename, component, status, reason, line: element?.loc.start.line ?? node.loc.start.line };
    latest.set(filename, event);
    options.onDiagnostic?.(event);
  }
  return { nodeTransforms: [transform], get diagnostics() { return Array.from(latest.values()); } };
}
