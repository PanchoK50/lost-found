'use client';

/** A row of mutually exclusive options, in the style of the floor rail. */
export function Segmented<T extends string>({ options, value, onChange, label, className = '' }: {
  options: { value: T; label: string }[];
  value: T;
  onChange(value: T): void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={label}>
      {options.map(o => <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}
