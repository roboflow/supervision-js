/* global Element, MutationObserver, URL, localStorage */

(function () {
  const packageName = "supervision";
  const packageVersion = "0.1.2";
  const packageReleaseStatus = "";
  const kindIconMap = {
    Accessor: "A",
    Class: "C",
    Constructor: "Ct",
    Document: "D",
    Enumeration: "E",
    Enum: "E",
    Function: "Fn",
    Interface: "I",
    Method: "M",
    Module: "M",
    Namespace: "N",
    Parameter: "P",
    Property: "P",
    Reference: "R",
    TypeAlias: "T",
    "Type alias": "T",
    Variable: "V",
  };

  function normalizeKind(kind) {
    return kind ? kind.replace(/\s+/g, "") : "Symbol";
  }

  function iconTextFor(kind) {
    return kindIconMap[kind] ?? kindIconMap[normalizeKind(kind)] ?? "S";
  }

  function upgradeIcon(icon) {
    if (icon.dataset.supervisionIcon === "true") {
      return;
    }

    const kind = icon.getAttribute("aria-label") ?? "Symbol";
    const normalizedKind = normalizeKind(kind);
    const label = iconTextFor(kind);

    icon.dataset.supervisionIcon = "true";
    icon.dataset.supervisionKind = normalizedKind;
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("role", "img");
    icon.innerHTML = `
      <rect class="supervision-doc-kind-icon__bg" x="2.5" y="2.5" width="19" height="19" rx="5" />
      <text class="supervision-doc-kind-icon__text" x="12" y="12.7" text-anchor="middle" dominant-baseline="middle">${label}</text>
    `;
  }

  function upgradeIcons(root) {
    const icons =
      root instanceof Element && root.matches(".tsd-kind-icon")
        ? [root]
        : root.querySelectorAll?.(".tsd-kind-icon");

    if (!icons) {
      return;
    }

    for (const icon of icons) {
      upgradeIcon(icon);
    }
  }

  function boot() {
    document.documentElement.dataset.theme = "light";
    localStorage.setItem("tsd-theme", "light");
    brandToolbar();
    configureEmbeddedPlaygrounds(document);
    customizeSidebar();
    decorateHomePage();
    upgradeIcons(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            upgradeIcons(node);
            configureEmbeddedPlaygrounds(node);
            customizeSidebar();
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function decorateHomePage() {
    const home = document.querySelector(".supervision-home");

    if (!home) {
      return;
    }

    home.closest(".tsd-typography")?.classList.add("supervision-docs--home");
    document.documentElement.classList.add("supervision-docs--home");
    home
      .closest(".container-main")
      ?.classList.add("supervision-docs--home-layout");
    configureHomeDemoLink(home);
  }

  function configureEmbeddedPlaygrounds(root) {
    const playgrounds =
      root instanceof Element &&
      root.matches("iframe[data-supervision-playground-src]")
        ? [root]
        : root.querySelectorAll?.("iframe[data-supervision-playground-src]");

    if (!playgrounds) {
      return;
    }

    for (const playground of playgrounds) {
      const deployedSource = playground.dataset.supervisionPlaygroundSrc;

      if (
        deployedSource &&
        playground.dataset.supervisionPlaygroundReady !== "true"
      ) {
        playground.src = resolveDemoUrl(deployedSource);
        playground.dataset.supervisionPlaygroundReady = "true";
      }
    }
  }

  window.addEventListener("message", (event) => {
    const payload = event.data;

    if (
      !payload ||
      payload.type !== "supervision-js:playground-height" ||
      !Number.isFinite(payload.height)
    ) {
      return;
    }

    const playground = Array.from(
      document.querySelectorAll("iframe[data-supervision-playground-src]"),
    ).find((iframe) => iframe.contentWindow === event.source);

    if (!playground) {
      return;
    }

    const expectedOrigin = new URL(playground.src, window.location.href).origin;

    if (event.origin !== expectedOrigin) {
      return;
    }

    playground.style.height = `${Math.ceil(payload.height)}px`;
  });

  function configureHomeDemoLink(home) {
    const demoLink = home.querySelector("[data-supervision-demo-link]");
    if (demoLink) {
      demoLink.href = resolveDemoUrl(demoLink.getAttribute("href") ?? "demo/");
    }
  }

  function customizeSidebar() {
    const navigation = document.querySelector(".site-menu .tsd-navigation");
    const rootLink = navigation?.querySelector(":scope > a");

    if (!navigation || !rootLink) {
      return;
    }

    const base = document.documentElement.dataset.base ?? "./";
    rootLink.href = new URL(`${base}index.html`, window.location.href).href;
    rootLink.textContent = "Home";
    rootLink.classList.add("supervision-docs__sidebar-home");

    const navList = navigation.querySelector(":scope > ul");
    if (!navList || navList.dataset.supervisionStructured === "true") {
      return;
    }

    const moduleItems = Array.from(navList.children).filter((item) =>
      item.querySelector?.('.tsd-kind-icon[aria-label="Module"]'),
    );

    if (moduleItems.length === 0) {
      return;
    }

    const apiItem = document.createElement("li");
    apiItem.className = "supervision-docs__api-reference";
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const label = document.createElement("span");
    const count = document.createElement("small");
    const apiList = document.createElement("ul");

    label.textContent = "API Reference";
    count.textContent = String(moduleItems.length);
    summary.append(label, count);
    details.append(summary, apiList);
    apiItem.append(details);

    for (const moduleItem of moduleItems) {
      apiList.append(moduleItem);
    }

    navList.append(apiItem);
    navList.dataset.supervisionStructured = "true";
  }

  function resolveDemoUrl(deployedPath) {
    // TypeDoc's standalone local server mounts docs at its origin root, while
    // the assembled site mounts docs at the domain root and the demo at /demo/.
    // Point only the standalone preview at the separately-running Vite demo.
    const isStandaloneLocalDocs =
      (window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1") &&
      window.location.port === "5175";

    if (isStandaloneLocalDocs) {
      return `http://127.0.0.1:5173/${deployedPath.includes("?") ? deployedPath.slice(deployedPath.indexOf("?")) : ""}`;
    }

    const base = document.documentElement.dataset.base ?? "./";
    return new URL(`${base}${deployedPath}`, window.location.href).href;
  }

  function brandToolbar() {
    const toolbar = document.querySelector(".tsd-toolbar-contents");
    const title = toolbar?.querySelector("a.title");
    const links = document.querySelector("#tsd-toolbar-links");

    if (!toolbar || !title || !links) {
      return;
    }

    const base = document.documentElement.dataset.base ?? "./";
    const docsHome = new URL(`${base}index.html`, window.location.href).href;
    const logo = new URL(
      `${base}assets/brand/roboflow-logomark.svg`,
      window.location.href,
    ).href;
    const demoUrl = resolveDemoUrl(`${base}demo/`);
    const version = packageReleaseStatus
      ? `v${packageVersion} (${packageReleaseStatus})`
      : `v${packageVersion}`;

    title.innerHTML = `
      <img class="supervision-docs__mark" src="${logo}" alt="Roboflow" />
      <span class="supervision-docs__brand-copy">
        <span>${packageName}</span>
        <span class="supervision-docs__product">JS</span>
        <span class="supervision-docs__version">${version}</span>
      </span>
    `;

    links.innerHTML = `
      <a class="supervision-docs__nav-link" href="${demoUrl}">Demo</a>
      <a class="supervision-docs__nav-link supervision-docs__nav-link--active" href="${docsHome}">Docs</a>
      <a class="supervision-docs__nav-link supervision-docs__github" href="https://github.com/roboflow/supervision-js">GitHub</a>
    `;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
