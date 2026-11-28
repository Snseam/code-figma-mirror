const linear = Array.from({ length: 256 }, (_, index) => {
  const value = index / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
});

function lab(red, green, blue) {
  const transform = value => value > 216 / 24389 ? Math.cbrt(value) : (24389 / 27 * value + 16) / 116;
  const x = transform((.4124564 * red + .3575761 * green + .1804375 * blue) / .95047);
  const y = transform(.2126729 * red + .7151522 * green + .072175 * blue);
  const z = transform((.0193339 * red + .119192 * green + .9503041 * blue) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function perceptualMetrics(source, target) {
  const { width, height } = source;
  const colors = new Map();
  function color(data, offset) {
    const alpha = data[offset + 3] / 255;
    const composite = channel => Math.round(255 + alpha * (channel - 255));
    const red = composite(data[offset]), green = composite(data[offset + 1]), blue = composite(data[offset + 2]);
    const key = (red << 16) | (green << 8) | blue;
    let entry = colors.get(key);
    if (!entry) {
      entry = { luma: .299 * red + .587 * green + .114 * blue, lab: lab(linear[red], linear[green], linear[blue]) };
      if (colors.size >= 65536) colors.clear();
      colors.set(key, entry);
    }
    return entry;
  }
  let deltaSum = 0, similarity = 0;
  for (let top = 0; top < height; top += 8) {
    for (let left = 0; left < width; left += 8) {
      let sumSource = 0, sumTarget = 0, squaresSource = 0, squaresTarget = 0, products = 0, count = 0;
      for (let row = top; row < Math.min(top + 8, height); row++) {
        for (let column = left; column < Math.min(left + 8, width); column++) {
          const offset = 4 * (row * width + column);
          const first = color(source.data, offset), second = color(target.data, offset);
          if (first !== second) deltaSum += Math.hypot(first.lab[0] - second.lab[0], first.lab[1] - second.lab[1], first.lab[2] - second.lab[2]);
          sumSource += first.luma;
          sumTarget += second.luma;
          squaresSource += first.luma ** 2;
          squaresTarget += second.luma ** 2;
          products += first.luma * second.luma;
          count++;
        }
      }
      const meanSource = sumSource / count, meanTarget = sumTarget / count;
      const covariance = products / count - meanSource * meanTarget;
      const varianceSum = (squaresSource + squaresTarget) / count - meanSource ** 2 - meanTarget ** 2;
      const luminance = (2 * meanSource * meanTarget + 6.5025) / (meanSource ** 2 + meanTarget ** 2 + 6.5025);
      similarity += count * luminance * (2 * covariance + 58.5225) / (varianceSum + 58.5225);
    }
  }
  return { ssim8: similarity / (width * height), meanDeltaE76: deltaSum / (width * height) };
}

export function regionMetrics(board, heat) {
  const regions = [];
  const viewport = { left: 0, top: 0, right: heat.width, bottom: heat.height };
  function visit(node, parentX, parentY, clip) {
    const x = parentX + node.x, y = parentY + node.y;
    const bounds = { left: Math.max(clip.left, x), top: Math.max(clip.top, y),
      right: Math.min(clip.right, x + node.width), bottom: Math.min(clip.bottom, y + node.height) };
    const kind = node.component || node.figmaKey ? 'component' : node.kind;
    if (['component', 'text', 'image'].includes(kind)) {
      const left = Math.floor(bounds.left), top = Math.floor(bounds.top);
      const right = Math.ceil(bounds.right), bottom = Math.ceil(bounds.bottom);
      if (bounds.left < bounds.right && bounds.top < bounds.bottom) {
        let diffPixels = 0;
        for (let row = top; row < bottom; row++) {
          for (let column = left; column < right; column++) {
            if (heat.data[(row * heat.width + column) * 4] === 0xd9) diffPixels++;
          }
        }
        const totalPixels = (right - left) * (bottom - top);
        regions.push({ id: node.id, name: node.name, kind, left, top, right, bottom, diffPixels, totalPixels, diffRatio: diffPixels / totalPixels });
      }
    }
    for (const child of node.children || []) visit(child, x, y, node.style?.clip ? bounds : clip);
  }
  for (const node of board.children || []) visit(node, 0, 0, viewport);
  return regions.sort((first, second) => second.diffRatio - first.diffRatio || second.diffPixels - first.diffPixels);
}
