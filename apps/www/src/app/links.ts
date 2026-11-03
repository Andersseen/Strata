export const SITE_LINKS = {
  github: "https://github.com/Andersseen/Strata",
  releases: "https://github.com/Andersseen/Strata/releases",
  issues: "https://github.com/Andersseen/Strata/issues",
  docs: "https://andersseen.github.io/Strata/",
  gettingStarted: "https://andersseen.github.io/Strata/GETTING-STARTED/",
  npmServerComponents: "https://www.npmjs.com/package/@strata-sc/server-components",
  npmCore: "https://www.npmjs.com/package/@strata-sc/core",
  npmAnalog: "https://www.npmjs.com/package/@strata-sc/analog",
  voltUi: "https://volt-ui.andersseen.dev",
  angularMovement: "https://github.com/Andersseen/angular-movement",
  lumenIcons: "https://github.com/Andersseen/lumen-icons",
  analog: "https://analogjs.org",
} as const;

/** In-page sections, in document order, used by the nav and its scroll spy. */
export const SECTION_LINKS = [
  { id: "server-components", label: "Server Components" },
  { id: "why", label: "Why Strata" },
  { id: "controllers", label: "Controllers" },
  { id: "architecture", label: "Architecture" },
  { id: "start", label: "Quick start" },
] as const;
