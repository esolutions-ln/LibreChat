import type { Domain } from './scale';
import { formatTick } from './scale';

export const W = 640;
export const H = 320;

export type Layout = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  innerW: number;
  innerH: number;
  rotate: boolean;
};

/** Long or numerous category labels are rotated so they never overlap. */
export function makeLayout(categories: string[]): Layout {
  const rotate = categories.length > 8 || categories.some((c) => c.length > 10);
  const left = 56;
  const right = 16;
  const top = 16;
  const bottom = rotate ? 76 : 32;
  return { left, right, top, bottom, innerW: W - left - right, innerH: H - top - bottom, rotate };
}

export const makeY = (l: Layout, d: Domain) => (v: number) =>
  l.top + l.innerH * (1 - (v - d.min) / (d.max - d.min));

const shorten = (s: string): string => (s.length > 14 ? `${s.slice(0, 13)}…` : s);

type AxesProps = {
  layout: Layout;
  domain: Domain;
  categories: string[];
  /** Centre x of category `i`. */
  xAt: (i: number) => number;
};

/** Grid lines, value ticks and category labels shared by the bar and line plots. */
export function Axes({ layout, domain, categories, xAt }: AxesProps) {
  const y = makeY(layout, domain);
  const baseline = y(Math.max(domain.min, Math.min(0, domain.max)));
  return (
    <g aria-hidden="true" className="text-xs">
      {domain.ticks.map((t) => (
        <g key={t}>
          <line
            x1={layout.left}
            x2={W - layout.right}
            y1={y(t)}
            y2={y(t)}
            className="stroke-border-light"
            strokeWidth={1}
          />
          <text
            x={layout.left - 6}
            y={y(t)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-text-secondary"
          >
            {formatTick(t)}
          </text>
        </g>
      ))}
      <line
        x1={layout.left}
        x2={W - layout.right}
        y1={baseline}
        y2={baseline}
        className="stroke-border-heavy"
        strokeWidth={1}
      />
      {categories.map((c, i) => {
        const x = xAt(i);
        const yy = H - layout.bottom + 14;
        return (
          <text
            key={`${c}-${i}`}
            x={x}
            y={yy}
            textAnchor={layout.rotate ? 'end' : 'middle'}
            transform={layout.rotate ? `rotate(-35 ${x} ${yy})` : undefined}
            className="fill-text-secondary"
          >
            {shorten(c)}
          </text>
        );
      })}
    </g>
  );
}
