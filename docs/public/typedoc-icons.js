/* global Element, MutationObserver */

(function () {
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
