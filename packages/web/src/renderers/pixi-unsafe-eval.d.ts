/**
 * pixi.js exports `./unsafe-eval` with no `types` condition, unlike its other
 * side-effect entries. The module installs Pixi's eval-free code paths when it
 * loads and exports nothing.
 */
declare module "pixi.js/unsafe-eval" {}
