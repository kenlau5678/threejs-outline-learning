# Outline Learning

Studying Omar Shehata's approach to rendering outlines in WebGL.

> Reference: [How to Render Outlines in WebGL](https://omar-shehata.medium.com/how-to-render-outlines-in-webgl-8253c14724f9)

![alt text](.\IMG\effect.png)

---

## The Principle in One Sentence

**An outline is a "discontinuity" in the image.** Store **distance (depth)** and **orientation (normals)** as a texture, then look for the discontinuities in 2D — and found outlines.

---

## 3D Problem → 2D Image Processing

The goal is to draw cartoon-style outline lines on 3D objects.

The naive approach is to analyze the 3D geometry directly (walking triangle by triangle to find silhouette edges) — expensive and hard. The key mental shift in the tutorial is to **turn "finding outlines" into a 2D image-processing problem**. First render the scene normally, but also store each pixel's **depth** and **normal** as images. Then, in screen space, look for the "places that change suddenly"  — those sudden changes are the outlines.

In essence: **an outline = a discontinuity in the image**, and only two things can produce a discontinuity — a jump in distance (depth) or a jump in orientation (normals).

---

## Two Sources of Outlines (Core Concept)

**Depth difference handles the outer silhouette.** At the edge of an object, the object is in front (near) and the background is right next to it (far). Neighboring pixels show a sudden jump in depth → the silhouette boundary is detected. It only recognizes "distance cliffs."

**Normal difference handles internal creases.** Take a cube facing you: the edge where two faces meet is continuous in depth, but the two faces point in completely different directions → the normal jump reveals the crease.

Depth tells you "where the object ends," normals tell you "where the surface folds." Only together do they form a complete outline.

---

## Rendering Pipeline

This maps to what the code does every frame:

**Pass 1 — Render the scene normally** to get the color. The GPU has to write the depth buffer anyway; we tap into it with a `DepthTexture.

**Pass 2 — Re-render the whole scene with `MeshNormalMaterial`** to get the normal image. This is done by temporarily applying one material to the entire scene via `scene.overrideMaterial`, then restoring it immediately after rendering. Because Three.js uses forward rendering, there is no ready-made normal buffer, so we have to render this extra pass ourselves.

**Pass 3 — Post-processing outline.** Run an edge-detection shader on a full-screen quad. It reads the three textures (color / depth / normal), computes the outline, and composites it onto the image.

**Finally, add an FXAA anti-aliasing pass**, because once you render to an off-screen texture, the browser's built-in anti-aliasing no longer applies.

---

## Outline Algorithm

**Comparing neighbors = computing a spatial gradient.** In the shader, subtract the current pixel from its neighbors (up / down / left / right — plus 4 diagonals for normals), take the absolute values, and sum them up. This gives "how sharply things change here." This is exactly a convolution kernel in image processing, the same idea as Sobel / Laplacian edge detection. Normals use `distance()` rather than `abs()` because a normal is a 3D vector — you need the angular distance between directions.

**Depth must be linearized first.** The depth buffer stores non-linear values (more precision near the camera). Subtracting raw values directly gives huge differences up close and almost nothing far away. The `perspectiveDepthToViewZ` + `viewZToOrthographicDepth` functions brought in by `#include <packing>` convert it back to a linear `[0, 1]` range, so the threshold behaves consistently at both near and far distances.

**Two tuning knobs:**

- **multiplier** scales the overall difference up.
- **bias** (implemented with `pow`) is a contrast curve. When `bias > 1`, it pushes weak edges toward 0 and keeps only the strong ones — used to suppress noise and produce clean outlines.

**Line thickness.** Determined by the *distance* at which you sample neighbors. The farther you sample, the more pixels away from the edge can still detect the discontinuity, so the line gets thicker — i.e. multiply the sampling offset by a `thickness` factor.