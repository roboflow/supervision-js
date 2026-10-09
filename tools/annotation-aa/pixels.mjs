export function comparePixels(left, right, width, roi) {
  const area = roi ?? { x: 0, y: 0, width, height: left.length / 4 / width };
  let changedPixels = 0;
  let totalDelta = 0;
  let maxDelta = 0;
  let alphaMass = 0;
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const offset = (y * width + x) * 4;
      let changed = false;
      alphaMass += left[offset + 3] / 255;
      for (let c = 0; c < 4; c++) {
        const delta = Math.abs(left[offset + c] - right[offset + c]);
        totalDelta += delta;
        maxDelta = Math.max(maxDelta, delta);
        changed ||= delta > 0;
      }
      changedPixels += Number(changed);
    }
  }
  return {
    changedPixels,
    maxByteDelta: maxDelta,
    meanAbsoluteByteDelta: totalDelta / (area.width * area.height * 4),
    alphaMass,
    exact: changedPixels === 0,
  };
}

export function alphaStatistics(pixels, width, roi) {
  let alphaMass = 0;
  let partialPixels = 0;
  let solidPixels = 0;
  for (let y = roi.y; y < roi.y + roi.height; y++) {
    for (let x = roi.x; x < roi.x + roi.width; x++) {
      const alpha = pixels[(y * width + x) * 4 + 3];
      alphaMass += alpha / 255;
      partialPixels += Number(alpha > 0 && alpha < 255);
      solidPixels += Number(alpha === 255);
    }
  }
  return { alphaMass, partialPixels, solidPixels };
}

export function downsample(pixels, width, height, factor) {
  const result = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            sum +=
              pixels[
                ((y * factor + dy) * width * factor + x * factor + dx) * 4 + c
              ];
          }
        }
        result[(y * width + x) * 4 + c] = Math.round(sum / factor ** 2);
      }
    }
  }
  return result;
}

export function png(pixels, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const rgba = new Uint8ClampedArray(pixels);
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3];
    if (!alpha) continue;
    for (let c = 0; c < 3; c++)
      rgba[i + c] = Math.round((rgba[i + c] * 255) / alpha);
  }
  canvas
    .getContext("2d")
    .putImageData(new window.ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL("image/png");
}

export async function digest(bytes) {
  return [
    ...new Uint8Array(await window.crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
