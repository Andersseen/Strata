import { ChangeDetectionStrategy, Component } from "@angular/core";
import { MOVEMENT_DIRECTIVES } from "angular-movement";

const WIDTH = 1600;
const HEIGHT = 900;
const LAYERS = 18;
/** Paths overhang the viewBox so the horizontal drift never exposes an end. */
const OVERHANG = 120;

interface Stratum {
  readonly d: string;
  readonly accent: boolean;
  readonly drift: number;
  readonly duration: number;
  readonly delay: number;
}

function stratumPath(layer: number): string {
  const spacing = HEIGHT / (LAYERS + 1);
  const base = spacing * (layer + 1);
  const points: string[] = [];

  for (let x = -OVERHANG; x <= WIDTH + OVERHANG; x += 20) {
    const u = x / WIDTH;
    const swell = Math.sin(u * 2.4 + layer * 0.35) * spacing * 0.55;
    const ripple = Math.sin(u * 7.1 - layer * 0.5) * spacing * 0.16;
    const fold = Math.sin(u * 1.1) * spacing * 1.4 * Math.sin(layer * 0.21);
    points.push(`${x} ${(base + swell + ripple + fold).toFixed(1)}`);
  }

  return `M${points.join("L")}`;
}

const STRATA: readonly Stratum[] = Array.from({ length: LAYERS }, (_, layer) => ({
  d: stratumPath(layer),
  accent: layer % 6 === 3,
  drift: layer % 2 === 0 ? -70 : 70,
  duration: 16_000 + (layer % 5) * 2_500,
  delay: layer * 180,
}));

/**
 * The hero's ambient background: sedimentary layers (strata). The geometry is
 * computed once and server-rendered as SVG; all motion is Angular Movement —
 * `moveLoop` drifts each stratum and draws the request pulses along the accent
 * strata with `pathLength`/`pathOffset`. Reduced motion is handled by the
 * library.
 */
@Component({
  selector: "strata-hero-strata",
  imports: [...MOVEMENT_DIRECTIVES],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { "aria-hidden": "true", class: "hero-strata" },
  template: `<svg
    [attr.viewBox]="viewBox"
    preserveAspectRatio="xMidYMid slice"
    xmlns="http://www.w3.org/2000/svg"
  >
    <defs>
      <linearGradient id="strata-accent-fade" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stop-color="currentColor" stop-opacity="0" />
        <stop offset="0.55" stop-color="currentColor" stop-opacity="0.75" />
        <stop offset="1" stop-color="currentColor" stop-opacity="0" />
      </linearGradient>
    </defs>
    @for (stratum of strata; track $index) {
      <g
        [moveLoop]="{ x: [0, stratum.drift] }"
        moveLoopType="reverse"
        moveEasing="ease-in-out"
        [moveDuration]="stratum.duration"
        [moveDelay]="stratum.delay"
      >
        <path
          [attr.d]="stratum.d"
          [class]="stratum.accent ? 'stratum stratum-accent' : 'stratum'"
        />
        @if (stratum.accent) {
          <path
            class="stratum-pulse"
            [attr.d]="stratum.d"
            [moveLoop]="{ pathLength: [0.08, 0.08], pathOffset: [0, 0.92] }"
            moveEasing="linear"
            moveDuration="9000"
            [moveDelay]="stratum.delay * 4"
          />
        }
      </g>
    }
  </svg>`,
})
export class HeroStrataComponent {
  protected readonly viewBox = `0 0 ${WIDTH} ${HEIGHT}`;
  protected readonly strata = STRATA;
}
