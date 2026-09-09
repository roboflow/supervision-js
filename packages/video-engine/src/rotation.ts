/**
 * A quarter turn, in degrees clockwise, that stored pixels still need before
 * they face the way the container says they should. Every phone recording held
 * in portrait carries one: the sensor stores landscape and the track's display
 * matrix names the turn.
 *
 * The sign is mediabunny's, read straight off the track. ffprobe prints the
 * opposite sign for the same file, so a clip ffprobe calls +90 is 270 here.
 */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * Draws an image upright into a destination box, mirroring the transform
 * mediabunny's own VideoSample.draw applies so a frame decoded by the runtime
 * and a frame decoded by a mediabunny sink land the same pixels.
 *
 * dWidth and dHeight name the destination AFTER the turn, which is what the
 * track's display size already is. So on a quarter turn the source is drawn at
 * swapped extents inside the turned frame, and the scale below undoes the
 * aspect that swap introduces.
 */
export function drawRotated(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  rotation: Rotation,
  dx: number,
  dy: number,
  dWidth: number,
  dHeight: number,
): void {
  if (rotation === 0) {
    context.drawImage(image, dx, dy, dWidth, dHeight);
    return;
  }
  context.save();
  context.translate(dx + dWidth / 2, dy + dHeight / 2);
  context.rotate((rotation * Math.PI) / 180);
  const aspectRatioChange = rotation % 180 === 0 ? 1 : dWidth / dHeight;
  context.scale(1 / aspectRatioChange, aspectRatioChange);
  context.drawImage(image, -dWidth / 2, -dHeight / 2, dWidth, dHeight);
  context.restore();
}

/**
 * The 2x2 rotation, row-major, that turns a destination texture coordinate
 * about (0.5, 0.5) into the source coordinate to sample. Each entry is
 * [cos -sin; sin cos] evaluated at MINUS the rotation, written out because a
 * quarter turn is exact and trig at these angles is not.
 *
 * The negation is the whole point: sampling turns opposite to the picture, so
 * showing a frame turned clockwise by R means reading it counter-clockwise by
 * R. The unit square is closed under quarter turns about its centre, so the
 * whole source still maps onto the whole destination and the shader's existing
 * stretch-to-fill absorbs the aspect change for free.
 */
export function uvRotationMatrix(
  rotation: Rotation,
): readonly [number, number, number, number] {
  return UV_ROTATIONS[rotation];
}

const UV_ROTATIONS: Record<
  Rotation,
  readonly [number, number, number, number]
> = {
  0: [1, 0, 0, 1],
  90: [0, 1, -1, 0],
  180: [-1, 0, 0, -1],
  270: [0, -1, 1, 0],
};
