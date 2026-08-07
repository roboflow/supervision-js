/* global Element, MutationObserver, URL, localStorage */

(function () {
  const packageName = "supervision";
  const packageVersion = "0.1.1";
  const packageReleaseStatus = "pending release";
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
    decorateHomePage();
    upgradeIcons(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            upgradeIcons(node);
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
      <a class="supervision-docs__nav-link" href="https://supervision-js-demo.onrender.com/">Demo</a>
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
