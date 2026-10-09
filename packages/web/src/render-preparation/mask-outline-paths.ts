/** Trace closed pixel boundaries, retaining holes and disconnected components. */
export function traceMaskOutlinePaths(
  raster: Uint8Array | Uint32Array,
  width: number,
  height: number,
  ids: ReadonlySet<number>,
): Map<number, Float32Array<ArrayBuffer>[]> {
  const edgesById = new Map<number, Map<number, number[]>>();
  const stride = width + 1;
  const steps = [1, stride, -1, -stride];
  const add = (id: number, vertex: number, direction: number) => {
    let edges = edgesById.get(id);
    if (!edges) edgesById.set(id, (edges = new Map()));
    const outgoing = edges.get(vertex);
    if (outgoing) outgoing.push(direction);
    else edges.set(vertex, [direction]);
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;
      const id = raster[offset]!;
      if (!ids.has(id)) continue;
      const vertex = y * stride + x;
      if (y === 0 || raster[offset - width] !== id) add(id, vertex, 0);
      if (x === width - 1 || raster[offset + 1] !== id) add(id, vertex + 1, 1);
      if (y === height - 1 || raster[offset + width] !== id)
        add(id, vertex + stride + 1, 2);
      if (x === 0 || raster[offset - 1] !== id) add(id, vertex + stride, 3);
    }
  }

  const result = new Map<number, Float32Array<ArrayBuffer>[]>();
  for (const [id, edges] of edgesById) {
    const paths: Float32Array<ArrayBuffer>[] = [];
    while (edges.size > 0) {
      const start = edges.keys().next().value!;
      let vertex = start;
      let previousDirection = -1;
      let firstDirection = -1;
      const points: number[] = [];
      do {
        const outgoing = edges.get(vertex)!;
        // Turn right at diagonal contacts so separate islands stay separate.
        const direction =
          previousDirection < 0
            ? outgoing[0]!
            : [1, 0, 3, 2]
                .map((turn) => (previousDirection + turn) % 4)
                .find((candidate) => outgoing.includes(candidate))!;
        if (firstDirection < 0) firstDirection = direction;
        if (direction !== previousDirection)
          points.push(vertex % stride, Math.floor(vertex / stride));
        outgoing.splice(outgoing.indexOf(direction), 1);
        if (outgoing.length === 0) edges.delete(vertex);
        vertex += steps[direction]!;
        previousDirection = direction;
      } while (vertex !== start);
      if (previousDirection === firstDirection) points.splice(0, 2);
      paths.push(new Float32Array(points));
    }
    result.set(id, paths);
  }
  return result;
}
