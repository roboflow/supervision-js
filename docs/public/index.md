<div class="supervision-home">
  <section class="supervision-home__hero" aria-labelledby="supervision-home-title">
    <div class="supervision-home__hero-copy">
      <p class="supervision-home__eyebrow">Roboflow Supervision for the browser</p>
      <h1 id="supervision-home-title">Render computer vision media as one synchronized scene.</h1>
      <p class="supervision-home__lede">
        <code>supervision</code> is a browser-native TypeScript library for interactive computer vision media. A media session keeps the visible frame, detections, annotation renderers, interaction, and playback on one timing reference.
      </p>
      <nav class="supervision-home__entrypoints" aria-label="Documentation entry points">
        <span>Explore</span>
        <a href="documents/Annotation_Renderers.html">Annotation renderers</a>
        <a href="documents/Quickstart.html">Quickstart</a>
        <a href="documents/Recipes.html">Recipes</a>
        <a href="modules/Styles.html">API reference</a>
      </nav>
      <p class="supervision-home__install"><code>npm install supervision</code></p>
      <div class="supervision-home__actions">
        <a class="supervision-home__button supervision-home__button--primary" href="documents/Quickstart.Application_Integration.html">Get started</a>
        <a class="supervision-home__button supervision-home__button--secondary" href="documents/Annotation_Renderers.html">Explore annotation renderers</a>
        <a class="supervision-home__button supervision-home__button--secondary" data-supervision-demo-link href="demo/">Open the demo</a>
      </div>
    </div>
    <aside class="supervision-home__scene-card" aria-label="Media session composition">
      <p class="supervision-home__card-label">One renderer-owned scene</p>
      <div class="supervision-home__scene-stack" aria-hidden="true">
        <span class="supervision-home__scene-layer supervision-home__scene-layer--media">Media frame</span>
        <span class="supervision-home__scene-layer supervision-home__scene-layer--masks">Masks, geometry &amp; assets</span>
        <span class="supervision-home__scene-layer supervision-home__scene-layer--labels">Labels &amp; interaction</span>
      </div>
      <p>
        The session owns composition and timing. Your application owns the surrounding UI, model calls, product workflow, and data persistence.
      </p>
    </aside>
  </section>
  <section class="supervision-home__section supervision-home__playground" aria-labelledby="playground-title">
    <div class="supervision-home__section-heading">
      <p class="supervision-home__eyebrow">Interactive playground</p>
      <h2 id="playground-title">See detections move with the media—not above it.</h2>
      <p>
        This looping basketball fixture combines segmentation masks, detection boxes, labels, and pose skeletons. Toggle annotation renderers and tune their styles while the same browser media session keeps every annotation in sync.
      </p>
    </div>
    <div class="supervision-home__playground-frame">
      <iframe
        allow="autoplay"
        data-supervision-playground-src="demo/?embed=docs-playground"
        loading="lazy"
        title="Interactive basketball detection playground"
      ></iframe>
    </div>
    <p class="supervision-home__playground-note">
      The playground is a small consumer of <code>supervision</code>, using the same session, detection, annotation renderer, and style contracts available to your application.
      <a href="documents/Core_Concepts.Detections_And_Rendering.html">Learn about detection rendering <span aria-hidden="true">→</span></a>
    </p>
  </section>
  <section class="supervision-home__section" aria-labelledby="quick-start-title">
    <div class="supervision-home__section-heading">
      <p class="supervision-home__eyebrow">Quick start</p>
      <h2 id="quick-start-title">Create one session for one media item.</h2>
    </div>
    <div class="supervision-home__quick-start">
      <div>
        <p>
          Give a session a container and media. It prepares the renderer, exposes state for your UI, and provides playback and detection controls without asking React or your app to run another frame loop.
        </p>
        <a href="documents/Core_Concepts.Media_Sessions.html">Learn how media sessions work <span aria-hidden="true">→</span></a>
      </div>
      <pre><code class="language-ts">import { createMediaSession } from "supervision";
const container = document.querySelector&lt;HTMLElement&gt;("#viewer");

if (!container) {
throw new Error("Missing #viewer container.");
}

const session = await createMediaSession({
container,
media: "/media/example.mp4",
renderer: { autoPlay: true, loop: true },
});
session.subscribe((state) =&gt; {
console.log(state.status, state.activities);
});</code></pre>
</div>
  </section>
  <section class="supervision-home__section" aria-labelledby="capabilities-title">
    <div class="supervision-home__section-heading">
      <p class="supervision-home__eyebrow">Browser capabilities</p>
      <h2 id="capabilities-title">The parts of a serious CV viewer, kept in one system.</h2>
      <p>
        Use the common session API first; use the deeper data, media, and editing APIs when the integration needs them.
      </p>
    </div>
    <div class="supervision-home__capability-grid">
      <article class="supervision-home__capability-card">
        <span class="supervision-home__capability-number">01</span>
        <h3>Media and playback</h3>
        <p>Images, video, and browser media streams with preparation, normalization, seeking, stepping, rate control, and current-frame refresh.</p>
        <a href="documents/Core_Concepts.Media_Preparation.html">Media preparation</a>
      </article>
      <article class="supervision-home__capability-card">
        <span class="supervision-home__capability-number">02</span>
        <h3>Detection rendering</h3>
        <p>Annotation renderers for boxes, masks, polygons, polylines, keypoints, labels, and multi-instance asset regions, selected from canonical media timing.</p>
        <a href="documents/Core_Concepts.Detections_And_Rendering.html">Detections and rendering</a>
      </article>
      <article class="supervision-home__capability-card">
        <span class="supervision-home__capability-number">03</span>
        <h3>Interaction and editing</h3>
        <p>Renderer-synchronized picking plus host-owned editing engines, persistence, undo/redo policy, and annotation commits.</p>
        <a href="documents/Recipes.Interactive_Picking.html">Interactive picking</a>
      </article>
    </div>
  </section>
  <section class="supervision-home__section" aria-labelledby="architecture-title">
    <div class="supervision-home__section-heading">
      <p class="supervision-home__eyebrow">Architecture</p>
      <h2 id="architecture-title">Portable semantics, platform-specific rendering.</h2>
      <p>
        The public browser package is built around a small platform-neutral core. Rendering and media engines stay behind that boundary so applications depend on sessions, detections, annotation renderer descriptors, and style contracts—not backend objects.
      </p>
    </div>
    <div class="supervision-home__package-grid">
      <article class="supervision-home__package-card supervision-home__package-card--core">
        <p class="supervision-home__package-kind">Private semantic core</p>
        <h3><code>supervision-js-core</code></h3>
        <p>Detections, geometry, masks, timelines, annotation renderer descriptors, styles, sources, picking, editing vocabulary, lifecycle contracts, and pure utilities.</p>
      </article>
      <article class="supervision-home__package-card supervision-home__package-card--web">
        <p class="supervision-home__package-kind">Published browser package</p>
        <h3><code>supervision</code></h3>
        <p><code>createMediaSession()</code>, browser media preparation, playback, render preparation, storage adapters, and the first 2D renderer.</p>
      </article>
      <article class="supervision-home__package-card supervision-home__package-card--experiment">
        <p class="supervision-home__package-kind">Private experiment</p>
        <h3><code>supervision-js-react-native</code></h3>
        <p>Native session and rendering experiments that share core semantics but are not part of the browser package or its compatibility promise.</p>
      </article>
    </div>
    <div class="supervision-home__pipeline" aria-label="Detection rendering pipeline">
      <article>
        <span>01</span>
        <h3>Semantic data</h3>
        <p>Detection frames and compact masks come from memory, chunks, IndexedDB, or your own source.</p>
      </article>
      <article>
        <span>02</span>
        <h3>Prepared window</h3>
        <p>A bounded set of nearby frames is parsed and prepared for rendering without retaining an entire video in memory.</p>
      </article>
      <article>
        <span>03</span>
        <h3>Active scene</h3>
        <p>Media and annotations are selected by the same media timing reference and presented together.</p>
      </article>
    </div>
  </section>
  <section class="supervision-home__section supervision-home__section--split" aria-labelledby="boundaries-title">
    <div>
      <p class="supervision-home__eyebrow">Public boundary</p>
      <h2 id="boundaries-title">Start with the session. Keep implementation details private.</h2>
      <p>
        The public API is deliberately smaller than the implementation. It gives applications media sessions, detections, annotation renderer descriptors, styles, interaction, state, and lifecycle primitives without coupling them to a scene graph, decoder, worker protocol, or prepared-artifact format.
      </p>
      <a class="supervision-home__text-link" href="documents/Core_Concepts.Public_API.html">Explore the public API <span aria-hidden="true">→</span></a>
    </div>
    <div class="supervision-home__boundary-card">
      <div>
        <p>Applications work with</p>
        <strong>sessions · detections · annotation renderers · styles · sources · state</strong>
      </div>
      <div>
        <p>Applications do not need to know</p>
        <strong>Pixi scenes · media adapters · workers · prepared artifacts</strong>
      </div>
    </div>
  </section>
  <section class="supervision-home__section supervision-home__next" aria-labelledby="next-title">
    <p class="supervision-home__eyebrow">Keep learning</p>
    <h2 id="next-title">Choose the path that matches your integration.</h2>
    <nav class="supervision-home__next-grid" aria-label="Documentation paths">
      <a href="documents/Quickstart.html"><strong>Quickstart</strong><span>Install, mount, and render your first detections.</span></a>
      <a href="documents/Annotation_Renderers.html"><strong>Annotation renderers</strong><span>Select and style boxes, masks, labels, polygons, pose, and asset regions in live playgrounds.</span></a>
      <a href="documents/Core_Concepts.html"><strong>Core concepts</strong><span>Understand sessions, semantic detections, styles, and preparation.</span></a>
      <a href="documents/Recipes.html"><strong>Recipes</strong><span>Apply focused patterns for sources, picking, lifecycle, and React.</span></a>
    </nav>
  </section>
</div>
