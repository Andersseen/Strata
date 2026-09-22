---
name: volt-ui
description: >
  Integrate Volt UI components into this Angular project. Use for any work on
  @voltui/components, Volt UI selectors, component composition, theming, or forms.
---

# Volt UI — Project Skill

## Project context

Strata's landing is an Angular standalone-components app and consumes the npm
package `@voltui/components`. Its global stylesheet already imports
`@voltui/components/themes.css`. Preserve this consumption mode: use `volt-*`
selectors and import classes from `@voltui/components`; do not introduce `ui-*`
selectors unless the app is deliberately migrated to the CLI/source-ownership
workflow.

## Required workflow

1. Build the page from Volt UI atoms and composites wherever an appropriate
   component exists. Do not use Volt only for a lone button or badge.
2. Before using an unfamiliar component or input, query the `volt-ui` MCP
   server with `get_component` or `get_usage_example`. Do not invent inputs.
3. Use semantic Volt theme tokens such as `bg-primary`, `text-foreground`, and
   `rounded-md` rather than hard-coded color variables when working in Tailwind.
4. Keep Angular components standalone and `OnPush`.

## Naming and selectors

Library components use `volt-*` and library directives use `[voltXxx]`.
Examples: `<volt-button>`, `<volt-card>`, `<volt-badge>`, and
`<a voltNavigationMenuLink>`. Attribute directives enhance an existing host;
presentational containers are element components.

## Component composition

Prefer the full component anatomy when it exists:

```html
<volt-card>
  <volt-card-header>
    <volt-card-title>Title</volt-card-title>
    <volt-card-description>Supporting copy</volt-card-description>
  </volt-card-header>
  <volt-card-content>Content</volt-card-content>
  <volt-card-footer>
    <volt-button>Continue</volt-button>
  </volt-card-footer>
</volt-card>
```

The relevant catalog includes button, badge, card, navigation-menu, separator,
tabs, accordion, avatar, progress, meter, table, tooltip, popover, dialog,
dropdown-menu, form-field, input, textarea, switch, checkbox, radio, select,
and search. The MCP catalog is the source of truth for exact imports and APIs.

## Overlay rule

Overlays are declared in an `ng-template` and triggered with their attribute
directive. For example, a dialog uses `[voltDialog]` on the trigger and
`voltDialogOverlay`, `voltDialogContent`, `voltDialogTitle`, and
`voltDialogDescription` inside the template.

## Forms

Use Volt CVA controls with Angular Reactive Forms. Pair inputs with
`<volt-form-field>`, label, hint, and error components. Set `type="submit"`
explicitly on submit buttons.

## MCP server

`https://volt-ui.pages.dev/api/mcp` provides `list_components`,
`get_component`, `get_usage_example`, `get_theme_info`, `get_project_info`, and
`generate_cli_command`, plus component/theme/project resources. Prefer these
tools over memory when implementing Volt UI.
