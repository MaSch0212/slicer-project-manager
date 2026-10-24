/**
 * Triangle soup: three vertices per triangle, back to back, no shared-index buffer.
 *
 * Every mesh parser (STL, OBJ, 3MF, STEP) returns this one shape so the rasterizer only has to
 * know one format. `positions` holds `triangleCount * 9` floats — x,y,z for each of a
 * triangle's three vertices, in triangle order — in a typed array rather than an array of
 * per-triangle objects, per the bounded-memory constraint.
 */
export type Mesh = {
  positions: Float32Array
  triangleCount: number
}
