/**
 * The brand mark, inline rather than an <img>.
 *
 * As an image the artwork carried its own colours, so the chevron and cursor
 * stayed near-white and vanished against a light background. Inline, they can
 * use the same tokens as everything else and follow the theme.
 *
 * The application icons are a separate asset: those sit on backgrounds the
 * product does not control, so they keep fixed colours.
 */
export function BrandMark() {
  return (
    <svg
      aria-labelledby="brand-mark-title"
      role="img"
      shapeRendering="geometricPrecision"
      viewBox="0 0 42 42"
    >
      <title id="brand-mark-title">OpsCapsule</title>
      <g fill="none" strokeLinecap="round">
        <path
          d="M 18 4.5 C 10.2 5.8 4.5 12.4 4.5 21 C 4.5 29.6 10.2 36.2 18 37.5"
          stroke="var(--accent-5)"
          strokeWidth="3"
        />
        <path
          d="M 24 4.5 C 31.8 5.8 37.5 12.4 37.5 21 C 37.5 29.6 31.8 36.2 24 37.5"
          stroke="var(--accent-5)"
          strokeWidth="3"
        />
        <path
          d="M 18.5 10 C 13.2 11 9.5 15.4 9.5 21 C 9.5 26.6 13.2 31 18.5 32"
          stroke="var(--accent-3)"
          strokeWidth="2.5"
        />
        <path
          d="M 23.5 10 C 28.8 11 32.5 15.4 32.5 21 C 32.5 26.6 28.8 31 23.5 32"
          stroke="var(--accent-3)"
          strokeWidth="2.5"
        />
      </g>
      {/* The prompt and cursor take the brightest surface tone, which inverts
          with the theme, so they stay legible against whatever is behind. */}
      <path
        d="M 17.5 16 L 23 21 L 17.5 26"
        fill="none"
        stroke="var(--surface-12)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="3"
      />
      <rect fill="var(--surface-12)" height="3" rx="0.4" width="3" x="26" y="24.5" />
    </svg>
  );
}
