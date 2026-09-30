/**
 * The research prototype's 16-bit PNG decoder
 * (depth-map-rendering-research, prototype/lib/png16.js), kept only as the
 * "before" in the decode benchmark. It unfilters one byte at a time with the
 * filter switch inside the loop, then copies each row out.
 */
export async function decodePng16Prototype(buffer: Uint8Array) {
  const b = buffer;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 8;
  let W = 0;
  let H = 0;
  const idat: Uint8Array[] = [];

  while (off < b.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...b.subarray(off + 4, off + 8));
    const data = b.subarray(off + 8, off + 8 + len);

    if (type === "IHDR") {
      W = dv.getUint32(off + 8);
      H = dv.getUint32(off + 12);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }

  const zlib = new Uint8Array(idat.reduce((n, c) => n + c.length, 0));
  let p = 0;

  for (const c of idat) {
    zlib.set(c, p);
    p += c.length;
  }

  const raw = new Uint8Array(
    await new Response(
      new Blob([zlib]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const bpp = 2;
  const stride = W * bpp;
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  const out = new Uint16Array(W * H);

  for (let y = 0; y < H; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));

    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];

      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);

        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v;
    }
    for (let x = 0; x < W; x += 1)
      out[y * W + x] = (cur[2 * x] << 8) | cur[2 * x + 1];
    prev.set(cur);
  }

  return { data: out, height: H, width: W };
}
